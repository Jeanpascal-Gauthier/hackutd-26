import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentStore, MAX_LOG } from "./store.ts";
import { applyClientEvent } from "./actions.ts";

const rec = { actions: ["Evacuate floors 7–12 by Stairwell A"], callerReply: "Leave now" };
const hooks = { setSimMinute: () => {} };

test("accepting keeps the recommendation in `accepted` and logs it", () => {
  const s = new IncidentStore();
  assert.equal(s.acceptRecommendation(), undefined, "nothing pending");
  s.setRecommendation(rec);
  assert.deepEqual(s.acceptRecommendation(), rec);
  assert.equal(s.get().recommendation, undefined);
  assert.deepEqual(s.get().accepted?.recommendation, rec);
  assert.ok(s.get().accepted!.time > 0);
  assert.equal(s.get().log?.at(-1)?.kind, "accepted");
});

test("dispatch event is recorded and logged", () => {
  const s = new IncidentStore();
  applyClientEvent({ type: "dispatch", roomId: "7-break" }, s, hooks);
  assert.equal(s.get().dispatches?.[0].roomId, "7-break");
  assert.match(s.get().log!.at(-1)!.text, /7-break/);
});

test("log keeps only the last MAX_LOG entries", () => {
  const s = new IncidentStore();
  for (let i = 0; i < MAX_LOG + 25; i++) s.log("report", `r${i}`);
  assert.equal(s.get().log!.length, MAX_LOG);
  assert.equal(s.get().log!.at(-1)!.text, `r${MAX_LOG + 24}`);
});
