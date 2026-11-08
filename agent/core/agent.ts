// The Nemotron agent: one caller message in -> tool calls (logged as a trail) -> room, confidence,
// recommendation, and a follow-up question for the caller when the location is unclear.
//
// processReport() has the same shape as the server's ReportProcessor
// (server/src/state/processor.ts); the server loads it with AGENT=1 (server/src/agent/bridge.ts).
// The agent never imports the server: tools reach it through AgentContext.server (HTTP by default).
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Building, BuildingLookup, IncidentState, Recommendation, TrailStep } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { createNvidiaClient, NVIDIA_FAST, NVIDIA_MODEL } from "./nvidia.ts";
import { describeBuilding, floorSpan } from "./rooms.ts";
import { httpServerApi } from "./server.ts";
import { FIND_BUILDING_REPLY, findBuildingTool } from "./tools/findBuilding.ts";
import { CONFIDENT, locateRoomTool, type LocateResult } from "./tools/locateRoom.ts";
import { mergeReportsTool } from "./tools/mergeReports.ts";
import { runSpreadTool } from "./tools/runSpread.ts";
import { findClearExitsTool } from "./tools/findClearExits.ts";
import { writeRecommendationTool } from "./tools/writeRecommendation.ts";
import type { AgentContext, AgentTool, RunState, ServerApi, ToolEnv } from "./tools/types.ts";

export type { AgentContext } from "./tools/types.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface AgentInput {
  text: string;
  caller: string;
  /** The caller's floor, when known from outside the message (e.g. a badge record). */
  callerFloor?: number;
}

/** Same fields as the server's ProcessResult, plus `buildingLookup`. */
export interface AgentResult {
  roomId?: string;
  confidence?: number;
  recommendation?: Recommendation;
  trail?: TrailStep[];
  reply?: string;
  /**
   * Set when find_building started an address lookup for this report. The report then has no
   * room yet: it waits for the operator to confirm the building, and the server processes it again.
   */
  buildingLookup?: BuildingLookup;
}

/** The demo building, used when the server can't say which building is active. */
export const DEMO_BUILDING = sharedBuilding as Building;

export const defaultContext: AgentContext = {
  building: DEMO_BUILDING,
  server: httpServerApi(),
};

/** Every tool the model may call: find_building, then the pipeline in order. */
const TOOL_LIST: AgentTool[] = [
  findBuildingTool,
  locateRoomTool,
  mergeReportsTool,
  runSpreadTool,
  findClearExitsTool,
  writeRecommendationTool,
];
const TOOLS = new Map(TOOL_LIST.map((t) => [t.schema.function.name, t]));

/** Lookups the operator still has to finish. */
const PENDING: BuildingLookup["status"][] = ["searching", "needs_confirmation", "loading"];

/** One line on the address lookup, when it matters to this report. */
function lookupLine(lookup: BuildingLookup | undefined): string | undefined {
  if (!lookup) return undefined;
  const q = JSON.stringify(lookup.query.slice(0, 120));
  if (PENDING.includes(lookup.status)) {
    return `An address lookup for ${q} is in progress (${lookup.status.replace("_", " ")}): the operator has not confirmed that building yet.`;
  }
  if (lookup.status === "failed") {
    const why = lookup.error ? `: ${lookup.error.slice(0, 120)}` : "";
    return `The last address lookup, for ${q}, failed${why}. Keep using the active building unless the caller gives a different address.`;
  }
  return undefined;
}

/** The system prompt for one report: the active building, and the lookup status when relevant. */
export function systemPrompt(building: Building, lookup?: BuildingLookup): string {
  const b = describeBuilding(building);
  const { lowest, highest } = floorSpan(building);
  const where = b.address ? `${b.name}, ${b.address}` : b.name;
  const estimated = b.layoutEstimated
    ? " Its room layout and occupant counts are estimated (from its outline, room type and time of day), so room names are generic."
    : "";
  const status = lookupLine(lookup);
  return `You are the dispatch assistant for Firewatch, which handles fire reports for one building at a time.
Active building: ${where}. ${/^[aeiou]/i.test(b.use) ? "An" : "A"} ${b.use} building with ${b.floors} ${b.floors === 1 ? "floor" : "floors"} (floors ${lowest}-${highest}).${estimated}${status ? `
${status}` : ""}
Each message is from someone reporting fire or smoke, by text or phone call.

0. If the caller gives a street address, or names a building or landmark, and it is not the active building${status && lookup && PENDING.includes(lookup.status) ? " or the address being looked up" : ""}, call find_building with it first.
   - If find_building starts a lookup, stop there and call no other tool: this report is processed again once the operator confirms the building.
   - If it says no new lookup is needed, or the caller gave no address, go on with step 1.
1. Call locate_room.
   - floor: the floor the caller named or clearly implied ("on 7", "seventh floor", "I'm on ten"). If none is named but the caller's floor is given, use that. If there is no floor, leave the field out entirely.
   - place: a short phrase of 1-4 words naming only the room or area where the fire or smoke is, e.g. "break room", "hallway", "east side". If the caller says the smoke is in one place and they are near another, use where the smoke is. If they only said where they are, use that. If there is no place, leave the field out.
   - If earlier messages from the same caller are listed, combine them: a reply like "east side" answers an earlier question.
   - Never invent a floor or room the caller did not mention. If they gave no location at all, call locate_room with no arguments.
2. If locate_room found no floor (confidence 0), stop here: the system texts the caller its followUp question.
3. Otherwise, even if the exact room is still unclear (the floor alone decides which stairwell is safe), call these, one at a time, in this order:
   a. merge_reports: combines every report so far into the likely fire origin.
   b. run_spread with no arguments: forecasts fire and smoke for 30 minutes from that origin.
   c. find_clear_exits: the clear stairwell for each floor at risk, and who needs help.
   d. write_recommendation, based only on the find_clear_exits result:
      - actions (1-3, for the incident commander): which floors to evacuate by which stairwell; send the first engine crew to the fire floor by a clear stairwell; help for people flagged "mobility" or "child"; door-to-door alerting on floors flagged "sleeping". Name every floor listed in noClearStair.
      - callerReply (for people in the building): leave by the clear stairwell, do not use any stairwell that fills with smoke, do not use the elevator.
      - If it returns problems, fix exactly those and call it again.
4. Then answer with one short line summarising what you found. The system texts the caller itself.`;
}
/** Model turns per report: one per tool in the pipeline, retries, and the final answer. */
const MAX_TURNS = 10;
/** Earlier messages kept per caller, so answers to follow-up questions make sense. */
const HISTORY = 5;

const conversations = new Map<string, string[]>();

/** Last building fetched from each server, keyed by its id and version (IncidentState.building). */
let buildingCache = new WeakMap<ServerApi, { key: string; building: Building }>();

/** Forget every caller's earlier messages and the cached building (new incident, or between tests). */
export function resetConversations(): void {
  conversations.clear();
  buildingCache = new WeakMap();
}

export interface ActiveBuilding {
  building: Building;
  /** The server's address lookup, from GET /state. */
  lookup?: BuildingLookup;
  /** server: just fetched; cache: same id and version as last time; fallback: the server didn't answer. */
  source: "server" | "cache" | "fallback";
  note?: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);
const isBuilding = (b: unknown): b is Building =>
  typeof b === "object" && b !== null && Array.isArray((b as Building).rooms) && (b as Building).rooms.length > 0;

/**
 * The building this report is about: the server's active one. GET /state each report (cheap; it
 * also carries the lookup status), GET /building only when the building's id or version changed.
 * If the server can't be reached: the last building it gave, else `ctx.building` (the demo).
 */
export async function loadActiveBuilding(ctx: AgentContext): Promise<ActiveBuilding> {
  const cached = buildingCache.get(ctx.server);
  let state: IncidentState;
  try {
    state = await ctx.server.getState();
  } catch (err) {
    return { building: cached?.building ?? ctx.building, source: "fallback", note: `GET /state failed: ${errText(err)}` };
  }
  const lookup = state.buildingLookup;
  // Older servers have no state.building: their building never changes, so fetch it once.
  const key = state.building ? `${state.building.id}@${state.building.version}` : "unversioned";
  if (cached?.key === key) return { building: cached.building, ...(lookup ? { lookup } : {}), source: "cache" };
  try {
    const { building } = await ctx.server.getBuilding();
    if (!isBuilding(building)) throw new Error("GET /building returned no rooms");
    buildingCache.set(ctx.server, { key, building });
    return { building, ...(lookup ? { lookup } : {}), source: "server" };
  } catch (err) {
    return {
      building: cached?.building ?? ctx.building,
      ...(lookup ? { lookup } : {}),
      source: "fallback",
      note: `GET /building failed: ${errText(err)}`,
    };
  }
}

let client: OpenAI | undefined;

function userMessage({ text, caller, callerFloor }: AgentInput, earlier: string[]): string {
  const lines = [`Caller ${caller}${callerFloor ? ` (on floor ${callerFloor})` : ""} says: ${JSON.stringify(text)}`];
  if (earlier.length) {
    lines.push("Earlier messages from this caller, oldest first:", ...earlier.map((t) => `- ${JSON.stringify(t)}`));
  }
  return lines.join("\n");
}

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to text the caller. Fixed wording or checked text, never free model output: a message to
 * someone in a fire must not invent advice.
 * - find_building started a lookup: FIND_BUILDING_REPLY (the report waits for the operator to
 *   confirm the building, and the server processes it again then).
 * - Room known: undefined, so the server texts the recommendation's callerReply (the evacuation
 *   route from the exit analysis; server/src/state/ingest.ts).
 * - Floor known, room unclear: what to do now (the checked callerReply when there is one), then
 *   the question listing that floor's rooms. A caller never gets only a question once we know
 *   enough to tell them which way out is safe.
 * - No floor: just the question.
 */
export function replyFor(run: Pick<RunState, "located" | "recommendation" | "lookup">): string | undefined {
  const { located, recommendation, lookup } = run;
  if (lookup) return FIND_BUILDING_REPLY;
  if (located && located.confidence >= CONFIDENT && located.roomId) return undefined;
  const question = located?.followUp ?? "Which floor are you on, and which room is the smoke or fire in?";
  if (located?.floor === undefined) return question;
  const guidance = recommendation?.callerReply ?? "Fire crews are on the way. Do not use the elevator.";
  return `${guidance} ${question}`;
}

async function runTool(name: string, rawArgs: string, env: ToolEnv): Promise<{ input: unknown; output: unknown }> {
  const tool = TOOLS.get(name);
  const args = parseArgs(rawArgs);
  if (!tool) return { input: rawArgs, output: { error: `unknown tool ${name}` } };
  if (!args) return { input: rawArgs, output: { error: `arguments are not a JSON object: ${rawArgs}` } };
  try {
    return { input: args, output: await tool.run(args, env) };
  } catch (err) {
    return { input: args, output: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export async function processReport(input: AgentInput, ctx: AgentContext = defaultContext): Promise<AgentResult> {
  const llm = ctx.llm ?? (client ??= createNvidiaClient());
  // A report held during an address lookup comes back once the building is confirmed: don't list
  // it as its own earlier message.
  const prior = conversations.get(input.caller) ?? [];
  const earlier = prior.at(-1) === input.text ? prior.slice(0, -1) : prior;
  conversations.set(input.caller, [...earlier, input.text].slice(-HISTORY));

  const active = await loadActiveBuilding(ctx);
  const env: ToolEnv = {
    ctx: { ...ctx, building: active.building },
    heard: [...earlier, input.text, input.callerFloor ? `floor ${input.callerFloor}` : ""].join("\n"),
    run: {
      report: { id: randomUUID(), text: input.text, caller: input.caller, time: Date.now() },
      ...(active.lookup ? { currentLookup: active.lookup } : {}),
    } satisfies RunState,
  };
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(active.building, active.lookup) },
    { role: "user", content: userMessage(input, earlier) },
  ];
  const trail: TrailStep[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await llm.chat.completions.create({
      model: NVIDIA_MODEL,
      messages,
      tools: TOOL_LIST.map((t) => t.schema),
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 1024,
      ...NVIDIA_FAST,
    });
    const msg = res.choices[0]?.message;
    if (!msg) break;

    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) break; // the model is done

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      if (env.run.lookup) {
        // find_building started a lookup earlier in this turn: nothing else runs on this building.
        const args = parseArgs(call.function.arguments) ?? call.function.arguments;
        trail.push({ tool: call.function.name, input: args, output: { skipped: "waiting for the operator to confirm the building" }, ms: 0 });
        continue;
      }
      const started = Date.now();
      const { input: args, output } = await runTool(call.function.name, call.function.arguments, env);
      trail.push({ tool: call.function.name, input: args, output, ms: Date.now() - started });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (env.run.lookup) break; // processed again once the operator confirms the building
  }

  const { located, recommendation, lookup } = env.run;
  if (lookup) return { confidence: 0, trail, reply: replyFor(env.run), buildingLookup: lookup };
  return {
    roomId: located?.roomId,
    confidence: located?.confidence ?? 0,
    recommendation,
    trail,
    reply: replyFor(env.run),
  };
}
