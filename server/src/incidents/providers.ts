// Real-world data for map incidents. Each provider is injected, so tests never touch the network.
import type { GeoPoint, WindReading } from "@firewatch/shared/types";
import type { BuildingService } from "../buildings/service.ts";
import { DEFAULT_OVERPASS_URL, nearbyBuildings, nearbyRoads } from "../buildings/overpass.ts";
import { isObject, providerJson, type Fetch, type RequestOptions } from "../buildings/provider.ts";
import type { AddressCandidate } from "../buildings/geoapify.ts";
import type { OsmElement } from "../buildings/types.ts";
import { ROAD_RADIUS_METERS, type RoadWay } from "./crashModel.ts";
import type { NearbyBuilding } from "./fireModel.ts";
import { localFrame, offset } from "./geo.ts";

export interface GeocodeMatch {
  location: GeoPoint;
  formatted: string;
}

export interface MapProviders {
  /** The best match precise enough to pin, or null when there is none. Throws if the geocoder is down. */
  geocode(query: string): Promise<GeocodeMatch | null>;
  roads(location: GeoPoint): Promise<RoadWay[]>;
  buildings(location: GeoPoint): Promise<NearbyBuilding[]>;
  /** Current surface wind. Throws if weather is unavailable. */
  wind(location: GeoPoint): Promise<WindReading>;
}

const EXPOSURE_RADIUS_METERS = 250;
const OVERPASS_WAIT_MS = 10000;
const ROUTE_BATCH = 4;
/** Matches this coarse put a pin kilometres away from the emergency. */
const TOO_VAGUE = new Set(["country", "state", "county", "city", "postcode"]);

function roadWay(element: OsmElement): RoadWay[] {
  const tags = element.tags ?? {};
  const highway = tags.highway;
  if (element.type !== "way" || !highway || !element.nodes || !element.geometry) return [];
  const tag = tags.oneway;
  const implied = highway === "motorway" || highway === "motorway_link" || tags.junction === "roundabout";
  const oneway = tag === "-1" || tag === "reverse" ? "reverse" : tag === "yes" || tag === "true" || tag === "1" || (implied && tag !== "no") ? "forward" : "both";
  const lanes = Number.parseInt(tags.lanes ?? "", 10);
  return [{ id: element.id, name: tags.name ?? tags.ref ?? null, highway, oneway, lanes: lanes > 0 ? lanes : null, nodes: element.nodes, geometry: element.geometry }];
}

function building(element: OsmElement): NearbyBuilding[] {
  if (element.type !== "way" || !element.geometry || element.geometry.length < 4) return [];
  return [{ id: `osm:way:${element.id}`, name: element.tags?.name ?? null, outline: element.geometry.slice(0, -1) }];
}

const key = (point: number[]) => `${point[0]},${point[1]}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ROUTE_RINGS = [{ count: 12, metres: ROAD_RADIUS_METERS }, { count: 6, metres: 600 }];
const KNOWN_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"]);

interface RouteStep { from_index?: unknown; to_index?: unknown; name?: unknown; road_class?: unknown; lane_count?: unknown }

/** One-way road pieces from a Geoapify route, skipping pieces that an earlier route already gave. */
function routeWays(body: unknown, nodeIds: Map<string, number>, known: Set<string>, nextWay: () => number): RoadWay[] {
  const feature = isObject(body) && Array.isArray(body.features) ? body.features[0] : undefined;
  if (!isObject(feature) || !isObject(feature.geometry) || !isObject(feature.properties)) return [];
  const lines = feature.geometry.coordinates, legs = feature.properties.legs;
  if (!Array.isArray(lines) || !Array.isArray(lines[0]) || !Array.isArray(legs) || !isObject(legs[0]) || !Array.isArray(legs[0].steps)) return [];
  const line = lines[0] as number[][];
  const nodeOf = (point: number[]) => {
    const id = nodeIds.get(key(point)) ?? nodeIds.size + 1;
    nodeIds.set(key(point), id);
    return id;
  };
  return (legs[0].steps as RouteStep[]).flatMap((step) => {
    if (typeof step.from_index !== "number" || typeof step.to_index !== "number") return [];
    const out: RoadWay[] = [];
    for (let i = step.from_index; i < step.to_index && i + 1 < line.length; i++) {
      const a = line[i]!, b = line[i + 1]!;
      const edge = `${key(a)}>${key(b)}`;
      if (known.has(edge) || key(a) === key(b)) continue;
      known.add(edge);
      out.push({
        id: nextWay(),
        name: typeof step.name === "string" && step.name ? step.name : null,
        highway: typeof step.road_class === "string" && KNOWN_CLASSES.has(step.road_class) ? step.road_class : "residential",
        oneway: "forward",
        lanes: typeof step.lane_count === "number" && step.lane_count > 0 ? step.lane_count : null,
        nodes: [nodeOf(a), nodeOf(b)],
        geometry: [{ lat: a[1]!, lon: a[0]! }, { lat: b[1]!, lon: b[0]! }],
      });
    }
    return out;
  });
}

/**
 * Roads leading to a point, from routes driven in to it from all sides. These are the streets a
 * queue backs up along, and this needs only Geoapify, for when the public Overpass servers are down.
 */
async function approachRoads(location: GeoPoint, apiKey: string, options: RequestOptions, batchDelayMs: number): Promise<RoadWay[]> {
  const { toPoint } = localFrame(location);
  const starts = ROUTE_RINGS.flatMap(({ count, metres }) => Array.from({ length: count }, (_, i) => toPoint(offset((i / count) * 2 * Math.PI, metres))));
  const nodeIds = new Map<string, number>();
  const known = new Set<string>();
  let way = 0;
  const ways: RoadWay[] = [];
  let answered = 0;
  for (let i = 0; i < starts.length; i += ROUTE_BATCH) {
    if (i > 0) await delay(batchDelayMs); // Geoapify's free plan allows about 5 requests a second
    const bodies = await Promise.allSettled(starts.slice(i, i + ROUTE_BATCH).map((start) => {
      const url = new URL("https://api.geoapify.com/v1/routing");
      url.search = new URLSearchParams({ waypoints: `${start.lat},${start.lon}|${location.lat},${location.lon}`, mode: "drive", details: "route_details", apiKey }).toString();
      return providerJson(url, "Geoapify routing", { headers: { accept: "application/json" } }, { timeoutMs: 8000, ...options });
    }));
    for (const body of bodies) {
      if (body.status !== "fulfilled") continue;
      answered++;
      ways.push(...routeWays(body.value, nodeIds, known, () => ++way));
    }
  }
  if (!answered) throw new Error("Geoapify routing did not answer");
  return ways;
}

async function placesNear({ lat, lon }: GeoPoint, apiKey: string, options: RequestOptions): Promise<NearbyBuilding[]> {
  const url = new URL("https://api.geoapify.com/v2/places");
  url.search = new URLSearchParams({ categories: "building", filter: `circle:${lon},${lat},${EXPOSURE_RADIUS_METERS}`, limit: "50", apiKey }).toString();
  const body = await providerJson(url, "Geoapify places", { headers: { accept: "application/json" } }, { timeoutMs: 8000, ...options });
  if (!isObject(body) || !Array.isArray(body.features)) throw new Error("Geoapify places returned no list");
  return body.features.flatMap((feature: unknown, index: number): NearbyBuilding[] => {
    const props = isObject(feature) && isObject(feature.properties) ? feature.properties : {};
    if (typeof props.lat !== "number" || typeof props.lon !== "number") return [];
    const name = typeof props.name === "string" ? props.name : typeof props.address_line1 === "string" ? props.address_line1 : null;
    return [{ id: typeof props.place_id === "string" ? props.place_id : `place-${index}`, name, outline: [], location: { lat: props.lat, lon: props.lon } }];
  });
}

export interface DefaultProviderOptions {
  geoapifyApiKey?: string;
  overpassUrl?: string;
  fetch?: Fetch;
  routeBatchDelayMs?: number;
}

/**
 * The best match to pin, or null. When the geocoder can only place the city it returns that first,
 * followed by weak guesses from anywhere in the world, so later matches must be in that city.
 */
export function pickMatch(candidates: Pick<AddressCandidate, "address" | "resultType" | "location">[]): GeocodeMatch | null {
  const vague = (c: { resultType: string | null }) => TOO_VAGUE.has(c.resultType ?? "");
  const first = candidates[0];
  if (!first) return null;
  const city = vague(first) ? first.address.split(",")[0]!.trim().toLowerCase() : null;
  const match = candidates.find((c) => !vague(c) && (city === null || c.address.toLowerCase().includes(city)));
  return match ? { location: match.location, formatted: match.address } : null;
}

/** The geocoder finds "A Road & B Road" as an intersection far more often than "A Road and B Road". */
export const intersectionQuery = (query: string) => (/^\s*\d/.test(query) ? query : query.replace(/\s+and\s+/i, " & "));

export function defaultMapProviders(service: Pick<BuildingService, "search">, options: DefaultProviderOptions = {}): MapProviders {
  const overpass = () => options.overpassUrl ?? process.env.OVERPASS_API_URL ?? DEFAULT_OVERPASS_URL;
  const apiKey = () => options.geoapifyApiKey ?? process.env.GEOAPIFY_API_KEY;
  const request = options.fetch ? { fetch: options.fetch } : {};
  const overpassRequest = { ...request, timeoutMs: OVERPASS_WAIT_MS };
  const batchDelay = options.routeBatchDelayMs ?? 1100;
  /** Overpass has the full street network and building outlines, but public servers are often down. */
  async function withFallback<T>(primary: () => Promise<T[]>, fallback: (key: string) => Promise<T[]>): Promise<T[]> {
    try {
      const found = await primary();
      if (found.length) return found;
    } catch (err) {
      if (!apiKey()?.trim()) throw err;
    }
    return apiKey()?.trim() ? fallback(apiKey()!) : [];
  }
  return {
    async geocode(query) {
      const { candidates } = await service.search(intersectionQuery(query));
      return pickMatch(candidates);
    },
    roads: (location) => withFallback(
      async () => (await nearbyRoads(location, ROAD_RADIUS_METERS, overpass(), overpassRequest)).flatMap(roadWay),
      (key) => approachRoads(location, key, request, batchDelay),
    ),
    buildings: (location) => withFallback(
      async () => (await nearbyBuildings(location, overpass(), overpassRequest, EXPOSURE_RADIUS_METERS)).flatMap(building),
      (key) => placesNear(location, key, request),
    ),
    async wind({ lat, lon }) {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: "wind_speed_10m,wind_direction_10m", wind_speed_unit: "ms" }).toString();
      const body = await providerJson(url, "Open-Meteo", { headers: { accept: "application/json" } }, { timeoutMs: 6000, maxBytes: 64 * 1024, ...request });
      const current = isObject(body) && isObject(body.current) ? body.current : {};
      const speedMps = current.wind_speed_10m, fromDegrees = current.wind_direction_10m;
      if (typeof speedMps !== "number" || typeof fromDegrees !== "number") throw new Error("Open-Meteo returned no wind");
      return { speedMps, fromDegrees };
    },
  };
}
