// Every incident the operator is handling, plus the summary strip above the columns.
import type { ReactNode } from "react";
import type { IncidentState, MapIncident, MapIncidentKind } from "@firewatch/shared/types";
import { AlertIcon, CrashIcon, FlameIcon, PinIcon } from "./Icons";
import { kindOf, kindText, locationIssue, needsAction, ownsBuilding, phaseText, placeOf, severityText, type IncidentQueue as Queue, type IncidentSelection, type QueueEntry } from "./incidents";
import { Ago, Empty, PanelHeading, Timestamp } from "./ui";

export function KindIcon({ kind, size = 18 }: { kind: MapIncidentKind; size?: number }) {
  const Icon = kind === "fire" ? FlameIcon : kind === "crash" ? CrashIcon : AlertIcon;
  return <span className={`queue-icon ${kind}`} aria-hidden="true"><Icon size={size} /></span>;
}

export function SeverityPill({ severity }: { severity: MapIncident["severity"] }) {
  const tone = severity === "critical" ? " danger" : severity === "serious" ? " warn" : "";
  return <span className={`pill${tone}`}>{severityText[severity]}</span>;
}

export function PhasePill({ phase }: { phase: MapIncident["phase"] }) {
  return <span className={`pill${phase === "resolved" ? " safe" : ""}`}>{phaseText[phase]}</span>;
}

export const sameSelection = (a: IncidentSelection | null, b: IncidentSelection) => a?.kind === b.kind && (a.kind !== "map" || b.kind !== "map" || a.id === b.id);

function QueueRow({ entry, selected, needsConfirmation, onSelect }: { entry: QueueEntry; selected: boolean; needsConfirmation: boolean; onSelect: () => void }) {
  let title: string, place: string, tags: ReactNode;
  if (entry.type === "building") {
    title = entry.building.label;
    place = entry.building.place;
    tags = <><span className="pill">{severityText.unknown}</span><span className="pill">{entry.building.dispatched ? phaseText.dispatched : phaseText.open}</span></>;
  } else {
    const { incident } = entry;
    const issue = locationIssue(incident);
    title = incident.label;
    place = placeOf(incident) ?? "No location given";
    tags = <>
      <SeverityPill severity={incident.severity} />
      <PhasePill phase={incident.phase} />
      {issue && <span className={`pill${issue === "Location needed" ? " warn" : ""}`}>{issue}</span>}
    </>;
  }
  return (
    <button className={`queue-row${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <span className="queue-row-top">
        <KindIcon kind={kindOf(entry)} />
        <strong>{title}</strong>
        {entry.time > 0 && <span className="queue-elapsed"><Ago value={entry.time} /></span>}
      </span>
      <span className="queue-place"><PinIcon size={14} />{place}</span>
      <span className="queue-tags">{tags}{needsConfirmation && <span className="pill warn">Confirm building</span>}</span>
      {entry.time > 0 && <span className="queue-started">Reported <Timestamp value={entry.time} /></span>}
    </button>
  );
}

export function IncidentQueue({ queue, state, selection, onSelect }: {
  queue: Queue;
  state: IncidentState | null;
  selection: IncidentSelection | null;
  onSelect: (selection: IncidentSelection) => void;
}) {
  const needsConfirmation = (entry: QueueEntry) => state?.buildingLookup?.status === "needs_confirmation" && (entry.type === "building" || ownsBuilding(entry.incident, state));
  const row = (entry: QueueEntry) => <li key={entry.key}><QueueRow entry={entry} selected={sameSelection(selection, entry.selection)} needsConfirmation={needsConfirmation(entry)} onSelect={() => onSelect(entry.selection)} /></li>;
  const resolvedSelected = queue.resolved.some((entry) => sameSelection(selection, entry.selection));
  return (
    <section className="panel incident-queue" aria-labelledby="queue-heading">
      <PanelHeading title="Incident queue" id="queue-heading" count={queue.active.length} />
      {queue.active.length ? <ul className="queue-list" aria-label="Active incidents, most severe first">{queue.active.map(row)}</ul> : <Empty title="No active incidents" text="New calls and reports will appear here." />}
      {queue.resolved.length > 0 && (
        <details className="queue-resolved" open={resolvedSelected || undefined}>
          <summary>Resolved <span className="count-badge">{queue.resolved.length}</span></summary>
          <ul className="queue-list" aria-label="Resolved incidents">{queue.resolved.map(row)}</ul>
        </details>
      )}
    </section>
  );
}

export function IncidentStrip({ queue, selected, selection }: {
  queue: Queue;
  selected: MapIncident | null;
  selection: IncidentSelection | null;
}) {
  const counts = { fire: 0, crash: 0, other: 0 } as Record<MapIncidentKind, number>;
  for (const entry of queue.active) counts[kindOf(entry)]++;
  const byType = (Object.entries(counts) as [MapIncidentKind, number][]).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kindText[kind].toLowerCase()}`).join(" · ");
  const needing = queue.active.filter(needsAction);
  const noLocation = needing.filter((entry) => entry.type === "map" && entry.incident.status !== "located").length;
  const awaiting = needing.length - noLocation;
  const actionDetail = [noLocation > 0 && `${noLocation} need a location`, awaiting > 0 && `${awaiting} awaiting dispatch`].filter(Boolean).join(" · ");
  return (
    <section className="priority-summary incident-strip" aria-label="Incident summary">
      <div className="priority-stat">
        <span className="priority-label">Active incidents</span>
        <strong className="priority-value">{queue.active.length}</strong>
        <span className="priority-detail">{byType || "None reported"}</span>
      </div>
      <div className={`priority-stat${needing.length ? " needs-stat" : ""}`}>
        <span className="priority-label">Needing action</span>
        <strong className="priority-value">{needing.length}</strong>
        <span className="priority-detail">{needing.length ? actionDetail : "All located and dispatched"}</span>
      </div>
      <div className="priority-stat">
        <span className="priority-label">Selected incident</span>
        {selected ? <>
          <strong className="priority-value strip-headline">{selected.label}<span>{placeOf(selected) ?? locationIssue(selected) ?? "No location given"}</span></strong>
          <span className="priority-detail">{severityText[selected.severity]} · {phaseText[selected.phase]}</span>
        </> : selection?.kind === "building" ? <>
          <strong className="priority-value strip-headline">{queue.building?.label ?? "Building fire"}<span>{queue.building?.place}</span></strong>
          <span className="priority-detail">Building tools below</span>
        </> : <><strong className="priority-value strip-headline">None<span>Select an incident in the queue</span></strong><span className="priority-detail">Waiting for incidents</span></>}
      </div>
    </section>
  );
}
