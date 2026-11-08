import type { FloorExit, IncidentState } from "@firewatch/shared/types";
import { estimatedFloors, useBuilding } from "./activeBuilding";
import { Empty, PanelHeading, PeopleCount } from "./ui";

const stairName = (id: string) => `Stairwell ${id.replace(/^stair-/, "").toUpperCase()}`;

function SmokeTime({ minute, currentMinute }: { minute: number | null; currentMinute: number }) {
  if (minute === null) return <span className="subtle">Below threshold through +30 min</span>;
  return (
    <span className={minute <= currentMinute ? "risk-active" : "risk-future"}>
      +{minute} min{minute <= currentMinute ? " · reached in this view" : " · predicted"}
    </span>
  );
}

function FloorForecast({ exit, minute, selected, estimated, onSelect }: {
  exit: FloorExit;
  minute: number;
  selected: boolean;
  estimated: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={`exit-floor ${selected ? "selected-floor" : ""}`}>
      <div className="exit-floor-heading">
        <button className="text-button" aria-pressed={selected} onClick={onSelect}>Floor {exit.floor}</button>
        <span><PeopleCount count={exit.people} estimated={estimated} /></span>
      </div>
      <dl className="exit-details">
        <div><dt>Recommended stair</dt><dd className={exit.stair ? "" : "risk-active"}>{exit.stair ? stairName(exit.stair) : "No stair recommended"}</dd></div>
        <div><dt>Floor smoke threshold</dt><dd><SmokeTime minute={exit.atRiskAt} currentMinute={minute} /></dd></div>
        {Object.entries(exit.blockedAt).map(([stair, blocked]) => (
          <div key={stair}><dt>{stairName(stair)} smoke threshold</dt><dd><SmokeTime minute={blocked} currentMinute={minute} /></dd></div>
        ))}
      </dl>
      {exit.flags.length > 0 && <p className="assistance-note">Assistance flags: {exit.flags.join(", ")}</p>}
    </article>
  );
}

export function ExitAnalysis({ state, floor, onSelectFloor, onSelectRoom }: {
  state: IncidentState | null;
  floor: number;
  onSelectFloor: (floor: number) => void;
  onSelectRoom: (roomId: string) => void;
}) {
  const active = useBuilding();
  const origin = state?.origin;
  const exits = [...(state?.exits ?? [])].sort((a, b) => b.floor - a.floor);
  const originFloor = active.roomsById.get(origin?.roomId ?? "")?.floor;
  const estimated = estimatedFloors(state, active);
  // Match the server's risk grouping: origin floor, smoky rooms/hall, or a smoky stair.
  const atRisk = exits.filter((exit) => exit.floor === originFloor || exit.atRiskAt !== null || Object.values(exit.blockedAt).some((value) => value !== null));
  return (
    <section className="panel analysis-panel" aria-labelledby="analysis-heading">
      <PanelHeading label="30-MINUTE FORECAST" title="Origin & evacuation" id="analysis-heading" />
      <div className="origin-summary">
        <span className="eyebrow">SUSPECTED FIRE ORIGIN</span>
        {origin ? (
          <div className="origin-location">
            <button className="text-button" onClick={() => onSelectRoom(origin.roomId)}>{active.roomName(origin.roomId)}</button>
            <span className="confidence">{Math.round(origin.confidence * 100)}% confidence</span>
          </div>
        ) : <p className="subtle">Waiting for a located report.</p>}
      </div>
      {exits.length ? (
        <>
          <div className="forecast-summary">
            <div><strong>{atRisk.length}</strong><span>floors at risk</span></div>
            <div><strong><PeopleCount count={atRisk.reduce((sum, exit) => sum + exit.people, 0)} estimated={atRisk.some((exit) => estimated.has(exit.floor))} unit="" /></strong><span>people on those floors</span></div>
            <div><strong>{exits.filter((exit) => !exit.stair).length}</strong><span>floors without a stair recommendation</span></div>
          </div>
          <p className="panel-note">Predicted smoke threshold times are measured from forecast minute 0. A recommended stair may still become smoky; review its time below.</p>
          <div className="exit-list" aria-label="Per-floor exit forecasts">
            {exits.map((exit) => <FloorForecast key={exit.floor} exit={exit} minute={state?.simMinute ?? 0} selected={exit.floor === floor} estimated={estimated.has(exit.floor)} onSelect={() => onSelectFloor(exit.floor)} />)}
          </div>
        </>
      ) : <Empty title="No exit forecast yet" text="A located report starts the model. Stair recommendations and predicted smoke arrival will appear here." />}
    </section>
  );
}
