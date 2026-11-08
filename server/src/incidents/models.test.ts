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
