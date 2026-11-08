// Real-world data for map incidents. Each provider is injected, so tests never touch the network.
import type { GeoPoint, WindReading } from "@firewatch/shared/types";
import type { BuildingService } from "../buildings/service.ts";
import { DEFAULT_OVERPASS_URL, nearbyBuildings, nearbyRoads, validOverpassUrl, validateLocation } from "../buildings/overpass.ts";
import { isObject, providerJson, type Fetch, type RequestOptions } from "../buildings/provider.ts";
import type { AddressCandidate } from "../buildings/geoapify.ts";
import type { OsmElement } from "../buildings/types.ts";
import { ROAD_RADIUS_METERS, type RoadWay } from "./crashModel.ts";
import { EXPOSURE_RADIUS_METERS, SENSITIVE_RADIUS_METERS, type NearbyBuilding, type NearbyBuildings } from "./fireModel.ts";
import { geoDistance, localFrame, offset } from "./geo.ts";

export interface GeocodeMatch {
  location: GeoPoint;
  formatted: string;
}

export interface MapProviders {
  /** The best match precise enough to pin, or null when there is none. Throws if the geocoder is down. */
  geocode(query: string): Promise<GeocodeMatch | null>;
  roads(location: GeoPoint): Promise<RoadWay[]>;
  /** Buildings close by, plus hospitals, schools and care homes further out. */
  buildings(location: GeoPoint): Promise<NearbyBuildings>;
  /** Current surface wind. Throws if weather is unavailable. */
  wind(location: GeoPoint): Promise<WindReading>;
  /** Ground elevation in metres, one per point, in order. Throws if unavailable. Optional: floods then spread evenly. */
  elevation?(points: GeoPoint[]): Promise<number[]>;
}

const OVERPASS_WAIT_MS = 10000;
const SENSITIVE_WAIT_MS = 8000; // this lookup runs beside the ordinary one and must not hold up the forecast
const MAX_SENSITIVE_SITES = 250; // a hard cap on the query; Overpass truncates arbitrarily past it
const SAME_SITE_METERS = 300; // one hospital is often mapped as both a campus and a point
const ROUTE_BATCH = 4;
const ELEVATION_BATCH = 100; // Open-Meteo's limit of coordinates per request
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

const SENSITIVE_USES = new Map([
  ["amenity=hospital", "hospital"], ["amenity=clinic", "clinic"], ["amenity=school", "school"],
  ["amenity=university", "university"], ["amenity=kindergarten", "kindergarten"], ["amenity=nursing_home", "nursing home"],
  ["healthcare=hospital", "hospital"], ["healthcare=clinic", "clinic"],
  ["social_facility=nursing_home", "nursing home"], ["social_facility=assisted_living", "care facility"], ["social_facility=group_home", "care facility"],
  // Only read off buildings already fetched: querying these would return every wing of every campus.
  ["building=hospital", "hospital"], ["building=school", "school"], ["building=university", "university"], ["building=kindergarten", "kindergarten"],
]);

function useOf(tags: Record<string, string> | undefined): string | undefined {
  for (const key of ["amenity", "healthcare", "social_facility", "building"]) {
    const use = SENSITIVE_USES.get(`${key}=${tags?.[key]}`);
    if (use) return use;
  }
  return undefined;
}

function building(element: OsmElement): NearbyBuilding[] {
  if (element.type !== "way" || !element.geometry || element.geometry.length < 4) return [];
  const use = useOf(element.tags);
  return [{ id: `osm:way:${element.id}`, name: element.tags?.name ?? null, outline: element.geometry.slice(0, -1), ...(use ? { use } : {}) }];
}

function sensitiveSite(raw: unknown): NearbyBuilding[] {
  if (!isObject(raw) || typeof raw.type !== "string" || typeof raw.id !== "number" || !isObject(raw.tags)) return [];
  const tags = raw.tags as Record<string, string>;
  const use = useOf(tags);
  const at = isObject(raw.center) ? raw.center : raw;
  if (!use || typeof at.lat !== "number" || typeof at.lon !== "number") return [];
  return [{ id: `osm:${raw.type}:${raw.id}`, name: typeof tags.name === "string" ? tags.name : null, outline: [], location: { lat: at.lat, lon: at.lon }, use }];
}

/** Sites by centre point only, which keeps a 3 km query small. Goes direct because overpass.ts has no tag query. */
async function sensitiveSitesOverpass(location: GeoPoint, url: string, options: RequestOptions): Promise<NearbyBuilding[]> {
  const { lat, lon } = validateLocation(location);
  const around = `(around:${SENSITIVE_RADIUS_METERS},${lat},${lon})`;
  const query = `[out:json][timeout:${SENSITIVE_WAIT_MS / 1000}];(`
    + `nwr["amenity"~"^(hospital|clinic|school|university|kindergarten|nursing_home)$"]${around};`
    + `nwr["healthcare"~"^(hospital|clinic)$"]${around};`
    + `nwr["social_facility"~"^(nursing_home|assisted_living|group_home)$"]${around};`
    + `);out center ${MAX_SENSITIVE_SITES};`;
  const body = await providerJson(validOverpassUrl(url), "OpenStreetMap", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "FireWatch/0.0.0 (HackUTD building lookup prototype)" },
    body: new URLSearchParams({ data: query }).toString(),
  }, { ...options, timeoutMs: SENSITIVE_WAIT_MS });
  // A remark means Overpass gave up part way, so the list would silently be missing sites.
  if (!isObject(body) || !Array.isArray(body.elements) || typeof body.remark === "string") throw new Error("Overpass returned no complete site list");
  return body.elements.slice(0, MAX_SENSITIVE_SITES).flatMap(sensitiveSite);
}

const GEOAPIFY_SENSITIVE: [string, string][] = [
  ["healthcare.hospital", "hospital"], ["healthcare.clinic_or_praxis", "clinic"], ["education.school", "school"],
  ["education.university", "university"], ["childcare.kindergarten", "kindergarten"],
  ["service.social_facility.nursing_home", "nursing home"], ["service.social_facility.retirement_home", "care facility"],
];

async function sensitiveSitesGeoapify({ lat, lon }: GeoPoint, apiKey: string, options: RequestOptions): Promise<NearbyBuilding[]> {
  const url = new URL("https://api.geoapify.com/v2/places");
  url.search = new URLSearchParams({
    categories: GEOAPIFY_SENSITIVE.map(([category]) => category).join(","),
    filter: `circle:${lon},${lat},${SENSITIVE_RADIUS_METERS}`,
    bias: `proximity:${lon},${lat}`,
    limit: String(MAX_SENSITIVE_SITES),
    apiKey,
  }).toString();
  const body = await providerJson(url, "Geoapify places", { headers: { accept: "application/json" } }, { timeoutMs: 8000, ...options });
  if (!isObject(body) || !Array.isArray(body.features)) throw new Error("Geoapify places returned no list");
  return body.features.flatMap((feature: unknown, index: number): NearbyBuilding[] => {
    const props = isObject(feature) && isObject(feature.properties) ? feature.properties : {};
    if (typeof props.lat !== "number" || typeof props.lon !== "number" || !Array.isArray(props.categories)) return [];
    const categories = props.categories.filter((c): c is string => typeof c === "string");
    const use = GEOAPIFY_SENSITIVE.find(([key]) => categories.some((c) => c === key || c.startsWith(`${key}.`)))?.[1];
    if (!use) return [];
    return [{ id: typeof props.place_id === "string" ? props.place_id : `site-${index}`, name: typeof props.name === "string" ? props.name : null, outline: [], location: { lat: props.lat, lon: props.lon }, use }];
  });
}

/** Adds the sites to the buildings. A site that is also a fetched building marks it rather than repeating it. */
function withSensitiveSites(nearby: NearbyBuilding[], sites: NearbyBuilding[]): NearbyBuilding[] {
  const byId = new Map(nearby.map((b) => [b.id, b]));
  const added: NearbyBuilding[] = [];
  for (const site of sites) {
    const known = byId.get(site.id);
    if (known) known.use ??= site.use;
    else if (!added.some((a) => a.name !== null && a.name === site.name && a.use === site.use && geoDistance(a.location!, site.location!) <= SAME_SITE_METERS)) added.push(site);
  }
  return [...nearby, ...added];
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
    async buildings(location) {
      // Side by side so a slow site lookup costs no extra time. Its failure only removes the sites.
      const [nearby, sites] = await Promise.all([
        withFallback(
          async () => (await nearbyBuildings(location, overpass(), overpassRequest, EXPOSURE_RADIUS_METERS)).flatMap(building),
          (key) => placesNear(location, key, request),
        ),
        withFallback(
          () => sensitiveSitesOverpass(location, overpass(), request),
          (key) => sensitiveSitesGeoapify(location, key, request),
        ).catch(() => null),
      ]);
      if (sites) return withSensitiveSites(nearby, sites);
      return Object.assign(nearby, { sensitiveSitesUnavailable: true });
    },
    async wind({ lat, lon }) {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: "wind_speed_10m,wind_direction_10m", wind_speed_unit: "ms" }).toString();
      const body = await providerJson(url, "Open-Meteo", { headers: { accept: "application/json" } }, { timeoutMs: 6000, maxBytes: 64 * 1024, ...request });
      const current = isObject(body) && isObject(body.current) ? body.current : {};
      const speedMps = current.wind_speed_10m, fromDegrees = current.wind_direction_10m;
      if (typeof speedMps !== "number" || typeof fromDegrees !== "number") throw new Error("Open-Meteo returned no wind");
      return { speedMps, fromDegrees };
    },
    async elevation(points) {
      const out: number[] = [];
      for (let i = 0; i < points.length; i += ELEVATION_BATCH) {
        const batch = points.slice(i, i + ELEVATION_BATCH).map(validateLocation);
        const url = new URL("https://api.open-meteo.com/v1/elevation");
        url.search = new URLSearchParams({ latitude: batch.map((p) => p.lat.toFixed(5)).join(","), longitude: batch.map((p) => p.lon.toFixed(5)).join(",") }).toString();
        const body = await providerJson(url, "Open-Meteo elevation", { headers: { accept: "application/json" } }, { timeoutMs: 6000, maxBytes: 64 * 1024, ...request });
        const heights = isObject(body) && Array.isArray(body.elevation) ? body.elevation : [];
        if (heights.length !== batch.length || !heights.every((h): h is number => typeof h === "number" && Number.isFinite(h))) throw new Error("Open-Meteo returned no elevation");
        out.push(...heights);
      }
      return out;
    },
  };
}
