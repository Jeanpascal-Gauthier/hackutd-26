// The Nemotron agent: one caller message in -> tool calls (logged as a trail) -> room, confidence,
// and the text to send back to the caller.
//
// processReport() has the same shape as the server's ReportProcessor
// (server/src/state/processor.ts), so the server plugs it in with setReportProcessor().
// The agent never imports the server: whoever calls it passes the data in through AgentContext.
import type OpenAI from "openai";
import type { Building, Recommendation, TrailStep } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { createNvidiaClient, NVIDIA_FAST, NVIDIA_MODEL } from "./nvidia.ts";
import { CONFIDENT, locateRoom, locateRoomTool, type LocateResult } from "./tools/locateRoom.ts";

type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
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

/** Everything the tools need, passed in by the caller. Grows as tools are added. */
export interface AgentContext {
  building: Building;
}

export const defaultContext: AgentContext = { building: sharedBuilding as Building };

/** What the caller actually said this conversation; tools check the model's arguments against it. */
interface Heard {
  text: string;
}

interface AgentTool {
  schema: ChatTool;
  run(args: Record<string, unknown>, ctx: AgentContext, heard: Heard): unknown;
}

const TOOLS: Record<string, AgentTool> = {
  locate_room: { schema: locateRoomTool, run: (args, ctx, heard) => locateRoom(args, ctx.building, heard.text) },
};

/**
 * The follow-up question for the caller, or undefined once the room is known.
 * Fixed wording, not model output: a message to someone in a fire must not invent advice.
 * With no reply, the server texts the recommendation's callerReply instead, which carries the
 * evacuation route from the exit analysis (server/src/state/ingest.ts).
 */
function replyFor(located: LocateResult | undefined): string | undefined {
  if (located && located.confidence >= CONFIDENT && located.roomId) return undefined;
  return located?.followUp ?? "Which floor are you on, and which room is the smoke or fire in?";
}

const SYSTEM_PROMPT = `You are the dispatch assistant for FireSight, which handles fire reports for one 12-floor office building.
Each message is a text from someone in the building reporting fire or smoke.

1. Always call locate_room first.
   - floor: the floor the caller named or clearly implied ("on 7", "seventh floor", "I'm on ten"). If none is named but the caller's floor is given, use that. If there is no floor, leave the field out entirely.
   - place: a short phrase of 1-4 words naming only the room or area where the fire or smoke is, e.g. "break room", "hallway", "east side". If the caller says the smoke is in one place and they are near another, use where the smoke is. If they only said where they are, use that. If there is no place, leave the field out.
   - If earlier messages from the same caller are listed, combine them: a reply like "east side" answers an earlier question.
   - Never invent a floor or room the caller did not mention. If they gave no location at all, call locate_room with no arguments.
2. When you have the tool results you need, answer with one short line summarising what you found. The system texts the caller itself.`;

/** Turns per report: locate (plus later tools), then the reply. A guard against loops. */
const MAX_TURNS = 6;
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

export async function processReport(input: AgentInput, ctx: AgentContext = defaultContext): Promise<AgentResult> {
  client ??= createNvidiaClient();
  const earlier = conversations.get(input.caller) ?? [];
  conversations.set(input.caller, [...earlier, input.text].slice(-HISTORY));

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage(input, earlier) },
  ];
  const heard: Heard = {
    text: [...earlier, input.text, input.callerFloor ? `floor ${input.callerFloor}` : ""].join("\n"),
  };
  const trail: TrailStep[] = [];
  let located: LocateResult | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.chat.completions.create({
      model: NVIDIA_MODEL,
      messages,
      tools: Object.values(TOOLS).map((t) => t.schema),
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 512,
      ...NVIDIA_FAST,
    });
    const msg = res.choices[0]?.message;
    if (!msg) break;

    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) break; // the model is done

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const started = Date.now();
      const tool = TOOLS[call.function.name];
      const args = parseArgs(call.function.arguments);
      let output: unknown;
      if (!tool) output = { error: `unknown tool ${call.function.name}` };
      else if (!args) output = { error: `arguments are not a JSON object: ${call.function.arguments}` };
      else {
        try {
          output = tool.run(args, ctx, heard);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      trail.push({ tool: call.function.name, input: args ?? call.function.arguments, output, ms: Date.now() - started });
      if (call.function.name === "locate_room" && output && !(output as { error?: unknown }).error) {
        located = output as LocateResult;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }

  // The tool's result is authoritative for the room, and the reply is fixed wording built from it.
  return {
    roomId: located?.roomId,
    confidence: located?.confidence ?? 0,
    trail,
    reply: replyFor(located),
  };
}
