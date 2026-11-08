import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createBuildingRoutes } from "./routes.ts";
import { createBuildingService } from "./service.ts";

async function request(path: string, method = "GET", body = "") {
  const req = Readable.from([Buffer.from(body)]) as IncomingMessage;
  req.url = path;
  req.method = method;
  let status = 0;
  let value: unknown;
  const res = {
    writeHead(code: number) { status = code; },
    end(raw: string) { value = JSON.parse(raw); },
  } as unknown as ServerResponse;
  const routes = createBuildingRoutes(createBuildingService({ geoapifyApiKey: "", fetch: async () => { throw new Error("Unexpected provider request"); } }));
  const handled = await routes(req, res);
  return { handled, status, body: value as Record<string, unknown> };
}

test("building router leaves unrelated incident paths to the existing router", async () => {
  assert.equal((await request("/building")).handled, false);
  assert.equal((await request("/buildings-extra")).handled, false);
});

test("malformed encoded paths and JSON fail with controlled errors", async () => {
  const path = await request("/buildings/%E0%A4%A");
  assert.equal(path.status, 400);
  assert.equal(path.body.code, "invalid_path");
  const json = await request("/buildings/resolve", "POST", "{");
  assert.equal(json.status, 400);
  assert.equal(json.body.code, "invalid_json");
});

test("request size and geographic bounds are validated before provider access", async () => {
  assert.equal((await request("/buildings/resolve", "POST", "x".repeat(4097))).status, 413);
  assert.equal((await request("/buildings/resolve", "POST", JSON.stringify({ lat: 1000, lon: 0 }))).status, 400);
});

test("provider status exposes configuration only and missing keys have a useful error", async () => {
  const providers = await request("/buildings/providers");
  assert.equal(providers.status, 200);
  assert.equal((providers.body.providers as Record<string, { configured: boolean }>).geoapify.configured, false);
  const search = await request("/buildings/search?q=Public%20Building");
  assert.equal(search.status, 503);
  assert.equal(search.body.code, "geoapify_not_configured");
});
