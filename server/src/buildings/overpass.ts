import type { Coordinates, OsmElement, OsmMember } from "./types.ts";
import { BuildingApiError, isObject, providerJson, type RequestOptions } from "./provider.ts";

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const SEARCH_RADIUS_METERS = 150;
export interface Bounds { south: number; west: number; north: number; east: number }

export function validateLocation(value: unknown): Coordinates {
  if (!isObject(value) || typeof value.lat !== "number" || typeof value.lon !== "number" ||
      !Number.isFinite(value.lat) || !Number.isFinite(value.lon) || Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180)
    throw new BuildingApiError(400, "invalid_location", "`lat` and `lon` must be finite numbers within geographic bounds.");
  return { lat: value.lat, lon: value.lon };
}

const coordinate = (value: unknown): value is Coordinates => isObject(value) &&
  typeof value.lat === "number" && typeof value.lon === "number" && Number.isFinite(value.lat) && Number.isFinite(value.lon) &&
  Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180;
const invalidResponse = () => new BuildingApiError(502, "provider_invalid_response", "OpenStreetMap returned invalid geometry or topology.");
const geometry = (value: unknown): Coordinates[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  // Dropping one vertex would create an outline that the source never supplied.
  if (!value.every(coordinate)) throw invalidResponse();
  return value.map(({ lat, lon }) => ({ lat, lon }));
};
const osmType = (value: unknown): value is OsmElement["type"] => value === "node" || value === "way" || value === "relation";
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Keep only known OSM fields; geometry, tags and member arrays are not trusted casts. */
function elements(body: unknown): OsmElement[] {
  if (!isObject(body) || !Array.isArray(body.elements) || body.elements.length > 20000 || typeof body.remark === "string")
    throw new BuildingApiError(502, "provider_invalid_response", "OpenStreetMap returned an incomplete or invalid response.");
  return body.elements.flatMap((raw: unknown): OsmElement[] => {
    if (!isObject(raw) || !osmType(raw.type) || !positiveId(raw.id)) return [];
    const element: OsmElement = { type: raw.type, id: raw.id };
    if (isObject(raw.tags)) element.tags = Object.fromEntries(Object.entries(raw.tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (Array.isArray(raw.nodes)) {
      if (!raw.nodes.every(positiveId)) throw invalidResponse();
      element.nodes = raw.nodes;
    }
    if (Array.isArray(raw.geometry)) element.geometry = geometry(raw.geometry);
    if (coordinate(raw)) { element.lat = raw.lat; element.lon = raw.lon; }
    if (coordinate(raw.center)) element.center = { lat: raw.center.lat, lon: raw.center.lon };
    if (typeof raw.timestamp === "string") element.timestamp = raw.timestamp;
    if (Array.isArray(raw.members)) element.members = raw.members.flatMap((member: unknown): OsmMember[] => {
      if (!isObject(member) || !osmType(member.type) || !positiveId(member.ref)) throw invalidResponse();
      return [{ type: member.type, ref: member.ref,
        ...(typeof member.role === "string" ? { role: member.role } : {}),
        ...(Array.isArray(member.geometry) ? { geometry: geometry(member.geometry) } : {}),
        ...(coordinate(member) ? { lat: member.lat, lon: member.lon } : {}),
      }];
    });
    return [element];
  });
}

export function validOverpassUrl(input: string): string {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new BuildingApiError(503, "overpass_not_configured", "OVERPASS_API_URL must be an HTTP(S) endpoint without credentials or query parameters.");
  }
}

async function queryOverpass(query: string, url: string, options: RequestOptions): Promise<OsmElement[]> {
  const body = await providerJson(validOverpassUrl(url), "OpenStreetMap", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ data: query }).toString(),
  }, options);
  return elements(body);
}

export async function nearbyBuildings(location: Coordinates, url = DEFAULT_OVERPASS_URL, options: RequestOptions = {}): Promise<OsmElement[]> {
  const { lat, lon } = validateLocation(location);
  const around = `(around:${SEARCH_RADIUS_METERS},${lat},${lon})`;
  return queryOverpass(`[out:json][timeout:8];(way["building"]${around};relation["building"]${around};);out meta geom;`, url, options);
}

/** Fetch indoor features plus child/member nodes required to preserve rooms and shared doors. */
export async function buildingInteriors(bounds: Bounds, url = DEFAULT_OVERPASS_URL, options: RequestOptions = {}): Promise<OsmElement[]> {
  const { south, west, north, east } = bounds;
  if (![south, west, north, east].every(Number.isFinite) || south > north || west > east ||
      south < -90 || north > 90 || west < -180 || east > 180 || north - south > 0.03 || east - west > 0.03)
    throw new BuildingApiError(422, "building_area_too_large", "Interior lookup is unavailable for this building's geographic bounds.");
  const box = `(${south},${west},${north},${east})`;
  const indoor = `["indoor"]${box};nwr["room"]${box};nwr["stairs"]${box};nwr["highway"="steps"]${box};nwr["highway"="corridor"]${box};nwr["highway"="elevator"]${box};nwr["door"]${box};nwr["entrance"]${box}`;
  return queryOverpass(`[out:json][timeout:8];(nwr${indoor};);(._;>;);out meta geom;`, url, options);
}
