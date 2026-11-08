// LIVE mode controller (MOCK=0): reports -> merged fires -> 30-minute spread forecast
// (precomputed, so scrubbing is instant) -> exits -> recommendation. Mirrors mock/controller.ts.
import type { IncidentState, Recommendation } from "@firewatch/shared/types";
import { isMapReport, mapRecommendations, type IncidentStore } from "../state/store.ts";
import type { ProcessResult, ReportProcessor } from "../state/processor.ts";
import type { SpreadSnapshot } from "../simulation/index.ts";
import { ActiveBuilding, type BuildingData } from "./buildingData.ts";
import { FORECAST_MINUTES, forecast, type ForecastData } from "./forecast.ts";
import { locate } from "./locate.ts";
import { mergeFires } from "./merge.ts";

export { FORECAST_MINUTES };

/** Fields a reset may carry over instead of clearing. */
export type ResetKeep = Partial<Pick<IncidentState, "buildingLookup" | "reports" | "trail" | "log">>;

export class LiveIncident {
  private snapshots: SpreadSnapshot[] = [];
  /** Sorted room ids of the fires the current forecast was run from ("" = none). */
  private fireKey = "";

  constructor(private store: IncidentStore, readonly active: ActiveBuilding = new ActiveBuilding()) {}

  /** The active building's data. It changes when an address lookup activates another building. */
  get data(): BuildingData & ForecastData {
    return this.active.get();
  }

  /**
   * No fire yet: every room of the active building clear, its occupants, no reports.
   * `keep` carries fields across the reset (a lookup, the log, reports held during a lookup).
   */
  reset(keep: ResetKeep = {}): void {
    this.snapshots = [];
    this.fireKey = "";
    // The map spans every emergency, so a change of building doesn't clear it (MapIncidents.clear does).
    const { mapIncidents, reports, recommendation } = this.store.get();
    const kept = keep.reports ?? [];
    const mapReports = reports.filter((report) => isMapReport(report) && !kept.some((k) => k.id === report.id));
    this.store.reset({
      simMinute: 0,
      rooms: this.data.building.rooms.map((r) => ({ roomId: r.id, fire: 0, smoke: 0 })),
      reports: [...kept, ...mapReports].sort((a, b) => a.time - b.time),
      occupants: this.data.occupants,
      trail: keep.trail ?? [],
      dispatches: [],
      log: keep.log ?? [],
      building: this.active.summary(),
      ...(keep.buildingLookup && { buildingLookup: keep.buildingLookup }),
      ...(mapIncidents && { mapIncidents }),
      ...(recommendation && mapRecommendations.has(recommendation) && { recommendation }),
    });
  }

  /** Make `data` the active building (its version goes up) and start a clean incident on it. */
  activate(data: BuildingData, keep: ResetKeep = {}): void {
    this.active.set(data);
    this.reset(keep);
  }

  /** Locator used when no agent is plugged in. */
  readonly processor: ReportProcessor = ({ text }) => {
    const found = locate(text, this.data.building);
    return { roomId: found.roomId, confidence: found.confidence, reply: found.followUp };
  };

  /**
   * Called after a report was added to the store. Re-merges every report into fires; when the
   * set of fires changes, re-runs the forecast with all of them burning, then exits and the
   * recommendation. `origin` is the most confident fire. An agent-supplied recommendation wins.
   */
  onReport(result: ProcessResult): void {
    const fires = mergeFires(this.store.get().reports, this.data.building);
    const key = fires.map((f) => f.roomId).sort().join(",");
    if (!fires.length || key === this.fireKey) {
      if (fires.length) this.store.patch({ origin: fires[0] });
      if (result.recommendation) this.setRecommendation(result.recommendation);
      return;
    }
    this.fireKey = key;
    const f = forecast(fires.map((x) => x.roomId), this.data);
    this.snapshots = f.snapshots;
    const minute = Math.min(this.store.get().simMinute, FORECAST_MINUTES);
    this.store.patch({ origin: fires[0], exits: f.exits, rooms: this.snapshots[minute].rooms });
    const pct = (x: { roomId: string; confidence: number }) => `${x.roomId} (${Math.round(x.confidence * 100)}%)`;
    this.store.log("origin", fires.length === 1 ? `Fire origin: ${pct(fires[0])}` : `${fires.length} fires: ${fires.map(pct).join(", ")}`);
    this.setRecommendation(result.recommendation ?? f.recommendation);
  }

  private setRecommendation(rec: Recommendation): void {
    this.store.setRecommendation(rec);
    this.store.log("recommendation", `Recommended: ${rec.actions.join("; ")}`);
  }

  /** Scrub the forecast. Before any report there is nothing to show, so only the minute moves. */
  goTo(minute: number): void {
    const m = Math.max(0, Math.min(FORECAST_MINUTES, Math.round(minute)));
    if (!this.snapshots.length) return this.store.patch({ simMinute: m });
    this.store.patch({ simMinute: m, rooms: this.snapshots[m].rooms });
  }
}
