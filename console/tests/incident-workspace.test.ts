import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncidentState, MapIncident } from "@firewatch/shared/types";
import type { ActiveBuilding } from "../src/activeBuilding";
import { buildingDecisions, buildQueue, ownsBuilding } from "../src/incidents";
import { buildResponderBrief } from "../src/buildResponderBrief";
import { followUpQuestions, situationChecks, situationText } from "../src/incidentChecks";

const active = { isDemo: true, roomsById: new Map(), profile: { name: "Demo building" } } as ActiveBuilding;
const incident = (changes: Partial<MapIncident> = {}): MapIncident => ({
  id: "fire-1", kind: "fire", label: "Fire", severity: "serious", status: "located",
  query: "1200 Main St", formatted: "1200 Main Street, Dallas", location: { lat: 32.78, lon: -96.8 },
  reports: [], time: 1000, updated: 1000, phase: "open", forecastStatus: "none", ...changes,
});
const state = (changes: Partial<IncidentState> = {}): IncidentState => ({ simMinute: 0, rooms: [], reports: [], occupants: [], ...changes });

test("incident checks flag missing coordinates even when a stale status says located", () => {
  const current = incident({ location: undefined, severity: "unknown" });
  const checks = situationChecks(current);
  assert.equal(checks.find((check) => check.label === "Location")?.attention, true);
  assert.match(checks.find((check) => check.label === "Location")!.value, /needs confirmation/);
  assert.match(followUpQuestions(current)[0]!, /exact address/);
});

test("crash follow-up asks about vehicles and lanes without borrowing fire evacuation tools", () => {
  const current = incident({ id: "crash-2", kind: "crash", label: "Car crash", lanesBlocked: "all" });
  const questions = followUpQuestions(current).join("\n");
  assert.match(questions, /vehicles/);
  assert.match(questions, /direction and lanes/);
  assert.doesNotMatch(questions, /stair|floor|evacuat/i);
  assert.equal(situationChecks(current).find((check) => check.label === "Road obstruction")?.attention, true);
});

test("general emergency tools retain unknowns and do not fabricate a type-specific model", () => {
  const current = incident({ id: "flood-1", kind: "other", label: "Flooding", status: "needs_location", location: undefined, formatted: undefined });
  const snapshot = situationText(current);
  assert.match(snapshot, /Flooding · flood-1/);
  assert.match(snapshot, /not independently verified/);
  assert.match(snapshot, /Location needs confirmation/);
  assert.doesNotMatch(snapshot, /Stair|wind|queue|Smoke/);
  assert.doesNotMatch(followUpQuestions(current).join("\n"), /vehicles|flames|stair/i);
});

test("closed incidents without dispatch records are not flagged as awaiting a response", () => {
  const response = situationChecks(incident({ phase: "resolved", dispatches: [] })).find((check) => check.label === "Response")!;
  assert.equal(response.attention, false);
  assert.equal(response.value, "Resolved");
  assert.match(response.source, /Incident closed/);
});

test("queue prioritizes critical incidents, separates resolved, and does not invent a building fire", () => {
  const queue = buildQueue(state({ mapIncidents: [
    incident(), incident({ id: "crash-1", kind: "crash", severity: "critical", time: 500 }),
    incident({ id: "closed", severity: "critical", phase: "resolved", time: 2000 }),
  ] }), active);
  assert.deepEqual(queue.active.map((entry) => entry.key), ["crash-1", "fire-1"]);
  assert.deepEqual(queue.resolved.map((entry) => entry.key), ["closed"]);
  assert.equal(queue.building, null);
});

test("building ownership requires an indoor fire at the lookup address", () => {
  const current = state({ buildingLookup: { query: " 1200  MAIN ST ", status: "active", candidates: [], time: 1000 } });
  assert.equal(ownsBuilding(incident({ inBuilding: true }), current), true);
  assert.equal(ownsBuilding(incident({ inBuilding: false }), current), false);
  assert.equal(ownsBuilding(incident({ kind: "crash", inBuilding: true }), current), false);
  assert.equal(ownsBuilding(incident({ inBuilding: true, query: "1300 Main St" }), current), false);
});

test("building actions exclude legacy slots that mirror map recommendations after JSON transport", () => {
  const recommendation = { actions: ["Send police to the crash."] };
  const accepted = { recommendation, time: 5000 };
  const current = JSON.parse(JSON.stringify(state({ recommendation, accepted, mapIncidents: [incident({ kind: "crash", recommendation, accepted })] }))) as IncidentState;
  assert.deepEqual(buildingDecisions(current), { recommendation: undefined, accepted: undefined });
});

test("a building recommendation remains visible beside unrelated map actions", () => {
  const recommendation = { actions: ["Use Stair A."] };
  const accepted = { recommendation, time: 5000 };
  const decisions = buildingDecisions(state({ recommendation, accepted, mapIncidents: [incident({ recommendation: { actions: ["Send fire crews."] } })] }));
  assert.equal(decisions.recommendation, recommendation);
  assert.equal(decisions.accepted, accepted);
});

test("brief includes only caller statements despite populated forecasts and response records", () => {
  const brief = buildResponderBrief(incident({
    kind: "crash", label: "Car crash", lanesBlocked: "all", forecastStatus: "ready", forecastAt: 1000,
    reports: [{ caller: "Alex", text: "Two vehicles blocking the intersection.", time: 1000, reply: "Help is on the way." }],
    crash: { road: "Main St", steps: [], segments: [], summary: "Queue may grow upstream.", assumptions: ["Alternates do not include live traffic."], alternateRoads: ["Elm St"] },
    phase: "dispatched", dispatches: [{ unit: "Engine 3", time: 2000 }],
    recommendation: { actions: ["Close Main St."] },
    accepted: { recommendation: { actions: ["Approach from Elm St."] }, time: 2000 },
    notes: [{ text: "Approach from the south", time: 2000 }],
  }));
  assert.equal(brief.text, "Reported location\n1200 Main St\n\nCallers report\nAlex: Two vehicles blocking the intersection.");
});

test("brief does not infer severity or indoor fire conditions from incident fields", () => {
  const brief = buildResponderBrief(incident({
    inBuilding: true, severity: "critical", label: "Building fire",
    reports: [{ caller: "Sam", text: "I think I smell smoke. I don't know where it is.", time: 1000 }],
    fire: { wind: { speedMps: 5, fromDegrees: 180 }, steps: [], exposures: [], summary: "Smoke reaches the school in 5 minutes.", assumptions: ["Fire is spreading."] },
    forecastStatus: "ready",
  }));
  assert.equal(brief.text, "Reported location\n1200 Main St\n\nCallers report\nSam: I think I smell smoke. I don't know where it is.");
});

test("brief uses the stated location even when geocoding is incomplete or disagrees", () => {
  for (const status of ["needs_location", "locating", "failed", "located"] as const) {
    const brief = buildResponderBrief(incident({ status, query: "old mill", formatted: "Different Mill, Dallas" }));
    assert.equal(brief.text, "Reported location\nold mill");
  }
});

test("missing caller details do not fall back to generated labels or geocoded locations", () => {
  const brief = buildResponderBrief(incident({ query: undefined, forecastStatus: "running" }));
  assert.deepEqual(brief.sections, []);
  assert.equal(brief.text, "");
});

test("brief retains early details, follow-up answers, corrections, and caller uncertainty in order", () => {
  const texts = [
    "Someone is trapped upstairs.", "I think there are two people.", "I cannot see the stairs.",
    "I'm outside now.", "Correction: three people, not two.", "The gate code is 1234.",
  ];
  const brief = buildResponderBrief(incident({
    reports: texts.map((text, index) => ({ caller: "Alex", text, time: 1000 + index })),
  }));
  assert.deepEqual(brief.sections[1]!.lines, texts.map((text) => `Alex: ${text}`));
});

test("brief compacts whitespace without rewriting or truncating caller details", () => {
  const brief = buildResponderBrief(incident({
    query: "  1200   Main St  ",
    reports: [
      { caller: "Alex", text: "  Smoke in the kitchen.\n  No flames that I can see.  ", time: 1000 },
      { caller: "Alex", text: " \n ", time: 1001 },
    ],
  }));
  assert.equal(brief.text, "Reported location\n1200 Main St\n\nCallers report\nAlex: Smoke in the kitchen. No flames that I can see.");
});
