import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIngest } from "./http.ts";

const rooms = new Set(["7-break", "7-hall"]);

test("plain report: text + caller, no agent result", () => {
  assert.deepEqual(validateIngest({ text: " smoke ", caller: "a" }, rooms), { text: "smoke", caller: "a" });
  assert.ok(Array.isArray(validateIngest({ text: "", caller: 5 }, rooms)));
  assert.ok(Array.isArray(validateIngest([], rooms)));
});

test("agent result is passed through as preprocessed", () => {
  const v = validateIngest({
    text: "smoke in break room on 7",
    caller: "+1214",
    roomId: "7-break",
    confidence: 0.9,
    recommendation: { actions: ["Evacuate floor 7"], callerReply: "Leave now" },
    trail: [{ tool: "locate_room", input: { text: "x" }, output: { roomId: "7-break" }, ms: 400 }],
    reply: "Leave by stairwell A",
  }, rooms);
  assert.ok(!Array.isArray(v));
  assert.deepEqual(v.preprocessed, {
    roomId: "7-break",
    confidence: 0.9,
    recommendation: { actions: ["Evacuate floor 7"], callerReply: "Leave now" },
    trail: [{ tool: "locate_room", input: { text: "x" }, output: { roomId: "7-break" }, ms: 400 }],
    reply: "Leave by stairwell A",
  });
});

test("a follow-up without a room is still an agent result", () => {
  const v = validateIngest({ text: "fire alarm", caller: "a", reply: "Which floor are you on?" }, rooms);
  assert.ok(!Array.isArray(v));
  assert.deepEqual(v.preprocessed, { reply: "Which floor are you on?" });
});

test("bad agent fields are rejected with reasons", () => {
  const bad = (extra: object) => validateIngest({ text: "x", caller: "y", ...extra }, rooms);
  for (const extra of [
    { roomId: "99-nowhere", confidence: 0.5 },
    { roomId: "7-break" }, // confidence required
    { roomId: "7-break", confidence: 2 },
    { recommendation: { actions: [] } },
    { recommendation: "evacuate" },
    { trail: [{ tool: "x" }] }, // ms missing
    { reply: "" },
  ]) assert.ok(Array.isArray(bad(extra)), JSON.stringify(extra));
});
