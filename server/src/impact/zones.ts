// City zones and incident links. The city is cut into ~500 m cells. Incidents of the same kind close
// together are merged by incidents/service.ts (one incident, several calls). Incidents of a
// different kind close together stay separate and are linked: a fire and a crash near one data
// centre are two incidents, but together they are worse (smoke at the intake, the fuel road cut).
import type { GeoPoint, MapIncident } from "@firewatch/shared/types";
import { METRES_PER_DEGREE } from "../buildings/geometry.ts";
import { geoDistance } from "../incidents/geo.ts";

export const ZONE_METERS = 500;

/** The ~500 m cell a point falls in, e.g. "z-6554:-10321". Neighbouring points share an id. */
export function zoneOf(point: GeoPoint): string {
  const row = Math.floor((point.lat * METRES_PER_DEGREE) / ZONE_METERS);
  const col = Math.floor((point.lon * METRES_PER_DEGREE * Math.cos((point.lat * Math.PI) / 180)) / ZONE_METERS);
  return `z${row}:${col}`;
}

const live = (incident: MapIncident) => incident.status === "located" && incident.location !== undefined && incident.phase !== "resolved";

/**
 * For each located, unresolved incident: its zone, and the ids of nearby incidents of another kind.
 * Incidents within ~500 m of each other (through a chain of neighbours) are one zone, named for the
 * cell of the oldest of them, so linked incidents never straddle a cell edge into different zones.
 */
export function linkIncidents(list: MapIncident[]): Map<string, { zoneId: string; related: string[] }> {
  const active = list.filter(live);
  const near = (a: MapIncident, b: MapIncident) => geoDistance(a.location!, b.location!) <= ZONE_METERS;

  const cluster = new Map<string, MapIncident[]>();
  for (const incident of active) {
    const group = [incident];
    for (const [id, members] of cluster) {
      if (members.some((member) => near(member, incident))) {
        group.push(...members);
        cluster.delete(id);
      }
    }
    cluster.set(incident.id, group);
  }

  const out = new Map<string, { zoneId: string; related: string[] }>();
  for (const members of cluster.values()) {
    const oldest = members.reduce((a, b) => (b.time < a.time || (b.time === a.time && b.id < a.id) ? b : a));
    const zoneId = zoneOf(oldest.location!);
    for (const incident of members) {
      const related = members
        .filter((other) => other.id !== incident.id && other.kind !== incident.kind && near(incident, other))
        .sort((a, b) => geoDistance(incident.location!, a.location!) - geoDistance(incident.location!, b.location!))
        .map((other) => other.id);
      out.set(incident.id, { zoneId, related });
    }
  }
  return out;
}
