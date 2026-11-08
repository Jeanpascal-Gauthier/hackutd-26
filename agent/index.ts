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
