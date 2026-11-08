import type {
  AreaGeometry, BuildingCandidate, BuildingRecord, BuildingSource, ConnectionRecord, Coordinates,
  FeatureGeometry, FloorRecord, OsmElement, PolygonGeometry, Position, RoomRecord,
} from "./types.ts";

export const osmId = (element: Pick<OsmElement, "type" | "id">): string => `osm:${element.type}:${element.id}`;
const same = (a: Position, b: Position) => Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
const clean = (value: string | undefined): string | null => value?.trim() || null;
const polygons = (area: AreaGeometry): Position[][][] => area.type === "Polygon" ? [area.coordinates] : area.coordinates;
const validCoordinate = (c: Coordinates): boolean => !!c && Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;

function positions(coordinates: Coordinates[] | undefined): Position[] | null {
  return coordinates?.length && coordinates.every(validCoordinate) ? coordinates.map((c) => [c.lon, c.lat]) : null;
}
function ring(points: Position[] | null): Position[] | null {
  if (!points || points.length < 4 || !same(points[0], points[points.length - 1])) return null;
  const area = points.slice(1).reduce((n, p, i) => n + points[i][0] * p[1] - p[0] * points[i][1], 0);
  return Math.abs(area) > 1e-14 ? points : null;
}

/** Join relation member ways, respecting member direction and closed rings. */
function stitch(parts: Position[][]): Position[][] | null {
  const remaining = parts.map((p) => [...p]);
  const result: Position[][] = [];
  while (remaining.length) {
    let joined = remaining.pop()!;
    while (!same(joined[0], joined[joined.length - 1])) {
      const index = remaining.findIndex((part) => same(joined[joined.length - 1], part[0]) || same(joined[joined.length - 1], part[part.length - 1]));
      if (index < 0) return null;
      let next = remaining.splice(index, 1)[0];
      if (!same(joined[joined.length - 1], next[0])) next = next.reverse();
      joined = joined.concat(next.slice(1));
    }
    const closed = ring(joined);
    if (!closed) return null;
    result.push(closed);
  }
  return result;
}

function onSegment(point: Position, a: Position, b: Position): boolean {
  const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
  return Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) - 1e-10 && point[0] <= Math.max(a[0], b[0]) + 1e-10 && point[1] >= Math.min(a[1], b[1]) - 1e-10 && point[1] <= Math.max(a[1], b[1]) + 1e-10;
}
function inRing(point: Position, outline: Position[]): "inside" | "outside" | "boundary" {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j], b = outline[i];
    if (onSegment(point, a, b)) return "boundary";
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? "inside" : "outside";
}
function contains(area: AreaGeometry, point: Position): boolean {
  return polygons(area).some(([outer, ...holes]) => inRing(point, outer) !== "outside" && holes.every((hole) => inRing(point, hole) !== "inside"));
}

function areaGeometry(element: OsmElement, byId: Map<string, OsmElement>): AreaGeometry | null {
  if (element.type === "way") {
    const coords = positions(element.geometry) ?? (element.nodes ? positions(element.nodes.map((id) => byId.get(`osm:node:${id}`)).filter((n): n is OsmElement => !!n).map((n) => ({ lat: n.lat!, lon: n.lon! }))) : null);
    // Missing node references must not quietly shorten a room or footprint.
    if (!element.geometry && element.nodes && coords?.length !== element.nodes.length) return null;
    const closed = ring(coords);
    return closed ? { type: "Polygon", coordinates: [closed] } : null;
  }
  if (element.type !== "relation" || !element.members?.length) return null;
  const outerParts: Position[][] = [], innerParts: Position[][] = [];
  for (const member of element.members) {
    if (member.type !== "way") continue;
    if (member.role && member.role !== "outer" && member.role !== "inner") continue;
    const memberWay = byId.get(`osm:way:${member.ref}`);
    const coords = positions(member.geometry ?? memberWay?.geometry);
    if (!coords || coords.length < 2) return null;
    (member.role === "inner" ? innerParts : outerParts).push(coords);
  }
  const outers = stitch(outerParts), inners = stitch(innerParts);
  if (!outers?.length || !inners) return null;
  const areas = outers.map((outline) => [outline]);
  for (const hole of inners) {
    const owner = areas.find(([outline]) => inRing(hole[0], outline) !== "outside");
    if (!owner) return null;
    owner.push(hole);
  }
  return areas.length === 1 ? { type: "Polygon", coordinates: areas[0] } : { type: "MultiPolygon", coordinates: areas };
}

function featureGeometry(element: OsmElement, byId: Map<string, OsmElement>): FeatureGeometry | null {
  if (element.type === "node") return validCoordinate({ lat: element.lat!, lon: element.lon! }) ? { type: "Point", coordinates: [element.lon!, element.lat!] } : null;
  if (element.type === "way" && ["steps", "corridor"].includes(element.tags?.highway ?? "")) {
    const line = positions(element.geometry);
    if (line && line.length >= 2 && !same(line[0], line[line.length - 1])) return { type: "LineString", coordinates: line };
  }
  return areaGeometry(element, byId);
}

function source(element: OsmElement, fetchedAt: string): BuildingSource {
  return {
    provider: "openstreetmap", id: osmId(element), url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    attribution: "© OpenStreetMap contributors", license: "ODbL-1.0", fetchedAt, updatedAt: element.timestamp ?? null,
  };
}
function height(value: string | undefined): number | null {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|')?$/i);
  if (!match) return null;
  const meters = Number(match[1]) * (/^(ft|feet|')$/i.test(match[2] ?? "") ? 0.3048 : 1);
  return meters > 0 && meters <= 1500 ? meters : null;
}
const isBuilding = (e: OsmElement) => e.type !== "node" && !!e.tags && ((!!e.tags.building && e.tags.building !== "no") || (!!e.tags["building:part"] && e.tags["building:part"] !== "no"));

/** Tags a candidate keeps: what the building is, how tall, what it's called. */
const CANDIDATE_TAGS = [
  "building", "building:use", "building:levels", "building:levels:underground", "building:flats", "roof:levels", "height",
  "amenity", "shop", "office", "tourism", "healthcare", "leisure", "name", "official_name", "operator",
];
function candidateTags(tags: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of CANDIDATE_TAGS) if (typeof tags[key] === "string" && tags[key].trim()) kept[key] = tags[key].slice(0, 200);
  return kept;
}

function candidate(element: OsmElement, byId: Map<string, OsmElement>, location: Coordinates, fetchedAt: string): BuildingCandidate {
  const tags = element.tags ?? {};
  const footprint = areaGeometry(element, byId);
  const points = footprint ? polygons(footprint).flat(2) : [];
  const midpoint = points.length ? { lat: (Math.min(...points.map((p) => p[1])) + Math.max(...points.map((p) => p[1]))) / 2, lon: (Math.min(...points.map((p) => p[0])) + Math.max(...points.map((p) => p[0]))) / 2 } : null;
  const floors = tags["building:levels"] === undefined ? NaN : Number(tags["building:levels"]);
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return {
    id: osmId(element), name: clean(tags.name), address: clean(tags["addr:full"]) ?? clean([street, tags["addr:city"], tags["addr:postcode"]].filter(Boolean).join(", ")),
    location: midpoint ?? (element.center && validCoordinate(element.center) ? element.center : location), footprint,
    heightMeters: height(tags.height), floorsAboveGround: Number.isInteger(floors) && floors > 0 && floors <= 500 ? floors : null,
    tags: candidateTags(tags), source: source(element, fetchedAt),
  };
}

export function listOsmBuildingCandidates(elements: OsmElement[], location: Coordinates, fetchedAt: string): BuildingCandidate[] {
  const byId = new Map(elements.map((element) => [osmId(element), element]));
  return elements.filter(isBuilding).map((element) => candidate(element, byId, location, fetchedAt));
}

export function getBuildingBounds(element: OsmElement, elements: OsmElement[]): { south: number; west: number; north: number; east: number } | null {
  const geometry = areaGeometry(element, new Map(elements.map((e) => [osmId(e), e])));
  if (!geometry) return null;
  const points = polygons(geometry).flat(2);
  return { south: Math.min(...points.map((p) => p[1])), west: Math.min(...points.map((p) => p[0])), north: Math.max(...points.map((p) => p[1])), east: Math.max(...points.map((p) => p[0])) };
}

/** Preserve source identifiers; expand only small integer ranges, never infer new floors. */
function levels(value: string | undefined): string[] {
  const result: string[] = [];
  for (const token of (value ?? "").split(";").map((s) => s.trim()).filter(Boolean).slice(0, 100)) {
    const range = token.match(/^(-?\d+)-(-?\d+)$/);
    if (range && Number(range[2]) >= Number(range[1]) && Number(range[2]) - Number(range[1]) < 100) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) result.push(String(n));
    } else if (token.length <= 80) result.push(token);
  }
  return [...new Set(result)];
}
function kind(tags: Record<string, string>): RoomRecord["kind"] {
  if (tags.stairs === "yes" || tags.highway === "steps") return "stair";
  if (tags.highway === "elevator") return "elevator";
  if (tags.indoor === "corridor" || tags.highway === "corridor") return "corridor";
  if (tags.indoor === "room") return "room";
  if (tags.indoor === "area") return "area";
  return "unknown";
}
const roomLike = (tags: Record<string, string>) => kind(tags) !== "unknown" || !!tags.room && tags.room !== "no" || tags.indoor === "yes" && !!(tags.name || tags.ref);

export function createLocationOnlyRecord(location: Coordinates, fetchedAt: string): BuildingRecord {
  return {
    id: `location:${location.lat.toFixed(6)},${location.lon.toFixed(6)}`, name: null, address: null, location,
    footprint: null, heightMeters: null, floorsAboveGround: null, floors: [], rooms: [], connections: [], tags: {},
    source: { provider: "location", id: null, url: null, attribution: "Reported coordinates; building geometry unavailable", license: null, fetchedAt, updatedAt: null },
    completeness: { footprint: false, height: false, floorLabels: false, interiors: "none", routeReady: false },
    warnings: ["No building footprint was found. Interior geometry, occupancy and routes are unknown."],
  };
}

export function normalizeOsmBuilding(buildingId: string, elements: OsmElement[], location: Coordinates, fetchedAt: string, footprint?: AreaGeometry): BuildingRecord | null {
  const byId = new Map(elements.map((element) => [osmId(element), element]));
  const building = byId.get(buildingId);
  if (!building || !isBuilding(building)) return null;
  const base = candidate(building, byId, location, fetchedAt);
  // Managed OSM providers supply GeoJSON directly rather than OSM member ways.
  if (footprint) base.footprint = footprint;
  const buildingTags = building.tags ?? {};
  const memberIds = new Set((building.members ?? []).map((m) => osmId({ type: m.type, id: m.ref })));
  const identifiers = new Set([String(building.id), buildingId, `${building.type}/${building.id}`, buildingTags.ref, buildingTags.name].filter(Boolean));
  const associated = (element: OsmElement): boolean => {
    if (osmId(element) === buildingId || isBuilding(element)) return false;
    const reference = element.tags?.["building:ref"] ?? element.tags?.["building:id"];
    if (reference && !identifiers.has(reference)) return false;
    const geometry = featureGeometry(element, byId);
    if (!geometry) return memberIds.has(osmId(element)) || !!reference;
    if (!base.footprint) return memberIds.has(osmId(element)) || !!reference;
    if (geometry.type === "Point") return contains(base.footprint, geometry.coordinates);
    // Sample vertices and edge midpoints: reject straddling/outside features and courtyard features.
    const outlines = geometry.type === "LineString" ? [geometry.coordinates] : polygons(geometry).flat();
    return outlines.every((outline) => outline.every((point, i) => {
      if (!contains(base.footprint!, point)) return false;
      return i === 0 || contains(base.footprint!, [(point[0] + outline[i - 1][0]) / 2, (point[1] + outline[i - 1][1]) / 2]);
    }));
  };
  const indoor = elements.filter((e) => e.tags && (roomLike(e.tags) || e.tags.indoor === "level" || e.tags.door || e.tags.entrance) && associated(e));
  const floorMap = new Map<string, FloorRecord>();
  const floorIds = (element: OsmElement): { sourceLevels: string[]; floorIds: string[] } => {
    const tags = element.tags ?? {};
    const sourceLevels = [...new Set([...levels(tags.level), ...levels(tags.repeat_on)])];
    const labels = (tags["level:ref"] ?? "").split(";").map((s) => s.trim());
    for (let i = 0; i < sourceLevels.length; i++) {
      const level = sourceLevels[i];
      const label = labels.length === sourceLevels.length ? clean(labels[i]) : null;
      const explicit = label ?? (tags.indoor === "level" ? clean(tags.name) : null);
      if (!floorMap.has(level) || explicit && !floorMap.get(level)!.sourceLabel) floorMap.set(level, { id: `${buildingId}:level:${encodeURIComponent(level)}`, sourceLevel: level, label: explicit ?? level, sourceLabel: explicit });
    }
    return { sourceLevels, floorIds: sourceLevels.map((level) => `${buildingId}:level:${encodeURIComponent(level)}`) };
  };
  indoor.filter((e) => e.tags?.indoor === "level").forEach(floorIds);
  const rooms: RoomRecord[] = indoor.filter((e) => roomLike(e.tags!)).map((element) => {
    const tags = element.tags!;
    return { id: osmId(element), name: clean(tags.name), number: clean(tags.ref), kind: kind(tags), purpose: clean(tags.room), ...floorIds(element), geometry: featureGeometry(element, byId), tags: { ...tags }, source: source(element, fetchedAt) };
  });
  const roomElement = new Map(rooms.map((r) => [r.id, byId.get(r.id)!]));
  const connections: ConnectionRecord[] = indoor.filter((e) => (e.tags!.door && e.tags!.door !== "no") || e.tags!.entrance && e.tags!.entrance !== "no" || ["stair", "elevator"].includes(kind(e.tags!))).map((element) => {
    const tags = element.tags!, ownLevels = floorIds(element), roomKind = kind(tags);
    const connectionKind: ConnectionRecord["kind"] = roomKind === "stair" || roomKind === "elevator" ? roomKind : tags.entrance && tags.entrance !== "no" ? "entrance" : "door";
    const roomIds = rooms.filter((room) => {
      if (room.id === osmId(element)) return true;
      if (!ownLevels.floorIds.length || !room.floorIds.some((id) => ownLevels.floorIds.includes(id))) return false;
      const roomSource = roomElement.get(room.id)!;
      return element.type === "node" && !!roomSource.nodes?.includes(element.id);
    }).map((room) => room.id);
    return { id: osmId(element), kind: connectionKind, roomIds, floorIds: ownLevels.floorIds, geometry: featureGeometry(element, byId), state: "unknown", tags: { ...tags }, source: source(element, fetchedAt) };
  });
  const floors = [...floorMap.values()].sort((a, b) => Number.isFinite(Number(a.sourceLevel)) && Number.isFinite(Number(b.sourceLevel)) ? Number(a.sourceLevel) - Number(b.sourceLevel) : a.sourceLevel.localeCompare(b.sourceLevel));
  const warnings = ["Public map data may be incomplete or outdated. Occupancy, door state and inspection status are unknown.", "Mapped features do not establish complete evacuation routes or validated fire simulation inputs."];
  if (!base.footprint) warnings.push("Building footprint is missing or malformed.");
  if (!rooms.length) warnings.push("No associated indoor room geometry or labels were found.");
  if (rooms.some((r) => !r.geometry || !r.floorIds.length)) warnings.push("Some mapped spaces lack geometry or floor information.");
  return { ...base, floors, rooms, connections, tags: { ...buildingTags }, completeness: { footprint: !!base.footprint, height: base.heightMeters !== null, floorLabels: floors.length > 0 && floors.every((f) => !!f.sourceLabel), interiors: rooms.length ? "partial" : "none", routeReady: false }, warnings };
}
