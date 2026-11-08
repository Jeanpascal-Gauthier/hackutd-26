// The server's MapIncident (plus the planned Step 0 fields, when present) -> the lean AgentIncident
// the impact tools read.
import type { MapIncident } from "@firewatch/shared/types";
import type { AffectedRoad, AgentIncident, FloodForecast, IncidentKind } from "./types.ts";

/**
 * A MapIncident as the server sends it today, or with the Step 0 fields once they land. `kind` is
 * widened to IncidentKind ("flood") since MapIncidentKind does not have it yet.
 */
export type MapIncidentInput = Omit<MapIncident, "kind"> & {
  kind: IncidentKind;
} & Partial<{ flood: FloodForecast; affectedRoads: AffectedRoad[]; related: string[]; zoneId: string; source: string }>;

const isPoint = (p: unknown): p is { lat: number; lon: number } =>
  typeof p === "object" && p !== null && Number.isFinite((p as { lat: unknown }).lat) && Number.isFinite((p as { lon: unknown }).lon);

/** Red road sections from a crash forecast: blocked and heavy segments, red from their queueMinute. */
export function crashRoads(m: Pick<MapIncident, "crash">): AffectedRoad[] {
  return (m.crash?.segments ?? [])
    .filter((s) => s.level === "blocked" || s.level === "heavy")
    .map((s) => ({ path: s.path, road: s.road, reason: "crash" as const, fromMinute: s.queueMinute }));
}

/** Null when the incident has no location yet (still geocoding, or none was given). */
export function fromMapIncident(m: MapIncidentInput): AgentIncident | null {
  if (!m || typeof m.id !== "string" || !isPoint(m.location)) return null;
  const text = m.reports?.find((r) => r.text?.trim())?.text.trim();
  const affectedRoads = m.affectedRoads ?? (m.crash ? crashRoads(m) : undefined);
  const out: AgentIncident = {
    id: m.id,
    kind: m.kind,
    severity: m.severity ?? "unknown",
    location: { lat: m.location.lat, lon: m.location.lon },
    description: text ? `${m.label}: ${text}` : m.label,
    calls: m.reports?.length ?? 0,
    time: m.time,
  };
  if (m.inBuilding !== undefined) out.inBuilding = m.inBuilding;
  if (m.lanesBlocked !== undefined) out.lanesBlocked = m.lanesBlocked;
  if (m.kind === "flood") out.source = m.source ?? m.label;
  else if (m.source) out.source = m.source;
  if (m.fire) {
    out.fire = m.fire;
    out.wind = m.fire.wind;
  }
  if (m.crash) out.crash = m.crash;
  if (m.flood) out.flood = m.flood;
  if (affectedRoads) out.affectedRoads = affectedRoads;
  if (m.related) out.related = m.related;
  if (m.zoneId) out.zoneId = m.zoneId;
  return out;
}

/** Every located incident, in order. */
export function fromMapIncidents(list: MapIncidentInput[]): AgentIncident[] {
  return (list ?? []).map(fromMapIncident).filter((i): i is AgentIncident => i !== null);
}
