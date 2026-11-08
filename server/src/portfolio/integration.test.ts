// The real agent's rules path on the demo: a fire, a crash and a flood around Campbell Rd & Coit Rd
// (agent/fixtures/demoIncidents.ts), as the map incidents the server would hold, against
// data/portfolio.json. Skipped when the agent can't be loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MapIncident } from "@firewatch/shared/types";
import type { AgentIncident } from "../../../agent/core/impact/types.ts";
import type { IncidentStatePlus, MapIncidentPlus } from "../incidents/stepZero.ts";
import { IncidentStore } from "../state/store.ts";
import { loadImpactAgent } from "./bridge.ts";
import { loadPortfolio } from "./load.ts";
import { PortfolioImpactService } from "./service.ts";

const DEMO_URL = new URL("../../../agent/fixtures/demoIncidents.ts", import.meta.url);

/** An AgentIncident fixture back as the MapIncident (+ Step 0 fields) the server holds. Floods stay kind "other". */
function asMapIncident(i: AgentIncident): MapIncidentPlus {
  const m: MapIncident & Record<string, unknown> = {
    id: i.id,
    kind: i.kind === "flood" ? "other" : i.kind,
    label: i.kind === "flood" ? "Flood" : i.kind === "fire" ? "Fire" : "Car crash",
    severity: i.severity,
    status: "located",
    location: i.location,
    reports: Array.from({ length: i.calls ?? 1 }, (_, n) => ({ caller: `caller-${n}`, text: i.description ?? "", time: i.time ?? 0 })),
    time: i.time ?? 0,
    updated: i.time ?? 0,
    phase: "open",
    forecastStatus: i.fire || i.crash ? "ready" : "none",
    ...(i.inBuilding !== undefined && { inBuilding: i.inBuilding }),
    ...(i.lanesBlocked && { lanesBlocked: i.lanesBlocked }),
    ...(i.fire && { fire: i.fire }),
    ...(i.crash && { crash: i.crash }),
    ...(i.flood && { flood: i.flood }),
    ...(i.affectedRoads && { affectedRoads: i.affectedRoads }),
    ...(i.related && { related: i.related }),
    ...(i.zoneId && { zoneId: i.zoneId }),
  };
  return m as MapIncidentPlus;
}

test("real agent: demo fire + crash + flood near Campbell & Coit", async (t) => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  let agent, demo: { DEMO_INCIDENTS: AgentIncident[]; DEMO_NOW: number } | undefined;
  try {
    agent = await loadImpactAgent();
    demo = await import(DEMO_URL.href).catch(() => undefined);
  } finally {
    Object.assign(console, { log, warn, error });
  }
  if (!agent || !demo) return t.skip("the impact agent or its demo fixtures can't be loaded yet");
  const portfolio = loadPortfolio();
  assert.equal(portfolio.length, 8);

  const store = new IncidentStore();
  const service = new PortfolioImpactService(store, portfolio, agent, { debounceMs: 0, llm: false, now: () => demo.DEMO_NOW });
  store.patch({ mapIncidents: demo.DEMO_INCIDENTS.map(asMapIncident) });
  service.recompute();
  const state = store.get() as IncidentStatePlus;
  const incident = (id: string) => (state.mapIncidents ?? []).find((m) => m.id === id) as MapIncidentPlus;
  const pi = state.portfolioImpact!;
  console.log(`  headline: ${pi.summary.headline}`);
  console.log(`  top: ${pi.affectedProperties.slice(0, 3).map((p) => `${p.name} (${p.risk})`).join(", ")}`);
  assert.equal(pi.mode, "rules");
  assert.ok(pi.summary.buildings >= 1, "the demo hits portfolio buildings");
  assert.ok(pi.summary.usdAtRisk > 0);
  assert.ok(pi.affectedProperties.some((p) => p.id === "dc-lookout"), "the data center is hit");
  const fire = incident("inc-fire-campbell");
  assert.ok(fire.impact && fire.impact.radiusMeters > 0);
  assert.ok(fire.affectedProperties!.length >= 1);
  const flood = incident("inc-flood-lookout");
  assert.ok(flood.impact, "the flood (kind other + flood) is assessed");

  // Execute the biggest saver: the $ at risk after actions goes down, and survives a recompute.
  const action = pi.affectedProperties.flatMap((p) => p.actions).filter((a) => a.savesUsd > 0).sort((a, b) => b.savesUsd - a.savesUsd)[0];
  if (action) {
    const out = service.execute(action.id);
    assert.ok(out.ok);
    assert.ok(out.portfolioImpact.summary.usdAtRiskAfterActions < pi.summary.usdAtRiskAfterActions);
    console.log(`  ${store.get().log!.at(-1)!.text}`);
    store.patch({ mapIncidents: store.get().mapIncidents!.map((m) => ({ ...m, updated: m.updated + 1 })) });
    service.recompute();
    assert.deepEqual((store.get() as IncidentStatePlus).portfolioImpact!.done, [action.id]);
  }
  service.stop();
});
