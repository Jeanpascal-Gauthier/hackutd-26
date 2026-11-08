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

test("one caller's texts run one at a time, in order; other callers are not held up", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((r) => (releaseFirst = r));
  const send = async (i: IngestInput): Promise<IngestResult> => {
    order.push(`start ${i.caller} ${i.text}`);
    if (i.text === "800 W Campbell Rd") await firstDone; // the first lookup is still being started
    order.push(`end ${i.caller} ${i.text}`);
    return { ok: true, reply: `ok ${i.text}` };
  };
  const handle = createHandler(send, () => {});
  const a = fakeSpace();
  const b = fakeSpace("any;-;+15559990000");
  const first = handle(a.space, msg("m1", "800 W Campbell Rd"));
  const second = handle(a.space, msg("m2", "800 West Campbell Road"));
  const other = handle(b.space, msg("m3", "smoke on 7", { sender: { id: "+15559990000" } }));
  await other;
  assert.deepEqual(order, ["start +15551230000 800 W Campbell Rd", "start +15559990000 smoke on 7", "end +15559990000 smoke on 7"],
    "the second text from the same caller waits; another caller doesn't");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["ok 800 W Campbell Rd", "ok 800 West Campbell Road"]);
  assert.deepEqual(order.slice(3), ["end +15551230000 800 W Campbell Rd", "start +15551230000 800 West Campbell Road", "end +15551230000 800 West Campbell Road"]);
  assert.deepEqual(a.sent, ["ok 800 W Campbell Rd", "ok 800 West Campbell Road"], "replies go out in order");
});

test("a failed text does not block that caller's next one", async () => {
  let n = 0;
  const handle = createHandler(async () => {
    if (n++ === 0) throw new Error("ingest crashed");
    return { ok: true, reply: "second ok" };
  }, () => {});
  const { space } = fakeSpace();
  await assert.rejects(handle(space, msg("m1", "first")));
  assert.equal(await handle(space, msg("m2", "second")), "second ok");
});
