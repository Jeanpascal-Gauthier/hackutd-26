// Every reported emergency on the map. A report answers the caller quickly: the geocode is awaited
// for a few seconds at most, and forecasts run in the background and appear in the state when ready.
// One emergency reported twice (a follow-up, a correction, a second caller) stays one incident.
import { randomUUID } from "node:crypto";
import type { IncidentSeverity, LanesBlocked, MapIncident, MapIncidentKind, Recommendation, Report } from "@firewatch/shared/types";
import { MAP_REPORT_PREFIX, isMapReport, mapRecommendations, type IncidentStore } from "../state/store.ts";
import { VOICE_INCIDENT_NEW, VOICE_INCIDENT_NOT_FOUND, VOICE_INCIDENT_UPDATE, VOICE_INCIDENT_WHERE } from "../transport/voice.ts";
import { forecastCrash, type RoadWay } from "./crashModel.ts";
import { forecastFire } from "./fireModel.ts";
import { geoDistance } from "./geo.ts";
import type { GeocodeMatch, MapProviders } from "./providers.ts";

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
  now?: () => number;
}

type LocateResult = { outcome: "found"; match: GeocodeMatch } | { outcome: "not_found" | "error" | "pending" };

const ANONYMOUS = "voice caller";
const MAX_INCIDENTS = 50;
const SAME_PLACE_METERS = 150;
const FOLLOW_UP_MS = 30 * 60 * 1000;
const DEFAULT_LABEL: Record<MapIncidentKind, string> = { fire: "Fire", crash: "Car crash", other: "Emergency" };

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
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
  /** Incidents that turned out to duplicate another once geocoded: removed id -> surviving id. */
  private mergedInto = new Map<string, string>();
  private geocodeWaitMs: number;
  private now: () => number;

  constructor(
    private store: IncidentStore,
    private providers: MapProviders,
    private lookups?: { lookupAddress(address: unknown, caller?: string): unknown },
    options: MapIncidentOptions = {},
  ) {
    this.geocodeWaitMs = options.geocodeWaitMs ?? 4000;
    this.now = options.now ?? Date.now;
  }

  private get list(): MapIncident[] {
    return this.store.get().mapIncidents ?? [];
  }

  private find(id: string) {
    return this.list.find((incident) => incident.id === id);
  }

  private update(id: string, change: Partial<MapIncident>): void {
    this.store.patch({ mapIncidents: this.list.map((incident) => (incident.id === id ? { ...incident, ...change, updated: this.now() } : incident)) });
  }

  private remove(id: string): void {
    this.store.patch({ mapIncidents: this.list.filter((incident) => incident.id !== id) });
    this.forget(id);
  }

  private forget(id: string): void {
    this.forecastRun.delete(id);
    this.roadCache.delete(id);
  }

  clear(): void {
    this.forecastRun.clear();
    this.roadCache.clear();
    this.mergedInto.clear();
    const { reports, recommendation } = this.store.get();
    this.store.patch({
      mapIncidents: [],
      reports: reports.filter((report) => !isMapReport(report)),
      ...(recommendation && mapRecommendations.has(recommendation) && { recommendation: undefined }),
    });
  }

  async report(input: MapIncidentInput): Promise<{ incident: MapIncident; reply: string }> {
    const existing = this.followUpOf(input);
    return existing ? this.follow(existing, input) : this.create(input);
  }

  /** The incident this report adds to: the caller's own recent one, or one at the same stated place. */
  private followUpOf(input: MapIncidentInput): MapIncident | undefined {
    const caller = input.caller ?? ANONYMOUS;
    const since = this.now() - FOLLOW_UP_MS;
    const query = input.address && normalize(input.address);
    return [...this.list].reverse().find((incident) => {
      if (incident.kind !== input.kind) return false;
      const recent = incident.reports.filter((report) => report.time >= since);
      const sameCaller = caller !== ANONYMOUS && recent.some((report) => report.caller === caller);
      const samePlace = query !== undefined && recent.length > 0 && incident.query !== undefined && normalize(incident.query) === query;
      // Without caller id, an unplaced incident is still the likeliest one this answer belongs to.
      const unplaced = caller === ANONYMOUS && incident.status === "needs_location" && recent.length > 0;
      return sameCaller || samePlace || unplaced;
    });
  }

  private entry(input: MapIncidentInput): MapIncident["reports"][number] {
    return { caller: input.caller ?? ANONYMOUS, text: input.description, time: this.now(), channel: input.channel };
  }

  /** Puts the call in the console's caller reports, which are otherwise only for building reports. */
  private addCallerReport(label: string, place: string | undefined, input: MapIncidentInput): void {
    this.store.addReport({
      id: `${MAP_REPORT_PREFIX}${randomUUID()}`,
      caller: input.caller ?? ANONYMOUS,
      text: `${label} at ${place ?? "an unknown location"}: ${input.description}`,
      time: this.now(),
      channel: input.channel,
    });
  }

  /** Fills Next actions from the incident, unless a building fire's evacuation plan is showing. */
  private recommend(id: string): void {
    const incident = this.find(id);
    if (!incident?.formatted) return;
    const current = this.store.get().recommendation;
    if (current && !mapRecommendations.has(current)) return;
    const place = spoken(incident.formatted);
    const forecast = incident.fire?.summary ?? incident.crash?.summary;
    const crew = incident.kind === "fire" ? "fire crews" : "responders";
    const recommendation: Recommendation = {
      actions: [
        `Send ${crew} to ${place}${incident.kind === "other" ? ` for: ${incident.label}` : ""}.`,
        ...(forecast ? [`Modeled forecast: ${forecast}`] : []),
      ],
    };
    mapRecommendations.add(recommendation);
    this.store.setRecommendation(recommendation);
    this.store.log("recommendation", `Recommended: ${recommendation.actions[0]}`);
  }

  private async create(input: MapIncidentInput): Promise<{ incident: MapIncident; reply: string }> {
    const time = this.now();
    const label = input.what ? capitalize(input.what) : DEFAULT_LABEL[input.kind];
    const incident: MapIncident = {
      id: `inc-${++this.seq}`,
      kind: input.kind,
      label,
      severity: input.severity,
      status: input.address ? "locating" : "needs_location",
      ...(input.address && { query: input.address }),
      ...(input.kind === "fire" && { inBuilding: input.inBuilding }),
      ...(input.kind === "crash" && { lanesBlocked: input.lanesBlocked }),
      reports: [this.entry(input)],
      time,
      updated: time,
      forecastStatus: "none",
    };
    const kept = [...this.list, incident].slice(-MAX_INCIDENTS);
    this.store.patch({ mapIncidents: kept });
    this.store.log("report", `${label} reported: ${input.address ?? "location not given"}`);
    this.addCallerReport(label, input.address, input);
    if (!input.address) return { incident, reply: VOICE_INCIDENT_WHERE };

    const located = await this.locate(incident.id, input.address);
    return this.answer(incident.id, input, located);
  }

  private async follow(existing: MapIncident, input: MapIncidentInput): Promise<{ incident: MapIncident; reply: string }> {
    const callers = new Set(existing.reports.map((report) => report.caller));
    callers.add(input.caller ?? ANONYMOUS);
    const moved = input.address !== undefined && (existing.query === undefined || normalize(input.address) !== normalize(existing.query));
    const lanesBlocked = existing.kind === "crash" && input.lanesBlocked !== "unknown" ? input.lanesBlocked : existing.lanesBlocked;
    const lanesChanged = lanesBlocked !== existing.lanesBlocked;
    this.update(existing.id, {
      reports: [...existing.reports, this.entry(input)],
      ...(input.severity !== "unknown" && { severity: input.severity }),
      ...(lanesChanged && { lanesBlocked }),
    });
    this.addCallerReport(existing.label, input.address ?? existing.formatted ?? existing.query, input);

    // A caller correcting their own location moves the pin; another caller's address does not.
    if (moved && (callers.size === 1 || existing.status !== "located")) {
      this.update(existing.id, { query: input.address, status: "locating", location: undefined, formatted: undefined, error: undefined, fire: undefined, crash: undefined, forecastStatus: "none" });
      this.roadCache.delete(existing.id);
      const located = await this.locate(existing.id, input.address!);
      return this.answer(existing.id, input, located);
    }
    if (lanesChanged && existing.status === "located") this.runForecast(existing.id);
    return { incident: this.find(existing.id)!, reply: existing.status === "needs_location" ? VOICE_INCIDENT_WHERE : VOICE_INCIDENT_UPDATE };
  }

  private answer(id: string, input: MapIncidentInput, located: LocateResult): { incident: MapIncident; reply: string } {
    const incident = this.find(id) ?? this.find(this.mergedInto.get(id) ?? "");
    if (!incident) throw new Error("incident disappeared");
    if (located.outcome === "not_found") return { incident, reply: VOICE_INCIDENT_NOT_FOUND };
    const buildingFire = input.kind === "fire" && input.inBuilding;
    if (buildingFire) this.lookups?.lookupAddress(input.address, input.caller);
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
    const twin = this.list.find((other) => other.id !== id && other.kind === incident.kind && other.location && geoDistance(other.location, match.location) <= SAME_PLACE_METERS);
    if (twin) {
      this.update(twin.id, { reports: [...twin.reports, ...incident.reports].sort((a, b) => a.time - b.time) });
      this.remove(id);
      this.mergedInto.set(id, twin.id);
      return;
    }
    this.update(id, { status: "located", location: match.location, formatted: match.formatted, error: undefined });
    this.store.log("report", `${incident.label} located: ${match.formatted}`);
    if (incident.kind === "other") this.recommend(id);
    this.runForecast(id);
  }

  private runForecast(id: string): void {
    const incident = this.find(id);
    if (!incident?.location || incident.kind === "other") return;
    const run = (this.forecastRun.get(id) ?? 0) + 1;
    this.forecastRun.set(id, run);
    this.update(id, { forecastStatus: "running" });
    const current = () => this.forecastRun.get(id) === run && this.find(id) !== undefined;
    const job = incident.kind === "fire" ? this.fire(id, incident, current) : this.crash(id, incident, current);
    job.catch((err) => {
      console.error(`[incidents] forecast failed for ${id}:`, err instanceof Error ? err.message : err);
      if (!current()) return;
      this.update(id, { forecastStatus: "failed", error: "The forecast could not be built. The location is still correct." });
      this.recommend(id);
    });
  }

  private async fire(id: string, incident: MapIncident, current: () => boolean): Promise<void> {
    const location = incident.location!;
    const [wind, buildings] = await Promise.all([
      this.providers.wind(location).catch(() => null),
      this.providers.buildings(location).catch(() => null),
    ]);
    if (!current()) return;
    this.update(id, { fire: forecastFire(location, wind, buildings), forecastStatus: "ready" });
    this.recommend(id);
  }

  private async crash(id: string, incident: MapIncident, current: () => boolean): Promise<void> {
    const location = incident.location!;
    const roads = this.roadCache.get(id) ?? (await this.providers.roads(location));
    if (!current()) return;
    this.roadCache.set(id, roads);
    this.update(id, { crash: forecastCrash(location, roads, incident.lanesBlocked ?? "unknown"), forecastStatus: "ready" });
    this.recommend(id);
  }
}
