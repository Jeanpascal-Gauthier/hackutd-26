// The contract every agent tool follows. Each tool lives in its own file in this folder and
// exports one AgentTool; agent.ts lists them. Types only.
import type OpenAI from "openai";
import type { Building, BuildingLookup, FloorExit, IncidentState, Occupant, Recommendation } from "@firewatch/shared/types";
import type { LocateResult } from "./locateRoom.ts";

// ---- The server's HTTP API (server/API.md), as the tools see it ----

/** POST /forecast -> summary. */
export interface ForecastSummary {
  /** Floors where people are or will be in danger (fire floor, smoky rooms, or a stair fills). */
  floorsAtRisk: number[];
  peopleAtRisk: number;
  /** Stairwell id -> floor -> first minute that stairwell fills with smoke there (only floors where it does). */
  stairBlocked: Record<string, Record<string, number>>;
  /** Rooms with fire >= 0.3 at the end of the forecast. */
  roomsBurningAtEnd: string[];
}

/** POST /forecast response (without `ok`). A what-if run: it never changes the incident. */
export interface Forecast {
  origin: string;
  minutes: number;
  summary: ForecastSummary;
  /** One entry per occupied floor, over the whole forecast. */
  exits: FloorExit[];
  /** The server's rule-based draft (server/src/live/recommend.ts). */
  recommendation: Recommendation;
}

/** GET /building response: the ACTIVE incident building (the demo one unless an address was confirmed). */
export interface BuildingInfo {
  /** Has `profile` (name, address, use, floors, time zone) except on older servers' demo building. */
  building: Building;
  occupants: Occupant[];
  /** Room id -> sprinkler status. */
  sprinklers: Record<string, "active" | "impaired" | "none">;
}

/** How tools reach the server. agent/core/server.ts calls it over HTTP; tests pass a fake. */
export interface ServerApi {
  /** GET /state: the incident so far. Its `reports` do NOT include the report being processed now. */
  getState(): Promise<IncidentState>;
  getBuilding(): Promise<BuildingInfo>;
  /** POST /forecast. Throws on an unknown origin or a server error. */
  forecast(origin: string, minutes?: number): Promise<Forecast>;
  /**
   * POST /incident/address: start looking up the building at an address (returns at once; the
   * operator confirms an outline on the console). The server ignores a repeat of the current query.
   */
  lookupAddress(address: string, caller?: string): Promise<BuildingLookup>;
}

// ---- What a tool gets when it runs ----

/** Data passed in by whoever runs the agent. */
export interface AgentContext {
  /**
   * The building the tools use. processReport() replaces it per report with the server's active
   * building (GET /building); this one is the fallback when the server can't be reached.
   */
  building: Building;
  server: ServerApi;
  /** The chat model. Tests pass a fake; by default the NVIDIA client (agent/core/nvidia.ts). */
  llm?: OpenAI;
}

/** The likely fire origin, from merge_reports. */
export interface MergedOrigin {
  roomId: string;
  roomName: string;
  confidence: number; // 0..1
}

/**
 * Scratchpad for one processReport() call. Each tool writes its result here and later tools
 * read it, so big data (the forecast) never has to pass through the model.
 */
export interface RunState {
  /** The report being processed now. Not in the server's state yet. roomId/confidence set by locate_room. */
  report: { id: string; text: string; caller: string; time: number; roomId?: string; confidence?: number };
  /** Set by locate_room. */
  located?: LocateResult;
  /** Set by merge_reports. */
  origin?: MergedOrigin;
  /** Set by run_spread: the forecast from `origin`. */
  forecast?: Forecast;
  /** Set by find_clear_exits: the exit plan per occupied floor. */
  exits?: FloorExit[];
  /** Set by write_recommendation, only once it passes its checks. */
  recommendation?: Recommendation;
  /** The server's address lookup when this report came in (GET /state), if any. */
  currentLookup?: BuildingLookup;
  /** Set by find_building when it started a lookup: this report waits for the operator to confirm. */
  lookup?: BuildingLookup;
}

export interface ToolEnv {
  ctx: AgentContext;
  /** Everything the caller actually said this conversation (plus "floor N" if known). */
  heard: string;
  run: RunState;
}

export interface AgentTool {
  /** OpenAI-format function schema sent to Nemotron. Its name is the tool's name. */
  schema: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  /**
   * Runs one call. `args` is the model's JSON arguments, unchecked: validate them.
   * Return a small JSON-able object: it is sent back to the model and shown in the console's
   * agent trail. Return `{ error: "..." }` instead of throwing for problems the model can fix.
   */
  run(args: Record<string, unknown>, env: ToolEnv): unknown | Promise<unknown>;
}
