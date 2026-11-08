import type { FloorExit, IncidentState } from "@firewatch/shared/types";
import { estimatedFloors, useBuilding, type ActiveBuilding } from "./activeBuilding";
import { CheckIcon, FlameIcon, StairsIcon, UsersIcon } from "./Icons";
import { Empty, PeopleCount, Timestamp } from "./ui";

const stairName = (id: string) => `Stair ${id.replace(/^stair-/, "").toUpperCase()}`;

export function riskFloors(state: IncidentState | null, active: ActiveBuilding): FloorExit[] {
  const originFloor = active.roomsById.get(state?.origin?.roomId ?? "")?.floor;
  return (state?.exits ?? []).filter((exit) =>
    exit.floor === originFloor || exit.atRiskAt !== null || Object.values(exit.blockedAt).some((minute) => minute !== null),
  ).sort((a, b) => a.floor - b.floor);
}

export function IncidentSummary({ state, onLocate }: {
  state: IncidentState | null;
  onLocate: (roomId: string) => void;
}) {
  const active = useBuilding();
  const origin = state?.origin;
  const room = active.roomsById.get(origin?.roomId ?? "");
  const exits = state?.exits ?? [];
  const atRisk = riskFloors(state, active);
  const estimated = estimatedFloors(state, active);
  const first = exits.flatMap((exit) => Object.entries(exit.blockedAt)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([stair, minute]) => ({ stair, minute, floor: exit.floor })))
    .sort((a, b) => a.minute - b.minute || a.floor - b.floor)[0];

  return (
    <section className="priority-summary" aria-label="Critical incident information">
      <div className={`priority-stat ${origin ? "origin-stat" : ""}`}>
        <span className="priority-label"><FlameIcon size={18} />Suspected fire origin</span>
        {room && origin ? (
          <>
            <button className="origin-link" onClick={() => onLocate(room.id)}>Floor {room.floor}<span>{room.name.replace(/^Floor \d+ /, "")}</span></button>
            <span className="priority-detail">{Math.round(origin.confidence * 100)}% location confidence</span>
          </>
        ) : <><strong className="priority-value">Not located</strong><span className="priority-detail">{state ? "Waiting for a located report" : "Waiting for server data"}</span></>}
      </div>
      <div className={`priority-stat ${atRisk.length ? "people-stat" : ""}`}>
        <span className="priority-label"><UsersIcon size={18} />People at risk</span>
        <strong className="priority-value">{exits.length ? <PeopleCount count={atRisk.reduce((sum, exit) => sum + exit.people, 0)} estimated={atRisk.some((exit) => estimated.has(exit.floor))} unit="" /> : "—"}<span>{exits.length ? `across ${atRisk.length} floor${atRisk.length === 1 ? "" : "s"}` : "Forecast pending"}</span></strong>
        <span className="priority-detail">{atRisk.some((exit) => estimated.has(exit.floor)) ? "Occupancy estimated · over the 30-minute forecast" : "Estimated over the 30-minute forecast"}</span>
      </div>
      <div className={`priority-stat ${first ? "exit-stat" : ""}`}>
        <span className="priority-label"><StairsIcon size={18} />Stair smoke forecast</span>
        <strong className="priority-value">{first ? stairName(first.stair) : "—"}<span>{first ? `Floor ${first.floor} · +${first.minute} min` : exits.length ? "No threshold reached in forecast" : "Forecast pending"}</span></strong>
        <span className="priority-detail">{first ? state && first.minute <= state.simMinute ? "Smoke threshold reached at this forecast view" : "Time measured from forecast minute 0" : "Over the 30-minute forecast"}</span>
      </div>
    </section>
  );
}

export function PriorityActions({ state, connected, onAccept }: {
  state: IncidentState | null;
  connected: boolean;
  onAccept: () => void;
}) {
  const pending = state?.recommendation;
  const accepted = state?.accepted;
  const recommendation = pending ?? accepted?.recommendation;
  return (
    <section className={`panel priority-actions ${pending ? "needs-decision" : ""}`} aria-labelledby="actions-heading">
      <div className="panel-heading">
        <h2 id="actions-heading">Next actions</h2>
        {pending ? <span className="pill warn">Needs decision</span> : accepted ? <span className="pill safe"><CheckIcon size={14} />Accepted on server</span> : null}
      </div>
      {recommendation ? (
        <div className="priority-actions-body">
          {!pending && accepted && <p className="accepted-at">Last accepted decision · <Timestamp value={accepted.time} /></p>}
          <ol className="action-list priority-action-list">
            {recommendation.actions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}
          </ol>
          {recommendation.callerReply && (
            <details className="caller-guidance" open={Boolean(pending)} key={pending ? "pending-reply" : "accepted-reply"}>
              <summary>Reply for the caller</summary>
              <p>{recommendation.callerReply}</p>
            </details>
          )}
          {pending ? (
            <>
              <button className="button primary full-width accept-button" disabled={!connected} onClick={onAccept}><CheckIcon size={18} />Accept recommendation</button>
              <p className="action-footnote">Commander backup control. Dispatch and caller replies are separate.</p>
              {accepted && <p className="previous-decision">Previous accepted decision: <Timestamp value={accepted.time} /> · See activity below.</p>}
            </>
          ) : <p className="action-footnote">Acceptance source is not recorded. New recommendations will appear here.</p>}
        </div>
      ) : <Empty title="No action recommendation yet" text="Located reports will produce suggested actions for review." />}
    </section>
  );
}

export function EvacuationPriorities({ state, floor, onFloor }: {
  state: IncidentState | null;
  floor: number;
  onFloor: (floor: number) => void;
}) {
  const active = useBuilding();
  const rows = riskFloors(state, active);
  const originFloor = active.roomsById.get(state?.origin?.roomId ?? "")?.floor;
  const estimated = estimatedFloors(state, active);
  return (
    <section className="panel evacuation-priorities" aria-labelledby="evacuation-heading">
      <div className="panel-heading"><h2 id="evacuation-heading">Evacuation priorities</h2><span className="count-badge">{state?.exits?.length ? `${rows.length} floors` : "Pending"}</span></div>
      {rows.length ? (
        <>
          <p className="evacuation-caption">Model recommendations · select a floor to inspect</p>
          <div className="priority-table-scroll">
            <table className="priority-table">
              <thead><tr><th scope="col">Floor</th><th scope="col">People</th><th scope="col">Recommended stair</th></tr></thead>
              <tbody>{rows.map((exit) => (
                <tr key={exit.floor} className={exit.floor === floor ? "selected-priority" : ""}>
                  <th scope="row"><button aria-label={`Inspect floor ${exit.floor}`} aria-pressed={exit.floor === floor} onClick={() => onFloor(exit.floor)}>{exit.floor}{exit.floor === originFloor && <span className="origin-label">Origin</span>}</button></th>
                  <td><PeopleCount count={exit.people} estimated={estimated.has(exit.floor)} unit="" />{exit.flags.length > 0 && <span className="assistance-label" title={exit.flags.join(", ")}>Assistance needed<span className="sr-only">: {exit.flags.join(", ")}</span></span>}</td>
                  <td><span className={exit.stair ? "recommended-stair" : "missing-stair"}>{exit.stair ? stairName(exit.stair) : "None recommended"}</span>{exit.stair && exit.blockedAt[exit.stair] != null && <span className="missing-stair stair-timing">Smoke at +{exit.blockedAt[exit.stair]} min</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="action-footnote table-footnote">Full smoke-arrival times and assistance flags are in detailed forecasts below.</p>
        </>
      ) : <Empty title={state?.exits?.length ? "No floors flagged in forecast" : "Waiting for exit analysis"} text="Evacuation priorities will appear when the model has a located report." />}
    </section>
  );
}
