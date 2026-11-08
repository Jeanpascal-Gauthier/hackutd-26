import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PortfolioBuilding } from "../agent/core/impact/types.ts";
import { PORTFOLIO_PATH, readPortfolio, validatePortfolio } from "./portfolio.ts";

const AGENT_FIXTURE = new URL("../agent/fixtures/portfolio.json", import.meta.url);
const fresh = () => readPortfolio();

test("data/portfolio.json is valid: 8 buildings near Campbell Rd & Coit Rd", () => {
  const p = fresh();
  assert.deepEqual(validatePortfolio(p), []);
  assert.equal(p.length, 8);
  for (const b of p) {
    assert.ok(Math.abs(b.location.lat - 32.975) < 0.05 && Math.abs(b.location.lon + 96.77) < 0.05, `${b.id} is near Richardson TX`);
  }
  assert.ok(p.some((b) => b.use === "data_center"));
});

test("data/portfolio.json matches the agent's fixture exactly (no drift)", () => {
  const agent = JSON.parse(readFileSync(AGENT_FIXTURE, "utf8")) as PortfolioBuilding[];
  assert.deepEqual(JSON.parse(readFileSync(PORTFOLIO_PATH, "utf8")), agent);
});

test("validator catches broken portfolios", () => {
  const bad = (mut: (p: PortfolioBuilding[]) => void, re: RegExp) => {
    const p = fresh();
    mut(p);
    const errors = validatePortfolio(p);
    assert.ok(errors.some((e) => re.test(e)), `${re} not in ${JSON.stringify(errors)}`);
  };
  const sys = (p: PortfolioBuilding[], i = 0) => p[0]!.systems[i]!;
  assert.deepEqual(validatePortfolio({}), ["portfolio must be an array of buildings"]);
  bad((p) => p.push({ ...p[0]! }), /duplicate building id/);
  bad((p) => p[0]!.systems.push({ ...sys(p) }), /duplicate system id/);
  bad((p) => sys(p, 1).dependsOn.push("nope"), /references unknown system nope/);
  bad((p) => (sys(p, 1).backups = ["ghost"]), /references unknown system ghost/);
  bad((p) => p[0]!.tenants[0]!.dependsOn.push("phantom"), /tenant .*references unknown system phantom/);
  bad((p) => {
    // a -> b -> a
    const [a, b] = p[0]!.systems;
    a!.dependsOn = [b!.id];
    b!.dependsOn = [a!.id];
  }, /dependency cycle/);
  bad((p) => (sys(p).damageUsd = -1), /damageUsd must be a number >= 0/);
  bad((p) => (sys(p).restoreHours = Number.NaN), /restoreHours must be a number >= 0/);
  bad((p) => (p[0]!.tenants[0]!.rentPerMonth = -5), /rentPerMonth must be a number >= 0/);
  bad((p) => (p[0]!.occupancy.day = -1), /occupancy/);
  bad((p) => (p[0]!.location = { lat: 132, lon: -96 }), /location/);
  bad((p) => (p[0]!.location = { lat: 0, lon: 0 }), /location/);
  bad((p) => (p[0]!.access.fuelRoute = "Nowhere Ln"), /fuelRoute Nowhere Ln must be one of access.roads/);
  bad((p) => (p[0]!.access.roads = []), /access.roads/);
  bad((p) => ((p[0] as { use: string }).use = "castle"), /use must be one of/);
});
