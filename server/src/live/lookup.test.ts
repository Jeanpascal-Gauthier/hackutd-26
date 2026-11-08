import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReportProcessor } from "../state/processor.ts";
import { DEMO } from "./buildingData.ts";
import { HOLD_REPLY, normalizeQuery } from "./lookup.ts";
import { coveredBy } from "./address.ts";
import { ADDRESS, ELEMENTS, fakeApp, gate, match } from "../testing/lookupFakes.ts";
import { parseClientEvent, applyClientEvent } from "../state/actions.ts";
import { loadOccupancyEstimator } from "../agent/bridge.ts";

const quiet = <T>(fn: () => Promise<T>) => async () => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
};

test("the server starts on the demo building, version 1, with no lookup", () => {
  const { app } = fakeApp();
  assert.deepEqual(app.store.get().building, { id: "demo", name: DEMO.building.profile.name, version: 1, layoutEstimated: false });
  assert.equal(app.store.get().buildingLookup, undefined);
  assert.equal(app.store.get().rooms.length, DEMO.building.rooms.length);
});

test("lookup -> needs_confirmation with summarized candidates, nearest first; the operator always confirms", quiet(async () => {
  const { app, world } = fakeApp();
  const started = app.lookups.lookupAddress(`  ${ADDRESS} `, "+15550100");
  assert.ok(started.ok);
  assert.equal(started.lookup?.status, "searching");
  assert.equal(started.lookup?.query, ADDRESS);
  assert.equal(started.lookup?.caller, "+15550100");
  assert.equal(app.lookups.holdReply(), HOLD_REPLY);
  await app.lookups.idle();

  const l = app.store.get().buildingLookup!;
  assert.equal(l.status, "needs_confirmation");
  assert.deepEqual(l.match, { formatted: match().formatted, lat: match().lat, lon: match().lon });
  assert.deepEqual(l.candidates.map((c) => c.id), ["osm:way:200", "osm:way:100"], "nearest first");
  assert.equal(l.candidates[1].name, "Science Hall");
  assert.equal(app.store.get().building?.id, "demo", "nothing activates before the operator confirms");
  assert.equal(world.calls.geoapify, 1);
  assert.ok(app.store.get().log!.some((e) => e.kind === "building" && /Looking up address/.test(e.text)));

  // One outline still needs confirmation.
  const one = fakeApp();
  one.world.outlines.set(`${match().lat},${match().lon}`, [ELEMENTS[0]]);
  one.app.lookups.lookupAddress(ADDRESS);
  await one.app.lookups.idle();
  assert.equal(one.app.store.get().buildingLookup?.status, "needs_confirmation");
  assert.equal(one.app.store.get().buildingLookup?.candidates.length, 1);
}));

test("the same query (any spacing or case) is ignored unless the last attempt failed", quiet(async () => {
  const { app, world } = fakeApp();
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  const before = app.store.get().buildingLookup;
  const again = app.lookups.lookupAddress(ADDRESS.toUpperCase().replace(/ /g, "   "));
  assert.ok(again.ok && again.unchanged);
  // The geocoded form of the address counts as the same query too.
  assert.ok((app.lookups.lookupAddress(match().formatted) as { unchanged?: boolean }).unchanged);
  assert.equal(app.store.get().buildingLookup, before);
  assert.equal(world.calls.geoapify, 1);
  assert.equal(normalizeQuery("  A  b "), "a b");

  // The same address said another way (spelled out, or shorter) is a repeat too: it must not
  // reset the operator's confirmation.
  for (const said of ["800 West Campbell Road, Richardson", "800 w. campbell rd", "800 West Campbell Rd Richardson TX"])
    assert.equal((app.lookups.lookupAddress(said) as { unchanged?: boolean }).unchanged, true, said);
  assert.equal(app.store.get().buildingLookup, before);
  assert.equal(world.calls.geoapify, 1, "spelled-out and shorter forms start no new geocode");

  // After a failure, the same query is retried.
  const failing = fakeApp();
  failing.world.geoapifyDown = true;
  failing.app.lookups.lookupAddress(ADDRESS);
  await failing.app.lookups.idle();
  assert.equal(failing.app.store.get().buildingLookup?.status, "failed");
  failing.world.geoapifyDown = false;
  const retry = failing.app.lookups.lookupAddress(ADDRESS);
  assert.ok(retry.ok && !retry.unchanged);
  await failing.app.lookups.idle();
  assert.equal(failing.app.store.get().buildingLookup?.status, "needs_confirmation");
}));

test("coveredBy: same address said another way or shorter; one that adds detail is new", () => {
  assert.ok(coveredBy("800 West Campbell Road", "800 W Campbell Rd, Richardson, TX"));
  assert.ok(coveredBy("800 w. campbell rd, richardson", "800 West Campbell Road, Richardson, TX 75080, United States"));
  assert.ok(!coveredBy("100 Main St, Plano", "100 Main St"), "adds the city: a correction, so a new lookup");
  assert.ok(!coveredBy("801 W Campbell Rd", "800 W Campbell Rd"));
  assert.ok(!coveredBy("800", "8000 Main St"), "whole tokens only");
  assert.ok(!coveredBy("the", "800 Main St"), "filler only says nothing");
});

test("a newer lookup supersedes an older one still in flight", quiet(async () => {
  const { app, world } = fakeApp();
  const slow = gate();
  world.gates.set("old street 1, dallas", slow.promise);
  world.geocode.set("old street 1, dallas", [match(33, -97, "Old Street 1, Dallas")]);
  app.lookups.lookupAddress("Old Street 1, Dallas");
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "needs_confirmation");
  slow.open();
  await new Promise((r) => setTimeout(r, 20));
  const l = app.store.get().buildingLookup!;
  assert.equal(l.query, ADDRESS, "the stale result did not overwrite the newer lookup");
  assert.equal(l.match?.formatted, match().formatted);
}));

test("a failed lookup keeps the incident on the previous building", quiet(async () => {
  const { app, world } = fakeApp();
  await app.ingest({ text: "smoke in the break room on the 7th floor", caller: "+1" });
  const before = app.store.get();
  world.geocode.set("nowhere at all", []);
  app.lookups.lookupAddress("nowhere at all");
  await app.lookups.idle();
  const after = app.store.get();
  assert.equal(after.buildingLookup?.status, "failed");
  assert.match(after.buildingLookup!.error!, /No address found/);
  assert.deepEqual(after.building, before.building);
  assert.equal(after.origin?.roomId, "7-break", "the incident is untouched");
  assert.equal(after.rooms.length, DEMO.building.rooms.length);
  assert.equal(app.lookups.holdReply(), undefined, "a failed lookup holds nothing");

  world.geoapifyDown = true;
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "failed");
  assert.equal(app.store.get().building?.id, "demo");
}));

test("confirm -> active building, version + 1, estimated occupants, estimate_occupancy trail step", quiet(async () => {
  const { app, fakes } = fakeApp();
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  assert.equal(app.lookups.confirmBuilding("osm:way:999").ok, false, "only a listed candidate");
  const confirmed = app.lookups.confirmBuilding("osm:way:100");
  assert.ok(confirmed.ok);
  assert.equal(app.store.get().buildingLookup?.status, "loading");
  await app.lookups.idle();

  const s = app.store.get();
  assert.equal(s.buildingLookup?.status, "active");
  assert.deepEqual(s.building, { id: "osm:way:100", name: "Science Hall", version: 2, layoutEstimated: true });
  assert.equal(fakes.synthCalls.length, 1);
  assert.equal(fakes.synthCalls[0].record.id, "osm:way:100");
  assert.deepEqual(fakes.synthCalls[0].options, { address: match().formatted, timezone: "America/Chicago" });
  assert.deepEqual(s.rooms.map((r) => r.roomId), app.active.get().building.rooms.map((r) => r.id));
  assert.ok(s.rooms.every((r) => r.fire === 0 && r.smoke === 0));
  assert.equal(s.occupants.reduce((n, o) => n + o.count, 0), 20);
  assert.ok(s.occupants.every((o) => o.estimated === true));
  const step = s.trail!.at(-1)!;
  assert.equal(step.tool, "estimate_occupancy");
  assert.deepEqual(step.input, { buildingId: "osm:way:100", use: "office", localTime: "Sun 14:05" });
  assert.deepEqual(step.output, { total: 20, byFloor: { "1": 8, "2": 12 }, basis: ["office", "weekend afternoon: 15% of design occupancy"] });
  const building = s.log!.filter((e) => e.kind === "building").map((e) => e.text);
  assert.ok(building.some((t) => /Active building: Science Hall/.test(t)), building.join("\n"));
  assert.ok(building.some((t) => /Estimated 20 people/.test(t)));
  assert.equal(app.active.get().inspections.length, 0, "no inspection records for public buildings");
  assert.equal(app.lookups.holdReply(), undefined);

  // The spread model and exits run on it.
  await app.ingest({ text: "fire in the break room on floor 2", caller: "+2" });
  assert.equal(app.store.get().origin?.roomId, "2-break");
  assert.ok(app.store.get().exits!.length > 0);
  assert.ok(app.store.get().recommendation);
}));

test("reports during a lookup are held with the fixed reply, then located on the new building", quiet(async () => {
  const { app } = fakeApp();
  let calls = 0;
  const counting: ReportProcessor = (input) => {
    calls++;
    return app.live.processor(input);
  };
  app.setReportProcessor(counting);
  await app.ingest({ text: "smoke on the 7th floor break room", caller: "+0" }); // before the lookup: demo building
  assert.equal(calls, 1);

  app.lookups.lookupAddress(ADDRESS, "+1");
  const searching = await app.ingest({ text: "smoke in the break room on floor 2", caller: "+1" });
  await app.lookups.idle();
  const waiting = await app.ingest({ text: "fire by the desks on the second floor", caller: "+2", channel: "voice" });
  for (const held of [searching, waiting]) {
    assert.equal(held.reply, HOLD_REPLY);
    assert.equal(held.report.roomId, undefined);
    assert.ok(held.held);
  }
  // A preprocessed (agent-process) result is held too: it was located on the old building.
  const pre = await app.ingest({ text: "flames on 7", caller: "+3", preprocessed: { roomId: "7-break", confidence: 0.9 } });
  assert.equal(pre.report.roomId, undefined);
  assert.equal(calls, 1, "held reports are not located against the old building");
  assert.equal(app.store.get().origin?.roomId, "7-break", "nothing new merged while held");

  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  const s = app.store.get();
  assert.equal(calls, 4, "each held report re-processed once, after activation");
  assert.deepEqual(s.reports.map((r) => [r.caller, r.roomId]), [["+1", "2-break"], ["+2", "2-office"], ["+3", undefined]]);
  assert.ok(s.reports.slice(0, 2).every((r) => r.reply === HOLD_REPLY), "callers are not sent anything new");
  assert.equal(s.reports[1].channel, "voice");
  assert.ok(["2-break", "2-office"].includes(s.origin!.roomId));
  assert.ok(s.rooms.some((r) => r.fire > 0));
  assert.ok(s.exits!.length > 0 && s.recommendation);
  assert.ok(s.log!.some((e) => /Held report from \+1 located: 2-break/.test(e.text)));
}));

test("a processor result naming a room the active building lacks falls back to the locator", quiet(async () => {
  const { app } = fakeApp();
  app.setReportProcessor(() => ({ roomId: "9-conf", confidence: 0.9 })); // a demo-only room
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  const out = await app.ingest({ text: "smoke in the break room on floor 2", caller: "+1" });
  assert.equal(out.report.roomId, "2-break");
}));

test("the processor sees the active building", quiet(async () => {
  const { app } = fakeApp();
  const seen: (string | undefined)[] = [];
  app.setReportProcessor((input) => (seen.push(input.building?.profile?.id), {}));
  await app.ingest({ text: "x", caller: "a" });
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  await app.ingest({ text: "y", caller: "b" });
  assert.deepEqual(seen, ["demo", "osm:way:100"]);
}));

test("no mapped outline: the location-only record is built and activated directly", quiet(async () => {
  const empty = fakeApp();
  empty.world.geocode.set("1 empty field, nowhere", [match(10, 10, "1 Empty Field")]);
  empty.world.outlines.set("10,10", []);
  empty.app.lookups.lookupAddress("1 Empty Field, Nowhere");
  await empty.app.lookups.idle();
  const s = empty.app.store.get();
  assert.equal(s.buildingLookup?.status, "active");
  assert.equal(s.buildingLookup?.candidates.length, 0);
  assert.match(empty.fakes.synthCalls[0].record.id, /^location:/);
  assert.equal(s.building?.version, 2);
}));

test("occupancy estimate missing or throwing: no occupants and a log line", quiet(async () => {
  for (const estimateOccupancy of [undefined, () => { throw new Error("boom"); }]) {
    const { app } = fakeApp({ estimateOccupancy });
    app.lookups.lookupAddress(ADDRESS);
    await app.lookups.idle();
    app.lookups.confirmBuilding("osm:way:100");
    await app.lookups.idle();
    const s = app.store.get();
    assert.equal(s.buildingLookup?.status, "active");
    assert.deepEqual(s.occupants, []);
    assert.ok(s.log!.some((e) => e.kind === "building" && /Occupancy estimate unavailable/.test(e.text)));
    assert.ok(!s.trail!.some((t) => t.tool === "estimate_occupancy"));
  }
}));

test("a synthesizer failure fails the lookup and keeps the old building; confirming again retries", quiet(async () => {
  let fail = true;
  const base = fakeApp();
  const { app } = fakeApp({
    synthesize: (record, options) => {
      if (fail) throw new Error("synthesizeBuilding: not implemented yet");
      return base.fakes.synthesize(record, options);
    },
  });
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "failed");
  assert.equal(app.store.get().building?.id, "demo");
  fail = false;
  assert.ok(app.lookups.confirmBuilding("osm:way:100").ok);
  await app.lookups.idle();
  assert.equal(app.store.get().building?.id, "osm:way:100");
}));

test("useDemoBuilding and /live/reset return to the demo building and clear the lookup", quiet(async () => {
  const { app } = fakeApp();
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  await app.ingest({ text: "fire in the break room on floor 2", caller: "+2" });
  assert.ok(app.lookups.useDemoBuilding().ok);
  let s = app.store.get();
  assert.deepEqual(s.building, { id: "demo", name: DEMO.building.profile.name, version: 3, layoutEstimated: false });
  assert.equal(s.buildingLookup, undefined);
  assert.deepEqual(s.reports, []);
  assert.equal(s.rooms.length, DEMO.building.rooms.length);
  assert.deepEqual(s.occupants, DEMO.occupants);

  // A lookup in flight is dropped by a reset.
  app.lookups.lookupAddress("Another Place 5, Austin");
  app.lookups.resetToDemo();
  await app.lookups.idle();
  s = app.store.get();
  assert.equal(s.buildingLookup, undefined);
  assert.equal(s.building?.id, "demo");
  assert.equal(s.building?.version, 3, "already on the demo building: no new activation");
}));

test("WebSocket events: lookupAddress / confirmBuilding / useDemoBuilding", quiet(async () => {
  const { app } = fakeApp();
  assert.deepEqual(parseClientEvent({ type: "lookupAddress", address: ADDRESS }), { type: "lookupAddress", address: ADDRESS });
  assert.equal(typeof parseClientEvent({ type: "lookupAddress", address: "" }), "string");
  assert.deepEqual(parseClientEvent({ type: "confirmBuilding", buildingId: "osm:way:1" }), { type: "confirmBuilding", buildingId: "osm:way:1" });
  assert.deepEqual(parseClientEvent({ type: "useDemoBuilding" }), { type: "useDemoBuilding" });
  const hooks = { setSimMinute: () => {}, lookups: app.lookups, roomIds: () => app.active.roomIds() };
  applyClientEvent({ type: "lookupAddress", address: ADDRESS }, app.store, hooks);
  await app.lookups.idle();
  applyClientEvent({ type: "confirmBuilding", buildingId: "osm:way:100" }, app.store, hooks);
  await app.lookups.idle();
  assert.equal(app.store.get().building?.id, "osm:way:100");
  // dispatch is validated against the active building's rooms.
  assert.equal(typeof parseClientEvent({ type: "dispatch", roomId: "7-break" }, app.active.roomIds()), "string");
  assert.ok(typeof parseClientEvent({ type: "dispatch", roomId: "2-break" }, app.active.roomIds()) === "object");
  applyClientEvent({ type: "useDemoBuilding" }, app.store, hooks);
  assert.equal(app.store.get().building?.id, "demo");
}));

test("mock mode stays on the demo building: lookups are ignored with a notice", quiet(async () => {
  const { app, world } = fakeApp({ mock: true });
  const r = app.lookups.lookupAddress(ADDRESS);
  assert.equal(r.ok, false);
  assert.equal(app.lookups.confirmBuilding("osm:way:100").ok, false);
  assert.equal(app.lookups.useDemoBuilding().ok, false);
  await app.lookups.idle();
  const s = app.store.get();
  assert.equal(s.buildingLookup, undefined);
  assert.equal(s.building?.id, "demo");
  assert.equal(world.calls.geoapify, 0);
  assert.ok(s.log!.some((e) => e.kind === "building" && /mock mode/.test(e.text)));
  app.mock!.stop();
}));

test("integration: the real synthesizer, summarizer and agent estimator build an incident building the spread model runs on", quiet(async () => {
  const estimateOccupancy = await loadOccupancyEstimator();
  const { app } = fakeApp({ synthesize: undefined, summarize: undefined, estimateOccupancy });
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  const l = app.store.get().buildingLookup!;
  assert.equal(l.status, "needs_confirmation", l.error);
  assert.deepEqual(l.candidates.map((c) => c.id), ["osm:way:100", "osm:way:200"], "the point is inside way 100");
  assert.equal(l.candidates[0].distanceMeters, 0);
  assert.equal(l.candidates[0].use, "office", "candidate tags reach the summary");
  assert.ok(l.candidates[0].outline.length >= 3);

  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  const s = app.store.get();
  assert.equal(s.buildingLookup?.status, "active", s.buildingLookup?.error);
  const b = app.active.get().building;
  assert.equal(b.profile.id, "osm:way:100");
  assert.equal(b.profile.source, "osm");
  assert.equal(b.profile.timezone, "America/Chicago");
  assert.equal(s.building?.version, 2);
  assert.ok(b.rooms.length > 0 && b.verticals.some((v) => v.kind === "stair"));
  if (estimateOccupancy) {
    assert.ok(s.occupants.every((o) => o.estimated && b.rooms.some((r) => r.id === o.room)));
    assert.ok(s.trail!.some((t) => t.tool === "estimate_occupancy"));
  }

  const floor = Math.max(...b.rooms.map((r) => r.floor));
  const target = b.rooms.find((r) => r.floor === floor && r.id !== `${floor}-hall` && !/stair|elev/.test(r.id)) ?? b.rooms[0];
  await app.ingest({ text: "fire here", caller: "+1", preprocessed: { roomId: target.id, confidence: 0.8 } });
  assert.equal(app.store.get().origin?.roomId, target.id);
  assert.ok(app.store.get().rooms.some((r) => r.fire > 0));
  assert.ok(app.store.get().recommendation);
}));

test("a report whose own processing starts the lookup (agent find_building) is held, then located after confirmation", quiet(async () => {
  const { app } = fakeApp();
  let runs = 0;
  // Like the agent: find_building starts the lookup mid-run; once the building is active the same
  // address is a repeat (ignored) and the report is located.
  app.setReportProcessor((input) => {
    runs++;
    const started = app.lookups.lookupAddress(ADDRESS, input.caller);
    if (started.ok && started.unchanged && app.store.get().buildingLookup?.status === "active") return app.live.processor(input);
    return { confidence: 0, reply: HOLD_REPLY, buildingLookup: started.ok ? started.lookup : undefined } as ReturnType<ReportProcessor>;
  });
  const first = await app.ingest({ text: `fire in the break room on floor 2 at ${ADDRESS}`, caller: "+1" });
  assert.equal(first.reply, HOLD_REPLY);
  assert.ok(first.held);
  assert.ok(first.report.time >= app.store.get().buildingLookup!.time);
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "needs_confirmation");
  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  const s = app.store.get();
  assert.equal(runs, 2, "processed once before the lookup, once after activation");
  assert.equal(s.buildingLookup?.status, "active", "the repeat during re-processing started no new lookup");
  assert.equal(s.reports.length, 1);
  assert.equal(s.reports[0].roomId, "2-break");
  assert.equal(s.origin?.roomId, "2-break");
  assert.ok(s.recommendation);

  // Using the demo building is always an activation, even from the demo building.
  const v = s.building!.version;
  app.lookups.useDemoBuilding();
  app.lookups.useDemoBuilding();
  assert.equal(app.store.get().building?.version, v + 2);
}));
