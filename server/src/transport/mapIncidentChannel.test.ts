// POST /map-incidents with a `channel`: a texted follow-up joins the caller's incident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { GeoPoint } from "@firewatch/shared/types";
import { createApp } from "../app.ts";
import { createBuildingService } from "../buildings/service.ts";
import type { MapProviders } from "../incidents/providers.ts";

const A: GeoPoint = { lat: 32.99, lon: -96.75 };

const providers: MapProviders = {
  geocode: async (query) => (query.toLowerCase() === "1 main st" ? { location: A, formatted: "1 Main St, Richardson, TX 75080, United States" } : null),
  roads: async () => [],
  buildings: async () => [],
  wind: async () => ({ speedMps: 4, fromDegrees: 180 }),
};

async function serve() {
  const app = createApp({
    mapProviders: providers,
    buildings: createBuildingService({ geoapifyApiKey: "x", fetch: (async () => { throw new Error("no network in tests"); }) as typeof fetch }),
  });
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const base = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
  const call = async (body: unknown) => {
    const res = await fetch(`${base}/map-incidents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const close = async () => {
    app.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
  };
  return { app, call, close };
}

const quietly = <T>(fn: () => Promise<T>) => async () => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
};

test("POST /map-incidents channel sms: the caller's follow-up places their incident", quietly(async () => {
  const s = await serve();
  try {
    const first = await s.call({ type: "fire", description: "there is a fire", caller: "+15550100", channel: "sms" });
    assert.equal(first.body.incident.status, "needs_location");
    const second = await s.call({ type: "fire", address: "1 Main St", description: "1 Main St", caller: "+15550100", channel: "sms" });
    assert.equal(second.body.incident.id, first.body.incident.id);
    const incidents = s.app.store.get().mapIncidents ?? [];
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.reports[0]!.channel, "sms");
  } finally {
    await s.close();
  }
}));

test("POST /map-incidents without a channel stays a console report", quietly(async () => {
  const s = await serve();
  try {
    await s.call({ type: "fire", description: "there is a fire", caller: "+15550100" });
    await s.call({ type: "fire", address: "1 Main St", description: "1 Main St", caller: "+15550100", channel: "bogus" });
    const incidents = s.app.store.get().mapIncidents ?? [];
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0]!.reports[0]!.channel, "console");
  } finally {
    await s.close();
  }
}));
