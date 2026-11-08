// Address lookup -> confirmed building -> active incident building (live mode). See server/API.md,
// "Building from an address".
//
//   lookupAddress(address)  status "searching": geocode (Geoapify, top result), then OSM
//                           outlines via the configured building provider. Outlines -> "needs_confirmation" with
//                           summarized candidates (the operator ALWAYS confirms, even one). No
//                           outlines -> build from the location-only record and activate it.
//   confirmBuilding(id)     "loading": load the record, synthesize a Building, estimate occupants,
//                           activate it (version + 1, clean incident), "active".
//   useDemoBuilding()       back to the demo building; lookup and incident cleared.
//
// While a lookup is searching / needs_confirmation / loading, reports are held (state/ingest.ts):
// stored with no room and HOLD_REPLY. After activation they are located on the new building, one
// at a time in arrival order, through the normal incident update (merge -> forecast -> exits ->
// recommendation). Callers are not messaged again. A newer lookup supersedes an older one: every
// async step checks its generation and drops stale results.
import type { Building, BuildingCandidateSummary, BuildingLookup, BuildingProfile, Occupant, Report, TrailStep } from "@firewatch/shared/types";
import type { IncidentStore } from "../state/store.ts";
import type { ReportProcessor } from "../state/processor.ts";
import type { LiveIncident } from "./incident.ts";
import { buildingData, DEMO, type BuildingData } from "./buildingData.ts";
import type { BuildingService, CacheInfo } from "../buildings/service.ts";
import { BuildingApiError } from "../buildings/provider.ts";
import { validateSearch } from "../buildings/geoapify.ts";
import type { BuildingCandidate, BuildingRecord, Coordinates } from "../buildings/types.ts";
import {
  summarizeCandidate as realSummarize,
  synthesizeBuilding as realSynthesize,
  type SynthesizedBuilding,
  type SynthesizeOptions,
} from "../buildings/synthesize.ts";
import type { OccupancyEstimate, OccupancyEstimator } from "../agent/bridge.ts";

/** What a held report's caller is told. */
export const HOLD_REPLY = "Help is on the way. We are confirming the building now. Do not use the elevator.";

const HOLDING: ReadonlySet<BuildingLookup["status"]> = new Set(["searching", "needs_confirmation", "loading"]);

export interface LookupDeps {
  store: IncidentStore;
  live: LiveIncident;
  buildings: Pick<BuildingService, "search" | "resolve">;
  /** The active ReportProcessor (re-runs held reports after activation). */
  getProcessor(): ReportProcessor;
  synthesize?: (record: BuildingRecord, options?: SynthesizeOptions) => SynthesizedBuilding;
  summarize?: (candidate: BuildingCandidate, origin: Coordinates) => BuildingCandidateSummary;
  /** The agent's estimateOccupancy, or undefined when it isn't available. */
  estimateOccupancy?(): OccupancyEstimator | undefined;
  /** Mock mode stays on the demo building: lookups are ignored with a log line. */
  mock?: boolean;
  now?(): number;
}

export type LookupResult =
  | { ok: true; lookup?: BuildingLookup; unchanged?: boolean }
  | { ok: false; status: 400 | 409; error: string };

/** "  800 W  Campbell Rd " -> "800 w campbell rd" */
export const normalizeQuery = (q: string) => q.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const message = (err: unknown) =>
  err instanceof BuildingApiError ? err.message : err instanceof Error ? err.message.slice(0, 200) : "Building lookup failed.";

export class BuildingLookups {
  /** Bumped by every new lookup and by a return to the demo: older async work is dropped. */
  private gen = 0;
  /** The exact geocoded point of the current lookup (resolve's candidate cache is keyed by it). */
  private location?: Coordinates;
  private timezone?: string;
  /** Ids of reports held (stored unlocated) since the last activation, in arrival order. */
  private held = new Set<string>();
  /** The newest async step, so tests (and callers that care) can wait for it. */
  private pending: Promise<void> = Promise.resolve();

  private readonly synthesize;
  private readonly summarize;
  private readonly now;

  constructor(private deps: LookupDeps) {
    this.synthesize = deps.synthesize ?? realSynthesize;
    this.summarize = deps.summarize ?? realSummarize;
    this.now = deps.now ?? Date.now;
  }

  /** Resolves when the newest lookup step (search, load, re-processing) has finished. */
  async idle(): Promise<void> {
    for (let seen: Promise<void> | undefined; seen !== this.pending; ) await (seen = this.pending);
  }

  private get lookup(): BuildingLookup | undefined {
    return this.deps.store.get().buildingLookup;
  }

  /** The reply for a report that arrives now, when it must be held (a lookup is under way). */
  holdReply(): string | undefined {
    const l = this.lookup;
    return l && HOLDING.has(l.status) ? HOLD_REPLY : undefined;
  }

  private ignoredInMock(what: string): LookupResult {
    console.log(`[lookup] ${what} ignored: mock mode runs on the demo building`);
    this.deps.store.log("building", `${what} ignored: mock mode runs on the demo building`);
    return { ok: false, status: 409, error: "building lookups are off in mock mode (start the server with MOCK=0)" };
  }

  /** state/ingest.ts calls this for each report it held: it is located after activation. */
  onHeld(report: Report): void {
    this.held.add(report.id);
  }

  /** Starts a lookup and returns at once; the search runs in the background. */
  lookupAddress(address: unknown, caller?: string): LookupResult {
    let query: string;
    try {
      query = validateSearch(address).replace(/\s+/g, " ");
    } catch (err) {
      return { ok: false, status: 400, error: message(err) };
    }
    if (this.deps.mock) return this.ignoredInMock(`Address lookup "${query}"`);
    const current = this.lookup;
    // A re-processed report (or a repeated tool call) asking for the same address changes nothing.
    if (current && current.status !== "failed" && [current.query, current.match?.formatted].some((q) => q && normalizeQuery(q) === normalizeQuery(query)))
      return { ok: true, lookup: current, unchanged: true };

    const gen = ++this.gen;
    const time = this.now();
    this.location = undefined;
    this.timezone = undefined;
    const lookup: BuildingLookup = { query, ...(caller?.trim() && { caller: caller.trim() }), status: "searching", candidates: [], time };
    this.deps.store.patch({ buildingLookup: lookup });
    this.deps.store.log("building", `Looking up address: ${query}${lookup.caller ? ` (from ${lookup.caller})` : ""}`);
    this.pending = this.search(gen, query);
    return { ok: true, lookup };
  }

  /** Patches the current lookup, unless a newer lookup (or a return to the demo) replaced it. */
  private update(gen: number, change: Partial<BuildingLookup>): boolean {
    const current = this.lookup;
    if (gen !== this.gen || !current) return false;
    this.deps.store.patch({ buildingLookup: { ...current, ...change } });
    return true;
  }

  private fail(gen: number, err: unknown): void {
    const error = message(err);
    if (!this.update(gen, { status: "failed", error })) return;
    console.error(`[lookup] failed: ${error}`);
    this.deps.store.log("building", `Building lookup failed: ${error} The incident stays on ${this.deps.live.active.summary().name}.`);
  }

  /** Last lookup generation whose offline copy was logged (once per lookup is enough). */
  private offlineLogged = 0;

  /** Tells the operator (log line) that part of this lookup came from an offline copy. */
  private noteOffline(gen: number, cache: CacheInfo | undefined, what: string): void {
    if (gen !== this.gen || cache?.source !== "snapshot" || this.offlineLogged === gen) return;
    this.offlineLogged = gen;
    this.deps.store.log("building",
      `${what} from an offline copy saved ${cache.fetchedAt.slice(0, 10)}; live lookup unavailable (${cache.offlineReason ?? "provider error"})`);
  }

  private async search(gen: number, query: string): Promise<void> {
    try {
      const { candidates, cache } = await this.deps.buildings.search(query);
      if (gen !== this.gen) return;
      this.noteOffline(gen, cache, "Address match");
      const top = candidates[0];
      if (!top) throw new Error(`No address found for "${query}".`);
      this.location = top.location;
      this.timezone = top.timezone ?? undefined;
      this.update(gen, { match: { formatted: top.address, lat: top.location.lat, lon: top.location.lon } });

      let record: BuildingRecord;
      try {
        const resolved = await this.deps.buildings.resolve(top.location);
        record = resolved.building;
        this.noteOffline(gen, resolved.cache, "Location");
      } catch (err) {
        if (gen !== this.gen) return;
        if (!(err instanceof BuildingApiError && err.status === 409 && err.code === "building_selection_required")) throw err;
        this.noteOffline(gen, err.details.cache as CacheInfo | undefined, "Building outlines");
        const outlines = (err.details.candidates ?? []) as BuildingCandidate[];
        const summaries = outlines
          .map((c) => this.summarize(c, top.location))
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
        if (!this.update(gen, { status: "needs_confirmation", candidates: summaries })) return;
        this.deps.store.log("building", `${summaries.length} building outline${summaries.length === 1 ? "" : "s"} near ${top.address}: confirm the building`);
        return;
      }
      // The provider returned no outline: build from the location-only record directly.
      if (gen !== this.gen) return;
      this.update(gen, { status: "loading" });
      this.deps.store.log("building", `No building outline returned for ${top.address}: using an estimated building at that point`);
      await this.build(gen, record);
    } catch (err) {
      this.fail(gen, err);
    }
  }

  /**
   * The operator picked one of the current lookup's candidates. Returns at once; loading,
   * synthesis and activation run in the background (watch `buildingLookup.status`).
   */
  confirmBuilding(buildingId: unknown): LookupResult {
    if (typeof buildingId !== "string" || !buildingId.trim()) return { ok: false, status: 400, error: "`buildingId` must be a candidate id" };
    if (this.deps.mock) return this.ignoredInMock(`Building confirmation ${buildingId}`);
    const current = this.lookup;
    if (!current || !this.location) return { ok: false, status: 409, error: "no building lookup is waiting for confirmation" };
    if (current.status === "loading") return { ok: true, lookup: current, unchanged: true };
    if (current.status !== "needs_confirmation" && current.status !== "failed")
      return { ok: false, status: 409, error: `the building lookup is ${current.status}, not waiting for confirmation` };
    const candidate = current.candidates.find((c) => c.id === buildingId);
    if (!candidate) return { ok: false, status: 409, error: "`buildingId` is not one of the lookup's candidates" };

    const gen = this.gen;
    this.update(gen, { status: "loading", error: undefined });
    this.deps.store.log("building", `Building confirmed: ${candidate.name ?? candidate.address ?? candidate.id}`);
    const location = this.location;
    this.pending = (async () => {
      try {
        const { building: record, cache } = await this.deps.buildings.resolve({ ...location, buildingId });
        if (gen !== this.gen) return;
        this.noteOffline(gen, cache, "Building details");
        await this.build(gen, record);
      } catch (err) {
        this.fail(gen, err);
      }
    })();
    return { ok: true, lookup: this.lookup };
  }

  /** Record -> Building -> occupants -> active building -> re-locate held reports. Throws on failure. */
  private async build(gen: number, record: BuildingRecord): Promise<void> {
    const current = this.lookup!;
    const address = current.match?.formatted ?? current.query;
    const synthesized = this.synthesize(record, { address, ...(this.timezone && { timezone: this.timezone }) });
    if (!synthesized?.building?.rooms?.length) throw new Error("Could not build a floor plan for this building.");
    let building = withProfile(synthesized.building, record, address, this.timezone);
    // An offline copy (server/snapshots/) is named first in the console's building notes.
    const offline = (record.warnings ?? []).filter((w) => /offline copy saved/i.test(w));
    if (offline.length) building = { ...building, profile: { ...building.profile, assumptions: [...offline, ...building.profile.assumptions] } };

    const started = this.now();
    const estimate = this.estimate(building);
    const ms = this.now() - started;
    if (gen !== this.gen) return;

    const data = buildingData({
      building,
      sprinklers: synthesized.sprinklers ?? {},
      doors: synthesized.doors ?? [],
      occupants: estimate?.occupants ?? [],
      // Public buildings have no real inspection records; only the assumed stair B door finding.
      inspections: synthesized.inspections ?? [],
    });
    const { store, live } = this.deps;
    const state = store.get();
    // Every report held since the last activation (an earlier lookup may have failed meanwhile).
    const held = state.reports.filter((r) => this.held.has(r.id) && !r.roomId);
    this.held.clear();
    live.activate(data, { reports: held, log: state.log, trail: state.trail, buildingLookup: current });

    const p = building.profile;
    store.log("building", `Active building: ${p.name}, ${p.floors} floor${p.floors === 1 ? "" : "s"}${p.layoutEstimated ? ", layout estimated" : ""}`);
    if (estimate) {
      const step: TrailStep = {
        tool: "estimate_occupancy",
        input: { buildingId: p.id, use: p.use, localTime: estimate.localTime },
        output: { total: estimate.total, byFloor: estimate.byFloor, basis: estimate.basis },
        ms,
      };
      store.patch({ trail: [...(store.get().trail ?? []), step] });
      store.log("building", `Estimated ${estimate.total} people inside at ${estimate.localTime} local time (estimate, not a record)`);
    } else {
      store.log("building", "Occupancy estimate unavailable: no occupants are shown for this building");
    }
    this.update(gen, { status: "active", error: undefined });
    await this.relocate(gen, held);
  }

  /** The agent's estimate, checked. Undefined (and logged) when it is missing or throws. */
  private estimate(building: Building): OccupancyEstimate | undefined {
    const fn = this.deps.estimateOccupancy?.();
    if (!fn) return undefined;
    try {
      const out = fn(building, this.now());
      const rooms = new Set(building.rooms.map((r) => r.id));
      if (!out || !Array.isArray(out.occupants)) throw new Error("estimateOccupancy returned no occupants array");
      const occupants: Occupant[] = out.occupants
        .filter((o) => o && rooms.has(o.room) && Number.isFinite(o.count) && o.count > 0)
        .map((o) => ({ room: o.room, count: Math.round(o.count), flags: Array.isArray(o.flags) ? o.flags : [], estimated: true }));
      return {
        occupants,
        total: Number.isFinite(out.total) ? out.total : occupants.reduce((n, o) => n + o.count, 0),
        byFloor: out.byFloor ?? {},
        localTime: typeof out.localTime === "string" ? out.localTime : "",
        basis: Array.isArray(out.basis) ? out.basis : [],
      };
    } catch (err) {
      console.error(`[agent] estimateOccupancy failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Locate held reports on the new building, in order; the normal incident update follows each. */
  private async relocate(gen: number, held: Report[]): Promise<void> {
    const { store, live } = this.deps;
    for (const report of held) {
      if (gen !== this.gen) return;
      let result;
      try {
        result = await this.deps.getProcessor()({ text: report.text, caller: report.caller, ...(report.channel && { channel: report.channel }) });
      } catch (err) {
        console.error(`[lookup] re-processing a held report failed: ${(err as Error).message}`);
        continue;
      }
      if (gen !== this.gen) return;
      const reports = store.get().reports;
      if (!reports.some((r) => r.id === report.id)) continue;
      store.patch({
        reports: reports.map((r) => (r.id === report.id ? { ...r, roomId: result.roomId, confidence: result.confidence } : r)),
      });
      if (result.trail?.length) store.patch({ trail: [...(store.get().trail ?? []), ...result.trail] });
      const where = result.roomId ? `${result.roomId} (${Math.round((result.confidence ?? 0) * 100)}%)` : "location unclear";
      store.log("report", `Held report from ${report.caller} located: ${where}`);
      live.onReport(result);
    }
  }

  /** Back to the demo building with no lookup and a clean incident (POST /live/reset uses this too). */
  /**
   * Back to the demo building with no lookup and a clean incident (POST /live/reset uses this too).
   * Switching back from another building is an activation (version + 1); `always` bumps the
   * version even when the demo building is already active.
   */
  resetToDemo(always = false): void {
    this.gen++;
    this.location = undefined;
    this.timezone = undefined;
    this.held.clear();
    const { live } = this.deps;
    if (live.active.isDemo && !always) live.reset();
    else live.activate(DEMO);
  }

  /** The operator's "use the demo building": always an activation (version + 1). */
  useDemoBuilding(): LookupResult {
    if (this.deps.mock) return this.ignoredInMock("Switch to the demo building");
    this.resetToDemo(true);
    this.deps.store.log("building", `Active building: ${DEMO.building.profile.name}`);
    return { ok: true };
  }
}

/** The synthesizer sets `profile`; if it ever doesn't, describe the record honestly. */
function withProfile(building: Building, record: BuildingRecord, address: string, timezone?: string): BuildingData["building"] {
  // Occupancy estimates read profile.timezone: keep the geocoder's when the synthesizer left it out.
  if (building.profile) return { ...building, profile: { ...building.profile, ...(!building.profile.timezone && timezone && { timezone }) } };
  const profile: BuildingProfile = {
    id: record.id,
    name: record.name ?? address,
    address: record.address ?? address,
    source: "osm",
    use: record.tags.building && record.tags.building !== "yes" ? record.tags.building : "unknown",
    floors: Math.max(1, ...building.rooms.map((r) => r.floor)),
    location: record.location,
    ...(timezone && { timezone }),
    layoutEstimated: true,
    assumptions: ["Rooms, doors and stairs were generated, not mapped."],
    attribution: record.source.attribution,
  };
  return { ...building, profile };
}
