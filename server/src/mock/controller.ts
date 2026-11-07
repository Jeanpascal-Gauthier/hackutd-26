// MOCK mode controller: replays the fixture into the store. Entirely separate from real
// agent processing; the real simulation would call store.patch() instead of this.
import type { IncidentStore } from "../state/store.ts";
import { MOCK_ID_PREFIX, SCRIPT_END, mockRecommendation, mockReports, mockRooms, mockState } from "./scenario.ts";

export class MockIncident {
  private timer?: NodeJS.Timeout;
  // Which scripted recommendation was last pushed; stops an accepted one from reappearing on the next tick.
  private lastRecIndex: number | undefined;

  constructor(private store: IncidentStore, private tickMs: number) {}

  /** Jump to a minute (clamped to the script). Keeps reports that arrived via POST /ingest. */
  goTo(minute: number): void {
    const m = Math.max(0, Math.min(SCRIPT_END, Math.round(minute)));
    const live = this.store.get().reports.filter((r) => !r.id.startsWith(MOCK_ID_PREFIX));
    const rec = mockRecommendation(m);
    const change = {
      simMinute: m,
      rooms: mockRooms(m),
      reports: [...mockReports(m), ...live],
      occupants: mockState(m).occupants,
    };
    if (rec?.index !== this.lastRecIndex) {
      this.lastRecIndex = rec?.index;
      this.store.patch({ ...change, recommendation: rec?.rec });
    } else {
      this.store.patch(change);
    }
  }

  /** Back to minute 0, ingested reports cleared, stopped. */
  reset(): void {
    this.stop();
    this.lastRecIndex = undefined;
    this.store.reset(mockState(0));
  }

  /** Reset, then advance one minute per tick until the script ends. */
  replay(): void {
    this.reset();
    this.timer = setInterval(() => {
      const next = this.store.get().simMinute + 1;
      this.goTo(next);
      if (next >= SCRIPT_END) this.stop();
    }, this.tickMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
