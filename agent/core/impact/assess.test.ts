// No network, no NVIDIA API: the impact orchestrator with a fake chat model and fake tools, the
// headline, fromMapIncident, and (last) the real tools on the demo incidents.
//   npx tsx --test core/impact/assess.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import type { MapIncident } from "@firewatch/shared/types";
import { assessIncident, assessIncidentRules, formatUsd, headlineFor, summarize, type ImpactImpl } from "./assess.ts";
import { estimateCost } from "./cost.ts";
import { fromMapIncident, fromMapIncidents } from "./fromMapIncident.ts";
import type { AffectedProperty, AgentIncident, BlastImpact, FailureStep, ImpactTool, PlannedAction, PortfolioBuilding } from "./types.ts";

// ---- Fakes ----

const FIRE: AgentIncident = { id: "f1", kind: "fire", severity: "critical", location: { lat: 32.99, lon: -96.75 }, inBuilding: true };
const CRASH: AgentIncident = { id: "c1", kind: "crash", severity: "serious", location: { lat: 32.98, lon: -96.74 }, lanesBlocked: "all" };

const DC: PortfolioBuilding = {
  id: "dc-1",
  name: "North DC",
  address: "1 Test Way",
  use: "data_center",
  location: { lat: 32.991, lon: -96.751 },
  elevationM: 200,
  occupancy: { day: 40, night: 12 },
  systems: [
    { id: "hvac", kind: "hvac", label: "Air handlers", dependsOn: [], level: "roof", restoreHours: 4, damageUsd: 50_000 },
    { id: "servers", kind: "servers", label: "Servers", dependsOn: ["hvac"], level: "ground", restoreHours: 8, damageUsd: 200_000 },
  ],
  tenants: [{ name: "Cloud Co", slaPenaltyPerHour: 10_000, rentPerMonth: 73_000, dependsOn: ["servers"] }],
  access: { roads: ["Main St"] },
};
const OFFICE: PortfolioBuilding = { ...DC, id: "of-1", name: "Office One", use: "office", tenants: [], occupancy: { day: 300, night: 5 } };
const PORTFOLIO = [DC, OFFICE];

const CHAIN: FailureStep[] = [
  { id: "dc-1:hvac", minute: 6, systemId: "hvac", label: "Smoke reaches HVAC intake", hazard: "smoke", causedBy: null, incidentId: "f1" },
  { id: "dc-1:servers", minute: 12, systemId: "servers", label: "Servers overheat", hazard: "heat", causedBy: "dc-1:hvac", incidentId: "f1" },
];
const DC_COST = estimateCost(DC, CHAIN);

const fakeImpact = (i: AgentIncident): BlastImpact => ({ center: i.location, radiusMeters: 400, reasons: [`${i.severity} ${i.kind}`] });
const fakeProperties = (): AffectedProperty[] => [
  {
    id: "dc-1",
    name: "North DC",
    use: "data_center",
    location: DC.location,
    risk: "high",
    incidentIds: ["f1"],
    chain: CHAIN,
    people: 40,
    downtimeHours: DC_COST.downtimeHours,
    cost: DC_COST,
    accessCut: false,
    actions: [],
    reasons: ["downwind of the fire"],
  },
  {
    id: "of-1",
    name: "Office One",
    use: "office",
    location: OFFICE.location,
    risk: "low",
    incidentIds: ["f1"],
    chain: [],
    people: 300,
    downtimeHours: 0,
    cost: { slaUsd: 0, lostRentUsd: 0, damageUsd: 0, totalUsd: 0 },
    accessCut: false,
    actions: [],
    reasons: ["inside the smoke radius"],
  },
];
const fakePlan = (p: AffectedProperty): PlannedAction[] =>
  p.id === "dc-1"
    ? [
        {
          id: "dc-1:close-dampers",
          text: "Close outside-air dampers",
          deadlineMinute: 4,
          prevents: ["dc-1:hvac"],
          savesUsd: DC_COST.totalUsd,
          reason: "Keeps smoke out of the air handlers",
          status: "pending",
        },
      ]
    : [];

const schema = (name: string): ImpactTool["schema"] => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

/** Fake impact tools with the real tools' names and scratchpad writes. `calls` counts runs. */
function fakeImpl(opts: { assessThrows?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const count = (n: string) => (calls[n] = (calls[n] ?? 0) + 1);
  const impl: ImpactImpl = {
    classify: fakeImpact,
    assess: () => {
      if (opts.assessThrows) throw new Error("assess exploded");
      return fakeProperties();
    },
    plan: (p) => fakePlan(p),
    tools: [
      {
        schema: schema("classify_blast_radius"),
        run(args, run) {
          count("classify_blast_radius");
          const inc = run.incidents.find((i) => i.id === args.incident_id);
          if (!inc) return { error: `unknown incident id ${String(args.incident_id)}` };
          run.impacts[inc.id] = fakeImpact(inc);
          return { incidentId: inc.id, radiusMeters: 400 };
        },
      },
      {
        schema: schema("assess_property_impact"),
        run(_args, run) {
          count("assess_property_impact");
          if (opts.assessThrows) throw new Error("assess exploded");
          run.properties = fakeProperties();
          return { count: run.properties.length };
        },
      },
      {
        schema: schema("plan_actions"),
        run(args, run) {
          count("plan_actions");
          if (!run.properties) return { error: "call assess_property_impact first" };
          const ids = Array.isArray(args.property_ids) ? (args.property_ids as string[]) : undefined;
          for (const p of run.properties) if (!ids || ids.includes(p.id)) run.actions[p.id] = fakePlan(p);
          return { planned: Object.keys(run.actions) };
        },
      },
    ],
  };
  return { impl, calls };
}

type Call = { name: string; args: Record<string, unknown> | string };
/** One model turn: tool calls, final text, an error to throw, or a delay (ms) before answering "late". */
type Turn = Call[] | string | Error | { delayMs: number };

function fakeLlm(turns: Turn[]) {
  const requests: { messages: { role: string; content?: unknown }[] }[] = [];
  let i = 0;
  const llm = {
    chat: {
      completions: {
        create: async (req: { messages: unknown[] }) => {
          requests.push(structuredClone(req) as (typeof requests)[number]);
          const turn = turns[i++] ?? "";
          if (turn instanceof Error) throw turn;
          if (!Array.isArray(turn) && typeof turn === "object") {
            await new Promise((r) => setTimeout(r, turn.delayMs));
            return { choices: [{ message: { role: "assistant", content: "late" } }] };
          }
          const calls = Array.isArray(turn) ? turn : [];
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: typeof turn === "string" ? turn : null,
                  tool_calls: calls.map((c, j) => ({
                    id: `t${i}-${j}`,
                    type: "function",
                    function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
                  })),
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { llm, requests };
}

const tools = (r: { trail: { tool: string }[] }) => r.trail.map((s) => s.tool);

// ---- The money and the headline ----

test("formatUsd: K under $1M (nearest $10K from $100K), M from $1M", () => {
  assert.equal(formatUsd(380_000), "~$380K");
  assert.equal(formatUsd(384_999), "~$380K");
  assert.equal(formatUsd(385_000), "~$390K");
  assert.equal(formatUsd(45_400), "~$45K");
  assert.equal(formatUsd(1_240_000), "~$1.2M");
  assert.equal(formatUsd(2_000_000), "~$2M");
  assert.equal(formatUsd(999_999), "~$1M");
  assert.equal(formatUsd(640), "~$640");
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(Number.NaN), "$0");
});

test("headline: exact form, thousands separators, singulars", () => {
  assert.equal(headlineFor(6, 1240, 380_000, 30), "6 buildings · 1,240 people · ~$380K at risk in the next 30 min");
  assert.equal(headlineFor(1, 1, 1_240_000, 60), "1 building · 1 person · ~$1.2M at risk in the next 60 min");
});

test("summarize: totals, and usdAtRiskAfterActions uses residualCost with the done ids", () => {
  const props = fakeProperties().map((p) => ({ ...p, actions: fakePlan(p) }));
  const before = summarize(props, 30, [], PORTFOLIO);
  assert.equal(before.buildings, 2);
  assert.equal(before.people, 340);
  assert.equal(before.usdAtRisk, DC_COST.totalUsd);
  assert.equal(before.usdAtRiskAfterActions, DC_COST.totalUsd);
  const after = summarize(props, 30, ["dc-1:close-dampers"], PORTFOLIO);
  assert.equal(after.usdAtRiskAfterActions, 0, "dampers stop hvac, and servers follow from it");
  assert.equal(after.headline, before.headline);
  // Without the portfolio: savesUsd subtracted instead.
  assert.equal(summarize(props, 30, ["dc-1:close-dampers"]).usdAtRiskAfterActions, 0);
});

// ---- The rules path ----

test("assessIncidentRules: classify each, assess, plan; trail like tool calls; templated briefing", () => {
  const { impl } = fakeImpl();
  const r = assessIncidentRules([FIRE, CRASH], PORTFOLIO, { impl, doneActionIds: ["dc-1:close-dampers"] });
  assert.equal(r.mode, "rules");
  assert.deepEqual(tools(r), ["classify_blast_radius", "classify_blast_radius", "assess_property_impact", "plan_actions"]);
  assert.deepEqual(r.trail[0]?.input, { incident_id: "f1" });
  assert.deepEqual(Object.keys(r.impacts), ["f1", "c1"]);
  assert.equal(r.affectedProperties[0]?.actions[0]?.status, "done");
  assert.equal(r.summary.usdAtRiskAfterActions, 0);
  assert.match(r.briefing, /North DC is most at risk/);
  assert.match(r.briefing, /Smoke reaches HVAC intake at minute 6/);
  assert.match(r.briefing, /Close outside-air dampers by minute 4/);
  assert.match(r.briefing, /2 buildings · 340 people/);
});

test("assessIncidentRules: never throws on bad input", () => {
  const bad = assessIncidentRules(null as unknown as AgentIncident[], PORTFOLIO);
  assert.equal(bad.affectedProperties.length, 0);
  assert.match(bad.briefing, /No incidents/);
  assert.equal(bad.summary.headline, "0 buildings · 0 people · $0 at risk in the next 30 min");
  const noLoc = assessIncidentRules([{ id: "x", kind: "fire" } as unknown as AgentIncident], PORTFOLIO);
  assert.match(noLoc.briefing, /location/);
  assert.match(assessIncidentRules([FIRE], undefined as unknown as PortfolioBuilding[]).briefing, /No portfolio buildings/);
  const { impl } = fakeImpl({ assessThrows: true });
  const broken = assessIncidentRules([FIRE], PORTFOLIO, { impl });
  assert.equal(broken.affectedProperties.length, 0);
  assert.deepEqual(broken.trail[1]?.output, { error: "assess exploded" });
});

// ---- The Nemotron path ----

test("assessIncident: the model calls the three tools in order -> mode llm, complete, model briefing", async () => {
  const { impl } = fakeImpl();
  const { llm, requests } = fakeLlm([
    [{ name: "classify_blast_radius", args: { incident_id: "f1" } }],
    [{ name: "assess_property_impact", args: {} }],
    [{ name: "plan_actions", args: {} }],
    "North DC loses HVAC at minute 6; close the dampers by minute 4 to save ~$300K.",
  ]);
  const r = await assessIncident([FIRE], PORTFOLIO, { llm, impl });
  assert.equal(r.mode, "llm");
  assert.deepEqual(tools(r), ["classify_blast_radius", "assess_property_impact", "plan_actions"]);
  assert.equal(r.affectedProperties.length, 2);
  assert.equal(r.affectedProperties[0]?.actions.length, 1);
  assert.equal(r.briefing, "North DC loses HVAC at minute 6; close the dampers by minute 4 to save ~$300K.");
  assert.equal(requests.length, 4);
  const user = String(requests[0]?.messages[1]?.content);
  assert.match(user, /incident_id f1: fire at 32\.99000, -96\.75000/);
});

test("assessIncident: the model skips plan_actions -> still complete (filled by rules)", async () => {
  const { impl } = fakeImpl();
  const { llm } = fakeLlm([[{ name: "classify_blast_radius", args: { incident_id: "f1" } }], [{ name: "assess_property_impact", args: {} }], "done"]);
  const r = await assessIncident([FIRE, CRASH], PORTFOLIO, { llm, impl });
  assert.equal(r.mode, "llm");
  assert.deepEqual(tools(r), ["classify_blast_radius", "assess_property_impact", "classify_blast_radius", "plan_actions"]);
  assert.ok(r.impacts.c1, "missing impact classified");
  assert.equal(r.affectedProperties[0]?.actions[0]?.id, "dc-1:close-dampers");
});

test("assessIncident: the LLM throws -> rules, reason in the trail", async () => {
  const { impl } = fakeImpl();
  const { llm } = fakeLlm([new Error("HTTP 503")]);
  const r = await assessIncident([FIRE], PORTFOLIO, { llm, impl });
  assert.equal(r.mode, "rules");
  assert.equal(r.trail[0]?.tool, "nemotron");
  assert.deepEqual(r.trail[0]?.output, { error: "HTTP 503", fallback: "rules" });
  assert.deepEqual(tools(r).slice(1), ["classify_blast_radius", "assess_property_impact", "plan_actions"]);
  assert.equal(r.affectedProperties[0]?.actions.length, 1);
});

test("assessIncident: timeout -> rules", async () => {
  const { impl } = fakeImpl();
  const { llm } = fakeLlm([{ delayMs: 300 }]);
  const started = Date.now();
  const r = await assessIncident([FIRE], PORTFOLIO, { llm, impl, timeoutMs: 40 });
  assert.ok(Date.now() - started < 250, "does not wait for the model");
  assert.equal(r.mode, "rules");
  assert.match(String((r.trail[0]?.output as { error: string }).error), /timed out after 40 ms/);
  assert.equal(r.affectedProperties.length, 2);
});

test("assessIncident: no NVIDIA_API_KEY -> rules", async () => {
  const saved = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    const { impl } = fakeImpl();
    const r = await assessIncident([FIRE], PORTFOLIO, { impl });
    assert.equal(r.mode, "rules");
    assert.match(JSON.stringify(r.trail[0]?.output), /NVIDIA_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.NVIDIA_API_KEY = saved;
  }
});

test("assessIncident: unknown tool and bad JSON args -> error outputs in the trail, no crash", async () => {
  const { impl } = fakeImpl();
  const { llm } = fakeLlm([
    [
      { name: "launch_drones", args: {} },
      { name: "classify_blast_radius", args: "{incident_id: f1" },
    ],
    [{ name: "classify_blast_radius", args: { incident_id: "f1" } }],
    "x".repeat(700), // too long for a briefing: the templated one is used
  ]);
  const r = await assessIncident([FIRE], PORTFOLIO, { llm, impl });
  assert.equal(r.mode, "llm");
  assert.deepEqual(r.trail[0]?.output, { error: "unknown tool launch_drones" });
  assert.match(String((r.trail[1]?.output as { error: string }).error), /not a JSON object/);
  assert.equal(r.trail[1]?.input, "{incident_id: f1");
  assert.deepEqual(tools(r).slice(2), ["classify_blast_radius", "assess_property_impact", "plan_actions"]);
  assert.match(r.briefing, /North DC is most at risk/);
});

test("assessIncident: the model calls no tools -> rules", async () => {
  const { impl } = fakeImpl();
  const { llm } = fakeLlm(["Everything is fine."]);
  const r = await assessIncident([FIRE], PORTFOLIO, { llm, impl });
  assert.equal(r.mode, "rules");
  assert.match(r.briefing, /North DC/);
});

// ---- fromMapIncident ----

const mapIncident = (extra: Partial<MapIncident> = {}): MapIncident => ({
  id: "m1",
  kind: "crash",
  label: "Car crash",
  severity: "serious",
  status: "located",
  location: { lat: 32.98, lon: -96.74 },
  reports: [
    { caller: "+1", text: "two cars on Main", time: 1 },
    { caller: "+2", text: "crash at Main and 5th", time: 2 },
  ],
  time: 1,
  updated: 2,
  phase: "open",
  forecastStatus: "ready",
  ...extra,
});

test("fromMapIncident: no location -> null", () => {
  assert.equal(fromMapIncident(mapIncident({ location: undefined, status: "locating" })), null);
  assert.deepEqual(fromMapIncidents([mapIncident({ location: undefined }), mapIncident({ id: "m2" })]).map((i) => i.id), ["m2"]);
});

test("fromMapIncident: crash segments -> affectedRoads (blocked/heavy only); calls = reports", () => {
  const a = { lat: 1, lon: 1 };
  const i = fromMapIncident(
    mapIncident({
      lanesBlocked: "all",
      crash: {
        road: "Main St",
        segments: [
          { path: [a], road: "Main St", queueMinute: 0, level: "blocked" },
          { path: [a], road: "Main St", queueMinute: 8, level: "heavy" },
          { path: [a], road: "5th St", queueMinute: 12, level: "moderate" },
        ],
        steps: [],
        summary: "",
        assumptions: [],
      },
    }),
  );
  assert.ok(i);
  assert.deepEqual(i.affectedRoads, [
    { path: [a], road: "Main St", reason: "crash", fromMinute: 0 },
    { path: [a], road: "Main St", reason: "crash", fromMinute: 8 },
  ]);
  assert.equal(i.calls, 2);
  assert.equal(i.lanesBlocked, "all");
  assert.equal(i.description, "Car crash: two cars on Main");
  // Step 0 roads win when given.
  const given = [{ path: [a], road: "X", reason: "closure" as const, fromMinute: 3 }];
  assert.deepEqual(fromMapIncident({ ...mapIncident(), affectedRoads: given })?.affectedRoads, given);
});

test("fromMapIncident: wind from the fire forecast; Step 0 fields pass through", () => {
  const wind = { speedMps: 6.7, fromDegrees: 225 };
  const fire = fromMapIncident(
    mapIncident({ kind: "fire", label: "Fire", inBuilding: true, fire: { wind, steps: [], exposures: [], summary: "", assumptions: [] } }),
  );
  assert.deepEqual(fire?.wind, wind);
  assert.equal(fire?.inBuilding, true);
  assert.equal(fire?.affectedRoads, undefined);
  const flood = fromMapIncident({ ...mapIncident(), kind: "flood", label: "Water main burst", related: ["m9"], zoneId: "z1" });
  assert.equal(flood?.kind, "flood");
  assert.equal(flood?.source, "Water main burst");
  assert.deepEqual(flood?.related, ["m9"]);
  assert.equal(flood?.zoneId, "z1");
  assert.equal(flood?.wind, undefined);
});
