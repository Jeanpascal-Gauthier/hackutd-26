// The contract every agent tool follows. Each tool lives in its own file in this folder and
// exports one AgentTool; agent.ts lists them. Types only.
import type OpenAI from "openai";
import type { Building, FloorExit, IncidentState, Occupant, Recommendation } from "@firewatch/shared/types";
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

/** GET /building response. */
export interface BuildingInfo {
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
}

// ---- What a tool gets when it runs ----

/** Data passed in by whoever runs the agent. */
export interface AgentContext {
  building: Building;
  server: ServerApi;
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
