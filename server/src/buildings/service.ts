import type { BuildingCandidate, BuildingRecord, Coordinates, OsmElement } from "./types.ts";
import { createLocationOnlyRecord, getBuildingBounds, listOsmBuildingCandidates, normalizeOsmBuilding, osmId } from "./normalize.ts";
import { searchAddresses, validateSearch, type AddressCandidate } from "./geoapify.ts";
import { buildingInteriors, DEFAULT_OVERPASS_URL, nearbyBuildings, validateLocation, validOverpassUrl } from "./overpass.ts";
import { BuildingApiError, isObject, type Fetch } from "./provider.ts";
import { createSnapshotStore, DEFAULT_SNAPSHOT_DIR, type SnapshotHit } from "./snapshots.ts";

export { BuildingApiError } from "./provider.ts";

export interface CacheInfo {
  stale: boolean;
  fetchedAt: string;
  expiresAt: string;
  /** "snapshot": served from an offline copy (server/snapshots/); `fetchedAt` is when it was saved. */
  source: "live" | "snapshot";
  /** Why a snapshot was served: the provider error code, or "offline_mode". */
  offlineReason?: string;
}
/** Where a value came from, when it is an offline copy. */
export interface OfflineOrigin { savedAt: string; reason: string }
interface Entry<T> { value: T; fetchedAt: number; expiresAt: number; offline?: OfflineOrigin }
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
  /** Folder of offline copies; false disables them. Default BUILDINGS_SNAPSHOT_DIR, else server/snapshots/. */
  snapshotDir?: string | false;
  /** Never contact Geoapify or Overpass; serve only snapshots. Default: BUILDINGS_OFFLINE=1. */
  offline?: boolean;
  /** After a provider fails, serve a matching snapshot without retrying it for this long. Default 60 s. */
  providerCooldownMs?: number;
}

/** Failures a snapshot may stand in for: timeouts, rate limits, 5xx, network errors, a missing key. */
const providerFailure = (error: unknown): error is BuildingApiError => error instanceof BuildingApiError && error.status >= 500;
const savedDate = (iso: string) => iso.slice(0, 10);

/** The operator-facing note on data served from an offline copy. */
export function offlineWarning(offline: OfflineOrigin, what = "Offline copy"): string {
  return `${what} saved ${savedDate(offline.savedAt)}; live lookup unavailable (${offline.reason}).`;
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
  const offlineMode = options.offline ?? process.env.BUILDINGS_OFFLINE === "1";
  const cooldown = options.providerCooldownMs ?? 60 * 1000;
  const snapshots = createSnapshotStore(options.snapshotDir ?? process.env.BUILDINGS_SNAPSHOT_DIR ?? DEFAULT_SNAPSHOT_DIR);
  const buildings = new Map<string, Entry<BuildingRecord>>();
  const searches = new Map<string, Entry<AddressCandidate[]>>();
  const nearby = new Map<string, Entry<OsmElement[]>>();
  const inFlight = new Map<string, Promise<BuildingResponse>>();
  /** Providers that failed recently: until when, and with which error. */
  const down = new Map<string, { until: number; error: BuildingApiError }>();

  const cacheInfo = (entry: Entry<unknown>): CacheInfo => ({
    stale: now() >= entry.expiresAt,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    source: entry.offline ? "snapshot" : "live",
    ...(entry.offline && { offlineReason: entry.offline.reason }),
  });
  function put<T>(map: Map<string, Entry<T>>, key: string, value: T, age: number, fetchedAt = now(), offline?: OfflineOrigin): Entry<T> {
    // An offline copy's fetchedAt is its save date, but it stays cached from now like a fresh lookup.
    const entry: Entry<T> = { value, fetchedAt, expiresAt: (offline ? now() : fetchedAt) + age, ...(offline && { offline }) };
    map.delete(key);
    map.set(key, entry);
    while (map.size > maxRecords) map.delete(map.keys().next().value!);
    return entry;
  }
  const response = (entry: Entry<BuildingRecord>): BuildingResponse => ({ ok: true, building: entry.value, cache: cacheInfo(entry) });

  /**
   * Live provider, then on a provider failure: the stale in-memory copy, then a snapshot, else the
   * original error. Offline mode skips the provider. Within `cooldown` of a failure a matching
   * snapshot is served without waiting on the provider again, and `optional` lookups (interiors)
   * fail fast instead of waiting on it.
   */
  async function withFallback<T>(
    provider: "geoapify" | "overpass",
    live: () => Promise<T>,
    stale: Entry<T> | undefined,
    saved: () => SnapshotHit<T> | undefined,
    optional = false,
  ): Promise<{ value: T; fetchedAt?: number; offline?: OfflineOrigin; stale?: Entry<T> }> {
    const fromSnapshot = (reason: string) => {
      const hit = saved();
      return hit && { value: hit.value, fetchedAt: Date.parse(hit.savedAt), offline: { savedAt: hit.savedAt, reason } };
    };
    if (offlineMode) {
      const hit = fromSnapshot("offline_mode");
      if (hit) return hit;
      throw new BuildingApiError(503, "offline_no_snapshot",
        "Offline mode (BUILDINGS_OFFLINE=1): no saved copy of this lookup. Capture one with `npm run snapshot -w server`.");
    }
    const recent = down.get(provider);
    if (recent && recent.until > now()) {
      if (stale) return { value: stale.value, stale };
      const hit = fromSnapshot(recent.error.code);
      if (hit) return hit;
      if (optional) throw recent.error;
    }
    try {
      const value = await live();
      down.delete(provider);
      return { value };
    } catch (error) {
      if (!providerFailure(error)) throw error;
      down.set(provider, { until: now() + cooldown, error });
      if (stale) return { value: stale.value, stale };
      const hit = fromSnapshot(error.code);
      if (!hit) throw error;
      console.warn(`[buildings] ${provider} ${error.code}: serving the offline copy saved ${savedDate(hit.offline.savedAt)}`);
      return hit;
    }
  }

  async function search(query: unknown) {
    const text = validateSearch(query);
    const key = text.toLocaleLowerCase();
    const cached = searches.get(key);
    if (cached && cached.expiresAt > now()) return { ok: true as const, candidates: cached.value, cache: cacheInfo(cached) };
    const got = await withFallback("geoapify", () => searchAddresses(text, apiKey, requestOptions), cached, () => snapshots.search(text));
    const entry = got.stale ?? put(searches, key, got.value, lookupTtl, got.fetchedAt, got.offline);
    return { ok: true as const, candidates: entry.value, cache: cacheInfo(entry) };
  }

  async function resolveFresh(location: Coordinates, buildingId?: string): Promise<BuildingResponse> {
    // Coordinate precision is shared by the query and cache: an adjacent selection cannot reuse
    // a different coordinate's candidate set simply because of rounded cache keys.
    const key = `${location.lat},${location.lon}`;
    let lookup = nearby.get(key);
    if (!lookup || lookup.expiresAt <= now()) {
      const got = await withFallback("overpass", () => nearbyBuildings(location, overpassUrl, requestOptions), lookup, () => snapshots.nearby(location));
      lookup = got.stale ?? put(nearby, key, got.value, lookupTtl, got.fetchedAt, got.offline);
    }
    const fetchedAt = new Date(lookup.fetchedAt).toISOString();
    const candidates = listOsmBuildingCandidates(lookup.value, location, fetchedAt);
    const cache = cacheInfo(lookup);
    const warnings = lookup.offline ? [offlineWarning(lookup.offline)] : [];
    let offline = lookup.offline;
    if (!candidates.length) {
      if (buildingId)
        throw new BuildingApiError(409, "building_not_at_location", "The selected building was not found at this location. Search again.", { candidates, cache });
      const record = createLocationOnlyRecord(location, fetchedAt);
      record.warnings.push(...warnings);
      return response(put(buildings, record.id, record, ttl, lookup.fetchedAt, offline));
    }
    if (!buildingId)
      throw new BuildingApiError(409, "building_selection_required", "Confirm the building before loading its details.", { candidates, cache });
    const selected: BuildingCandidate | undefined = candidates.find((candidate) => candidate.id === buildingId);
    if (!selected)
      throw new BuildingApiError(409, "building_not_at_location", "The selected building is not one of this location's candidates.", { candidates, cache });
    const cached = buildings.get(buildingId);
    if (cached && cached.expiresAt > now()) return response(cached);
    let all = lookup.value;
    const raw = all.find((element) => osmId(element) === selected.id);
    const bounds = raw && getBuildingBounds(raw, all);
    if (bounds) {
      try {
        const got = await withFallback("overpass", () => buildingInteriors(bounds, overpassUrl, requestOptions), undefined,
          () => snapshots.interiors(selected.id, location), true);
        if (got.offline && !offline) {
          warnings.push(offlineWarning(got.offline, "Interior details are an offline copy"));
          offline = got.offline;
        }
        const combined = new Map(all.map((element) => [osmId(element), element]));
        for (const element of got.value) combined.set(osmId(element), element);
        all = [...combined.values()];
      } catch (error) {
        if (!(error instanceof BuildingApiError)) throw error;
        warnings.push(`Interior lookup unavailable (${error.code}); this record includes only previously retrieved data.`);
      }
    }
    const record = normalizeOsmBuilding(selected.id, all, location, fetchedAt);
    if (!record) throw new BuildingApiError(502, "building_geometry_unavailable", "The selected building could not be normalized.");
    record.warnings.push(...warnings);
    return response(put(buildings, record.id, record, ttl, lookup.fetchedAt, offline));
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
    }, snapshots: { offlineMode, saved: snapshots.count() } };
  }

  return { search, resolve, get, rooms, providers };
}

export type BuildingService = ReturnType<typeof createBuildingService>;
