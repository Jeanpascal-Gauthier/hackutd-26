// No network beyond localhost: the form server with a fake ingest().
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { IngestInput } from "../core/ingest.ts";
import type { AssignResult } from "../photon/assign.ts";
import { createFormServer } from "./server.ts";

async function start(reply = "Leave by Stairwell A. Do not use the elevator.", ok = true, delayMs = 0) {
  const calls: IngestInput[] = [];
  const server = createFormServer({
    ingest: async (input) => {
      calls.push(input);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return ok ? { ok, reply, incidentId: "inc-1", status: "needs_location" } : { ok, error: "server down" };
    },
    publicUrl: "http://10.0.0.5:8090/",
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) =>
    fetch(`${base}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { base, post, calls, close: () => new Promise((r) => server.close(r)) };
}

test("GET / serves the report page; /health answers", async () => {
  const s = await start();
  try {
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /<form id="f">/);
    assert.deepEqual(await (await fetch(`${s.base}/health`)).json(), { ok: true });
  } finally {
    await s.close();
  }
});

test("POST /report forwards text + a namespaced caller and returns the reply", async () => {
  const s = await start();
  try {
    const res = await s.post({ text: "  smoke in the break room on 7  ", caller: "web-abc123" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, reply: "Leave by Stairwell A. Do not use the elevator." });
    assert.deepEqual(s.calls, [{ text: "smoke in the break room on 7", caller: "form:web-abc123", channel: "form" }]);
  } finally {
    await s.close();
  }
});

test("server down: the caller still gets a safe reply", async () => {
  const s = await start("", false);
  try {
    const body = (await (await s.post({ text: "fire on 3", caller: "web-x" })).json()) as { ok: boolean; reply: string };
    assert.equal(body.ok, false);
    assert.match(body.reply, /Do not use the elevator/);
  } finally {
    await s.close();
  }
});

test("bad input is rejected without calling ingest", async () => {
  const s = await start();
  try {
    assert.equal((await s.post({ text: "", caller: "web-x" })).status, 400);
    assert.equal((await s.post({ text: "x".repeat(501), caller: "web-x" })).status, 400);
    assert.equal((await s.post({ text: "fire", caller: "<script>" })).status, 400);
    const raw = await fetch(`${s.base}/report`, { method: "POST", body: "not json" });
    assert.equal(raw.status, 400);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test("one report at a time per caller; the next one is fine once it's answered", async () => {
  const s = await start(undefined, true, 100);
  try {
    const [first, second] = await Promise.all([
      s.post({ text: "fire on 7", caller: "web-q" }),
      s.post({ text: "again", caller: "web-q" }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 429]);
    assert.equal((await s.post({ text: "follow-up", caller: "web-q" })).status, 200);
    assert.equal((await s.post({ text: "other person", caller: "web-r" })).status, 200);
  } finally {
    await s.close();
  }
});

test("GET /qr encodes the public URL, or a given https URL, and escapes it", async () => {
  const s = await start();
  try {
    const page = await (await fetch(`${s.base}/qr`)).text();
    assert.match(page, /<svg/);
    assert.match(page, /http:\/\/10\.0\.0\.5:8090\//);
    const tunnel = await (await fetch(`${s.base}/qr?url=${encodeURIComponent("https://abc.trycloudflare.com/")}`)).text();
    assert.match(tunnel, /https:\/\/abc\.trycloudflare\.com\//);
    const bad = await (await fetch(`${s.base}/qr?url=${encodeURIComponent("javascript:alert(1)")}`)).text();
    assert.doesNotMatch(bad, /javascript:/);
  } finally {
    await s.close();
  }
});

// iMessage sign-up: a fake register and a fake normalize (the real ones belong to photon/assign.ts).
/** Digits-only fake: 10 digits -> +1..., "+..." kept, anything else undefined. */
const fakeNormalize = (s: string) => {
  const d = s.replace(/[^\d]/g, "");
  if (s.includes("@")) return s.toLowerCase();
  if (s.trim().startsWith("+") && d.length >= 8) return `+${d}`;
  return d.length === 10 ? `+1${d}` : undefined;
};

async function startIm(opts: { result?: (handle: string) => AssignResult; delayMs?: number; maxRegistrations?: number; register?: false } = {}) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const server = createFormServer({
    ingest: async () => ({ ok: true, reply: "ok" }),
    log: () => {},
    normalize: fakeNormalize,
    maxRegistrations: opts.maxRegistrations,
    register:
      opts.register === false
        ? undefined
        : async (handle) => {
            calls.push(handle);
            if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
            if (opts.result) return opts.result(handle);
            const reused = seen.has(handle);
            seen.add(handle);
            return {
              ok: true,
              assignment: { handle, assignedPhoneNumber: "+14155550100", assignmentId: `as_${handle}`, platform: "imessage", createdAt: "2026-11-07T00:00:00Z", reused },
            };
          },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (phone: unknown) =>
    fetch(`${base}/imessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
  return { base, post, calls, close: () => new Promise((r) => server.close(r)) };
}

test("without register: no iMessage step, /imessage is 404, /config says off", async () => {
  const s = await startIm({ register: false });
  try {
    assert.equal((await s.post("415-555-0123")).status, 404);
    assert.deepEqual(await (await fetch(`${s.base}/config`)).json(), { imessage: false });
    const page = await (await fetch(`${s.base}/`)).text();
    assert.match(page, /<form id="f">/);
    assert.doesNotMatch(page, /Prefer iMessage/);
  } finally {
    await s.close();
  }
});

test("with register: the page has the iMessage section and /config says on", async () => {
  const s = await startIm();
  try {
    const page = await (await fetch(`${s.base}/`)).text();
    assert.match(page, /<form id="f">/);
    assert.match(page, /Prefer iMessage\? \(iPhone\)/);
    assert.match(page, /<input id="imp"[^>]*type="tel"[^>]*autocomplete="tel"[^>]*inputmode="tel"/);
    assert.match(page, /<label for="imp">/);
    assert.match(page, /"sms:" \+ num/);
    assert.doesNotMatch(page, /innerHTML/);
    assert.deepEqual(await (await fetch(`${s.base}/config`)).json(), { imessage: true });
  } finally {
    await s.close();
  }
});

test("a valid phone is normalized, registered, and the assigned number returned", async () => {
  const s = await startIm();
  try {
    const res = await s.post(" (415) 555-0123 ");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, number: "+14155550100", reused: false });
    assert.deepEqual(s.calls, ["+14155550123"]);
    assert.deepEqual(await (await s.post("415.555.0123")).json(), { ok: true, number: "+14155550100", reused: true });
  } finally {
    await s.close();
  }
});

test("bad phones and emails get 400 without calling register", async () => {
  const s = await startIm();
  try {
    for (const bad of ["12", "call me", "", 4155550123, "9".repeat(40)]) {
      const res = await s.post(bad);
      assert.equal(res.status, 400, `phone ${JSON.stringify(bad)}`);
      assert.equal(((await res.json()) as { ok: boolean }).ok, false);
    }
    const email = await s.post("judge@example.com");
    assert.equal(email.status, 400);
    assert.deepEqual(await email.json(), { ok: false, error: "Enter the phone number you text from." });
    assert.equal((await fetch(`${s.base}/imessage`, { method: "POST", body: "not json" })).status, 400);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test("an upstream failure gives 502 with the error; a throw gives 502 with no details", async () => {
  const failing = await startIm({ result: () => ({ ok: false, error: "No free seats on the shared line.", code: "seats_exhausted", status: 409 }) });
  try {
    const res = await failing.post("415-555-0123");
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: "No free seats on the shared line." });
  } finally {
    await failing.close();
  }
  const throwing = await startIm({
    result: () => {
      throw new Error("Bearer pho_sk_secret at Object.create (assign.ts:12:3)");
    },
  });
  try {
    const res = await throwing.post("415-555-0123");
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.doesNotMatch(text, /pho_sk|assign\.ts|Bearer/);
    assert.match(text, /use the form above/);
  } finally {
    await throwing.close();
  }
});

test("one sign-up in flight per client IP", async () => {
  const s = await startIm({ delayMs: 100 });
  try {
    const [a, b] = await Promise.all([s.post("415-555-0123"), s.post("415-555-0124")]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
    assert.equal(s.calls.length, 1);
    assert.equal((await s.post("415-555-0124")).status, 200);
  } finally {
    await s.close();
  }
});

test("the cap counts new registrations only; reused ones still pass", async () => {
  const s = await startIm({ maxRegistrations: 1 });
  try {
    assert.equal((await s.post("415-555-0123")).status, 200);
    const full = await s.post("415-555-0199");
    assert.equal(full.status, 429);
    assert.deepEqual(await full.json(), { ok: false, error: "iMessage sign-ups are full right now: use the form above." });
    assert.deepEqual(await (await s.post("4155550123")).json(), { ok: true, number: "+14155550100", reused: true });
    assert.deepEqual(s.calls, ["+14155550123", "+14155550123"]);
  } finally {
    await s.close();
  }
});

test("a reused result does not use up the cap", async () => {
  const s = await startIm({
    maxRegistrations: 1,
    result: (handle) => ({
      ok: true,
      assignment: { handle, assignedPhoneNumber: "+14155550100", assignmentId: "as_1", platform: "imessage", createdAt: "x", reused: handle.endsWith("0000") },
    }),
  });
  try {
    assert.equal((await s.post("415-555-0000")).status, 200); // already on Photon from an earlier run: reused
    assert.equal((await s.post("415-555-0123")).status, 200); // first new seat
    assert.equal((await s.post("415-555-0124")).status, 429);
  } finally {
    await s.close();
  }
});

// ---- Building address: starts the server's lookup before the report ----

async function startWithLookup(fails = false) {
  const order: string[] = [];
  const lookups: [string, string][] = [];
  const server = createFormServer({
    ingest: async (input) => {
      order.push(`ingest:${input.text}`);
      return { ok: true, reply: "Help is on the way. We are confirming the building now. Do not use the elevator." };
    },
    lookupAddress: async (address, caller) => {
      order.push(`lookup:${address}`);
      lookups.push([address, caller]);
      if (fails) throw new Error("POST /incident/address failed: HTTP 503");
      return { ok: true };
    },
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) =>
    fetch(`${base}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { base, post, order, lookups, close: () => new Promise((r) => server.close(r)) };
}

test("the page has an optional building address field", async () => {
  const s = await startWithLookup();
  try {
    const page = await (await fetch(`${s.base}/`)).text();
    assert.match(page, /<label for="a">Building address \(optional\)<\/label>/);
    assert.match(page, /<input id="a"[^>]*maxlength="200"/);
    assert.doesNotMatch(page, /<input id="a"[^>]*required/);
  } finally {
    await s.close();
  }
});

test("an address starts the lookup first, then the report goes in", async () => {
  const s = await startWithLookup();
  try {
    const res = await s.post({ text: "fire on 3", caller: "web-a", address: "  800 W   Campbell Rd, Richardson " });
    assert.equal(res.status, 200);
    assert.deepEqual(s.order, ["lookup:800 W Campbell Rd, Richardson", "ingest:fire on 3"]);
    assert.deepEqual(s.lookups, [["800 W Campbell Rd, Richardson", "form:web-a"]]);
  } finally {
    await s.close();
  }
});

test("no address (or an empty one): no lookup, the form works as before", async () => {
  const s = await startWithLookup();
  try {
    assert.equal((await s.post({ text: "fire on 3", caller: "web-b" })).status, 200);
    assert.equal((await s.post({ text: "again", caller: "web-b", address: "   " })).status, 200);
    assert.equal(s.lookups.length, 0);
    assert.deepEqual(s.order, ["ingest:fire on 3", "ingest:again"]);
  } finally {
    await s.close();
  }
});

test("a failed lookup still sends the report; a bad address is a 400", async () => {
  const s = await startWithLookup(true);
  try {
    const res = await s.post({ text: "fire on 3", caller: "web-c", address: "1313 Broadway" });
    assert.equal(res.status, 200);
    assert.deepEqual(s.order, ["lookup:1313 Broadway", "ingest:fire on 3"]);
    assert.equal((await s.post({ text: "x", caller: "web-c", address: 42 })).status, 400);
    assert.equal((await s.post({ text: "x", caller: "web-c", address: "y".repeat(201) })).status, 400);
    assert.equal(s.order.length, 2);
  } finally {
    await s.close();
  }
});
