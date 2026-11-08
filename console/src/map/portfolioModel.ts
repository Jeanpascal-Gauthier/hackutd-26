// Reuse the backend contract and its pure cost calculation. No agent client or server runtime is bundled.
import type { MapIncident } from "@firewatch/shared/types";
import type { PortfolioBuilding, PortfolioImpact, MapIncidentPlus } from "../../../server/src/incidents/stepZero";
import { residualCost, withoutPrevented } from "../../../agent/core/impact/cost";
import { radiusRing, type ForecastScenario } from "./forecastModel";

export type { PortfolioBuilding, PortfolioImpact, MapIncidentPlus };

/** Adapt published analysis to the map without inventing occupancy, savings, or failure chains. */
export function portfolioScenario(impact: PortfolioImpact | undefined, incidents: MapIncident[], portfolio: PortfolioBuilding[]): ForecastScenario | undefined {
  if (!impact?.affectedProperties.length) return undefined;
  const buildingsById = new Map(portfolio.map((building) => [building.id, building]));
  const done = new Set(impact.done);
  return {
    id: "server-portfolio", source: "server", label: "Portfolio impact · server analysis",
    buildings: impact.affectedProperties.map((property) => {
      const building = buildingsById.get(property.id);
      const systems = new Map(building?.systems.map((system) => [system.id, system.label]) ?? []);
      const actions = property.actions.map((action) => ({ ...action, status: done.has(action.id) ? "done" as const : action.status }));
      const remaining = new Set(withoutPrevented(property.chain, actions.filter((action) => action.status === "done").flatMap((action) => action.prevents)).map((step) => step.id));
      const outline = incidents.flatMap((incident) => incident.fire?.exposures ?? []).find((exposure) => exposure.id === property.id && exposure.outline.length >= 3)?.outline;
      return {
        id: property.id, name: property.name, location: property.location,
        // Portfolio records give points, not surveyed footprints. The UI identifies these markers.
        outline: outline ?? radiusRing(property.location, 20), people: property.people,
        loss: property.cost.totalUsd, firstImpactMinute: property.chain[0]?.minute ?? 0,
        server: { risk: property.risk, remainingLoss: building ? residualCost(building, property.chain, actions).totalUsd : null },
        reasons: property.reasons,
        chain: property.chain.map((step) => {
          const cause = property.chain.find((other) => other.id === step.causedBy);
          return { minute: step.minute, title: step.label, detail: `${systems.get(step.systemId) ?? step.systemId} · ${step.hazard}${cause ? ` · Follows: ${cause.label}` : ""}`, interrupted: !remaining.has(step.id) };
        }),
        actions: actions.map((action) => ({ id: action.id, label: action.text, owner: "Facilities team", lossReduction: action.savesUsd, peopleProtected: 0, deadlineMinute: action.deadlineMinute, reason: action.reason, status: action.status })),
      };
    }),
    // These layers come directly from MapIncidentPlus in buildForecastScene.
    floods: [], roads: [], blasts: [], links: [],
  };
}

export function liveMapLayers(incidents: MapIncident[]) {
  const active = (incidents as MapIncidentPlus[]).filter((incident) => incident.phase !== "resolved");
  return {
    flood: active.some((incident) => !!incident.flood),
    impact: active.some((incident) => !!incident.impact),
    links: active.some((incident) => !!incident.related?.length),
    forecast: active.some((incident) => incident.fire || incident.crash || incident.flood),
  };
}
