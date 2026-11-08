import { test } from "node:test";
import assert from "node:assert/strict";
import type { MapIncident } from "@firewatch/shared/types";
import { IncidentStore } from "../state/store.ts";
import type { IncidentStatePlus, MapIncidentPlus } from "../incidents/stepZero.ts";
import type { AgentIncident, IncidentImpactResult } from "../../../agent/core/impact/types.ts";
import { impactAgentFrom, loadImpactAgent, type ImpactAgent } from "./bridge.ts";
import { incidentSignature, PortfolioImpactService } from "./service.ts";
import { parsePortfolio } from "./load.ts";
import { BUILDING, mapIncident } from "./testFixtures.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 20;
const settle = () => wait(DEBOUNCE * 4);

const quietly = <T>(fn: () => Promise<T> | T) => async () => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
};

/** One property hit by every incident, with one $290K action out of $380K. */
function result(incidents: AgentIncident[], mode: "rules" | "llm", done: string[] = []): IncidentImpactResult {
  const ids = incidents.map((i) => i.id);
  return {
    impacts: Object.fromEntries(ids.map((id) => [id, { center: { lat: 0, lon: 0 }, radiusMeters: 500, reasons: [`${mode} radius`] }])),
    affectedProperties: ids.length ? [{
      id: "dc-1", name: "Fairview Data Center", use: "data_center", location: BUILDING.location, risk: "high", incidentIds: ids,
      chain: [{ id: "dc-1:hvac", minute: 8, systemId: "hvac", label: "Smoke reaches HVAC intake", hazard: "smoke", causedBy: null, incidentId: ids[0]! }],
      people: 40, downtimeHours: 6, cost: { slaUsd: 300_000, lostRentUsd: 0, damageUsd: 80_000, totalUsd: 380_000 }, accessCut: false, reasons: [],
      actions: [{ id: "dc-1:close-dampers", text: "Close outside-air dampers", deadlineMinute: 7, prevents: ["dc-1:hvac"], savesUsd: 290_000, reason: "Keeps smoke out", status: done.includes("dc-1:close-dampers") ? "done" : "pending" }],
    }] : [],
    summary: { buildings: ids.length ? 1 : 0, people: 40, usdAtRisk: 380_000, usdAtRiskAfterActions: 380_000, horizonMinutes: 30, headline: "1 building · 40 people · ~$380K at risk in the next 30 min" },
    trail: [], mode, briefing: `${mode} briefing`,
  };
}

/** A fake agent: rules is immediate; each assessIncident call waits until the test resolves it. */
function fakeAgent(options: { llm?: boolean } = {}) {
  const calls = { rules: [] as { ids: string[]; done: string[] }[], llm: 0 };
  const pending: (() => void)[] = [];
  const agent: ImpactAgent = {
    fromMapIncident: (m) => (m.location ? { id: m.id, kind: m.kind, severity: m.severity, location: m.location } : null),
    assessIncidentRules: (incidents, _portfolio, opts) => {
      calls.rules.push({ ids: incidents.map((i) => i.id), done: opts?.doneActionIds ?? [] });
      return result(incidents, "rules", opts?.doneActionIds);
    },
    ...(options.llm !== false && {
      assessIncident: (incidents, _portfolio, ctx) => {
        calls.llm++;
        return new Promise<IncidentImpactResult>((resolve) => pending.push(() => resolve(result(incidents, "llm", ctx?.doneActionIds))));
      },
    }),
  };
  /** Resolves the oldest pending Nemotron call. */
  const finishLlm = async () => {
    pending.shift()!();
    await wait(5);
  };
  return { agent, calls, finishLlm, pending };
}

function setup(options: { llm?: boolean; agent?: ImpactAgent | null } = {}) {
  const store = new IncidentStore();
  const fake = fakeAgent(options);
  const service = new PortfolioImpactService(store, [BUILDING], options.agent === null ? undefined : options.agent ?? fake.agent, { debounceMs: DEBOUNCE });
  const state = () => store.get() as IncidentStatePlus;
  const incident = (id: string) => (state().mapIncidents ?? []).find((m) => m.id === id) as MapIncidentPlus;
  const bump = (id: string, change: Partial<MapIncident> = {}) =>
    store.patch({ mapIncidents: (store.get().mapIncidents ?? []).map((m) => (m.id === id ? { ...m, ...change, updated: m.updated + 1 } : m)) });
  return { store, service, ...fake, state, incident, bump };
}

test("a located incident is assessed: portfolioImpact, per-incident impact and affectedProperties, a log line", async () => {
  const s = setup({ llm: false });
  s.store.patch({ mapIncidents: [mapIncident("a", { status: "locating", location: undefined })] });
  await settle();
  assert.equal(s.calls.rules.length, 0, "not located yet");
  assert.equal(s.state().portfolioImpact, undefined);

  s.bump("a", { status: "located", location: { lat: 32.97659, lon: -96.77042 } });
  await settle();
  assert.equal(s.calls.rules.length, 1);
  const pi = s.state().portfolioImpact!;
  assert.equal(pi.mode, "rules");
  assert.equal(pi.summary.buildings, 1);
  assert.deepEqual(pi.done, []);
  assert.equal(s.incident("a").impact?.radiusMeters, 500);
  assert.deepEqual(s.incident("a").affectedProperties?.map((p) => p.id), ["dc-1"]);
  assert.equal(s.incident("a").label, "Fire", "other incident fields are kept");
  const log = s.state().log!.at(-1)!;
  assert.equal(log.kind, "recommendation");
  assert.equal(log.incidentId, "a");
  assert.match(log.text, /^Portfolio impact: 1 building · 40 people · ~\$380K at risk/);
  s.service.stop();
});

test("its own writes and unrelated changes do not recompute; a resolved incident drops out", async () => {
  const s = setup({ llm: false });
  s.store.patch({ mapIncidents: [mapIncident("a"), mapIncident("b", { kind: "crash" })] });
  await settle();
  assert.equal(s.calls.rules.length, 1);
  s.store.patch({ simMinute: 5 });
  s.store.log("report", "unrelated");
  await settle();
  assert.equal(s.calls.rules.length, 1, "no loop, no recompute");

  s.bump("b", { phase: "resolved" });
  await settle();
  assert.equal(s.calls.rules.length, 2);
  assert.deepEqual(s.calls.rules[1]!.ids, ["a"]);
  assert.equal(s.incident("b").affectedProperties, undefined, "a resolved incident loses its fields");
  assert.equal(s.state().log!.filter((e) => e.text.startsWith("Portfolio impact")).length, 1, "same headline logged once");
  s.service.stop();
});

test("changes are debounced into one recompute", async () => {
  const s = setup({ llm: false });
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  s.bump("a");
  s.bump("a", { severity: "serious" });
  await wait(DEBOUNCE / 2);
  assert.equal(s.calls.rules.length, 0, "waits for the debounce");
  await settle();
  assert.equal(s.calls.rules.length, 1);
  assert.notEqual(incidentSignature(s.store.get()), "");
  s.service.stop();
});

test("rules publish first, then Nemotron's result replaces it", async () => {
  const s = setup();
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  assert.equal(s.state().portfolioImpact!.mode, "rules");
  assert.equal(s.state().portfolioImpact!.briefing, "rules briefing");
  assert.equal(s.calls.llm, 1);
  await s.finishLlm();
  assert.equal(s.state().portfolioImpact!.mode, "llm");
  assert.equal(s.state().portfolioImpact!.briefing, "llm briefing");
  assert.deepEqual(s.incident("a").impact!.reasons, ["llm radius"]);
  s.service.stop();
});

test("a Nemotron result for incidents that have since changed is dropped", async () => {
  const s = setup();
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  s.bump("a", { severity: "serious" }); // changes the signature while the first call runs
  await s.finishLlm(); // stale: the incidents changed
  assert.equal(s.state().portfolioImpact!.mode, "rules");
  await settle(); // the recompute
  assert.equal(s.calls.rules.length, 2);
  assert.equal(s.calls.llm, 2);
  await s.finishLlm();
  assert.equal(s.state().portfolioImpact!.mode, "llm");
  s.service.stop();
});

test("execute lowers the $ at risk, survives a recompute, and undo restores it", async () => {
  const s = setup({ llm: false });
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  assert.equal(s.service.execute("nope").ok, false);
  const out = s.service.execute("dc-1:close-dampers");
  assert.ok(out.ok);
  assert.equal(out.portfolioImpact.summary.usdAtRiskAfterActions, 90_000);
  assert.deepEqual(s.state().portfolioImpact!.done, ["dc-1:close-dampers"]);
  assert.equal(s.state().portfolioImpact!.affectedProperties[0]!.actions[0]!.status, "done");
  assert.equal(s.incident("a").affectedProperties![0]!.actions[0]!.status, "done", "also on the incident");
  assert.equal(s.state().log!.at(-1)!.text, "Executed: Close outside-air dampers (Fairview Data Center) → ~$90K at risk");
  assert.equal(s.calls.rules.length, 1, "executing does not recompute");

  s.bump("a", { severity: "serious" });
  await settle();
  assert.equal(s.calls.rules.length, 2);
  assert.deepEqual(s.calls.rules[1]!.done, ["dc-1:close-dampers"], "the agent is told what is done");
  assert.equal(s.state().portfolioImpact!.summary.usdAtRiskAfterActions, 90_000, "done survives the recompute");

  const undone = s.service.undo("dc-1:close-dampers");
  assert.ok(undone.ok);
  assert.equal(undone.portfolioImpact.summary.usdAtRiskAfterActions, 380_000);
  assert.deepEqual(undone.portfolioImpact.done, []);
  assert.equal(s.incident("a").affectedProperties![0]!.actions[0]!.status, "pending");
  assert.match(s.state().log!.at(-1)!.text, /^Undone: Close outside-air dampers/);
  s.service.stop();
});

test("the agent's summarize is used for usdAtRiskAfterActions when exported", async () => {
  const { agent } = fakeAgent({ llm: false });
  const store = new IncidentStore();
  const seen: string[][] = [];
  const service = new PortfolioImpactService(store, [BUILDING], {
    ...agent,
    summarize: (properties, horizonMinutes, done = []) => (seen.push(done), {
      buildings: properties.length, people: 40, usdAtRisk: 380_000, usdAtRiskAfterActions: done.length ? 12_345 : 380_000, horizonMinutes, headline: "h",
    }),
  }, { debounceMs: DEBOUNCE });
  store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  const out = service.execute("dc-1:close-dampers");
  assert.ok(out.ok);
  assert.equal(out.portfolioImpact.summary.usdAtRiskAfterActions, 12_345);
  assert.deepEqual(seen.at(-1), ["dc-1:close-dampers"]);
  service.stop();
});

test("clear() and an emptied map drop portfolioImpact, the incident fields and the done list", async () => {
  const s = setup({ llm: false });
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  s.service.execute("dc-1:close-dampers");
  s.service.clear();
  assert.equal(s.state().portfolioImpact, undefined);
  assert.equal(s.incident("a").impact, undefined);
  s.bump("a");
  await settle();
  assert.deepEqual(s.state().portfolioImpact!.done, [], "done does not survive a reset");

  s.store.patch({ mapIncidents: [] });
  await settle();
  assert.equal(s.state().portfolioImpact, undefined);
  s.service.stop();
});

test("a reset that keeps the map but drops portfolioImpact gets it back", async () => {
  const s = setup({ llm: false });
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  const { portfolioImpact: _gone, ...rest } = s.state();
  s.store.reset(rest); // like LiveIncident.reset on a change of building
  assert.equal(s.state().portfolioImpact?.summary.buildings, 1);
  assert.equal(s.calls.rules.length, 1);
  s.service.stop();
});

test("no agent: the feature is off and nothing throws", quietly(async () => {
  const s = setup({ agent: null });
  assert.equal(s.service.enabled, false);
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  assert.equal(s.state().portfolioImpact, undefined);
  const out = s.service.execute("dc-1:close-dampers");
  assert.ok(!out.ok && out.status === 503);
  assert.deepEqual(s.service.buildings().map((b) => b.id), ["dc-1"]);

  assert.equal(impactAgentFrom([{ assessIncidentRules: () => 1 }]).agent, undefined);
  assert.deepEqual(impactAgentFrom([undefined]).missing, ["assessIncidentRules", "fromMapIncident"]);
  const missing = new URL("./does-not-exist.ts", import.meta.url);
  assert.equal(await loadImpactAgent(missing, [missing]), undefined);
}));

test("an agent that throws or returns junk publishes nothing and never throws", quietly(async () => {
  const s = setup({
    agent: {
      fromMapIncident: () => { throw new Error("boom"); },
      assessIncidentRules: () => { throw new Error("boom"); },
      assessIncident: async () => ({ junk: true }) as unknown as IncidentImpactResult,
    },
  });
  s.store.patch({ mapIncidents: [mapIncident("a")] });
  await settle();
  assert.equal(s.state().portfolioImpact, undefined);
  s.service.stop();
}));

test("parsePortfolio drops malformed buildings", () => {
  const { buildings, dropped } = parsePortfolio([BUILDING, { id: "x" }, BUILDING]);
  assert.deepEqual(buildings.map((b) => b.id), ["dc-1"]);
  assert.equal(dropped, 2);
  assert.deepEqual(parsePortfolio({}).buildings, []);
});
