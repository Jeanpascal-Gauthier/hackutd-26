import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocationOnlyRecord, getBuildingBounds, listOsmBuildingCandidates, normalizeOsmBuilding } from "./normalize.ts";
import type { Coordinates, OsmElement, Position } from "./types.ts";

const time = "2026-11-08T12:00:00Z";
const location: Coordinates = { lat: 0.005, lon: 0.005 };
const box = (x: number, y: number, w: number, h: number): Coordinates[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(([lon, lat]) => ({ lat, lon }));
const building: OsmElement = { type: "way", id: 1, tags: { building: "yes", name: "Library", ref: "LIB", height: "60 ft", "building:levels": "4" }, geometry: box(0, 0, 0.01, 0.01) };
const room = (id: number, tags: Record<string, string> = {}, geometry = box(0.001, 0.001, 0.001, 0.001)): OsmElement => ({ type: "way", id, tags: { indoor: "room", level: "0", ...tags }, geometry });
const normalize = (elements: OsmElement[]) => normalizeOsmBuilding("osm:way:1", [building, ...elements], location, time)!;

test("preserves a sourced room name, number, purpose and signposted floor label independently of source level", () => {
  const result = normalize([room(2, { name: "Coffee Room", ref: "305", room: "kitchen", level: "2", "level:ref": "3" })]);
  assert.equal(result.rooms[0].id, "osm:way:2");
  assert.equal(result.rooms[0].name, "Coffee Room");
  assert.equal(result.rooms[0].number, "305");
  assert.equal(result.rooms[0].purpose, "kitchen");
  assert.deepEqual(result.rooms[0].sourceLevels, ["2"]);
  assert.deepEqual(result.floors.map(({ sourceLevel, label }) => ({ sourceLevel, label })), [{ sourceLevel: "2", label: "3" }]);
  assert.equal(result.heightMeters, 18.288);
  assert.equal(result.floorsAboveGround, 4);
  assert.equal(result.rooms[0].source.updatedAt, null);
  assert.equal(result.rooms[0].source.license, "ODbL-1.0");
  assert.equal(result.completeness.routeReady, false);
});

test("exterior-only building does not invent rooms, floors, occupants or routes", () => {
  const result = normalize([]);
  assert.deepEqual(result.rooms, []);
  assert.deepEqual(result.floors, []);
  assert.deepEqual(result.connections, []);
  assert.equal(result.completeness.interiors, "none");
  assert.equal(result.completeness.routeReady, false);
  assert.ok(!("occupants" in result));
  assert.ok(result.warnings.some((w) => w.includes("Occupancy")));
});

test("unnamed rooms stay unnamed and malformed/missing geometry does not become a fabricated rectangle", () => {
  const result = normalize([
    room(2),
    { type: "node", id: 3, tags: { indoor: "yes", name: "Information desk", level: "0" }, lat: 0.003, lon: 0.003 },
    { type: "way", id: 4, tags: { indoor: "room", name: "Label only", "building:ref": "LIB" } },
  ]);
  assert.equal(result.rooms[0].name, null);
  assert.equal(result.rooms[0].number, null);
  assert.equal(result.rooms[1].geometry?.type, "Point");
  assert.equal(result.rooms[2].geometry, null);
  assert.deepEqual(result.rooms[2].floorIds, []);
  assert.equal(result.completeness.routeReady, false);
});

test("source basement/ground/multilevel identifiers and shared-node door evidence survive normalization", () => {
  const first = room(2, { level: "-1", "level:ref": "B1" });
  first.nodes = [101, 102, 103, 104, 101];
  const second = room(3, { level: "-1" });
  second.nodes = [102, 105, 106, 103, 102];
  const door: OsmElement = { type: "node", id: 102, lat: 0.001, lon: 0.001, tags: { door: "yes", level: "-1" } };
  const stairs = room(4, { stairs: "yes", level: "-1-1", name: "West stair" });
  const ground = room(5, { indoor: "level", level: "0", "level:ref": "G" }, box(0, 0, 0.01, 0.01));
  const result = normalize([first, second, door, stairs, ground]);
  assert.deepEqual(result.floors.map((f) => [f.sourceLevel, f.label]), [["-1", "B1"], ["0", "G"], ["1", "1"]]);
  const stair = result.rooms.find((r) => r.kind === "stair")!;
  assert.deepEqual(stair.sourceLevels, ["-1", "0", "1"]);
  const entrance = result.connections.find((c) => c.id === "osm:node:102")!;
  assert.deepEqual(entrance.roomIds, ["osm:way:2", "osm:way:3"]);
  assert.equal(entrance.state, "unknown");
});

test("never adds neighboring building interiors or contradictory building references", () => {
  const result = normalize([
    room(2, { name: "Outside" }, box(0.02, 0.02, 0.001, 0.001)),
    room(3, { name: "Neighbor", "building:ref": "OTHER" }),
    room(4, { name: "Straddles wall" }, box(0.009, 0.001, 0.003, 0.001)),
    room(5, { name: "Inside" }),
    { type: "node", id: 6, lat: 0, lon: 0.005, tags: { entrance: "main", level: "0" } },
  ]);
  assert.deepEqual(result.rooms.map((r) => r.name), ["Inside"]);
  assert.equal(result.connections[0].kind, "entrance");
});

test("relation outer segments, courtyards and separate building polygons are preserved", () => {
  const outer = box(0, 0, 0.01, 0.01);
  const hole = box(0.004, 0.004, 0.002, 0.002);
  const relation: OsmElement = {
    type: "relation", id: 20, tags: { type: "multipolygon", building: "yes" },
    members: [
      { type: "way", ref: 21, role: "outer", geometry: outer.slice(0, 3) },
      { type: "way", ref: 22, role: "outer", geometry: outer.slice(2) },
      { type: "way", ref: 23, role: "inner", geometry: hole },
      { type: "way", ref: 24, role: "outer", geometry: box(0.02, 0.02, 0.01, 0.01) },
    ],
  };
  const elements = [relation, room(30, { name: "Courtyard" }, box(0.0045, 0.0045, 0.0005, 0.0005)), room(31, { name: "Actual room" })];
  const result = normalizeOsmBuilding("osm:relation:20", elements, location, time)!;
  assert.equal(result.footprint?.type, "MultiPolygon");
  if (result.footprint?.type !== "MultiPolygon") assert.fail("Expected multipolygon");
  const polygonWithHole = result.footprint.coordinates.find((p) => p.length === 2)!;
  assert.deepEqual(polygonWithHole[1], hole.map((p) => [p.lon, p.lat] as Position));
  assert.deepEqual(result.rooms.map((r) => r.name), ["Actual room"]);
  assert.deepEqual(getBuildingBounds(relation, elements), { south: 0, west: 0, north: 0.03, east: 0.03 });
});

test("unclosed relation members and invalid geographic coordinates cannot become valid footprints", () => {
  const invalid = { ...building, id: 50, geometry: box(181, 0, 1, 1) };
  const result = listOsmBuildingCandidates([invalid], location, time)[0];
  assert.equal(result.footprint, null);
  const relation: OsmElement = { type: "relation", id: 60, tags: { building: "yes" }, members: [{ type: "way", ref: 61, role: "outer", geometry: [{ lat: 0, lon: 0 }, { lat: 0.001, lon: 0.001 }] }] };
  assert.equal(getBuildingBounds(relation, [relation]), null);
  assert.equal(normalizeOsmBuilding("osm:way:999", [building], location, time), null);
});

test("location-only fallback is stable, explicit and has no inferred building properties", () => {
  const first = createLocationOnlyRecord(location, time);
  assert.equal(first.id, createLocationOnlyRecord(location, time).id);
  assert.equal(first.footprint, null);
  assert.equal(first.heightMeters, null);
  assert.equal(first.floorsAboveGround, null);
  assert.equal(first.source.provider, "location");
  assert.deepEqual(first.completeness, { footprint: false, height: false, floorLabels: false, interiors: "none", routeReady: false });
});

test("open mapped stair/corridor ways preserve source geometry and exclude neighboring or courtyard-crossing ways", () => {
  const stairs: OsmElement = { type: "way", id: 70, tags: { highway: "steps", level: "-1;0", name: "South stairs" }, geometry: [{ lat: 0.001, lon: 0.002 }, { lat: 0.002, lon: 0.003 }] };
  const corridor: OsmElement = { type: "way", id: 71, tags: { highway: "corridor", level: "0", name: "Main corridor" }, geometry: [{ lat: 0.002, lon: 0.002 }, { lat: 0.002, lon: 0.008 }] };
  const outside: OsmElement = { ...stairs, id: 72, geometry: [{ lat: 0.009, lon: 0.009 }, { lat: 0.02, lon: 0.02 }] };
  const result = normalize([stairs, corridor, outside]);
  assert.deepEqual(result.rooms.map((r) => [r.name, r.geometry?.type]), [["South stairs", "LineString"], ["Main corridor", "LineString"]]);
  assert.deepEqual(result.connections.find((c) => c.id === "osm:way:70")?.floorIds, ["osm:way:1:level:-1", "osm:way:1:level:0"]);
  assert.equal(result.completeness.routeReady, false);
});

test("room-purpose tags without indoor still retain labels and purpose without inventing a space classification", () => {
  const result = normalize([{ type: "way", id: 80, tags: { room: "office", level: "0", name: "Admissions", ref: "101" }, geometry: box(0.001, 0.001, 0.001, 0.001) }]);
  assert.equal(result.rooms[0].kind, "unknown");
  assert.equal(result.rooms[0].purpose, "office");
  assert.equal(result.rooms[0].name, "Admissions");
  assert.equal(result.rooms[0].number, "101");
});

test("candidates keep the outline's descriptive tags (use, levels, name) and nothing else", () => {
  const office: OsmElement = {
    type: "way", id: 7, geometry: box(0, 0, 0.01, 0.01),
    tags: { building: "office", "building:levels": "6", amenity: "college", name: "Tower", "addr:street": "Main St", note: "private note" },
  };
  const [c] = listOsmBuildingCandidates([office], location, time);
  assert.deepEqual(c.tags, { building: "office", "building:levels": "6", amenity: "college", name: "Tower" });
  // A full record still carries every tag.
  assert.equal(normalizeOsmBuilding("osm:way:7", [office], location, time)!.tags.note, "private note");
});
