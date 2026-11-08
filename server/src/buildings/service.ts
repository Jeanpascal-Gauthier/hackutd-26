import type { BuildingCandidate, BuildingRecord, Coordinates } from "./types.ts";
import { createLocationOnlyRecord, getBuildingBounds, listOsmBuildingCandidates, normalizeOsmBuilding, osmId } from "./normalize.ts";
import { searchAddresses, validateSearch, type AddressCandidate } from "./geoapify.ts";
import { buildingInteriors, DEFAULT_OVERPASS_URL, nearbyBuildings, validateLocation, validOverpassUrl } from "./overpass.ts";
import { BuildingApiError, isObject, type Fetch } from "./provider.ts";

export { BuildingApiError } from "./provider.ts";

export interface CacheInfo { stale: boolean; fetchedAt: string; expiresAt: string }
interface Entry<T> { value: T; fetchedAt: number; expiresAt: number }
export interface BuildingResponse { ok: true; building: BuildingRecord; cache: CacheInfo }
export interface ResolveInput extends Coordinates { buildingId?: string }
export interface BuildingServiceOptions {
  geoapifyApiKey?: string;
  overpassApiUrl?: string;
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  lookupTtlMs?: number;
  maxCachedBuildings?: number;
}

function validateBuildingId(value: unknown): string {
  if (typeof value !== "string" || !/^osm:(way|relation):[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value.split(":")[2])))
    throw new BuildingApiError(400, "invalid_building_id", "`buildingId` must be a building candidate ID returned by this service.");
  return value;
}

/** Lookup records stay separate from the active incident and demo simulation. */
export function createBuildingService(options: BuildingServiceOptions = {}) {
  const apiKey = options.geoapifyApiKey ?? process.env.GEOAPIFY_API_KEY;
  const overpassUrl = options.overpassApiUrl ?? process.env.OVERPASS_API_URL ?? DEFAULT_OVERPASS_URL;
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? 15 * 60 * 1000;
  const lookupTtl = options.lookupTtlMs ?? 5 * 60 * 1000;
  const maxRecords = Math.max(1, Math.min(1000, options.maxCachedBuildings ?? 100));
  const requestOptions = { fetch: options.fetch, timeoutMs: options.timeoutMs };
  const buildings = new Map<string, Entry<BuildingRecord>>();
  const searches = new Map<string, Entry<AddressCandidate[]>>();
  const nearby = new Map<string, Entry<Awaited<ReturnType<typeof nearbyBuildings>>>>();
  const inFlight = new Map<string, Promise<BuildingResponse>>();

  const cacheInfo = (entry: Entry<unknown>): CacheInfo => ({
    stale: now() >= entry.expiresAt,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
  });
  function put<T>(map: Map<string, Entry<T>>, key: string, value: T, age: number, fetchedAt = now()): Entry<T> {
    const entry = { value, fetchedAt, expiresAt: fetchedAt + age };
    map.delete(key);
    map.set(key, entry);
    while (map.size > maxRecords) map.delete(map.keys().next().value!);
    return entry;
  }
  const response = (entry: Entry<BuildingRecord>): BuildingResponse => ({ ok: true, building: entry.value, cache: cacheInfo(entry) });

  async function search(query: unknown) {
    const text = validateSearch(query);
    const cached = searches.get(text.toLocaleLowerCase());
    if (cached && cached.expiresAt > now()) return { ok: true as const, candidates: cached.value, cache: cacheInfo(cached) };
    const candidates = await searchAddresses(text, apiKey, requestOptions);
    const entry = put(searches, text.toLocaleLowerCase(), candidates, lookupTtl);
    return { ok: true as const, candidates, cache: cacheInfo(entry) };
  }

  async function resolveFresh(location: Coordinates, buildingId?: string): Promise<BuildingResponse> {
    // Coordinate precision is shared by the query and cache: an adjacent selection cannot reuse
    // a different coordinate's candidate set simply because of rounded cache keys.
    const key = `${location.lat},${location.lon}`;
    let lookup = nearby.get(key);
    if (!lookup || lookup.expiresAt <= now())
      lookup = put(nearby, key, await nearbyBuildings(location, overpassUrl, requestOptions), lookupTtl);
    const fetchedAt = new Date(lookup.fetchedAt).toISOString();
    const candidates = listOsmBuildingCandidates(lookup.value, location, fetchedAt);
    if (!candidates.length) {
      if (buildingId)
        throw new BuildingApiError(409, "building_not_at_location", "The selected building was not found at this location. Search again.", { candidates });
      const record = createLocationOnlyRecord(location, fetchedAt);
      return response(put(buildings, record.id, record, ttl, lookup.fetchedAt));
    }
    if (!buildingId)
      throw new BuildingApiError(409, "building_selection_required", "Confirm the building before loading its details.", { candidates });
    const selected: BuildingCandidate | undefined = candidates.find((candidate) => candidate.id === buildingId);
    if (!selected)
      throw new BuildingApiError(409, "building_not_at_location", "The selected building is not one of this location's candidates.", { candidates });
    const cached = buildings.get(buildingId);
    if (cached && cached.expiresAt > now()) return response(cached);
    let all = lookup.value;
    const raw = all.find((element) => osmId(element) === selected.id);
    const bounds = raw && getBuildingBounds(raw, all);
    const warnings: string[] = [];
    if (bounds) {
      try {
        const interiors = await buildingInteriors(bounds, overpassUrl, requestOptions);
        const combined = new Map(all.map((element) => [osmId(element), element]));
        for (const element of interiors) combined.set(osmId(element), element);
        all = [...combined.values()];
      } catch (error) {
        if (!(error instanceof BuildingApiError)) throw error;
        warnings.push(`Interior lookup unavailable (${error.code}); this record includes only previously retrieved data.`);
      }
    }
    const record = normalizeOsmBuilding(selected.id, all, location, fetchedAt);
    if (!record) throw new BuildingApiError(502, "building_geometry_unavailable", "The selected building could not be normalized.");
    record.warnings.push(...warnings);
    return response(put(buildings, record.id, record, ttl, lookup.fetchedAt));
  }

  async function resolve(input: unknown): Promise<BuildingResponse> {
    const location = validateLocation(input);
    const buildingId = isObject(input) && input.buildingId !== undefined ? validateBuildingId(input.buildingId) : undefined;
    const key = `${location.lat},${location.lon}:${buildingId ?? ""}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = resolveFresh(location, buildingId);
    inFlight.set(key, pending);
    try { return await pending; } finally { inFlight.delete(key); }
  }

  function get(id: string): BuildingResponse {
    const entry = buildings.get(id);
    if (!entry) throw new BuildingApiError(404, "building_not_cached", "Building not found in this server's cache. Resolve the location again.");
    return response(entry);
  }

  function rooms(id: string) {
    const { building, cache } = get(id);
    return {
      ok: true as const, buildingId: building.id, floors: building.floors, rooms: building.rooms,
      connections: building.connections, source: building.source, completeness: building.completeness,
      warnings: building.warnings, routeAnalysisAvailable: false as const, cache,
    };
  }

  function providers() {
    let overpassConfigured = true;
    try { validOverpassUrl(overpassUrl); } catch { overpassConfigured = false; }
    return { ok: true as const, providers: {
      geoapify: { configured: Boolean(apiKey?.trim()), requiresApiKey: true },
      overpass: { configured: overpassConfigured, requiresApiKey: false },
    } };
  }

  return { search, resolve, get, rooms, providers };
}

export type BuildingService = ReturnType<typeof createBuildingService>;
