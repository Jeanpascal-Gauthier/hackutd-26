import type { GeoPoint, MapIncident } from "@firewatch/shared/types";
import type { MapIncidentPlus } from "../../../server/src/incidents/stepZero";

export interface MitigationAction {
  id: string;
  label: string;
  owner: string;
  lossReduction: number;
  peopleProtected: number;
  deadlineMinute?: number;
  reason?: string;
  status?: "pending" | "done";
}

export interface RiskBuilding {
  id: string;
  name: string;
  location: GeoPoint;
  outline: GeoPoint[];
  people: number;
  loss: number;
  firstImpactMinute: number;
  chain: { minute: number; title: string; detail: string; preventedBy?: string; interrupted?: boolean }[];
  actions: MitigationAction[];
  reasons?: string[];
  server?: { risk: RiskLevel; remainingLoss: number | null };
}

export interface ForecastScenario {
  id: string;
  source?: "server";
  label?: string;
  buildings: RiskBuilding[];
  floods: { id: string; incidentId: string; steps: { minute: number; water: GeoPoint[] }[] }[];
  roads: { id: string; incidentId: string; road: string; reason: string; minute: number; path: GeoPoint[] }[];
  blasts: { id: string; incidentId: string; center: GeoPoint; radiusMeters: number }[];
  links: { from: string; to: string; reason: string }[];
}

export interface Execution {
  actionId: string;
  buildingId: string;
  time: number;
  forecastMinute: number;
}

export type RiskLevel = "high" | "moderate" | "low";
export const RISK_COLORS: Record<RiskLevel, string> = { high: "#ef6464", moderate: "#e8b04e", low: "#4bbf94" };
export const money = (value: number) => value >= 1000 ? `$${Math.round(value / 1000).toLocaleString("en-US")}K` : `$${Math.round(value).toLocaleString("en-US")}`;

export function buildingImpact(building: RiskBuilding, executions: Execution[]) {
  if (building.server) return { loss: building.server.remainingLoss ?? building.loss, people: building.people };
  const completed = new Set(executions.filter((event) => event.buildingId === building.id).map((event) => event.actionId));
  const actions = building.actions.filter((action) => completed.has(action.id));
  return {
    loss: Math.max(0, building.loss - actions.reduce((sum, action) => sum + action.lossReduction, 0)),
    people: Math.max(0, building.people - actions.reduce((sum, action) => sum + action.peopleProtected, 0)),
  };
}

export function totalImpact(scenario: ForecastScenario, executions: Execution[], minute: number) {
  const exposed = scenario.buildings.filter((building) => building.firstImpactMinute <= minute + 30);
  return exposed.reduce((total, building) => {
    const remaining = buildingImpact(building, executions);
    return { buildings: total.buildings + (remaining.loss > 0 || remaining.people > 0 ? 1 : 0), people: total.people + remaining.people, loss: total.loss + remaining.loss };
  }, { buildings: 0, people: 0, loss: 0 });
}

/** Idempotent: one click produces one audit record and one reduction, including rapid double clicks. */
export function executeMitigation(scenario: ForecastScenario, executions: Execution[], buildingId: string, actionId: string, minute: number, time = Date.now()): Execution[] {
  const building = scenario.buildings.find((item) => item.id === buildingId);
  if (!building?.actions.some((action) => action.id === actionId) || executions.some((event) => event.actionId === actionId)) return executions;
  return [...executions, { actionId, buildingId, time, forecastMinute: minute }];
}

export function readExecutions(scenario: ForecastScenario, raw: string | null): Execution[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    let valid: Execution[] = [];
    for (const value of parsed) {
      if (value && typeof value === "object" && Number.isFinite(value.time) && Number.isFinite(value.forecastMinute)) {
        valid = executeMitigation(scenario, valid, value.buildingId, value.actionId, Math.max(0, Math.min(30, value.forecastMinute)), value.time);
      }
    }
    return valid;
  } catch { return []; }
}

export function buildingRisk(building: RiskBuilding, executions: Execution[], minute: number): RiskLevel {
  if (building.server) {
    const base = building.server.risk;
    if (building.server.remainingLoss === null || building.server.remainingLoss >= building.loss) return base;
    const fraction = building.server.remainingLoss / Math.max(1, building.loss);
    return fraction <= 0.3 ? "low" : fraction <= 0.65 && base === "high" ? "moderate" : base;
  }
  const fraction = buildingImpact(building, executions).loss / Math.max(1, building.loss);
  if (fraction <= 0.3) return "low";
  return minute >= building.firstImpactMinute && fraction > 0.65 ? "high" : "moderate";
}

export function radiusRing(center: GeoPoint, meters: number): GeoPoint[] {
  return Array.from({ length: 48 }, (_, index) => {
    const angle = index / 48 * 2 * Math.PI;
    return { lat: center.lat + Math.cos(angle) * meters / 111_320, lon: center.lon + Math.sin(angle) * meters / (111_320 * Math.cos(center.lat * Math.PI / 180)) };
  });
}

/** Interpolate matching vertices; forecasts with different topology advance at their recorded steps. */
export function interpolateRing(steps: { minute: number; ring: GeoPoint[] }[], minute: number, origin: GeoPoint): GeoPoint[] {
  if (!steps.length) return [];
  const next = steps.find((step) => step.minute >= minute) ?? steps[steps.length - 1]!;
  if (next.minute === 0 || minute >= steps[steps.length - 1]!.minute) return next.ring;
  const previous = [...steps].reverse().find((step) => step.minute < minute);
  const from = previous?.ring ?? next.ring.map(() => origin);
  const fraction = Math.max(0, Math.min(1, (minute - (previous?.minute ?? 0)) / Math.max(1, next.minute - (previous?.minute ?? 0))));
  if (from.length !== next.ring.length) return previous?.ring ?? next.ring;
  return next.ring.map((point, index) => ({ lat: from[index]!.lat + (point.lat - from[index]!.lat) * fraction, lon: from[index]!.lon + (point.lon - from[index]!.lon) * fraction }));
}

export interface SceneShape {
  id: string;
  kind: "polygon" | "line";
  path: GeoPoint[];
  color: string;
  opacity: number;
  weight: number;
  dashed?: boolean;
  title: string;
  buildingId?: string;
  zIndex: number;
}

export interface ForecastScene {
  shapes: SceneShape[];
  /** Stable camera extent: scrubbing and executing actions must never move the map. */
  extent: GeoPoint[];
  scenarioId?: string;
}

export function buildForecastScene(incidents: MapIncident[], minute: number, scenario?: ForecastScenario, executions: Execution[] = [], selectedBuildingId?: string | null): ForecastScene {
  const shapes: SceneShape[] = [];
  const active = incidents.filter((incident) => incident.phase !== "resolved" && incident.status === "located" && incident.location) as MapIncidentPlus[];
  const activeIds = new Set(active.map((incident) => incident.id));
  const add = (shape: SceneShape) => { if (shape.path.length >= (shape.kind === "line" ? 2 : 3)) shapes.push(shape); };
  const links = new Set<string>();
  for (const incident of active) {
    if (incident.flood && incident.location) add({ id: `${incident.id}-flood`, kind: "polygon", path: interpolateRing(incident.flood.steps.map((step) => ({ minute: step.minute, ring: step.water })), minute, incident.location), color: "#409df0", opacity: 0.38, weight: 2, title: `Flood forecast · +${minute} min`, zIndex: 2 });
    for (const [index, road] of (incident.affectedRoads ?? []).entries()) if (road.fromMinute <= minute) {
      add({ id: `${incident.id}-road-${index}`, kind: "line", path: road.path, color: "#ef545c", opacity: 1, weight: 7, title: `${road.road ?? "Road"} · ${road.reason === "flood" ? "Flooded" : road.reason === "closure" ? "Closed" : "Crash queue"}`, zIndex: 6 });
    }
    if (incident.impact) {
      const ring = radiusRing(incident.impact.center, incident.impact.radiusMeters);
      add({ id: `${incident.id}-impact-fill`, kind: "polygon", path: ring, color: "#e8b04e", opacity: 0.06, weight: 0, title: `${incident.label} · ${incident.impact.radiusMeters} m impact radius`, zIndex: 1 });
      add({ id: `${incident.id}-impact`, kind: "line", path: [...ring, ring[0]!], color: "#e8b04e", opacity: 0.9, weight: 2, dashed: true, title: `${incident.label} · ${incident.impact.radiusMeters} m impact radius · ${incident.impact.reasons.join("; ")}`, zIndex: 4 });
    }
    for (const related of incident.related ?? []) {
      const target = active.find((item) => item.id === related);
      const key = [incident.id, related].sort().join("|");
      if (!target?.location || links.has(key)) continue;
      links.add(key);
      add({ id: `linked-${key}`, kind: "line", path: [incident.location!, target.location], color: "#93d6ce", opacity: 0.9, weight: 2, dashed: true, title: `${incident.label} ↔ ${target.label} · linked incidents`, zIndex: 7 });
    }
    if (incident.fire && incident.location) {
      for (const layer of ["smoke", "fire"] as const) {
        add({ id: `${incident.id}-${layer}`, kind: "polygon", path: interpolateRing(incident.fire.steps.map((step) => ({ minute: step.minute, ring: step[layer] })), minute, incident.location), color: layer === "fire" ? "#f57841" : "#a9a5b6", opacity: layer === "fire" ? 0.23 : 0.17, weight: 1, title: `${layer === "fire" ? "Fire" : "Smoke"} forecast · +${minute} min`, zIndex: layer === "fire" ? 3 : 1 });
      }
      if (!scenario) for (const exposure of incident.fire.exposures) {
        const reached = exposure.fireEtaMinutes <= minute || (exposure.smokeEtaMinutes !== null && exposure.smokeEtaMinutes <= minute);
        add({ id: `${incident.id}-${exposure.id}`, kind: "polygon", path: exposure.outline.length ? exposure.outline : radiusRing(exposure.location, 12), color: RISK_COLORS[reached ? exposure.risk : "low"], opacity: 0.6, weight: 2, title: `${exposure.name ?? "Nearby building"} · ${reached ? exposure.risk : "low"} risk`, zIndex: 8 });
      }
    }
    for (const [index, segment] of (incident.affectedRoads?.length ? [] : incident.crash?.segments ?? []).entries()) {
      if (segment.queueMinute <= minute) add({ id: `${incident.id}-queue-${index}`, kind: "line", path: segment.path, color: segment.level === "blocked" ? "#d93648" : "#ef6464", opacity: 0.95, weight: segment.level === "blocked" ? 8 : 6, title: `${segment.road ?? "Road"} · ${segment.level === "blocked" ? "Closed" : "Crash queue"}`, zIndex: 5 });
    }
  }
  if (scenario) {
    for (const flood of scenario.floods) {
      const incident = active.find((item) => item.id === flood.incidentId);
      if (incident?.location) add({ id: flood.id, kind: "polygon", path: interpolateRing(flood.steps.map((step) => ({ minute: step.minute, ring: step.water })), minute, incident.location), color: "#409df0", opacity: 0.38, weight: 2, title: `Flood forecast · +${minute} min`, zIndex: 2 });
    }
    for (const road of scenario.roads) if (activeIds.has(road.incidentId) && road.minute <= minute) {
      add({ id: road.id, kind: "line", path: road.path, color: "#ef545c", opacity: 1, weight: 7, title: `${road.road} · ${road.reason}`, zIndex: 6 });
    }
    for (const blast of scenario.blasts) if (activeIds.has(blast.incidentId)) {
      const ring = radiusRing(blast.center, blast.radiusMeters);
      add({ id: `${blast.id}-fill`, kind: "polygon", path: ring, color: "#e8b04e", opacity: 0.08, weight: 0, title: `${blast.radiusMeters} m blast radius`, zIndex: 2 });
      add({ id: blast.id, kind: "line", path: [...ring, ring[0]!], color: "#e8b04e", opacity: 0.9, weight: 2, dashed: true, title: `${blast.radiusMeters} m blast radius`, zIndex: 4 });
    }
    for (const link of scenario.links) {
      const from = active.find((item) => item.id === link.from)?.location;
      const to = active.find((item) => item.id === link.to)?.location;
      if (from && to) add({ id: `link-${link.from}-${link.to}`, kind: "line", path: [from, to], color: "#93d6ce", opacity: 0.9, weight: 2, dashed: true, title: link.reason, zIndex: 7 });
    }
    for (const building of scenario.buildings) {
      const selected = selectedBuildingId === building.id;
      const risk = buildingRisk(building, executions, minute);
      add({ id: building.id, kind: "polygon", path: building.outline, color: RISK_COLORS[risk], opacity: selected ? 0.85 : 0.6, weight: selected ? 4 : 2, title: `${building.name} · ${risk} risk · ${money(buildingImpact(building, executions).loss)} at risk`, buildingId: building.id, zIndex: selected ? 10 : 8 });
    }
  }
  const extent = scenario ? [
    ...scenario.buildings.flatMap((building) => building.outline),
    ...scenario.floods.flatMap((flood) => flood.steps.at(-1)?.water ?? []),
    ...scenario.roads.flatMap((road) => road.path),
    ...scenario.blasts.flatMap((blast) => radiusRing(blast.center, blast.radiusMeters)),
    ...active.flatMap((incident) => incident.crash?.segments.flatMap((segment) => segment.path) ?? []),
    ...active.flatMap((incident) => incident.affectedRoads?.flatMap((road) => road.path) ?? []),
    ...active.flatMap((incident) => incident.flood?.steps.at(-1)?.water ?? []),
    ...active.flatMap((incident) => incident.impact ? radiusRing(incident.impact.center, incident.impact.radiusMeters) : []),
  ] : [];
  return { shapes, extent, scenarioId: scenario?.id };
}
