import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { IncidentImpactResult } from "../../../agent/core/impact/types.ts";
import type { IncidentStatePlus } from "../incidents/stepZero.ts";
import { fakeApp } from "../testing/lookupFakes.ts";
import type { ImpactAgent } from "./bridge.ts";
import { BUILDING, mapIncident } from "./testFixtures.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const agent: ImpactAgent = {
  fromMapIncident: (m) => (m.location ? { id: m.id, kind: m.kind, severity: m.severity, location: m.location } : null),
  assessIncidentRules: (incidents) => ({
    impacts: {},
    affectedProperties: [{
      id: "dc-1", name: "Fairview Data Center", use: "data_center", location: BUILDING.location, risk: "high", incidentIds: incidents.map((i) => i.id),
      chain: [], people: 40, downtimeHours: 6, cost: { slaUsd: 0, lostRentUsd: 0, damageUsd: 380_000, totalUsd: 380_000 }, accessCut: false, reasons: [],
      actions: [{ id: "dc-1:close-dampers", text: "Close outside-air dampers", deadlineMinute: 7, prevents: [], savesUsd: 290_000, reason: "", status: "pending" }],
    }],
    summary: { buildings: 1, people: 40, usdAtRisk: 380_000, usdAtRiskAfterActions: 380_000, horizonMinutes: 30, headline: "h" },
    trail: [], mode: "rules", briefing: "b",
  }) satisfies IncidentImpactResult,
};

async function serve(withAgent = true) {
  const { app } = fakeApp({ portfolio: { buildings: [BUILDING], agent: withAgent ? agent : undefined, options: { debounceMs: 5 } } });
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const base = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
  const call = async (method: string, path: string) => {
    const res = await fetch(base + path, { method });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const close = async () => {
    app.portfolio.stop();
    app.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
  };
  return { app, call, close };
}

test("GET /portfolio, GET /portfolio/impact, POST execute/undo, and a reset clears it", async () => {
  const s = await serve();
  try {
    const list = await s.call("GET", "/portfolio");
    assert.equal(list.status, 200);
    assert.equal(list.body.enabled, true);
    assert.deepEqual(list.body.buildings.map((b: { id: string }) => b.id), ["dc-1"]);
    assert.equal((await s.call("GET", "/portfolio/impact")).body.portfolioImpact, null);

    s.app.store.patch({ mapIncidents: [mapIncident("a")] });
    await wait(40);
    const impact = await s.call("GET", "/portfolio/impact");
    assert.equal(impact.body.portfolioImpact.summary.buildings, 1);

    const id = encodeURIComponent("dc-1:close-dampers");
    const exec = await s.call("POST", `/portfolio/actions/${id}/execute`);
    assert.equal(exec.status, 200);
    assert.equal(exec.body.ok, true);
    assert.equal(exec.body.portfolioImpact.summary.usdAtRiskAfterActions, 90_000);
    const raw = await s.call("POST", "/portfolio/actions/dc-1:close-dampers/undo"); // a raw ":" works too
    assert.equal(raw.body.portfolioImpact.summary.usdAtRiskAfterActions, 380_000);
    const unknown = await s.call("POST", "/portfolio/actions/nope/execute");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.ok, false);

    assert.equal((await s.call("POST", "/live/reset")).status, 200);
    assert.equal((s.app.store.get() as IncidentStatePlus).portfolioImpact, undefined);
    assert.equal((await s.call("GET", "/portfolio/impact")).body.portfolioImpact, null);
  } finally {
    await s.close();
  }
});

test("without an agent the routes answer, with the feature off", async () => {
  const s = await serve(false);
  try {
    const list = await s.call("GET", "/portfolio");
    assert.equal(list.body.enabled, false);
    assert.equal(list.body.buildings.length, 1);
    assert.equal((await s.call("POST", "/portfolio/actions/x/execute")).status, 503);
  } finally {
    await s.close();
  }
});
