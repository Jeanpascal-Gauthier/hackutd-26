// classify_blast_radius: the radius table, each modifier and its reason, and the tool wrapper.
//   npx tsx --test core/impact/blastRadius.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { insideImpact, offsetPoint } from "./geo.ts";
import { classifyBlastRadius, classifyBlastRadiusTool, compassWord, maxReachMeters, type BlastSummary } from "./blastRadius.ts";
import type { AgentIncident, ImpactRun } from "./types.ts";

const HERE = { lat: 32.9857, lon: -96.7502 };
/** 15 mph in m/s. */
const MPH15 = 15 / 2.237;

const incident = (over: Partial<AgentIncident> = {}): AgentIncident => ({
  id: "i1",
  kind: "fire",
  severity: "serious",
  location: HERE,
  wind: null,
  ...over,
});

test("compassWord: 8-point words, wraps around", () => {
  assert.equal(compassWord(0), "N");
  assert.equal(compassWord(45), "NE");
  assert.equal(compassWord(225), "SW");
  assert.equal(compassWord(350), "N");
  assert.equal(compassWord(-90), "W");
  assert.equal(compassWord(720 + 180), "S");
});

test("severity ordering for every kind; unknown is treated as serious", () => {
  for (const kind of ["fire", "crash", "flood"] as const) {
    const r = (severity: AgentIncident["severity"]) => classifyBlastRadius(incident({ kind, severity })).radiusMeters;
    assert.ok(r("minor") < r("serious") && r("serious") < r("critical"), kind);
    assert.equal(r("unknown"), r("serious"), kind);
  }
  const unknown = classifyBlastRadius(incident({ severity: "unknown" }));
  assert.ok(unknown.reasons.includes("severity unknown → treated as serious"));
  assert.deepEqual(
    (["minor", "serious", "critical"] as const).map((severity) => classifyBlastRadius(incident({ severity })).radiusMeters),
    [150, 300, 450],
  );
});

test("center is the incident location; radius is rounded to 10 m", () => {
  const out = classifyBlastRadius(incident({ inBuilding: true })); // 300 × 1.33 = 399
  assert.deepEqual(out.center, HERE);
  assert.equal(out.radiusMeters, 400);
});

test("inBuilding makes a fire zone larger, with a reason", () => {
  const outside = classifyBlastRadius(incident());
  const inside = classifyBlastRadius(incident({ inBuilding: true }));
  assert.ok(inside.radiusMeters > outside.radiusMeters);
  assert.ok(inside.reasons.some((r) => /building involved/.test(r)));
});

test("explosion / propane / chemical keywords grow a fire zone ×1.5", () => {
  const out = classifyBlastRadius(incident({ description: "Propane tank EXPLOSION behind the store" }));
  assert.equal(out.radiusMeters, 450);
  assert.ok(out.reasons.some((r) => /propane|explosion/.test(r)));
});

test("wind FROM 225° (SW) stretches the zone toward 45° (NE)", () => {
  const out = classifyBlastRadius(incident({ wind: { speedMps: MPH15, fromDegrees: 225 } }));
  assert.equal(out.stretch?.towardDegrees, 45);
  assert.ok(out.stretch!.factor > 1 && out.stretch!.factor <= 2.5);
  assert.ok(out.reasons.includes("15 mph wind from the SW → stretched downwind to the NE"), out.reasons.join(" | "));
  // A point past the radius reaches the zone downwind, not upwind.
  const far = out.radiusMeters * 1.3;
  assert.ok(insideImpact(out, offsetPoint(HERE, far, 45)));
  assert.ok(!insideImpact(out, offsetPoint(HERE, far, 225)));
});

test("stronger wind stretches further, capped at 2.5", () => {
  const f = (speedMps: number) => classifyBlastRadius(incident({ wind: { speedMps, fromDegrees: 0 } })).stretch?.factor ?? 1;
  assert.ok(f(4) < f(8));
  assert.equal(f(40), 2.5);
  assert.equal(f(1.5), 1); // calm: no stretch
});

test("null wind -> even circle with a reason; falls back to the fire forecast's wind", () => {
  const out = classifyBlastRadius(incident({ wind: null }));
  assert.equal(out.stretch, undefined);
  assert.ok(out.reasons.includes("wind unknown → even circle"));
  const fromForecast = classifyBlastRadius(
    incident({ wind: undefined, fire: { wind: { speedMps: 5, fromDegrees: 90 }, steps: [], exposures: [], summary: "", assumptions: [] } }),
  );
  assert.equal(fromForecast.stretch?.towardDegrees, 270);
});

test("plan example: critical fire, building involved, 15 mph wind -> ~600 m, stretched downwind", () => {
  const out = classifyBlastRadius(incident({ severity: "critical", inBuilding: true, wind: { speedMps: MPH15, fromDegrees: 225 } }));
  assert.equal(out.radiusMeters, 600);
  assert.equal(out.stretch?.towardDegrees, 45);
  assert.ok(maxReachMeters(out) > 900 && maxReachMeters(out) < 1100, `${maxReachMeters(out)}`);
  assert.deepEqual(out.reasons, ["critical fire", "building involved → larger zone", "15 mph wind from the SW → stretched downwind to the NE"]);
});

test("crash: small radius; all lanes blocked cuts road access", () => {
  const out = classifyBlastRadius(incident({ kind: "crash", lanesBlocked: "all" }));
  assert.equal(out.radiusMeters, 100);
  assert.equal(out.stretch, undefined);
  assert.ok(out.reasons.includes("all lanes blocked → road access cut"));
});

test("crash: the modeled queue extends the radius to queue/2", () => {
  const crash = {
    road: "Main St",
    segments: [],
    steps: [
      { minute: 5, queueMeters: 300, roads: ["Main St"] },
      { minute: 15, queueMeters: 800, roads: ["Main St"] },
    ],
    summary: "",
    assumptions: [],
  };
  const out = classifyBlastRadius(incident({ kind: "crash", lanesBlocked: "all", crash }));
  assert.equal(out.radiusMeters, 400);
  assert.ok(out.reasons.some((r) => /queue reaches 800 m on Main St/.test(r)));
});

test("crash: a fuel tanker doubles the zone", () => {
  const out = classifyBlastRadius(incident({ kind: "crash", severity: "critical", description: "fuel tanker rollover" }));
  assert.equal(out.radiusMeters, 300);
  assert.ok(out.reasons.some((r) => /spill/.test(r)));
});

test("flood: the modeled water polygon at the last step sets the radius", () => {
  const ring = (m: number) => [0, 90, 180, 270].map((b) => offsetPoint(HERE, m, b));
  const out = classifyBlastRadius(
    incident({
      kind: "flood",
      severity: "serious",
      source: "water main burst",
      flood: { steps: [{ minute: 10, water: ring(200) }, { minute: 30, water: ring(720) }] },
    }),
  );
  assert.equal(out.radiusMeters, 720);
  assert.ok(out.reasons.includes("modeled water reaches 720 m by minute 30"), out.reasons.join(" | "));
  assert.ok(out.reasons.includes("water main burst: steady flow until valve shut"));
  // A small polygon never shrinks the base radius.
  const small = classifyBlastRadius(incident({ kind: "flood", flood: { steps: [{ minute: 5, water: ring(50) }] } }));
  assert.equal(small.radiusMeters, 350);
});

test("other: pin-sized with a reason", () => {
  const out = classifyBlastRadius(incident({ kind: "other", severity: "critical" }));
  assert.equal(out.radiusMeters, 100);
  assert.ok(out.reasons[0]!.includes("pin-sized"));
});

test("deterministic: same input, same output", () => {
  const i = incident({ severity: "critical", inBuilding: true, wind: { speedMps: 7, fromDegrees: 200 } });
  assert.deepEqual(classifyBlastRadius(i), classifyBlastRadius(i));
});

// ---- the tool wrapper ----

function runWith(incidents: AgentIncident[]): ImpactRun {
  return { incidents, portfolio: [], opts: { horizonMinutes: 30, now: 0 }, impacts: {}, actions: {} };
}

test("schema: classify_blast_radius with a required incident_id", () => {
  const fn = classifyBlastRadiusTool.schema.function;
  assert.equal(fn.name, "classify_blast_radius");
  assert.deepEqual(fn.parameters?.required, ["incident_id"]);
  assert.match(fn.description ?? "", /first/i);
});

test("tool: unknown or missing id -> error listing valid ids, nothing stored", () => {
  const run = runWith([incident({ id: "fire-1" }), incident({ id: "crash-2", kind: "crash" })]);
  const out = classifyBlastRadiusTool.run({ incident_id: "nope" }, run) as { error: string };
  assert.match(out.error, /unknown incident id "nope".*fire-1, crash-2/);
  const missing = classifyBlastRadiusTool.run({}, run) as { error: string };
  assert.match(missing.error, /incident_id must be a non-empty string.*fire-1, crash-2/);
  assert.deepEqual(run.impacts, {});
});

test("tool: stores the impact in run.impacts and returns a small summary", () => {
  const fire = incident({ id: "fire-1", severity: "critical", inBuilding: true, wind: { speedMps: MPH15, fromDegrees: 225 } });
  const run = runWith([fire]);
  const out = classifyBlastRadiusTool.run({ incident_id: " fire-1 " }, run) as BlastSummary;
  assert.deepEqual(run.impacts["fire-1"], classifyBlastRadius(fire));
  assert.equal(out.incidentId, "fire-1");
  assert.equal(out.kind, "fire");
  assert.equal(out.radiusMeters, 600);
  assert.equal(out.stretchedToward, "NE");
  assert.equal(out.maxReachMeters, maxReachMeters(run.impacts["fire-1"]!));
  assert.deepEqual(out.reasons, run.impacts["fire-1"]!.reasons);
  assert.ok(!("center" in out));
  assert.ok(JSON.stringify(out).length < 400, JSON.stringify(out));
});

test("tool: no stretch -> stretchedToward is left out", () => {
  const run = runWith([incident({ id: "c1", kind: "crash" })]);
  const out = classifyBlastRadiusTool.run({ incident_id: "c1" }, run) as BlastSummary;
  assert.equal("stretchedToward" in out, false);
  assert.equal(out.maxReachMeters, out.radiusMeters);
});
