// The call queue: every caller report across all incidents, newest first, laid out like the incident
// queue. Clicking a call selects its incident; the calls of the selected incident are highlighted.
import type { Report } from "@firewatch/shared/types";
import { useBuilding } from "./activeBuilding";
import { PinIcon } from "./Icons";
import { KindIcon, sameSelection } from "./IncidentQueue";
import type { CallEntry, IncidentSelection } from "./incidents";
import { Ago, Empty, PanelHeading } from "./ui";

const channels: Record<NonNullable<Report["channel"]>, string> = { voice: "Voice", sms: "SMS", form: "Form", console: "Console" };

function CallRow({ call, selected, onSelect }: { call: CallEntry; selected: boolean; onSelect: () => void }) {
  const { roomName } = useBuilding();
  const { report, incident, label } = call;
  // A building-pipeline report points at a room, and says so when it is not sure which.
  const room = report.incidentId ? null : roomName(report.roomId);
  const uncertain = !report.incidentId && (!report.roomId || report.confidence === undefined || report.confidence < 0.7);
  const place = [label, incident?.formatted ?? incident?.query, room].filter(Boolean).join(" · ");
  const content = (
    <>
      <span className="queue-row-top">
        <KindIcon kind={incident?.kind ?? "fire"} />
        <strong>{report.caller}</strong>
        <span className="queue-elapsed"><Ago value={report.time} /></span>
      </span>
      <span className="call-text">{report.text}</span>
      {report.reply && <span className="call-reply"><span className="eyebrow">Caller was told</span> {report.reply}</span>}
      <span className="queue-place"><PinIcon size={14} />{place}</span>
      <span className="queue-tags">
        {report.channel && <span className="pill">{channels[report.channel]}</span>}
        {incident?.phase === "resolved" && <span className="pill safe">Resolved</span>}
        {uncertain && <span className="pill warn">Location uncertain</span>}
      </span>
    </>
  );
  // A call with nothing to select (its incident is gone) is shown, but is not a button.
  return call.selection
    ? <button className={`queue-row${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}>{content}</button>
    : <div className="queue-row">{content}</div>;
}

export function CallerReports({ calls, selection, onSelect, freshIds }: {
  calls: CallEntry[];
  selection: IncidentSelection | null;
  onSelect: (selection: IncidentSelection) => void;
  freshIds: ReadonlySet<string>;
}) {
  return (
    <section className="panel reports-panel" aria-labelledby="reports-heading">
      <PanelHeading title="Caller reports" id="reports-heading" count={calls.length} />
      {calls.length ? (
        <div className="call-queue" role="log" aria-label="Caller reports, newest first" aria-live="polite" aria-relevant="additions">
          <ul className="queue-list">
            {calls.map((call) => (
              <li key={call.report.id} className={freshIds.has(call.report.id) ? "is-new" : undefined}>
                <CallRow call={call} selected={!!call.selection && sameSelection(selection, call.selection)} onSelect={() => call.selection && onSelect(call.selection)} />
              </li>
            ))}
          </ul>
        </div>
      ) : <Empty title="No caller reports yet" text="Every call and text will appear here, newest first." />}
    </section>
  );
}
