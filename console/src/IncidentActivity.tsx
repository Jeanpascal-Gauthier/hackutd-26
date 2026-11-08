import type { IncidentState, LogEntry } from "@firewatch/shared/types";
import { Empty, PanelHeading, Timestamp } from "./ui";
import { CheckIcon } from "./Icons";
import { useBuilding } from "./activeBuilding";

/** A dispatch to a room (building pipeline) or a free-text unit (map incident). */
export interface DispatchRecord { time: number; roomId?: string; unit?: string }

export function IncidentDecisions({ accepted, dispatches, onSelectRoom }: {
  accepted?: IncidentState["accepted"];
  dispatches: readonly DispatchRecord[];
  onSelectRoom?: (roomId: string) => void;
}) {
  const { roomName } = useBuilding();
  return (
    <section className="panel decisions-panel" aria-labelledby="decisions-heading">
      <PanelHeading label="SHARED DECISIONS" title="Accepted & dispatched" id="decisions-heading" />
      {accepted ? (
        <div className="accepted-decision fade-in" key={accepted.time}>
          <div className="decision-meta">
            <span className="pill safe"><CheckIcon size={13} />Accepted on server</span>
            <Timestamp value={accepted.time} />
          </div>
          <h3>Last accepted recommendation</h3>
          <ol className="action-list">
            {accepted.recommendation.actions.map((action, index) => <li key={index}>{action}</li>)}
          </ol>
          {accepted.recommendation.callerReply && (
            <div className="caller-reply">
              <span className="eyebrow">ACCEPTED CALLER REPLY</span>
              <p>{accepted.recommendation.callerReply}</p>
            </div>
          )}
          <p className="subtle">Acceptance is shared across clients. The server does not identify who approved it.</p>
        </div>
      ) : <Empty title="No accepted decision yet" text="Accepted recommendations remain visible here after leaving the pending panel." />}
      <div className="dispatch-heading"><h3>Dispatch history</h3><span className="count-badge">{dispatches.length}</span></div>
      {dispatches.length ? (
        <ol className="dispatch-list" aria-label="Server dispatch history, newest first">
          {[...dispatches].reverse().map((dispatch, index) => (
            <li key={`${dispatch.time}-${index}`}>
              <div>
                <span className="eyebrow">DISPATCH RECORDED</span>
                {dispatch.roomId ? onSelectRoom ? <button className="text-button" onClick={() => onSelectRoom(dispatch.roomId!)}>{roomName(dispatch.roomId)}</button> : <span>{roomName(dispatch.roomId)}</span> : <span>{dispatch.unit ?? "Unit not named"}</span>}
              </div>
              <Timestamp value={dispatch.time} />
            </li>
          ))}
        </ol>
      ) : <p className="panel-note">No dispatches recorded for this incident.</p>}
      <p className="panel-note">Dispatch records show destinations and times; crew travel status is not supplied.</p>
    </section>
  );
}

const kinds: Record<LogEntry["kind"], string> = {
  report: "Report", origin: "Origin", recommendation: "Recommendation", accepted: "Accepted", dispatch: "Dispatch", building: "Building",
};

export function IncidentLog({ entries = [], freshIds }: { entries?: readonly LogEntry[]; freshIds?: ReadonlySet<string> }) {
  const visibleEntries = entries.filter((entry) => entry.kind !== "building" || !/^(Estimated \d+ people inside at |Occupancy estimate unavailable:)/.test(entry.text));
  return (
    <section className="panel" aria-labelledby="log-heading">
      <PanelHeading label="SHARED HISTORY" title="Incident log" id="log-heading" count={visibleEntries.length} />
      <p className="log-caption">Server history, newest first. Includes activity from other clients.</p>
      {visibleEntries.length ? (
        <ol className="incident-log" aria-label="Shared incident log, newest first">
          {[...visibleEntries].reverse().map((entry, index) => (
            <li key={`${entry.time}-${entry.kind}-${index}`} className={freshIds?.has(`${entry.time}-${entry.kind}-${entry.text}`) ? "is-new" : undefined}>
              <span className={`log-dot ${entry.kind}`} />
              <div><span className="log-kind">{kinds[entry.kind] ?? entry.kind}</span><p>{entry.text}</p><Timestamp value={entry.time} /></div>
            </li>
          ))}
        </ol>
      ) : <Empty title="No shared activity yet" text="Reports, decisions, and dispatches will appear when the server records them." />}
    </section>
  );
}
