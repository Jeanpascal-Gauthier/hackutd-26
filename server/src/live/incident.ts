// LIVE mode controller (MOCK=0): reports -> merged origin -> 30-minute spread forecast
// (precomputed, so scrubbing is instant) -> exits -> recommendation. Mirrors mock/controller.ts.
import type { Building, Occupant } from "@firewatch/shared/types";
import type { IncidentStore } from "../state/store.ts";
import type { ProcessResult, ReportProcessor } from "../state/processor.ts";
import { findExits, simulateSpread, type SpreadSnapshot } from "../simulation/index.ts";
import * as defaults from "./buildingData.ts";
import { locate } from "./locate.ts";
import { mergeReports } from "./merge.ts";
import { recommend } from "./recommend.ts";

export const FORECAST_MINUTES = 30;

interface LiveData {
  building: Building;
  sprinklerRooms: string[];
  occupants: Occupant[];
}

export class LiveIncident {
  private snapshots: SpreadSnapshot[] = [];
  private originId: string | undefined;

  constructor(private store: IncidentStore, private data: LiveData = defaults) {}

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
   * Called after a report was added to the store. Re-merges the origin; when it moves,
   * re-runs the forecast, exits and recommendation. An agent-supplied recommendation wins.
   */
  onReport(result: ProcessResult): void {
    const { building, sprinklerRooms, occupants } = this.data;
    const origin = mergeReports(this.store.get().reports, building);
    if (!origin) return;

    if (origin.roomId === this.originId) {
      this.store.patch({ origin });
      return;
    }
    this.originId = origin.roomId;
    this.snapshots = simulateSpread(building, origin.roomId, FORECAST_MINUTES, { sprinklerRooms });
    const exits = findExits(building, this.snapshots, occupants);
    const minute = Math.min(this.store.get().simMinute, FORECAST_MINUTES);
    this.store.patch({
      origin,
      exits,
      rooms: this.snapshots[minute].rooms,
      recommendation: result.recommendation ?? recommend(exits, origin.roomId, building),
    });
  }

  /** Scrub the forecast. Before any report there is nothing to show, so only the minute moves. */
  goTo(minute: number): void {
    const m = Math.max(0, Math.min(FORECAST_MINUTES, Math.round(minute)));
    if (!this.snapshots.length) return this.store.patch({ simMinute: m });
    this.store.patch({ simMinute: m, rooms: this.snapshots[m].rooms });
  }
}
