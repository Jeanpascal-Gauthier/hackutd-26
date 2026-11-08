// No SDK, no credentials: the Photon message handler with a fake space and ingest().
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IngestInput, IngestResult } from "../core/ingest.ts";
import { createHandler, NOT_TEXT_REPLY, type ChatMessage, type ChatSpace } from "./handler.ts";

function fakeSpace(id = "any;-;+15551230000") {
  const sent: string[] = [];
  const typing: string[] = [];
  const space: ChatSpace = {
    id,
    send: async (t) => void sent.push(t),
    startTyping: async () => void typing.push("start"),
    stopTyping: async () => void typing.push("stop"),
  };
  return { space, sent, typing };
}

const msg = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  direction: "inbound",
  sender: { id: "+15551230000" },
  content: { type: "text", text },
  ...over,
});

function fakeIngest(result: IngestResult) {
  const calls: IngestInput[] = [];
  return { calls, send: async (i: IngestInput) => (calls.push(i), result) };
}

test("a text goes to ingest with the sender as caller, and the reply comes back", async () => {
  const ing = fakeIngest({ ok: true, reply: "Leave by Stairwell A. Do not use the elevator.", roomId: "7-break", confidence: 0.85 });
  const { space, sent, typing } = fakeSpace();
  const reply = await createHandler(ing.send, () => {})(space, msg("m1", " smoke in the break room on 7 "));
  assert.deepEqual(ing.calls, [{ text: "smoke in the break room on 7", caller: "+15551230000" }]);
  assert.deepEqual(sent, ["Leave by Stairwell A. Do not use the elevator."]);
  assert.equal(reply, sent[0]);
  assert.deepEqual(typing, ["start", "stop"]);
});

test("outbound messages and duplicate deliveries are ignored", async () => {
  const ing = fakeIngest({ ok: true, reply: "ok" });
  const { space, sent } = fakeSpace();
  const handle = createHandler(ing.send, () => {});
  await handle(space, msg("m1", "fire on 7", { direction: "outbound" }));
  await handle(space, msg("m2", "fire on 7"));
  await handle(space, msg("m2", "fire on 7"));
  assert.equal(ing.calls.length, 1);
  assert.equal(sent.length, 1);
});

test("non-text content gets a prompt to text in words, without calling ingest", async () => {
  const ing = fakeIngest({ ok: true, reply: "ok" });
  const { space, sent } = fakeSpace();
  await createHandler(ing.send, () => {})(space, msg("m1", "", { content: { type: "attachment" } }));
  assert.equal(ing.calls.length, 0);
  assert.deepEqual(sent, [NOT_TEXT_REPLY]);
});

test("server down: a safe fallback reply is still sent, and typing stops", async () => {
  const ing = fakeIngest({ ok: false, error: "fetch failed" });
  const { space, sent, typing } = fakeSpace();
  await createHandler(ing.send, () => {})(space, msg("m1", "fire on 3"));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Do not use the elevator/);
  assert.deepEqual(typing, ["start", "stop"]);
});

test("no sender id: the conversation id is the caller", async () => {
  const ing = fakeIngest({ ok: true, reply: "ok" });
  const { space } = fakeSpace("any;-;+15559990000");
  await createHandler(ing.send, () => {})(space, msg("m1", "fire on 3", { sender: undefined }));
  assert.equal(ing.calls[0]!.caller, "any;-;+15559990000");
});
