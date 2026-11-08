import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReportProcessor } from "../state/processor.ts";
import { guardAgent, loadAgentProcessor, loadAgentReset } from "./bridge.ts";

const input = { text: "smoke on 7", caller: "test" };
const fallback: ReportProcessor = () => ({ roomId: "7-hall", confidence: 0.4 });
const quiet = <T>(fn: () => Promise<T>) => async () => {
  const err = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = err; }
};

test("guard passes a good agent result through", async () => {
  const p = guardAgent(async () => ({ roomId: "7-break", confidence: 0.9, reply: "hi" }), fallback, 1000);
  assert.deepEqual(await p(input), { roomId: "7-break", confidence: 0.9, reply: "hi" });
});

test("guard falls back when the agent throws, times out or returns junk", quiet(async () => {
  const throws = guardAgent(async () => { throw new Error("nemotron 500"); }, fallback, 1000);
  assert.deepEqual(await throws(input), { roomId: "7-hall", confidence: 0.4 });
  const hangs = guardAgent(() => new Promise(() => {}), fallback, 50);
  assert.deepEqual(await hangs(input), { roomId: "7-hall", confidence: 0.4 });
  const junk = guardAgent((async () => undefined) as unknown as ReportProcessor, fallback, 1000);
  assert.deepEqual(await junk(input), { roomId: "7-hall", confidence: 0.4 });
}));

test("loads processReport from a module that exports it", async () => {
  const p = await loadAgentProcessor(new URL("./fixtures/good-agent.ts", import.meta.url));
  assert.ok(p);
  assert.deepEqual(await p(input), { roomId: "7-break", confidence: 0.9, reply: "agent saw: smoke on 7" });
});

test("missing export or missing module -> undefined, no crash", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await loadAgentProcessor(new URL("./fixtures/no-export-agent.ts", import.meta.url)), undefined);
    assert.equal(await quiet(() => loadAgentProcessor(new URL("./fixtures/nope.ts", import.meta.url)))(), undefined);
    // The real agent/index.ts loads without throwing, whether or not it exports processReport yet.
    const real = await loadAgentProcessor();
    assert.ok(real === undefined || typeof real === "function");
  } finally {
    console.warn = warn;
  }
});

test("loads resetConversations when exported; undefined when not", async () => {
  const url = new URL("./fixtures/good-agent.ts", import.meta.url);
  const reset = await loadAgentReset(url);
  assert.ok(reset);
  const fixture = (await import(url.href)) as { resets: number };
  const before = fixture.resets;
  reset();
  assert.equal(fixture.resets, before + 1);
  assert.equal(await loadAgentReset(new URL("./fixtures/no-export-agent.ts", import.meta.url)), undefined);
  // The real agent/index.ts exports it.
  assert.equal(typeof (await loadAgentReset()), "function");
});
