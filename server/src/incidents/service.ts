// Every reported emergency on the map. A report answers the caller quickly: the geocode is awaited
// for a few seconds at most, and forecasts run in the background and appear in the state when ready.
// One emergency reported twice (a follow-up, a correction, a second caller) stays one incident.
// Grouping: the same kind close by (same or neighbouring ~500 m zone, within 700 m) merges into one
// incident; different kinds close by stay separate but are linked through `related`.
// Records may carry fields other services attach (impact, affectedProperties): every change here
// spreads the existing incident, so those survive.
import { randomUUID } from "node:crypto";
import type { GeoPoint, IncidentPhase, IncidentSeverity, LanesBlocked, MapIncident, MapIncidentKind, Recommendation, Report } from "@firewatch/shared/types";
import { MAP_REPORT_PREFIX, isMapReport, mapRecommendations, type IncidentStore } from "../state/store.ts";
import { VOICE_INCIDENT_NEW, VOICE_INCIDENT_NOT_FOUND, VOICE_INCIDENT_UPDATE, VOICE_INCIDENT_WHERE } from "../transport/voice.ts";
import { crashAffectedRoads, forecastCrash, type RoadWay } from "./crashModel.ts";
import { forecastFire, type NearbyBuilding } from "./fireModel.ts";
import { floodSamplePoints, forecastFlood, isFloodReport } from "./floodModel.ts";
import { geoDistance } from "./geo.ts";
import type { GeocodeMatch, MapProviders } from "./providers.ts";
import type { MapIncidentPlus } from "./stepZero.ts";
import { closeBy, zoneId } from "./zones.ts";

export interface MapIncidentInput {
  kind: MapIncidentKind;
  /** Display name for `other` incidents ("gas leak"), or a more specific one for the rest. */
  what?: string;
  address?: string;
  description: string;
  severity: IncidentSeverity;
  lanesBlocked: LanesBlocked;
  inBuilding: boolean;
  caller?: string;
  channel: Report["channel"];
}

export interface MapIncidentOptions {
  /** How long a report waits for the geocoder before answering without a read-back. */
  geocodeWaitMs?: number;
  /** How often a located, unresolved fire or crash re-runs its forecast. 0 disables. Default 5 minutes. */
  forecastRefreshMs?: number;
  now?: () => number;
}

type LocateResult = { outcome: "found"; match: GeocodeMatch } | { outcome: "not_found" | "error" | "pending" };
type ActionOutcome = { ok: boolean; error?: string };
/** Where the reply to one call gets recorded. */
interface Call { entry: MapIncident["reports"][number]; reportId: string }
interface ForecastJob { id: string; incident: MapIncidentPlus; current: () => boolean; refresh: boolean }

const ANONYMOUS = "voice caller";
const CONSOLE_CALLER = "console operator";
const MAX_INCIDENTS = 50;
const MAX_DISPATCHES = 50;
const MAX_NOTES = 50;
const PHASE_ORDER: IncidentPhase[] = ["open", "dispatched", "on_scene", "resolved"];
const SEVERITY_ORDER: IncidentSeverity[] = ["unknown", "minor", "serious", "critical"];
const SAME_PLACE_METERS = 150;
const FOLLOW_UP_MS = 30 * 60 * 1000;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_LABEL: Record<MapIncidentKind, string> = { fire: "Fire", crash: "Car crash", other: "Emergency" };
/** Floods stay kind "other" until shared/types.ts gains "flood" (see stepZero.ts); this label marks them. */
const FLOOD_LABEL = "Flood";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const callerName = (input: MapIncidentInput) => input.caller ?? (input.channel === "console" ? CONSOLE_CALLER : ANONYMOUS);
const byTime = (a: { time: number }, b: { time: number }) => a.time - b.time;
const unknownIncident = (id: string): ActionOutcome => ({ ok: false, error: `unknown incident ${id}` });
const isFlood = (incident: MapIncident) => incident.kind === "other" && normalize(incident.label) === normalize(FLOOD_LABEL);
const reportIsFlood = (input: MapIncidentInput) => input.kind === "other" && isFloodReport(input.what, input.description);
/** What counts as "the same kind" for merging and linking. Floods are their own kind. */
const kindKey = (incident: MapIncident) => (isFlood(incident) ? "flood" : incident.kind === "other" ? `other:${normalize(incident.label)}` : incident.kind);
const sameIds = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).join(",") === (b ?? []).join(",");
/**
 * Whether a report (or a newly placed incident) can join `incident`. A resolved incident is closed.
 * `other` covers many emergencies, so a named one only joins the same name; no name can still attach.
 * A flood report joins only a flood.
 */
function canJoin(incident: MapIncident, kind: MapIncidentKind, what: string | undefined, flood: boolean): boolean {
  if (incident.phase === "resolved" || incident.kind !== kind) return false;
  if (kind !== "other") return true;
  if (flood) return isFlood(incident);
  return !what || normalize(incident.label) === normalize(what);
}
/**
 * "800 W Campbell Rd, Richardson, TX 75080, United States" -> "800 W Campbell Rd, Richardson".
 * Keeps the city, so a caller can hear a wrong match. Transit-stop names ("Coit @ Campbell - S") are skipped.
 */
function spoken(formatted: string): string {
  const parts = formatted.split(",").map((part) => part.trim());
  const place = parts.slice(0, Math.max(1, parts.length - 2)).filter((part, i) => i > 0 || !/@| - /.test(part));
  return (place.length ? place : parts).slice(0, 3).join(", ");
}

export class MapIncidents {
  private seq = 0;
  private forecastRun = new Map<string, number>();
  private roadCache = new Map<string, RoadWay[]>();
  private buildingCache = new Map<string, NearbyBuilding[]>();
  private elevationCache = new Map<string, number[]>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  /** Incidents that turned out to duplicate another once geocoded: removed id -> surviving id. */
  private mergedInto = new Map<string, string>();
  /** Injected (scripted demo) incidents: fixed forecasts, never re-run, never joined by a live report. */
  private injected = new Set<string>();
  private geocodeWaitMs: number;
  private forecastRefreshMs: number;
  private now: () => number;

  constructor(
    private store: IncidentStore,
    private providers: MapProviders,
    private lookups?: { lookupAddress(address: unknown, caller?: string): unknown },
    options: MapIncidentOptions = {},
  ) {
    this.geocodeWaitMs = options.geocodeWaitMs ?? 4000;
    this.forecastRefreshMs = options.forecastRefreshMs ?? DEFAULT_REFRESH_MS;
    this.now = options.now ?? Date.now;
  }

  private get list(): MapIncidentPlus[] {
    return this.store.get().mapIncidents ?? [];
  }

  private find(id: string) {
    return this.list.find((incident) => incident.id === id);
  }

  private update(id: string, change: Partial<MapIncidentPlus>): void {
    this.store.patch({ mapIncidents: this.list.map((incident) => (incident.id === id ? { ...incident, ...change, updated: this.now() } : incident)) });
  }

  private remove(id: string): void {
    this.store.patch({ mapIncidents: this.list.filter((incident) => incident.id !== id) });
    this.forget(id);
    this.relink();
  }

  /**
   * Recomputes `zoneId` (every located incident) and `related` (symmetric: located, unresolved,
   * close by, different kind). Injected incidents of different kinds are one scripted scenario, so
   * they are linked to each other wherever they are. Writes only the incidents that changed.
   */
  private relink(): void {
    const list = this.list;
    const live = list.filter((incident) => incident.location && incident.phase !== "resolved");
    let changed = false;
    const next = list.map((incident) => {
      const zone = incident.location && zoneId(incident.location);
      const linked = incident.location && incident.phase !== "resolved"
        ? live.filter((other) => other.id !== incident.id && kindKey(other) !== kindKey(incident) && (closeBy(other.location!, incident.location!) || (this.injected.has(other.id) && this.injected.has(incident.id)))).map((other) => other.id)
        : [];
      if (zone === incident.zoneId && sameIds(linked, incident.related)) return incident;
      changed = true;
      const { zoneId: _zone, related: _related, ...rest } = incident;
      return { ...rest, ...(zone && { zoneId: zone }), ...(linked.length && { related: linked }), updated: this.now() };
    });
    if (changed) this.store.patch({ mapIncidents: next });
  }

  private forget(id: string): void {
    this.injected.delete(id);
    this.stopRefresh(id);
    this.forecastRun.delete(id);
    this.roadCache.delete(id);
    this.buildingCache.delete(id);
    this.elevationCache.delete(id);
  }

  private stopRefresh(id: string): void {
    clearTimeout(this.refreshTimers.get(id));
    this.refreshTimers.delete(id);
  }

  /** Drops any forecast in flight and the next refresh. Bumps the run so a late result is not current. */
  private cancelForecast(id: string): void {
    this.stopRefresh(id);
    this.forecastRun.set(id, (this.forecastRun.get(id) ?? 0) + 1);
  }

  clear(): void {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.forecastRun.clear();
    this.roadCache.clear();
    this.buildingCache.clear();
    this.elevationCache.clear();
    this.mergedInto.clear();
    this.injected.clear();
    const { reports, recommendation } = this.store.get();
    this.store.patch({
      mapIncidents: [],
      reports: reports.filter((report) => !isMapReport(report)),
      ...(recommendation && mapRecommendations.has(recommendation) && { recommendation: undefined }),
    });
  }

  /**
   * Puts a complete, located incident on the map as is (the scripted CBRE demo): its forecast is
   * kept and never re-run or refreshed, and live reports never merge into or follow up on it (a
   * different kind close by still links). Its calls go in the caller reports. Replaces an incident
   * with the same id.
   */
  inject(incident: MapIncidentPlus): MapIncidentPlus {
    const all = [...this.list.filter((item) => item.id !== incident.id), incident];
    const dropped = this.overflow(all);
    this.forget(incident.id);
    this.injected.add(incident.id);
    this.store.patch({ mapIncidents: all.filter((item) => !dropped.includes(item)) });
    for (const item of dropped) {
      this.releaseRecommendation(item);
      this.forget(item.id);
    }
    this.relink();
    const place = incident.formatted ? spoken(incident.formatted) : incident.query;
    this.store.log("report", `${incident.label} reported: ${place ?? "location not given"}`, incident.id);
    incident.reports.forEach((report, n) => {
      this.store.addReport({
        id: `${MAP_REPORT_PREFIX}${incident.id}-${n}`,
        caller: report.caller,
        text: `${incident.label} at ${place ?? "an unknown location"}: ${report.text}`,
        time: report.time,
        ...(report.channel && { channel: report.channel }),
        incidentId: incident.id,
      });
    });
    if (incident.formatted) this.recommend(incident.id);
    return this.find(incident.id) ?? incident;
  }

  async report(input: MapIncidentInput): Promise<{ incident: MapIncident; reply: string }> {
    const existing = this.followUpOf(input);
    const call: Call = { entry: this.entry(input), reportId: `${MAP_REPORT_PREFIX}${randomUUID()}` };
    const { incident, reply } = await (existing ? this.follow(existing, input, call) : this.create(input, call));
    this.recordReply(incident.id, call, reply);
    return { incident: this.find(incident.id) ?? incident, reply };
  }

  /** Keeps what the caller was told on both records of the call. */
  private recordReply(id: string, { entry, reportId }: Call, reply: string): void {
    const incident = this.find(id);
    if (incident) this.update(id, { reports: incident.reports.map((report) => (report === entry ? { ...report, reply } : report)) });
    this.store.patch({ reports: this.store.get().reports.map((report) => (report.id === reportId ? { ...report, reply } : report)) });
  }

  /** The operator sent a unit: recorded on the incident, which leaves `open`. */
  dispatch(incidentId: string, unit?: string): ActionOutcome {
    const incident = this.find(incidentId);
    if (!incident) return unknownIncident(incidentId);
    if (incident.phase === "resolved") return { ok: false, error: `incident ${incidentId} is resolved` };
    this.update(incidentId, {
      dispatches: [...(incident.dispatches ?? []), { ...(unit && { unit }), time: this.now() }].slice(-MAX_DISPATCHES),
      ...(incident.phase === "open" && { phase: "dispatched" as const }),
    });
    this.store.log("dispatch", `${unit ?? "Crew"} dispatched to ${incident.label}${this.at(incident)}`, incidentId);
    return { ok: true };
  }

  setPhase(incidentId: string, phase: IncidentPhase): ActionOutcome {
    const incident = this.find(incidentId);
    if (!incident) return unknownIncident(incidentId);
    if (incident.phase === phase) return { ok: true };
    const change: Partial<MapIncident> = { phase };
    if (phase === "resolved") {
      this.cancelForecast(incidentId);
      this.releaseRecommendation(incident);
      change.recommendation = undefined;
      if (incident.forecastStatus === "running") change.forecastStatus = incident.fire || incident.crash || incident.flood ? "ready" : "none";
    }
    this.update(incidentId, change);
    this.relink(); // a resolved incident drops out of its neighbours' links; a reopened one rejoins
    this.store.log("dispatch", `${incident.label}${this.at(incident)} is now ${phase.replace("_", " ")}`, incidentId);
    // Reopened: the old forecast may be long stale, so refresh it and resume the schedule.
    if (incident.phase === "resolved" && this.forecastRefreshMs > 0) this.runForecast(incidentId, true);
    return { ok: true };
  }

  addNote(incidentId: string, text: string): ActionOutcome {
    const incident = this.find(incidentId);
    if (!incident) return unknownIncident(incidentId);
    this.update(incidentId, { notes: [...(incident.notes ?? []), { text, time: this.now() }].slice(-MAX_NOTES) });
    this.store.log("report", `Note on ${incident.label}${this.at(incident)}: ${text}`, incidentId);
    return { ok: true };
  }

  private at(incident: MapIncident): string {
    const place = incident.formatted ? spoken(incident.formatted) : incident.query;
    return place ? ` at ${place}` : "";
  }

  /** Empties the global slot if it is showing this incident's pending recommendation. */
  private releaseRecommendation(incident: MapIncident): void {
    if (incident.recommendation && this.store.get().recommendation === incident.recommendation) this.store.setRecommendation(undefined);
  }

  /** The incident this report adds to: the caller's own recent one, or one at the same stated place. */
  private followUpOf(input: MapIncidentInput): MapIncident | undefined {
    const caller = callerName(input);
    // One operator types many reports, so only the place can tie a console report to an earlier one.
    const byCaller = input.channel !== "console";
    const since = this.now() - FOLLOW_UP_MS;
    const query = input.address && normalize(input.address);
    const flood = reportIsFlood(input);
    return [...this.list].reverse().find((incident) => {
      if (this.injected.has(incident.id) || !canJoin(incident, input.kind, input.what, flood)) return false;
      const recent = incident.reports.filter((report) => report.time >= since);
      // A new address on an already pinned incident is a separate emergency, even from the same phone.
      const elsewhere = query !== undefined && incident.status === "located" && incident.query !== undefined && normalize(incident.query) !== query;
      const sameCaller = byCaller && caller !== ANONYMOUS && !elsewhere && recent.some((report) => report.caller === caller);
      const samePlace = query !== undefined && recent.length > 0 && incident.query !== undefined && normalize(incident.query) === query;
      // Without caller id, an unplaced incident is still the likeliest one this answer belongs to.
      const unplaced = byCaller && caller === ANONYMOUS && incident.status === "needs_location" && recent.length > 0;
      return sameCaller || samePlace || unplaced;
    });
  }

  private entry(input: MapIncidentInput): MapIncident["reports"][number] {
    return { caller: callerName(input), text: input.description, time: this.now(), channel: input.channel };
  }

  /** Puts the call in the console's caller reports, which are otherwise only for building reports. */
  private addCallerReport(incidentId: string, reportId: string, label: string, place: string | undefined, input: MapIncidentInput): void {
    this.store.addReport({
      id: reportId,
      caller: callerName(input),
      text: `${label} at ${place ?? "an unknown location"}: ${input.description}`,
      time: this.now(),
      channel: input.channel,
      incidentId,
    });
  }

  private recommendationFor(incident: MapIncidentPlus): Recommendation | undefined {
    if (!incident.formatted) return undefined;
    const forecast = incident.fire?.summary ?? incident.crash?.summary ?? incident.flood?.summary;
    const crew = incident.kind === "fire" ? "fire crews" : "responders";
    const recommendation: Recommendation = {
      actions: [
        `Send ${crew} to ${spoken(incident.formatted)}${incident.kind === "other" ? ` for: ${incident.label}` : ""}.`,
        ...(forecast ? [`Modeled forecast: ${forecast}`] : []),
      ],
    };
    mapRecommendations.add(recommendation);
    return recommendation;
  }

  /** Writes the incident's Next actions, and the global slot unless a building fire's plan is showing. */
  private recommend(id: string): void {
    const incident = this.find(id);
    if (!incident || incident.phase === "resolved") return;
    const recommendation = this.recommendationFor(incident);
    if (!recommendation) return;
    this.update(id, { recommendation });
    const current = this.store.get().recommendation;
    if (!current || mapRecommendations.has(current)) this.store.setRecommendation(recommendation);
    this.store.log("recommendation", `Recommended: ${recommendation.actions[0]}`, id);
  }

  /**
   * After a background refresh: rewrites a recommendation that is still pending, quietly and only if
   * its text changed. Accepted ones are history, and the global slot moves only if it held the old one.
   */
  private refreshRecommendation(id: string): void {
    const incident = this.find(id);
    const pending = incident?.recommendation;
    if (!incident || !pending) return;
    const next = this.recommendationFor(incident);
    if (!next || JSON.stringify(next.actions) === JSON.stringify(pending.actions)) return;
    this.update(id, { recommendation: next });
    if (this.store.get().recommendation === pending) this.store.setRecommendation(next);
  }

  /** Oldest resolved first, then oldest of any phase. Never the newest, which is the one being added. */
  private overflow(list: MapIncident[]): MapIncident[] {
    const excess = list.length - MAX_INCIDENTS;
    if (excess <= 0) return [];
    const resolved = list.filter((incident) => incident.phase === "resolved");
    const rest = list.filter((incident) => incident.phase !== "resolved");
    return [...resolved, ...rest].slice(0, excess);
  }

  private async create(input: MapIncidentInput, call: Call): Promise<{ incident: MapIncident; reply: string }> {
    const time = this.now();
    const label = reportIsFlood(input) ? FLOOD_LABEL : input.what ? capitalize(input.what) : DEFAULT_LABEL[input.kind];
    const incident: MapIncident = {
      id: `inc-${++this.seq}`,
      kind: input.kind,
      label,
      severity: input.severity,
      status: input.address ? "locating" : "needs_location",
      ...(input.address && { query: input.address }),
      ...(input.kind === "fire" && { inBuilding: input.inBuilding }),
      ...(input.kind === "crash" && { lanesBlocked: input.lanesBlocked }),
      reports: [call.entry],
      time,
      updated: time,
      phase: "open",
      forecastStatus: "none",
    };
    const all = [...this.list, incident];
    const dropped = this.overflow(all);
    this.store.patch({ mapIncidents: all.filter((item) => !dropped.includes(item)) });
    for (const item of dropped) {
      this.releaseRecommendation(item);
      this.forget(item.id);
    }
    if (dropped.length) this.relink();
    this.store.log("report", `${label} reported: ${input.address ?? "location not given"}`, incident.id);
    this.addCallerReport(incident.id, call.reportId, label, input.address, input);
    if (!input.address) return { incident, reply: VOICE_INCIDENT_WHERE };

    const located = await this.locate(incident.id, input.address);
    return this.answer(incident.id, input, located);
  }

  private async follow(existing: MapIncident, input: MapIncidentInput, call: Call): Promise<{ incident: MapIncident; reply: string }> {
    const moved = input.address !== undefined && (existing.query === undefined || normalize(input.address) !== normalize(existing.query));
    const lanesBlocked = existing.kind === "crash" && input.lanesBlocked !== "unknown" ? input.lanesBlocked : existing.lanesBlocked;
    const lanesChanged = lanesBlocked !== existing.lanesBlocked;
    const floodGrew = isFlood(existing) && input.severity !== "unknown" && input.severity !== existing.severity;
    const buildingIdentified = existing.kind === "fire" && input.inBuilding && !existing.inBuilding;
    this.update(existing.id, {
      reports: [...existing.reports, call.entry],
      ...(input.severity !== "unknown" && { severity: input.severity }),
      ...(lanesChanged && { lanesBlocked }),
      ...(buildingIdentified && { inBuilding: true }),
    });
    this.addCallerReport(existing.id, call.reportId, existing.label, input.address ?? existing.formatted ?? existing.query, input);

    // Only an incident with no pin yet gets here with a new address: followUpOf splits off the rest.
    if (moved) {
      // The old place's forecast and Next actions no longer apply, and a late result for it must not land.
      this.cancelForecast(existing.id);
      this.releaseRecommendation(existing);
      this.update(existing.id, { query: input.address, status: "locating", location: undefined, formatted: undefined, error: undefined, fire: undefined, crash: undefined, flood: undefined, affectedRoads: undefined, forecastStatus: "none", forecastAt: undefined, recommendation: undefined });
      this.roadCache.delete(existing.id);
      this.buildingCache.delete(existing.id);
      this.elevationCache.delete(existing.id);
      this.relink();
      const located = await this.locate(existing.id, input.address!);
      return this.answer(existing.id, input, located);
    }
    if ((lanesChanged || floodGrew) && existing.status === "located") this.runForecast(existing.id);
    if (buildingIdentified && existing.query && existing.status === "located") {
      this.lookups?.lookupAddress(existing.query, input.caller);
      return { incident: this.find(existing.id)!, reply: VOICE_INCIDENT_NEW.buildingFire };
    }
    return { incident: this.find(existing.id)!, reply: existing.status === "needs_location" ? VOICE_INCIDENT_WHERE : VOICE_INCIDENT_UPDATE };
  }

  private answer(id: string, input: MapIncidentInput, located: LocateResult): { incident: MapIncident; reply: string } {
    const incident = this.find(id) ?? this.find(this.mergedInto.get(id) ?? "");
    if (!incident) throw new Error("incident disappeared");
    if (located.outcome === "not_found") return { incident, reply: VOICE_INCIDENT_NOT_FOUND };
    const buildingFire = incident.kind === "fire" && incident.inBuilding;
    // Keep the lookup tied to the surviving incident's address, even if another caller used an alias.
    if (buildingFire) this.lookups?.lookupAddress(incident.query ?? input.address, input.caller);
    const body = VOICE_INCIDENT_NEW[buildingFire ? "buildingFire" : input.kind];
    return { incident, reply: located.outcome === "found" ? `I have the location as ${spoken(located.match.formatted)}. ${body}` : body };
  }

  /** Geocodes in the background, and waits only `geocodeWaitMs` for the answer. */
  private locate(id: string, query: string): Promise<LocateResult> {
    const work = this.providers.geocode(query).then(
      (match): LocateResult => {
        if (this.find(id)?.query !== query) return { outcome: "pending" }; // reset or corrected meanwhile
        if (!match) {
          this.update(id, { status: "needs_location" });
          return { outcome: "not_found" };
        }
        this.place(id, match);
        return { outcome: "found", match };
      },
      (err): LocateResult => {
        console.error(`[incidents] geocoding failed for ${id}:`, err instanceof Error ? err.message : err);
        if (this.find(id)?.query === query) this.update(id, { status: "failed", error: "The address could not be looked up." });
        return { outcome: "error" };
      },
    );
    let timer: NodeJS.Timeout;
    const wait = new Promise<LocateResult>((resolve) => (timer = setTimeout(() => resolve({ outcome: "pending" }), this.geocodeWaitMs)));
    return Promise.race([work, wait]).finally(() => clearTimeout(timer));
  }

  private place(id: string, match: GeocodeMatch): void {
    const incident = this.find(id)!;
    const twin = incident.phase === "resolved" ? undefined : this.twinOf(incident, match.location);
    if (twin) {
      this.absorb(twin, incident);
      return;
    }
    this.update(id, { status: "located", location: match.location, formatted: match.formatted, error: undefined });
    this.relink();
    this.store.log("report", `${incident.label} located: ${match.formatted}`, id);
    if (incident.kind === "other" && !isFlood(incident)) this.recommend(id);
    this.runForecast(id);
  }

  /**
   * The open incident a newly placed one duplicates, nearest first: the same kind within 150 m, or,
   * for fires, crashes and floods, the same kind close by (neighbouring zone, 700 m) that has had a
   * report in the last 30 minutes. Never an injected incident.
   */
  private twinOf(incident: MapIncident, location: GeoPoint): MapIncidentPlus | undefined {
    const flood = isFlood(incident);
    const what = incident.label === DEFAULT_LABEL.other ? undefined : incident.label;
    const zoned = incident.kind !== "other" || flood;
    const since = this.now() - FOLLOW_UP_MS;
    let best: { twin: MapIncidentPlus; range: number } | undefined;
    for (const other of this.list) {
      if (other.id === incident.id || !other.location || this.injected.has(other.id) || !canJoin(other, incident.kind, what, flood)) continue;
      const range = geoDistance(other.location, location);
      const near = range <= SAME_PLACE_METERS || (zoned && closeBy(other.location, location) && other.reports.some((report) => report.time >= since));
      if (near && (!best || range < best.range)) best = { twin: other, range };
    }
    return best?.twin;
  }

  /** Folds a duplicate into the incident it matches: everything said and done on it moves across. */
  private absorb(twin: MapIncident, duplicate: MapIncident): void {
    const dispatches = [...(twin.dispatches ?? []), ...(duplicate.dispatches ?? [])].sort(byTime);
    const notes = [...(twin.notes ?? []), ...(duplicate.notes ?? [])].sort(byTime);
    const lanesChanged = duplicate.kind === "crash" && duplicate.lanesBlocked !== "unknown" && duplicate.lanesBlocked !== undefined && duplicate.lanesBlocked !== twin.lanesBlocked;
    const worse = SEVERITY_ORDER.indexOf(duplicate.severity) > SEVERITY_ORDER.indexOf(twin.severity);
    this.update(twin.id, {
      reports: [...twin.reports, ...duplicate.reports].sort(byTime),
      severity: worse ? duplicate.severity : twin.severity,
      ...(duplicate.inBuilding && { inBuilding: true }),
      ...(lanesChanged && { lanesBlocked: duplicate.lanesBlocked }),
      ...(dispatches.length && { dispatches: dispatches.slice(-MAX_DISPATCHES) }),
      ...(notes.length && { notes: notes.slice(-MAX_NOTES) }),
      phase: PHASE_ORDER.indexOf(duplicate.phase) > PHASE_ORDER.indexOf(twin.phase) ? duplicate.phase : twin.phase,
      ...(!twin.accepted && duplicate.accepted && { accepted: duplicate.accepted }),
    });
    this.remove(duplicate.id);
    this.mergedInto.set(duplicate.id, twin.id);
    this.store.reassignIncident(duplicate.id, twin.id);
    if (lanesChanged || (worse && isFlood(twin))) this.runForecast(twin.id);
  }

  /** Which forecast a kind gets. Exhaustive: a new kind must choose here, or it will not compile. */
  private forecaster(incident: MapIncident): ((job: ForecastJob) => Promise<void>) | undefined {
    const kind = incident.kind;
    switch (kind) {
      case "fire": return (job) => this.fire(job);
      case "crash": return (job) => this.crash(job);
      case "other": return isFlood(incident) ? (job) => this.flood(job) : undefined;
      default: {
        const unhandled: never = kind;
        throw new Error(`no forecast decision for incident kind ${String(unhandled)}`);
      }
    }
  }

  /**
   * Builds the incident's forecast in the background. A `refresh` is the periodic re-run: the old
   * forecast and `forecastStatus` stay as they are until a new one is ready, and failures change nothing.
   */
  private runForecast(id: string, refresh = false): void {
    const incident = this.find(id);
    if (!incident?.location || incident.phase === "resolved" || this.injected.has(id)) return; // an injected forecast is fixed
    const forecast = this.forecaster(incident);
    if (!forecast) return;
    this.stopRefresh(id); // rescheduled when this run ends, so runs never overlap
    const run = (this.forecastRun.get(id) ?? 0) + 1;
    this.forecastRun.set(id, run);
    if (!refresh) this.update(id, { forecastStatus: "running" });
    const current = () => this.forecastRun.get(id) === run && this.find(id) !== undefined;
    forecast({ id, incident, current, refresh })
      .catch((err) => {
        console.error(`[incidents] forecast${refresh ? " refresh" : ""} failed for ${id}:`, err instanceof Error ? err.message : err);
        if (!current() || refresh) return;
        this.update(id, { forecastStatus: "failed", error: "The forecast could not be built. The location is still correct." });
        this.recommend(id);
      })
      .finally(() => {
        // A flood's inputs (ground, roads) do not change, so a re-run would only restart the water.
        if (current() && !isFlood(incident)) this.scheduleRefresh(id);
      });
  }

  private scheduleRefresh(id: string): void {
    this.stopRefresh(id);
    if (this.forecastRefreshMs <= 0) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(id);
      this.runForecast(id, true);
    }, this.forecastRefreshMs);
    timer.unref();
    this.refreshTimers.set(id, timer);
  }

  private forecastReady(id: string, forecast: Pick<MapIncidentPlus, "fire" | "crash" | "flood" | "affectedRoads">, refresh: boolean): void {
    this.update(id, { ...forecast, forecastStatus: "ready", forecastAt: this.now(), error: undefined });
    if (refresh) this.refreshRecommendation(id);
    else this.recommend(id);
  }

  private async fire({ id, incident, current, refresh }: ForecastJob): Promise<void> {
    const location = incident.location!;
    const [wind, buildings] = await Promise.all([
      this.providers.wind(location).catch(() => null),
      this.buildingCache.get(id) ?? this.providers.buildings(location).catch(() => null),
    ]);
    if (!current()) return;
    if (refresh && !wind && incident.fire?.wind) return; // a missed reading must not erase a wind-driven plume
    if (buildings) this.buildingCache.set(id, buildings);
    this.forecastReady(id, { fire: forecastFire(location, wind, buildings) }, refresh);
  }

  private async crash({ id, incident, current, refresh }: ForecastJob): Promise<void> {
    const location = incident.location!;
    const roads = this.roadCache.get(id) ?? (await this.providers.roads(location));
    if (!current()) return;
    this.roadCache.set(id, roads);
    const crash = forecastCrash(location, roads, incident.lanesBlocked ?? "unknown");
    this.forecastReady(id, { crash, affectedRoads: crashAffectedRoads(crash) }, refresh);
  }

  /** Ground elevation and roads both degrade: without them the water is an even circle and no road is listed. */
  private async flood({ id, incident, current, refresh }: ForecastJob): Promise<void> {
    const location = incident.location!;
    const [elevations, roads] = await Promise.all([
      this.elevationCache.get(id) ?? this.providers.elevation?.(floodSamplePoints(location)).catch(() => null) ?? null,
      this.roadCache.get(id) ?? this.providers.roads(location).catch(() => null),
    ]);
    if (!current()) return;
    if (elevations) this.elevationCache.set(id, elevations);
    if (roads) this.roadCache.set(id, roads);
    const text = [incident.label, ...incident.reports.map((report) => report.text)].join(" ");
    this.forecastReady(id, forecastFlood(location, incident.severity, elevations, roads, text), refresh);
  }
}
