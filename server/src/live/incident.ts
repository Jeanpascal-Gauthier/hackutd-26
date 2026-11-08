// LIVE mode controller (MOCK=0): reports -> merged fires -> 30-minute spread forecast
// (precomputed, so scrubbing is instant) -> exits -> recommendation. Mirrors mock/controller.ts.
import type { Recommendation } from "@firewatch/shared/types";
import type { IncidentStore } from "../state/store.ts";
import type { ProcessResult, ReportProcessor } from "../state/processor.ts";
import type { SpreadSnapshot } from "../simulation/index.ts";
import * as defaults from "./buildingData.ts";
import { FORECAST_MINUTES, forecast, type ForecastData } from "./forecast.ts";
import { locate } from "./locate.ts";
import { mergeFires } from "./merge.ts";

export { FORECAST_MINUTES };

export class LiveIncident {
  private snapshots: SpreadSnapshot[] = [];
  /** Sorted room ids of the fires the current forecast was run from ("" = none). */
  private fireKey = "";

  constructor(private store: IncidentStore, readonly data: ForecastData = defaults) {}

  /** No fire yet: every room clear, occupants known, no reports. */
  reset(): void {
    this.snapshots = [];
    this.fireKey = "";
    this.store.reset({
      simMinute: 0,
      rooms: this.data.building.rooms.map((r) => ({ roomId: r.id, fire: 0, smoke: 0 })),
      reports: [],
      occupants: this.data.occupants,
      trail: [],
      dispatches: [],
      log: [],
    });
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
