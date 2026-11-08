// Public entry point for @firewatch/agent.
export { ingest } from "./core/ingest.ts";
export {
  processReport,
  resetConversations,
  defaultContext,
  loadActiveBuilding,
  systemPrompt,
  type ActiveBuilding,
  type AgentContext,
  type AgentInput,
  type AgentResult,
} from "./core/agent.ts";
// The server calls this in-process when it activates a building (agent trail step estimate_occupancy).
export { estimateOccupancy, type OccupancyEstimate } from "./core/occupancy.ts";
export { FIND_BUILDING_REPLY } from "./core/tools/findBuilding.ts";
// CBRE "Invisible Network": which portfolio buildings an emergency hits, what fails, the $ at risk, what to do.
export {
  assessIncident,
  assessIncidentRules,
  summarize,
  formatUsd,
  headlineFor,
  type AssessContext,
  type RulesOptions,
} from "./core/impact/assess.ts";
export { fromMapIncident, fromMapIncidents, type MapIncidentInput } from "./core/impact/fromMapIncident.ts";
export { classifyBlastRadius } from "./core/impact/blastRadius.ts";
export { assessPropertyImpact } from "./core/impact/propertyImpact.ts";
export { planActions, applyActions } from "./core/impact/planActions.ts";
export { estimateCost, residualCost } from "./core/impact/cost.ts";
export type * from "./core/impact/types.ts";
