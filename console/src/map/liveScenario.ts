// The server's portfolio impact, as the map panel draws it. The server (server/src/portfolio) puts
// `portfolioImpact` on the state and, on each map incident, `flood`, `impact` (blast radius),
// `affectedRoads` and `related`. Those fields are not in shared/types.ts yet, so their shapes are
// written out here. Everything is optional: a server without the portfolio sends none of it, and
// the map falls back to pins and the fire and crash forecasts.
import type { GeoPoint, IncidentState, MapIncident } from "@firewatch/shared/types";
import type { Execution, ForecastScenario, MitigationAction, RiskBuilding, RiskLevel } from "./forecastModel";

export interface ServerStep { id: string; minute: number; systemId: string; label: string; hazard: "fire" | "smoke" | "water" | "access" | "power" | "heat"; causedBy: string | null; incidentId: string }
export interface ServerAction { id: string; text: string; deadlineMinute: number; prevents: string[]; savesUsd: number; reason: string; status: "pending" | "done" }
export interface ServerProperty {
  id: string; name: string; use: string; location: GeoPoint; risk: RiskLevel; incidentIds: string[];
  chain: ServerStep[]; people: number; downtimeHours: number; cost: { totalUsd: number }; accessCut: boolean; actions: ServerAction[]; reasons: string[];
}
export interface ServerSummary { buildings: number; people: number; usdAtRisk: number; usdAtRiskAfterActions: number; horizonMinutes: number; headline: string }
export interface ServerPortfolioImpact { summary: ServerSummary; affectedProperties: ServerProperty[]; briefing: string; mode: "llm" | "rules"; done: string[]; updated: number }

export type LiveIncident = MapIncident & {
  flood?: { steps: { minute: number; water: GeoPoint[] }[]; summary?: string };
  impact?: { center: GeoPoint; radiusMeters: number; reasons: string[] };
  affectedRoads?: { path: GeoPoint[]; road: string | null; reason: string; fromMinute: number }[];
  related?: string[];
};
export type LiveState = Omit<IncidentState, "mapIncidents"> & { mapIncidents?: LiveIncident[]; portfolioImpact?: ServerPortfolioImpact };

/** What the map panel needs besides the scenario: the server's own totals, and Execute / Undo. */
export interface LiveImpact {
  scenario: ForecastScenario;
  summary: ServerSummary | null;
  briefing: string | null;
  mode: "llm" | "rules" | null;
  /** Epoch ms the server last recomputed. */
  updated: number | null;
}

const HAZARD: Record<ServerStep["hazard"], string> = { fire: "Fire", smoke: "Smoke", water: "Flood water", access: "Access cut off", power: "Power loss", heat: "Overheating" };
const FOOTPRINT_METERS = 22;
const MAX_CHAIN_TEXT = 140;

const footprint = (center: GeoPoint): GeoPoint[] =>
  [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([north, east]) => ({
    lat: center.lat + (north! * FOOTPRINT_METERS) / 111_320,
    lon: center.lon + (east! * FOOTPRINT_METERS) / (111_320 * Math.cos((center.lat * Math.PI) / 180)),
  }));

function toBuilding(property: ServerProperty, labels: Map<string, string>): RiskBuilding {
  const steps = new Map(property.chain.map((step) => [step.id, step]));
  const chain = property.chain.map((step) => {
    const cause = step.causedBy ? steps.get(step.causedBy) : undefined;
    // Several actions can stop one step: show it as stopped once any of them is done.
    const stoppers = property.actions.filter((action) => action.prevents.includes(step.id));
    const stopper = stoppers.find((action) => action.status === "done") ?? stoppers[0];
    const detail = cause ? `Follows from: ${cause.label.toLowerCase()}.` : `${HAZARD[step.hazard]} from ${labels.get(step.incidentId) ?? "the incident"}.`;
    return { minute: step.minute, title: step.label, detail: detail.slice(0, MAX_CHAIN_TEXT), ...(stopper && { preventedBy: stopper.id }) };
  });
  const actions: MitigationAction[] = property.actions.map((action) => ({
    id: action.id,
    label: action.text,
    owner: action.deadlineMinute <= 0 ? "Do now" : `Before +${action.deadlineMinute} min`,
    lossReduction: action.savesUsd,
    peopleProtected: 0,
    done: action.status === "done",
    reason: action.reason,
  }));
  return {
    id: property.id, name: property.name, location: property.location, outline: footprint(property.location),
    people: property.people, loss: property.cost.totalUsd, firstImpactMinute: property.chain.reduce((first, step) => Math.min(first, step.minute), 30),
    chain, actions, baseRisk: property.risk,
  };
}

/** The executions the server has already run, so the panel's loss and risk math counts them. */
export function serverExecutions(scenario: ForecastScenario, time = Date.now()): Execution[] {
  return scenario.buildings.flatMap((building) => building.actions.filter((action) => action.done).map((action) => ({ actionId: action.id, buildingId: building.id, time, forecastMinute: 0 })));
}

/** Null when the server sent nothing about portfolio impact, a flood, a blast radius or a red road. */
export function liveScenario(state: IncidentState | null): LiveImpact | null {
  const live = state as unknown as LiveState | null;
  const incidents = (live?.mapIncidents ?? []).filter((incident) => incident.status === "located" && incident.location && incident.phase !== "resolved");
  const portfolio = live?.portfolioImpact;
  const hasLayers = incidents.some((incident) => incident.flood || incident.impact || incident.affectedRoads?.some((road) => road.reason !== "crash"));
  if (!portfolio && !hasLayers) return null;

  const labels = new Map(incidents.map((incident) => [incident.id, incident.label]));
  const links: ForecastScenario["links"] = [];
  const seen = new Set<string>();
  for (const incident of incidents) for (const other of incident.related ?? []) {
    const key = [incident.id, other].sort().join("|");
    const partner = incidents.find((item) => item.id === other);
    if (seen.has(key) || !partner) continue;
    seen.add(key);
    links.push({ from: incident.id, to: other, reason: `${incident.label} and ${partner.label} are close together: linked, not merged` });
  }

  const scenario: ForecastScenario = {
    // The id changes when the set of incidents does, so the map refits once for a new arrival.
    id: `live:${incidents.map((incident) => incident.id).sort().join(",")}`,
    buildings: (portfolio?.affectedProperties ?? []).map((property) => toBuilding(property, labels)),
    floods: incidents.filter((incident) => incident.flood?.steps.length).map((incident) => ({ id: `${incident.id}-flood`, incidentId: incident.id, steps: incident.flood!.steps })),
    // Crash queues are drawn from the crash forecast itself; these are the other red roads.
    roads: incidents.flatMap((incident) => (incident.affectedRoads ?? []).filter((road) => road.reason !== "crash").map((road, index) => ({
      id: `${incident.id}-road-${index}`, incidentId: incident.id, road: road.road ?? "Unnamed road",
      reason: road.reason === "flood" ? "Flooded · impassable" : "Closed", minute: road.fromMinute, path: road.path,
    }))),
    blasts: incidents.filter((incident) => incident.impact).map((incident) => ({
      id: `${incident.id}-blast`, incidentId: incident.id, center: incident.impact!.center, radiusMeters: Math.round(incident.impact!.radiusMeters), reasons: incident.impact!.reasons,
    })),
    links,
  };
  return { scenario, summary: portfolio?.summary ?? null, briefing: portfolio?.briefing ?? null, mode: portfolio?.mode ?? null, updated: portfolio?.updated ?? null };
}
