import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAddresses } from "./geoapify.ts";
import { buildingInteriors, nearbyBuildings, OVERPASS_USER_AGENT } from "./overpass.ts";
import { BuildingApiError, providerJson } from "./provider.ts";

test("geocoding uses encoded parameters and returns bounded source-labelled candidates", async () => {
  let calls = 0;
  const result = await searchAddresses("Coffee & Office, Dallas", "test-key", {
    fetch: async (input) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.geoapify.com");
      assert.equal(url.searchParams.get("text"), "Coffee & Office, Dallas");
      assert.equal(url.searchParams.get("limit"), "5");
      assert.equal(url.searchParams.get("apiKey"), "test-key");
      return Response.json({ results: [
        { formatted: "Coffee & Office", lat: 32, lon: -96, result_type: "building", rank: { confidence: 0.9, match_type: "full_match" }, datasource: { sourcename: "osm", attribution: "OSM contributors" } },
        { formatted: "bad coordinates", lat: 1000, lon: 0 },
      ] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].source.attribution, "OSM contributors");
  assert.equal(result[0].confidence, 0.9);
  assert.equal(JSON.stringify(result).includes("test-key"), false);
});

test("missing key and invalid coordinates do not send requests", async () => {
  const fetch: typeof globalThis.fetch = async () => { throw new Error("Unexpected request"); };
  await assert.rejects(searchAddresses("Dallas", "", { fetch }), (e: unknown) => e instanceof BuildingApiError && e.status === 503);
  await assert.rejects(nearbyBuildings({ lat: NaN, lon: 0 }, undefined, { fetch }), (e: unknown) => e instanceof BuildingApiError && e.status === 400);
});

test("upstream body and exception details containing credentials never leave the provider boundary", async () => {
  const secret = "test-credential-do-not-return";
  for (const fetch of [
    async () => new Response(`upstream url?apiKey=${secret}`, { status: 403 }),
    async () => { throw new Error(`failed https://provider/?apiKey=${secret}`); },
  ]) {
    await assert.rejects(searchAddresses("Dallas", secret, { fetch }), (error: unknown) => {
      assert.ok(error instanceof BuildingApiError);
      assert.equal(error.status, 502);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
});

test("provider timeout, rate limit and response size have controlled errors", async () => {
  await assert.rejects(providerJson("https://example.test", "Test", {}, {
    timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}),
  }), (e: unknown) => e instanceof BuildingApiError && e.status === 504);
  await assert.rejects(providerJson("https://example.test", "Test", {}, {
    fetch: async () => new Response("", { status: 429 }),
  }), (e: unknown) => e instanceof BuildingApiError && e.code === "provider_rate_limited");
  await assert.rejects(providerJson("https://example.test", "Test", {}, {
    maxBytes: 8, fetch: async () => new Response("123456789"),
  }), (e: unknown) => e instanceof BuildingApiError && e.code === "provider_response_too_large");
});

test("Overpass requests use bounded generated queries and preserve raw room fields", async () => {
  const queries: string[] = [];
  const fetch: typeof globalThis.fetch = async (_, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), OVERPASS_USER_AGENT);
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    queries.push(new URLSearchParams(String(init?.body)).get("data")!);
    return Response.json({ elements: [{ type: "node", id: 12, lat: 32, lon: -96, tags: { indoor: "room", name: "Coffee Room", level: "0", "level:ref": "G" } }] });
  };
  const result = await nearbyBuildings({ lat: 32, lon: -96 }, undefined, { fetch });
  await buildingInteriors({ south: 32, west: -96, north: 32.001, east: -95.999 }, undefined, { fetch });
  assert.match(queries[0], /around:150,32,-96/);
  assert.match(queries[1], /\["indoor"\]/);
  assert.match(queries[1], /\["door"\]/);
  assert.match(queries[1], /\["highway"="corridor"\]/);
  assert.match(queries[1], /\(\._;>;\)/);
  assert.equal(result[0].tags?.["level:ref"], "G");
});

test("Overpass outline and interior lookups accept responses taking 32 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  const fetch: typeof globalThis.fetch = async (_, init) => {
    signals.push(init!.signal!);
    const query = new URLSearchParams(String(init?.body)).get("data")!;
    const executionSeconds = Number(/\[timeout:(\d+)\]/.exec(query)?.[1]);
    assert.ok(executionSeconds >= 32 && executionSeconds < 60, "execution budget must allow slow queries and leave time for transfer");
    return new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({ elements: [] })), 32000));
  };
  const pending = Promise.all([
    nearbyBuildings({ lat: 32, lon: -96 }, undefined, { fetch }),
    buildingInteriors({ south: 32, west: -96, north: 32.001, east: -95.999 }, undefined, { fetch }),
  ]);
  t.mock.timers.tick(32000);
  assert.deepEqual(await pending, [[], []]);
  assert.ok(signals.every(signal => !signal.aborted));
});

test("Overpass still aborts stalled requests at 60 seconds and honors explicit shorter timeouts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const timeoutMs of [undefined, 5000]) {
    let signal: AbortSignal | null = null;
    const rejected = assert.rejects(nearbyBuildings({ lat: 32, lon: -96 }, undefined, {
      timeoutMs,
      fetch: async (_, init) => { signal = init!.signal!; return new Promise<Response>(() => {}); },
    }), (e: unknown) => e instanceof BuildingApiError && e.status === 504 && e.code === "provider_timeout");
    t.mock.timers.tick((timeoutMs ?? 60000) - 1);
    assert.equal((signal as AbortSignal | null)?.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal((signal as AbortSignal | null)?.aborted, true);
  }
});

test("Geoapify retains its 10-second default deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(searchAddresses("Dallas", "key", {
    fetch: async () => new Promise<Response>(() => {}),
  }), (e: unknown) => e instanceof BuildingApiError && e.code === "provider_timeout");
  t.mock.timers.tick(10000);
  await rejected;
});

test("Overpass requests identify the app (public instances reject Node's default user agent)", async () => {
  const agents: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (_, init) => {
    agents.push(new Headers(init?.headers).get("user-agent"));
    return Response.json({ elements: [] });
  };
  await nearbyBuildings({ lat: 32, lon: -96 }, undefined, { fetch });
  await buildingInteriors({ south: 32, west: -96, north: 32.001, east: -95.999 }, undefined, { fetch });
  assert.deepEqual(agents, [OVERPASS_USER_AGENT, OVERPASS_USER_AGENT]);
  assert.match(OVERPASS_USER_AGENT, /^FireSight\//);
});

test("Overpass never repairs a polygon by discarding invalid vertices or topology", async () => {
  for (const element of [
    { type: "way", id: 1, tags: { building: "yes" }, geometry: [{ lat: 32, lon: -96 }, { lat: 999, lon: -96 }, { lat: 32.001, lon: -95.999 }, { lat: 32, lon: -96 }] },
    { type: "way", id: 1, nodes: [1, "bad", 3] },
    { type: "relation", id: 1, members: [{ type: "way", ref: "bad", role: "outer" }] },
  ]) {
    await assert.rejects(nearbyBuildings({ lat: 32, lon: -96 }, undefined, {
      fetch: async () => Response.json({ elements: [element] }),
    }), (e: unknown) => e instanceof BuildingApiError && e.code === "provider_invalid_response");
  }
});

test("Overpass runtime remarks are not mistaken for complete results", async () => {
  await assert.rejects(nearbyBuildings({ lat: 32, lon: -96 }, undefined, {
    fetch: async () => Response.json({ elements: [], remark: "runtime error: timeout" }),
  }), (e: unknown) => e instanceof BuildingApiError && e.status === 502);
});
