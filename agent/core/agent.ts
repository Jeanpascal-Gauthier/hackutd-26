// The Nemotron agent: one caller message in -> tool calls (logged as a trail) -> room, confidence,
// recommendation, and a follow-up question for the caller when the location is unclear.
//
// processReport() has the same shape as the server's ReportProcessor
// (server/src/state/processor.ts); the server loads it with AGENT=1 (server/src/agent/bridge.ts).
// The agent never imports the server: tools reach it through AgentContext.server (HTTP by default).
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Building, Recommendation, TrailStep } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { createNvidiaClient, NVIDIA_FAST, NVIDIA_MODEL } from "./nvidia.ts";
import { httpServerApi } from "./server.ts";
import { CONFIDENT, locateRoomTool, type LocateResult } from "./tools/locateRoom.ts";
import { mergeReportsTool } from "./tools/mergeReports.ts";
import { runSpreadTool } from "./tools/runSpread.ts";
import { findClearExitsTool } from "./tools/findClearExits.ts";
import { writeRecommendationTool } from "./tools/writeRecommendation.ts";
import type { AgentContext, AgentTool, RunState, ToolEnv } from "./tools/types.ts";

export type { AgentContext } from "./tools/types.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface AgentInput {
  text: string;
  caller: string;
  /** The caller's floor, when known from outside the message (e.g. a badge record). */
  callerFloor?: number;
}

/** Same fields as the server's ProcessResult. */
export interface AgentResult {
  roomId?: string;
  confidence?: number;
  recommendation?: Recommendation;
  trail?: TrailStep[];
  reply?: string;
}

export const defaultContext: AgentContext = {
  building: sharedBuilding as Building,
  server: httpServerApi(),
};

/** Every tool the model may call, in pipeline order. */
const TOOL_LIST: AgentTool[] = [
  locateRoomTool,
  mergeReportsTool,
  runSpreadTool,
  findClearExitsTool,
  writeRecommendationTool,
];
const TOOLS = new Map(TOOL_LIST.map((t) => [t.schema.function.name, t]));

const SYSTEM_PROMPT = `You are the dispatch assistant for FireSight, which handles fire reports for one 12-floor office building.
Each message is a text from someone in the building reporting fire or smoke.

1. Always call locate_room first.
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
      - actions (1-3, for the incident commander): which floors to evacuate by which stairwell; send the first engine crew to the fire floor by a clear stairwell; help for people flagged "mobility". Name every floor listed in noClearStair.
      - callerReply (for people in the building): leave by the clear stairwell, do not use any stairwell that fills with smoke, do not use the elevator.
      - If it returns problems, fix exactly those and call it again.
4. Then answer with one short line summarising what you found. The system texts the caller itself.`;

/** Model turns per report: one per tool in the pipeline, retries, and the final answer. */
const MAX_TURNS = 10;
/** Earlier messages kept per caller, so answers to follow-up questions make sense. */
const HISTORY = 5;

const conversations = new Map<string, string[]>();

/** Forget every caller's earlier messages (new incident, or between tests). */
export function resetConversations(): void {
  conversations.clear();
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
 * - Room known: undefined, so the server texts the recommendation's callerReply (the evacuation
 *   route from the exit analysis; server/src/state/ingest.ts).
 * - Floor known, room unclear: what to do now (the checked callerReply when there is one), then
 *   the question listing that floor's rooms. A caller never gets only a question once we know
 *   enough to tell them which way out is safe.
 * - No floor: just the question.
 */
function replyFor(located: LocateResult | undefined, recommendation: Recommendation | undefined): string | undefined {
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
  client ??= createNvidiaClient();
  const earlier = conversations.get(input.caller) ?? [];
  conversations.set(input.caller, [...earlier, input.text].slice(-HISTORY));

  const env: ToolEnv = {
    ctx,
    heard: [...earlier, input.text, input.callerFloor ? `floor ${input.callerFloor}` : ""].join("\n"),
    run: { report: { id: randomUUID(), text: input.text, caller: input.caller, time: Date.now() } } satisfies RunState,
  };
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage(input, earlier) },
  ];
  const trail: TrailStep[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.chat.completions.create({
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
      const started = Date.now();
      const { input: args, output } = await runTool(call.function.name, call.function.arguments, env);
      trail.push({ tool: call.function.name, input: args, output, ms: Date.now() - started });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }

  const { located, recommendation } = env.run;
  return {
    roomId: located?.roomId,
    confidence: located?.confidence ?? 0,
    recommendation,
    trail,
    reply: replyFor(located, recommendation),
  };
}
