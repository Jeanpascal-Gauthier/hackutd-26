// Runs caller messages through the real agent (Nemotron + tools) and prints what it decided.
//
//   npm run try -w agent                          # the fixtures, plus a follow-up answer, with checks
//   npm run try -w agent -- "smoke on floor 3"    # one message of your own
//
// Exits 1 if a fixture check fails.
import calls from "../fixtures/calls.json" with { type: "json" };
import { processReport, type AgentInput, type AgentResult } from "../core/agent.ts";
import { CONFIDENT } from "../core/tools/locateRoom.ts";

interface Case {
  input: AgentInput;
  expect?: { label: string; ok: (r: AgentResult) => boolean };
}

const confident = (r: AgentResult) => (r.confidence ?? 0) >= CONFIDENT;

const fixtureCases: Case[] = [
  { input: calls[0]!, expect: { label: "7-break, confident", ok: (r) => r.roomId === "7-break" && confident(r) } },
  {
    input: calls[1]!,
    expect: { label: "a room on floor 8", ok: (r) => r.roomId?.startsWith("8-") === true },
  },
  { input: calls[2]!, expect: { label: "no confident room, asks a question", ok: (r) => !confident(r) && !!r.reply } },
  // demo-3 answers the follow-up question; the agent must combine it with their first message.
  {
    input: { caller: "demo-3", text: "I'm on the tenth floor, it's on the east side" },
    expect: { label: "10-east, confident", ok: (r) => r.roomId === "10-east" && confident(r) },
  },
];

const cli = process.argv.slice(2).join(" ").trim();
const cases: Case[] = cli ? [{ input: { caller: "cli", text: cli } }] : fixtureCases;

let failed = 0;
for (const { input, expect } of cases) {
  console.log(`\n── ${input.caller}${input.callerFloor ? ` (floor ${input.callerFloor})` : ""}: ${JSON.stringify(input.text)}`);
  const started = Date.now();
  let r: AgentResult;
  try {
    r = await processReport(input);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.log(`   ERROR ${e.status ? `HTTP ${e.status}: ` : ""}${e.message ?? String(err)}`);
    failed++;
    continue;
  }
  for (const step of r.trail ?? []) {
    console.log(`   ${step.tool}(${JSON.stringify(step.input)}) -> ${JSON.stringify(step.output)}  [${step.ms} ms]`);
  }
  console.log(`   room:   ${r.roomId ?? "-"}  confidence ${r.confidence ?? 0}`);
  console.log(`   reply:  ${r.reply === undefined ? "(none: the server texts its recommendation instead)" : JSON.stringify(r.reply)}`);
  console.log(`   total:  ${Date.now() - started} ms`);
  if (expect) {
    const ok = expect.ok(r);
    if (!ok) failed++;
    console.log(`   ${ok ? "PASS" : "FAIL"}: expected ${expect.label}`);
  }
}

if (!cli) console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
