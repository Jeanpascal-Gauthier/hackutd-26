// LIVE mode controller (MOCK=0): reports -> merged origin -> 30-minute spread forecast
// (precomputed, so scrubbing is instant) -> exits -> recommendation. Mirrors mock/controller.ts.
import type { IncidentStore } from "../state/store.ts";
import type { ProcessResult, ReportProcessor } from "../state/processor.ts";
import type { SpreadSnapshot } from "../simulation/index.ts";
import * as defaults from "./buildingData.ts";
import { FORECAST_MINUTES, forecast, type ForecastData } from "./forecast.ts";
import { locate } from "./locate.ts";
import { mergeReports } from "./merge.ts";

export { FORECAST_MINUTES };

export class LiveIncident {
  private snapshots: SpreadSnapshot[] = [];
  private originId: string | undefined;

  constructor(private store: IncidentStore, readonly data: ForecastData = defaults) {}

  /** No fire yet: every room clear, occupants known, no reports. */
  reset(): void {
    this.snapshots = [];
    this.originId = undefined;
    this.store.reset({
      simMinute: 0,
      rooms: this.data.building.rooms.map((r) => ({ roomId: r.id, fire: 0, smoke: 0 })),
      reports: [],
      occupants: this.data.occupants,
      trail: [],
    });
  }

  /** Locator used when no agent is plugged in. */
  readonly processor: ReportProcessor = ({ text }) => {
    const found = locate(text, this.data.building);
    return { roomId: found.roomId, confidence: found.confidence, reply: found.followUp };
  };

  /**
   * Called after a report was added to the store. Re-merges the origin; when it moves, re-runs
   * the forecast, exits and recommendation. An agent-supplied recommendation always wins.
   */
  onReport(result: ProcessResult): void {
    const origin = mergeReports(this.store.get().reports, this.data.building);
    if (!origin) {
      if (result.recommendation) this.store.patch({ recommendation: result.recommendation });
      return;
    }
    if (origin.roomId === this.originId) {
      this.store.patch(result.recommendation ? { origin, recommendation: result.recommendation } : { origin });
      return;
    }
    this.originId = origin.roomId;
    const f = forecast(origin.roomId, this.data);
    this.snapshots = f.snapshots;
    const minute = Math.min(this.store.get().simMinute, FORECAST_MINUTES);
    this.store.patch({
      origin,
      exits: f.exits,
      rooms: this.snapshots[minute].rooms,
      recommendation: result.recommendation ?? f.recommendation,
    });
  }

  /** Scrub the forecast. Before any report there is nothing to show, so only the minute moves. */
  goTo(minute: number): void {
    const m = Math.max(0, Math.min(FORECAST_MINUTES, Math.round(minute)));
    if (!this.snapshots.length) return this.store.patch({ simMinute: m });
    this.store.patch({ simMinute: m, rooms: this.snapshots[m].rooms });
  }
}
