// The scripted CBRE demo (portfolio/demo.ts) through the HTTP routes, with the real agent's rules
// path and data/portfolio.json; and MapIncidents.inject() on its own. The agent tests skip when the
// agent or its demo fixtures can't be loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { GeoPoint } from "@firewatch/shared/types";
import { MapIncidents } from "../incidents/service.ts";
import type { MapProviders } from "../incidents/providers.ts";
import type { IncidentStatePlus, MapIncidentPlus } from "../incidents/stepZero.ts";
import { IncidentStore } from "../state/store.ts";
import { fakeApp } from "../testing/lookupFakes.ts";
import { loadImpactAgent, type ImpactAgent } from "./bridge.ts";
import { demoMapIncident, loadDemoFixtures, type DemoFixtures } from "./demo.ts";
import { loadPortfolio } from "./load.ts";

const HEADLINE = "6 buildings · 1,240 people · ~$380K at risk in the next 30 min";

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await work();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

let loaded: Promise<{ agent?: ImpactAgent; fixtures?: DemoFixtures }> | undefined;
const realAgent = () => (loaded ??= quietly(async () => ({ agent: await loadImpactAgent(), fixtures: await loadDemoFixtures() })));

async function serve(agent: ImpactAgent | undefined, load?: () => Promise<DemoFixtures | undefined>) {
  const { app } = fakeApp({ portfolio: { buildings: loadPortfolio(), agent, options: { debounceMs: 5, llm: false } }, ...(load && { loadDemoFixtures: load }) });
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const base = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
  const call = async (method: string, path: string) => {
    const res = await fetch(base + path, { method });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const state = () => app.store.get() as IncidentStatePlus;
  const close = async () => {
    app.portfolio.stop();
    app.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
  };
  return { app, call, state, close };
}

test("demo fixtures round-trip through fromMapIncident to the same assessment", async (t) => {
  const { agent, fixtures } = await realAgent();
  if (!agent || !fixtures) return t.skip("the impact agent or its demo fixtures can't be loaded");
  const portfolio = loadPortfolio();
  const opts = { now: fixtures.now, horizonMinutes: 30 };
  const direct = agent.assessIncidentRules(fixtures.incidents, portfolio, opts);
  const mapped = fixtures.incidents.map((i) => agent.fromMapIncident({ ...demoMapIncident(i, 1), kind: i.kind })!);
  const viaMap = agent.assessIncidentRules(mapped, portfolio, opts);
  assert.equal(direct.summary.headline, HEADLINE);
  assert.deepEqual(viaMap.summary, direct.summary);
  assert.deepEqual(viaMap.affectedProperties.map((p) => [p.id, p.cost.totalUsd, p.chain[0]?.label]), direct.affectedProperties.map((p) => [p.id, p.cost.totalUsd, p.chain[0]?.label]));
  const flood = demoMapIncident(fixtures.incidents[2]!, 1);
  assert.equal(flood.kind, "other");
  assert.equal(flood.label, "Flood");
  assert.ok(flood.flood);
});

test("POST /portfolio/demo/step: fire, crash, flood, then done; execute; reset", async (t) => {
  const { agent, fixtures } = await realAgent();
  if (!agent || !fixtures) return t.skip("the impact agent or its demo fixtures can't be loaded");
  const s = await serve(agent);
  try {
    // 1. The fire: one incident, its impact computed at once (no debounce wait).
    const one = await s.call("POST", "/portfolio/demo/step");
    assert.equal(one.status, 200);
    assert.equal(one.body.step, 1);
    assert.deepEqual(one.body.added.map((a: { label: string }) => a.label), ["Fire"]);
    assert.equal(s.state().mapIncidents!.length, 1);
    const fire = s.state().mapIncidents![0]! as MapIncidentPlus;
    assert.equal(fire.forecastStatus, "ready");
    assert.ok(fire.impact && fire.impact.radiusMeters > 0);
    assert.ok(fire.affectedProperties!.length >= 1);
    assert.ok(one.body.portfolioImpact.summary.buildings >= 1);
    assert.ok(s.app.portfolio.scriptedClock);
    assert.ok(s.state().reports.some((r) => r.incidentId === fire.id && /strip mall on Campbell/.test(r.text)));

    // 2 + 3. Crash and flood: three linked incidents and the scripted headline.
    await s.call("POST", "/portfolio/demo/step");
    const three = await s.call("POST", "/portfolio/demo/step");
    assert.equal(three.body.step, 3);
    const list = s.state().mapIncidents! as MapIncidentPlus[];
    assert.deepEqual(list.map((m) => [m.kind, m.label]), [["fire", "Fire"], ["crash", "Car crash"], ["other", "Flood"]]);
    assert.ok(list.every((m) => m.related?.length && m.zoneId && m.forecastStatus === "ready"));
    const [f, c] = list;
    assert.ok(f!.related!.includes(c!.id) && c!.related!.includes(f!.id), "fire and crash are linked both ways");
    for (const m of list) for (const other of m.related!) assert.ok(list.find((x) => x.id === other)!.related!.includes(m.id), "links are symmetric");
    assert.equal(s.state().portfolioImpact!.summary.headline, HEADLINE);
    assert.equal((await s.call("GET", "/portfolio/impact")).body.portfolioImpact.summary.headline, HEADLINE);

    const done = await s.call("POST", "/portfolio/demo/step");
    assert.deepEqual([done.body.ok, done.body.done, done.body.step], [true, true, 3]);
    assert.equal(s.state().mapIncidents!.length, 3);

    // 5. Execute the data center's dampers + flood barriers: ~$90K left.
    const dc = s.state().portfolioImpact!.affectedProperties.find((p) => p.id === "dc-lookout")!;
    for (const suffix of ["close-dampers", "flood-barriers"]) {
      const action = dc.actions.find((a) => a.id.endsWith(suffix));
      assert.ok(action, `the data center has a ${suffix} action`);
      assert.equal((await s.call("POST", `/portfolio/actions/${encodeURIComponent(action.id)}/execute`)).status, 200);
    }
    const after = s.state().portfolioImpact!.summary;
    assert.ok(after.usdAtRiskAfterActions >= 80_000 && after.usdAtRiskAfterActions <= 100_000, `after actions: ${after.usdAtRiskAfterActions}`);
    assert.match(after.headline, /~\$90K at risk/);

    // Reset: empty map, no impact, the real clock, and the script starts over.
    const reset = await s.call("POST", "/portfolio/demo/reset");
    assert.deepEqual(reset.body, { ok: true, step: 0 });
    assert.deepEqual(s.state().mapIncidents, []);
    assert.equal(s.state().portfolioImpact, undefined);
    assert.equal(s.app.portfolio.scriptedClock, false);
    assert.ok(!s.state().reports.some((r) => r.incidentId));
    await s.call("POST", "/portfolio/demo/step");
    assert.deepEqual(s.state().mapIncidents!.map((m) => m.label), ["Fire"]);
    assert.ok(!s.state().portfolioImpact!.done.length, "executed actions do not survive a reset");

    // /live/reset restarts the script too; /run puts all three in at once.
    await s.call("POST", "/live/reset");
    assert.equal(s.app.portfolio.scriptedClock, false);
    const all = await s.call("POST", "/portfolio/demo/run");
    assert.equal(all.body.step, 3);
    assert.equal(all.body.added.length, 3);
    assert.equal(all.body.portfolioImpact.summary.headline, HEADLINE);
  } finally {
    await s.close();
  }
});

test("the demo routes answer 503 when the fixtures can't load, and the rest still works", async () => {
  const s = await serve(undefined, async () => undefined);
  try {
    for (const path of ["/portfolio/demo/step", "/portfolio/demo/run"]) {
      const out = await s.call("POST", path);
      assert.equal(out.status, 503);
      assert.equal(out.body.ok, false);
      assert.match(out.body.error, /demoIncidents/);
    }
    assert.equal((await s.call("POST", "/portfolio/demo/reset")).status, 200);
    assert.equal((await s.call("GET", "/portfolio")).status, 200);
    assert.deepEqual(s.state().mapIncidents ?? [], []);
  } finally {
    await s.close();
  }
});

// ---- MapIncidents.inject on its own ----

const FIRE_AT: GeoPoint = { lat: 32.97629, lon: -96.77047 };
const NEAR_FIRE: GeoPoint = { lat: 32.9765, lon: -96.7702 }; // ~35 m away

function injectedFire(): MapIncidentPlus {
  return {
    id: "inc-fire-campbell", kind: "fire", label: "Fire", severity: "critical", status: "located", location: FIRE_AT,
    formatted: "Campbell Coit Plaza, Campbell Road, Richardson, TX 75080, United States", inBuilding: false,
    reports: [{ caller: "demo caller 1", text: "Fire behind the strip mall on Campbell Rd, smoke everywhere", time: 1 }],
    time: 1, updated: 1, phase: "open", forecastStatus: "ready", forecastAt: 1,
    fire: { wind: { speedMps: 6.7, fromDegrees: 225 }, steps: [], exposures: [], summary: "demo plume", assumptions: [] },
  };
}

function counted() {
  const calls = { geocode: 0, wind: 0, roads: 0, buildings: 0, elevation: 0 };
  const providers: MapProviders = {
    geocode: async (query) => (calls.geocode++, { location: NEAR_FIRE, formatted: `${query}, Richardson, TX 75080, United States` }),
    wind: async () => (calls.wind++, { speedMps: 1, fromDegrees: 0 }),
    roads: async () => (calls.roads++, []),
    buildings: async () => (calls.buildings++, []),
    elevation: async (points) => (calls.elevation++, points.map(() => 180)),
  };
  const store = new IncidentStore();
  const service = new MapIncidents(store, providers, undefined, { forecastRefreshMs: 5 });
  const list = () => (store.get().mapIncidents ?? []) as MapIncidentPlus[];
  return { calls, store, service, list };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("inject: no forecast job, no refresh, not even after a reopen", async () => {
  const w = counted();
  w.service.inject(injectedFire());
  await wait(30);
  const fire = w.list()[0]!;
  assert.deepEqual([fire.forecastStatus, fire.forecastAt, fire.fire?.summary], ["ready", 1, "demo plume"]);
  w.service.setPhase(fire.id, "resolved");
  w.service.setPhase(fire.id, "open");
  await wait(30);
  assert.deepEqual(w.calls, { geocode: 0, wind: 0, roads: 0, buildings: 0, elevation: 0 });
  assert.equal(w.list()[0]!.fire?.summary, "demo plume");
  assert.equal(w.list()[0]!.forecastAt, 1);
  w.service.clear();
});

test("inject: a live report next to an injected incident is linked (other kind) or kept apart (same kind), never merged", async () => {
  const w = counted();
  w.service.inject(injectedFire());
  const crash = await w.service.report({ kind: "crash", address: "Campbell Rd and Coit Rd", description: "two cars, all lanes blocked", severity: "serious", lanesBlocked: "all", inBuilding: false, channel: "voice", caller: "+15550001" });
  const fire = await w.service.report({ kind: "fire", address: "7651 Campbell Rd", description: "smoke behind the strip mall", severity: "serious", lanesBlocked: "unknown", inBuilding: false, channel: "voice", caller: "+15550002" });
  await wait(30);
  const list = w.list();
  assert.equal(list.length, 3, "nothing merged into the injected fire");
  const injected = list.find((m) => m.id === "inc-fire-campbell")!;
  assert.equal(injected.reports.length, 1);
  assert.equal(injected.fire?.summary, "demo plume", "its forecast is untouched");
  assert.ok(injected.related?.includes(crash.incident.id), "the live crash is linked to it");
  assert.ok(list.find((m) => m.id === crash.incident.id)!.related?.includes(injected.id));
  assert.notEqual(fire.incident.id, injected.id);
  w.service.clear();
});
