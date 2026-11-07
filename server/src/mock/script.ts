// Scripted demo calls (MOCK=1). They go through the real pipeline: locator/agent -> merge ->
// spread model -> exits -> recommendation. Only the arrival times and caller words are scripted.
// Texts follow agent/fixtures/calls.json (copied, not imported: different owner).
import type { IncidentState, TrailStep } from "@firewatch/shared/types";
import type { IngestOutcome } from "../state/ingest.ts";

export interface ScriptedCall {
  minute: number; // when the call arrives during replay
  caller: string;
  text: string;
}

export const SCRIPT: ScriptedCall[] = [
  { minute: 0, caller: "demo-1 (mock)", text: "theres smoke coming out of the break room on 7, near the microwaves" },
  { minute: 3, caller: "demo-3 (mock)", text: "fire alarm going off, I can't tell where it's coming from, what do I do" },
  { minute: 6, caller: "demo-2 (mock)", text: "I smell smoke in the hallway, I'm on the 8th floor by the conference room" },
  { minute: 12, caller: "demo-4 (mock)", text: "the east stairs are full of smoke on floor 10, we're in the east office" },
];

/**
 * A plausible agent trail for one call, built from what the pipeline actually produced, so the
 * console's trail panel has data before the real agent exists. Timings are illustrative.
 */
export function demoTrail(call: ScriptedCall, out: IngestOutcome, state: IncidentState): TrailStep[] {
  const { roomId, confidence } = out.result;
  const steps: TrailStep[] = [
    {
      tool: "locate_room",
      input: { text: call.text },
      output: roomId ? { roomId, confidence } : { followUp: out.reply },
      ms: 420,
    },
  ];
  if (!roomId || !state.origin) return steps;

  const atRisk = (state.exits ?? []).filter((e) => e.atRiskAt !== null || Object.values(e.blockedAt).some((m) => m !== null));
  steps.push(
    { tool: "merge_reports", input: { reports: state.reports.length }, output: state.origin, ms: 12 },
    { tool: "run_spread", input: { origin: state.origin.roomId, minutes: 30 }, output: { rooms: state.rooms.length, snapshots: 31 }, ms: 38 },
    {
      tool: "find_clear_exits",
      input: { origin: state.origin.roomId },
      output: atRisk.map((e) => ({ floor: e.floor, stair: e.stair, blockedAt: e.blockedAt, people: e.people })),
      ms: 6,
    },
    { tool: "write_recommendation", input: { floorsAtRisk: atRisk.map((e) => e.floor) }, output: state.recommendation ?? null, ms: 610 },
  );
  return steps;
}
