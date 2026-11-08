// No network: the Photon 2.0 poller and reply space with a fake @photon-ai/api client.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ChatSpace } from "./handler.ts";
import { createPoller, replySpace, toChatMessage, type PhotonApi, type PhotonMessage } from "./photon2.ts";

const T0 = Date.parse("2026-11-07T20:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function msg(id: string, at: number, over: Partial<PhotonMessage> = {}): PhotonMessage {
  return {
    id,
    platform: "imessage",
    status: "received",
    createdAt: iso(at),
    content: { type: "text", text: "smoke in the break room on 7" },
    sentBy: { id: "pho_usr_human", handle: "+15551230000", kind: "human" },
    receivedBy: { id: "pho_usr_agent", handle: "+15559990000", kind: "agent" },
    space: { id: "pho_spc_1" },
    ...over,
  };
}

function fakeApi(pages: PhotonMessage[][]) {
  const listed: Record<string, unknown>[] = [];
  const sent: { key: string; body: Record<string, unknown> }[] = [];
  let call = 0;
  const api: PhotonApi = {
    projects: {
      listMessages: async (input) => {
        listed.push(input.query ?? {});
        return { items: pages[Math.min(call++, pages.length - 1)] ?? [] };
      },
      sendMessage: async (input) => void sent.push({ key: input.headers["idempotency-key"], body: input.body }),
    },
  };
  return { api, listed, sent };
}

test("toChatMessage: person text becomes a handler message; receipts, typing and agent echoes are ignored", () => {
  assert.deepEqual(toChatMessage(msg("m1", T0)), {
    id: "m1",
    direction: "inbound",
    sender: { id: "+15551230000" },
    content: { type: "text", text: "smoke in the break room on 7" },
  });
  assert.equal(toChatMessage(msg("m2", T0, { content: { type: "message.read" } })), undefined);
  assert.equal(toChatMessage(msg("m3", T0, { content: { type: "space.typing.update" } })), undefined);
  assert.equal(toChatMessage(msg("m4", T0, { sentBy: { id: "pho_usr_agent", kind: "agent" } })), undefined);
  assert.equal(toChatMessage(msg("m5", T0, { status: "delivered" })), undefined);
  assert.equal(toChatMessage(msg("m6", T0, { content: { type: "attachment" } }))?.content.type, "attachment");
});

test("replySpace: replies into the same space as the receiving agent, with idempotency keys", async () => {
  const { api, sent } = fakeApi([]);
  const space = replySpace(api, "pho_prj_x", msg("m1", T0));
  await space.startTyping!();
  await space.send("Leave by Stairwell A. Do not use the elevator.");
  await space.stopTyping!();
  assert.deepEqual(sent.map((s) => s.key), ["firesight:typing-on:m1", "firesight:reply0:m1", "firesight:typing-off:m1"]);
  assert.deepEqual(sent[1]!.body, {
    spaceId: "pho_spc_1",
    senderId: "pho_usr_agent",
    parentMessageId: "m1",
    content: { type: "text", format: "plain", text: "Leave by Stairwell A. Do not use the elevator." },
  });
  assert.deepEqual(sent[0]!.body.content, { type: "space.typing.update", typing: true });
});

test("replySpace: no receiving agent -> the send fails loudly instead of guessing a sender", async () => {
  const { api } = fakeApi([]);
  const space = replySpace(api, "pho_prj_x", msg("m1", T0, { receivedBy: undefined }));
  await assert.rejects(space.send("hi"), /no receivedBy agent/);
});

test("poller: hands over only new person messages, dedupes across overlapping polls, skips old ones", async () => {
  const first = [msg("old", T0 - 60_000), msg("m1", T0 + 1000), msg("read", T0 + 1500, { content: { type: "message.read" } })];
  const second = [msg("m1", T0 + 1000), msg("m2", T0 + 5000)]; // m1 again: overlap window
  const { api, listed } = fakeApi([first, second]);
  const got: [ChatSpace, ChatMessage][] = [];
  const pollOnce = createPoller({ api, projectId: "pho_prj_x", since: new Date(T0), onMessage: (s, m) => got.push([s, m]), log: () => {} });
  assert.equal(await pollOnce(), 1);
  assert.equal(await pollOnce(), 1);
  assert.deepEqual(got.map(([, m]) => m.id), ["m1", "m2"]);
  assert.equal(got[0]![0].id, "pho_spc_1");
  assert.equal(listed[0]!.direction, "received");
  assert.equal(listed[0]!.order, "asc");
  // The second poll looks back from the newest message seen, with overlap.
  assert.ok(Date.parse(String(listed[1]!.createdSince)) <= T0 + 1000);
});

test("poller: follows nextPageToken", async () => {
  let calls = 0;
  const api: PhotonApi = {
    projects: {
      listMessages: async (input) => {
        calls++;
        return input.query?.pageToken
          ? { items: [msg("p2", T0 + 2000)] }
          : { items: [msg("p1", T0 + 1000)], nextPageToken: "next" };
      },
      sendMessage: async () => undefined,
    },
  };
  const ids: string[] = [];
  await createPoller({ api, projectId: "pho_prj_x", since: new Date(T0), onMessage: (_, m) => ids.push(m.id), log: () => {} })();
  assert.equal(calls, 2);
  assert.deepEqual(ids, ["p1", "p2"]);
});
