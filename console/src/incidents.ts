// Pure helpers for the incident queue: what is selected, how entries sort, and who owns the building.
// The building pipeline (SMS, QR form, MOCK=1) has no MapIncident, so the selection is a small union
// rather than a fabricated incident.
import type { IncidentPhase, IncidentSeverity, IncidentState, MapIncident, MapIncidentKind, Report } from "@firewatch/shared/types";
import type { ActiveBuilding } from "./activeBuilding";

export type IncidentSelection = { kind: "map"; id: string } | { kind: "building" };

/** The synthetic queue entry for a building fire no map incident owns. */
export interface BuildingEntry {
  label: string;
  place: string;
  time: number | null;
  dispatched: boolean;
  needsConfirmation: boolean;
}

export type QueueEntry =
  | { type: "map"; key: string; selection: IncidentSelection; incident: MapIncident; severity: IncidentSeverity; time: number }
  | { type: "building"; key: "building"; selection: IncidentSelection; building: BuildingEntry; severity: IncidentSeverity; time: number };

export interface IncidentQueue {
  active: QueueEntry[];
  resolved: QueueEntry[];
  building: BuildingEntry | null;
  /** The map incident that owns the active building, if any. */
  ownerId: string | null;
}

export const kindText: Record<MapIncidentKind, string> = { fire: "Fire", crash: "Crash", other: "Other" };
export const severityText: Record<IncidentSeverity, string> = { critical: "Critical", serious: "Serious", minor: "Minor", unknown: "Severity unknown" };
export const phaseText: Record<IncidentPhase, string> = { open: "Open", dispatched: "Dispatched", on_scene: "On scene", resolved: "Resolved" };
export const lanesText = { all: "All lanes", some: "Some lanes", unknown: "Unknown" } as const;

const severityRank: Record<IncidentSeverity, number> = { critical: 0, serious: 1, unknown: 2, minor: 3 };

export const placeOf = (incident: MapIncident) => incident.formatted ?? incident.query;

/** Null when `status` is `located`; otherwise how the location reads to the operator. */
export function locationIssue(incident: MapIncident): "Locating" | "Location needed" | null {
  if (incident.status === "located") return null;
  return incident.status === "locating" ? "Locating" : "Location needed";
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** True when this incident's address is the one the building lookup ran on. */
export function ownsBuilding(incident: MapIncident, state: IncidentState | null) {
  const lookup = state?.buildingLookup?.query;
  return incident.kind === "fire" && incident.inBuilding === true && !!incident.query && !!lookup && normalize(incident.query) === normalize(lookup);
}

function buildingEntry(state: IncidentState | null, active: ActiveBuilding, owned: boolean): BuildingEntry | null {
  if (!state || owned) return null;
  const orphanReports = state.reports.filter((report) => !report.incidentId);
  const lookup = state.buildingLookup;
  // An unowned lookup still needs the building panel, or its confirmation could never be reached.
  const pendingLookup = lookup !== undefined && lookup.status !== "active";
  if (!state.origin && orphanReports.length === 0 && active.isDemo && !pendingLookup) return null;
  const times = orphanReports.map((report) => report.time);
  if (lookup) times.push(lookup.time);
  const origin = active.roomsById.get(state.origin?.roomId ?? "");
  return {
    label: "Building fire",
    place: active.isDemo ? origin?.name ?? lookup?.query ?? "Building not confirmed" : active.profile.address ?? active.profile.name,
    time: times.length ? Math.min(...times) : null,
    dispatched: (state.dispatches?.length ?? 0) > 0,
    needsConfirmation: lookup?.status === "needs_confirmation",
  };
}

/** Sorted most severe first, then newest first, with resolved entries set apart. */
export function buildQueue(state: IncidentState | null, active: ActiveBuilding): IncidentQueue {
  const incidents = state?.mapIncidents ?? [];
  const owners = incidents.filter((incident) => ownsBuilding(incident, state));
  const owner = owners.find((incident) => incident.phase !== "resolved") ?? owners[0];
  const building = buildingEntry(state, active, owner !== undefined);
  const entries: QueueEntry[] = incidents.map((incident) => ({ type: "map", key: incident.id, selection: { kind: "map", id: incident.id }, incident, severity: incident.severity, time: incident.time }));
  if (building) entries.push({ type: "building", key: "building", selection: { kind: "building" }, building, severity: "unknown", time: building.time ?? 0 });
  entries.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.time - a.time);
  const isResolved = (entry: QueueEntry) => entry.type === "map" && entry.incident.phase === "resolved";
  return { active: entries.filter((entry) => !isResolved(entry)), resolved: entries.filter(isResolved), building, ownerId: owner?.id ?? null };
}

/** One call in the call queue: the report, and the incident it belongs to. */
export interface CallEntry {
  report: Report;
  /** Null for a building report no map incident owns, or when the incident is gone. */
  incident: MapIncident | null;
  /** What clicking the call selects. Null when there is nothing to select. */
  selection: IncidentSelection | null;
  /** "Fire", "Car crash", "Building fire"... */
  label: string;
}

/**
 * Every call, newest first, across all incidents. A building-pipeline report has no incident of its
 * own: it belongs to the building entry, or to the map incident that owns the active building.
 */
export function buildCallQueue(state: IncidentState | null, queue: IncidentQueue): CallEntry[] {
  const incidents = state?.mapIncidents ?? [];
  const owner = incidents.find((incident) => incident.id === queue.ownerId) ?? null;
  return [...(state?.reports ?? [])]
    .sort((a, b) => b.time - a.time)
    .map((report): CallEntry => {
      if (report.incidentId) {
        const incident = incidents.find((item) => item.id === report.incidentId) ?? null;
        return { report, incident, selection: incident ? { kind: "map", id: incident.id } : null, label: incident?.label ?? "Incident" };
      }
      if (queue.building) return { report, incident: null, selection: { kind: "building" }, label: queue.building.label };
      if (owner) return { report, incident: owner, selection: { kind: "map", id: owner.id }, label: owner.label };
      return { report, incident: null, selection: null, label: "Building fire" };
    });
}

/** No usable location yet, or nobody has been sent. */
export function needsAction(entry: QueueEntry) {
  if (entry.type === "building") return !entry.building.dispatched;
  return entry.incident.status !== "located" || entry.incident.phase === "open";
}

export function kindOf(entry: QueueEntry): MapIncidentKind {
  return entry.type === "building" ? "fire" : entry.incident.kind;
}

/** The legacy global slots can mirror a map incident. Keep those out of building-only actions. */
export function buildingDecisions(state: IncidentState | null) {
  const incidents = state?.mapIncidents ?? [];
  const sameRecommendation = (a: IncidentState["recommendation"], b: IncidentState["recommendation"]) =>
    !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
  const pendingIsMap = incidents.some((incident) => sameRecommendation(state?.recommendation, incident.recommendation) || sameRecommendation(state?.recommendation, incident.accepted?.recommendation));
  const acceptedIsMap = incidents.some((incident) => incident.accepted?.time === state?.accepted?.time && sameRecommendation(state?.accepted?.recommendation, incident.accepted?.recommendation));
  return {
    recommendation: pendingIsMap ? undefined : state?.recommendation,
    accepted: acceptedIsMap ? undefined : state?.accepted,
  };
}
