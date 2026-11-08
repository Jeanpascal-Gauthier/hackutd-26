// No real server: ingest() against a local fake POST /map-incidents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { findAddress, ingest, readReport, resetIngest } from "./ingest.ts";

test("readReport: kind of emergency, flood, in-building fire", () => {
  assert.deepEqual(readReport("two cars crashed, one flipped"), { kind: "crash", inBuilding: false });
  assert.deepEqual(readReport("smoke coming out of the kitchen on floor 3"), { kind: "fire", inBuilding: true });
  assert.deepEqual(readReport("brush fire by the highway"), { kind: "fire", inBuilding: false });
  assert.deepEqual(readReport("the street is flooding"), { kind: "other", what: "flood", inBuilding: false });
  assert.deepEqual(readReport("someone collapsed"), { kind: "other", inBuilding: false });
  assert.equal(readReport("car on fire after a crash").kind, "crash");
});

test("findAddress: street addresses and cross streets", () => {
  assert.equal(findAddress("fire at 800 W Campbell Rd, Richardson. Hurry"), "800 W Campbell Rd, Richardson");
  assert.equal(findAddress("crash at 1313 Main Street near the light"), "1313 Main Street");
  assert.equal(findAddress("2100 N Central Expy."), "2100 N Central Expy");
  assert.equal(findAddress("wreck at Coit and Campbell"), "Coit & Campbell");
  assert.equal(findAddress("crash on the corner of Main St & 5th Ave"), "Main St & 5th Ave");
  assert.equal(findAddress("smoke on floor 3 of my building"), undefined);
  assert.equal(findAddress("3 cars crashed on the road"), undefined);
  assert.equal(findAddress("fire and smoke everywhere"), undefined);
});

async function fakeServer(status: (n: number) => string) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      assert.equal(req.url, "/map-incidents");
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, reply: `reply ${bodies.length}`, incident: { id: "inc-1", status: status(bodies.length) } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const previous = process.env.FIRESIGHT_SERVER_URL;
  process.env.FIRESIGHT_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetIngest();
  const close = () => {
    if (previous === undefined) delete process.env.FIRESIGHT_SERVER_URL;
    else process.env.FIRESIGHT_SERVER_URL = previous;
    return new Promise((r) => server.close(r));
  };
  return { bodies, close };
}

test("a text becomes a map incident; the answer to 'where?' is its address, with the same kind", async () => {
  const s = await fakeServer((n) => (n === 1 ? "needs_location" : "located"));
  try {
    const first = await ingest({ text: "there's a fire in my apartment", caller: "+15550100" });
    assert.deepEqual(first, { ok: true, reply: "reply 1", incidentId: "inc-1", status: "needs_location" });
    assert.deepEqual(s.bodies[0], { type: "fire", description: "there's a fire in my apartment", in_building: true, caller: "+15550100", channel: "sms" });

    await ingest({ text: "coit and campbell", caller: "+15550100" });
    assert.deepEqual(s.bodies[1], { type: "fire", address: "coit and campbell", description: "coit and campbell", in_building: false, caller: "+15550100", channel: "sms" });

    // Placed now: a further text is just more detail, not a new address.
    await ingest({ text: "it is spreading", caller: "+15550100" });
    assert.equal(s.bodies[2]!.address, undefined);
    assert.equal(s.bodies[2]!.type, "fire");
  } finally {
    await s.close();
  }
});

test("a flood follow-up keeps what=flood; other callers and stale reports start fresh", async () => {
  const s = await fakeServer(() => "needs_location");
  try {
    let t = 0;
    const now = () => t;
    await ingest({ text: "water main burst, street flooding", caller: "a" }, now);
    await ingest({ text: "Elm St", caller: "a" }, now);
    assert.equal(s.bodies[1]!.what, "flood");
    assert.equal(s.bodies[1]!.address, "Elm St");

    await ingest({ text: "Elm St", caller: "b" }, now);
    assert.equal(s.bodies[2]!.address, undefined, "b was never asked where");

    t = 31 * 60 * 1000;
    await ingest({ text: "Oak St", caller: "a" }, now);
    assert.equal(s.bodies[3]!.address, undefined, "too late to be a follow-up");
    assert.equal(s.bodies[3]!.type, "other");
  } finally {
    await s.close();
  }
});

test("the form's address field and channel go through", async () => {
  const s = await fakeServer(() => "locating");
  try {
    await ingest({ text: "smoke on 3", caller: "form:web-a", channel: "form", address: "800 W Campbell Rd" });
    assert.equal(s.bodies[0]!.address, "800 W Campbell Rd");
    assert.equal(s.bodies[0]!.channel, "form");
  } finally {
    await s.close();
  }
});

test("server errors come back as ok: false", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, errors: ["`description` must be a non-empty string"] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const previous = process.env.FIRESIGHT_SERVER_URL;
  process.env.FIRESIGHT_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await ingest({ text: "x", caller: "c" }), { ok: false, error: "`description` must be a non-empty string" });
  } finally {
    if (previous === undefined) delete process.env.FIRESIGHT_SERVER_URL;
    else process.env.FIRESIGHT_SERVER_URL = previous;
    await new Promise((r) => server.close(r));
  }
});
