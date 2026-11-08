import { test } from "node:test";
import assert from "node:assert/strict";
import type { GeoPoint } from "@firewatch/shared/types";
import { forecastCrash, type RoadWay } from "./crashModel.ts";
import { forecastFire, type NearbyBuilding } from "./fireModel.ts";
import { geoDistance, localFrame } from "./geo.ts";

const ORIGIN: GeoPoint = { lat: 32.99, lon: -96.75 };
const frame = localFrame(ORIGIN);
const at = (east: number, north: number) => frame.toPoint([east, north]);
const box = (id: string, east: number, north: number, half = 10): NearbyBuilding => ({
  id, name: id, outline: [at(east - half, north - half), at(east + half, north - half), at(east + half, north + half), at(east - half, north + half)],
});

test("fire: smoke goes downwind and the fire stretches that way", () => {
  const f = forecastFire(ORIGIN, { speedMps: 5, fromDegrees: 270 }, []); // from the west: blows east
  const last = f.steps[f.steps.length - 1]!;
  const metres = last.smoke.map(frame.toMetres);
  assert.ok(metres.every(([east]) => east >= 0), "plume stays east of the fire");
  assert.ok(Math.max(...metres.map(([east]) => east)) > 3000);
  const fire = last.fire.map(frame.toMetres);
  assert.ok(Math.max(...fire.map(([east]) => east)) > 3 * -Math.min(...fire.map(([east]) => east)), "faster downwind");
  assert.match(f.summary, /from the west/);
});

test("fire: downwind buildings are reached first; the building it started in is marked", () => {
  const f = forecastFire(ORIGIN, { speedMps: 6, fromDegrees: 270 }, [box("east", 60, 0), box("west", -60, 0), box("home", 0, 0, 20)]);
  const byId = new Map(f.exposures.map((b) => [b.id, b]));
  assert.equal(byId.get("home")!.origin, true);
  assert.equal(byId.get("home")!.fireEtaMinutes, 0);
  assert.ok(byId.get("east")!.fireEtaMinutes < (byId.get("west")?.fireEtaMinutes ?? Infinity));
  assert.notEqual(byId.get("east")!.smokeEtaMinutes, null);
});

test("fire: without wind or building data it says so instead of guessing", () => {
  const f = forecastFire(ORIGIN, null, null);
  assert.equal(f.wind, null);
  assert.deepEqual(f.exposures, []);
  assert.match(f.summary, /Wind is unknown/);
  assert.ok(f.assumptions.some((a) => a.includes("even circle")));
  assert.ok(f.assumptions.some((a) => a.includes("could not be loaded")));
});

// West-east Main St through the crash at (0, 0), with Side Ave joining it 600 m west.
const road = (id: number, name: string, highway: string, nodes: number[], points: [number, number][], oneway: RoadWay["oneway"] = "both"): RoadWay =>
  ({ id, name, highway, oneway, lanes: null, nodes, geometry: points.map(([e, n]) => at(e, n)) });
const STREETS = [
  road(1, "Main St", "primary", [1, 2], [[-600, 0], [0, 0]]),
  road(2, "Main St", "primary", [2, 3], [[0, 0], [600, 0]]),
  road(3, "Side Ave", "tertiary", [1, 4], [[-600, 0], [-600, 500]]),
  road(4, "Main St", "primary", [5, 1], [[-1200, 0], [-600, 0]]),
];

test("crash: the queue grows backward, spreads to side streets, and only grows over time", () => {
  const f = forecastCrash(ORIGIN, STREETS, "all");
  assert.equal(f.road, "Main St");
  assert.ok(f.segments.some((s) => s.level === "blocked"));
  assert.ok(f.segments.some((s) => s.road === "Side Ave"), "reaches the side street");
  for (let i = 1; i < f.steps.length; i++) assert.ok(f.steps[i]!.queueMeters >= f.steps[i - 1]!.queueMeters);
  assert.ok(f.steps[f.steps.length - 1]!.roads.includes("Side Ave"));
  assert.match(f.summary, /Main St is blocked/);
  for (const s of f.segments) for (const p of s.path) assert.ok(geoDistance(ORIGIN, p) < 2000);
});

test("crash: a partial blockage queues more slowly than a full one", () => {
  const minuteToEnd = (lanes: "all" | "some") => Math.min(...forecastCrash(ORIGIN, STREETS, lanes).segments.filter((s) => s.road === "Side Ave").map((s) => s.queueMinute));
  assert.ok(minuteToEnd("some") > minuteToEnd("all"));
});

test("crash: a one-way road only queues on the side traffic comes from", () => {
  const oneWay = [road(1, "Oak", "secondary", [1, 2], [[-500, 0], [0, 0]], "forward"), road(2, "Oak", "secondary", [2, 3], [[0, 0], [500, 0]], "forward")];
  const f = forecastCrash(ORIGIN, oneWay, "all");
  assert.ok(f.segments.length > 0);
  for (const s of f.segments) for (const p of s.path) assert.ok(frame.toMetres(p)[0] <= 1);
});

test("crash: no road nearby gives an honest empty forecast", () => {
  const f = forecastCrash(ORIGIN, [road(1, "Far Rd", "primary", [1, 2], [[1000, 1000], [1500, 1000]])], "all");
  assert.equal(f.road, null);
  assert.deepEqual(f.segments, []);
  assert.match(f.summary, /No mapped road/);
});

test("fire: a building known only as a point still gets timings, and is drawn as a marker", () => {
  const point = { id: "p", name: "Shop", outline: [], location: at(50, 0) };
  const here = { id: "h", name: "Here", outline: [], location: at(5, 5) };
  const f = forecastFire(ORIGIN, { speedMps: 5, fromDegrees: 270 }, [point, here]);
  const shop = f.exposures.find((b) => b.id === "p")!;
  assert.deepEqual(shop.outline, []);
  assert.deepEqual(shop.location, point.location);
  assert.equal(shop.distanceMeters, 50);
  assert.equal(f.exposures.find((b) => b.id === "h")!.origin, true);
});

test("crash: at a junction every approach backs up at full strength", () => {
  const ways = [
    road(1, "North Rd", "primary", [1, 2], [[0, 800], [0, 0]], "forward"),
    road(2, "South Rd", "primary", [3, 2], [[0, -800], [0, 0]], "forward"),
  ];
  const f = forecastCrash(ORIGIN, ways, "all");
  const reach = (name: string) => f.segments.filter((s) => s.road === name).length;
  assert.ok(reach("North Rd") > 0 && reach("North Rd") === reach("South Rd"));
});

test("crash: a driveway closer to the pin does not outrank the named street", () => {
  const ways = [
    { ...road(1, "x", "residential", [1, 2], [[-40, 5], [40, 5]]), name: null },
    road(2, "Campbell Rd", "primary", [3, 4], [[-500, 60], [500, 60]]),
  ];
  assert.equal(forecastCrash(ORIGIN, ways, "all").road, "Campbell Rd");
});

test("crash: opposite one-way pieces of the same stretch both queue", () => {
  const ways = [
    road(1, "Elm", "primary", [1, 2], [[-500, 0], [500, 0]], "forward"),
    road(2, "Elm", "primary", [2, 1], [[500, 0], [-500, 0]], "forward"),
  ];
  const metres = forecastCrash(ORIGIN, ways, "all").segments.flatMap((s) => s.path.map((p) => frame.toMetres(p)[0]));
  assert.ok(Math.min(...metres) < -100 && Math.max(...metres) > 100);
});

const site = (id: string, east: number, north: number, use: string, name: string | null = id): NearbyBuilding => ({ id, name, outline: [], location: at(east, north), use });
const WEST_WIND = { speedMps: 5, fromDegrees: 270 }; // blows east at 180 m/min of plume travel

test("fire: a distant sensitive site the plume reaches is listed and named; others are left out", () => {
  const f = forecastFire(ORIGIN, WEST_WIND, [site("General Hospital", 1000, 0, "hospital"), site("Upwind School", -1000, 0, "school"), site("Side Clinic", 0, 1000, "clinic")]);
  assert.deepEqual(f.exposures.map((b) => b.id), ["General Hospital"]);
  const hospital = f.exposures[0]!;
  assert.equal(hospital.use, "hospital");
  assert.equal(hospital.smokeEtaMinutes, 6);
  assert.equal(hospital.fireEtaMinutes, Math.round(985 / 3.5), "the model's own fire rate, with no special case");
  assert.equal(hospital.risk, "low");
  assert.match(f.summary, /Smoke could reach General Hospital in about 6 minutes/);
  assert.doesNotMatch(f.summary, /Upwind School|Side Clinic/);
  assert.match(f.summary, /smoke 0 within 30 minutes/, "a site 1 km out is not counted as a nearby building");
});

test("fire: a site beyond the plume's 30-minute reach is left out", () => {
  const slow = { speedMps: 1, fromDegrees: 270 }; // 36 m/min, so about 1.1 km by 30 minutes
  assert.deepEqual(forecastFire(ORIGIN, slow, [site("Far School", 2000, 0, "school")]).exposures, []);
});

test("fire: the cap trims ordinary buildings but never a reached sensitive site, and order stays soonest first", () => {
  const ordinary = Array.from({ length: 60 }, (_, i) => box(`b${i}`, 30 + i * 3, 0, 1));
  const f = forecastFire(ORIGIN, WEST_WIND, [...ordinary, site("Far Hospital", 2000, 0, "hospital"), site("Far School", 2500, 0, "school")]);
  assert.equal(f.exposures.length, 40);
  assert.ok(f.exposures.some((b) => b.id === "Far Hospital") && f.exposures.some((b) => b.id === "Far School"));
  for (let i = 1; i < f.exposures.length; i++) assert.ok(f.exposures[i]!.fireEtaMinutes >= f.exposures[i - 1]!.fireEtaMinutes);
});

test("fire: summary reads plainly for unnamed sites, unknown wind and a fire in the site itself", () => {
  const unnamed = forecastFire(ORIGIN, WEST_WIND, [site("n", 900, 0, "nursing home", null)]);
  assert.match(unnamed.summary, /a nursing home in about 5 minutes/);
  const calm = forecastFire(ORIGIN, null, [site("Elm School", 300, 0, "school")]);
  assert.match(calm.summary, /With wind unknown, smoke could reach Elm School in about 10 minutes/);
  const inside = forecastFire(ORIGIN, WEST_WIND, [{ ...box("Oak Clinic", 0, 0, 20), use: "clinic" }]);
  assert.match(inside.summary, /The fire is at Oak Clinic\./);
});

test("fire: assumptions say where sensitive sites come from, and when they could not be checked", () => {
  const checked = forecastFire(ORIGIN, WEST_WIND, []);
  assert.ok(checked.assumptions.some((a) => /sensitive sites come from OpenStreetMap.*incomplete/.test(a)));
  const unchecked = forecastFire(ORIGIN, WEST_WIND, Object.assign([] as NearbyBuilding[], { sensitiveSitesUnavailable: true }));
  assert.ok(unchecked.assumptions.some((a) => a.includes("could not be checked")));
  assert.ok(!unchecked.assumptions.some((a) => a.includes("sensitive sites come from")));
});

test("fire: exposure coordinates are rounded for the broadcast", () => {
  const raw = { lat: ORIGIN.lat + 0.00012345678, lon: ORIGIN.lon + 0.00012345678 };
  const ring = [raw, { lat: raw.lat, lon: raw.lon + 0.0001 }, { lat: raw.lat + 0.0001, lon: raw.lon + 0.0001 }];
  const f = forecastFire(ORIGIN, WEST_WIND, [{ id: "r", name: null, outline: ring }, { id: "p", name: null, outline: [], location: raw }]);
  const decimals = (n: number) => (String(n).split(".")[1] ?? "").length;
  const points = f.exposures.flatMap((b) => [b.location, ...b.outline]);
  assert.ok(points.length >= 4);
  for (const p of points) assert.ok(decimals(p.lat) <= 6 && decimals(p.lon) <= 6);
});

test("crash: clearance follows the blockage and the road's class", () => {
  const onRoad = (highway: string, lanes: "all" | "some" | "unknown") => forecastCrash(ORIGIN, [road(1, "R", highway, [1, 2], [[-500, 0], [500, 0]])], lanes).clearance;
  assert.deepEqual(onRoad("primary", "all"), { reopenMinute: 30, clearedMinute: 60 }); // 450 veh/lane at a net 900/h
  assert.deepEqual(onRoad("primary", "some"), { reopenMinute: 20, clearedMinute: 32 });
  assert.deepEqual(onRoad("primary", "unknown"), { reopenMinute: 20, clearedMinute: 32 });
  assert.deepEqual(onRoad("motorway", "all"), { reopenMinute: 30, clearedMinute: null }, "minute 180 is past the model's range");
});

test("crash: summary and assumptions state the clearance", () => {
  const f = forecastCrash(ORIGIN, STREETS, "some");
  assert.match(f.summary, /reopens around minute 20, the queue could clear by about minute 32/);
  assert.ok(f.assumptions.some((a) => a.includes("reopens at minute 20")));
  assert.ok(f.assumptions.some((a) => a.includes("do not shrink")));
  const motorway = forecastCrash(ORIGIN, [road(1, "I-75", "motorway", [1, 2], [[-500, 0], [500, 0]])], "all");
  assert.match(motorway.summary, /more than 2 hours/);
});

test("crash: alternates leave out the queue, are deduplicated, and put connected higher-class roads first", () => {
  const ways = [
    ...STREETS,
    road(5, "Exit Pkwy", "secondary", [1, 6], [[-600, 0], [-600, -500]], "forward"), // leaves a queued junction
    road(6, "Exit Pkwy", "secondary", [6, 7], [[-600, -500], [-600, -900]], "forward"),
    road(7, "Parallel Blvd", "primary", [8, 9], [[-500, 400], [500, 400]]), // near, but not joined to the queue
    road(8, "Quiet Ln", "residential", [10, 11], [[100, 300], [200, 300]]),
    road(9, "Exit Ramp", "secondary_link", [1, 12], [[-600, 0], [-650, -50]], "forward"),
    road(10, "Distant Dr", "secondary", [13, 14], [[1400, 1200], [1500, 1200]]),
  ];
  const f = forecastCrash(ORIGIN, ways, "all");
  assert.deepEqual(f.alternateRoads, ["Exit Pkwy", "Parallel Blvd"]);
});

test("crash: alternates are capped, and empty when there are none or no road", () => {
  const many = Array.from({ length: 8 }, (_, i) => road(20 + i, `Road ${i}`, "primary", [100 + 2 * i, 101 + 2 * i], [[-300, 100 + 50 * i], [300, 100 + 50 * i]]));
  assert.equal(forecastCrash(ORIGIN, [...STREETS, ...many], "all").alternateRoads!.length, 5);
  assert.deepEqual(forecastCrash(ORIGIN, STREETS, "all").alternateRoads, []);
  const none = forecastCrash(ORIGIN, [road(1, "Far Rd", "primary", [1, 2], [[1000, 1000], [1500, 1000]])], "all");
  assert.deepEqual(none.alternateRoads, []);
  assert.equal(none.clearance, undefined);
});
