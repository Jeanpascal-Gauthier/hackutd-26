// MOCK=1: an opt-in scripted demo on top of the real live incident.
// Replay starts with no fire, delivers the scripted calls through the real ingest path at their
// minutes, and advances the forecast one minute per tick up to minute 30. Scrubbing (setSimMinute)
// goes straight to the live incident; scripted calls arrive only on ticks.
import type { IncidentStore } from "../state/store.ts";
import type { Ingest } from "../state/ingest.ts";
import { FORECAST_MINUTES, type LiveIncident } from "../live/incident.ts";
import { SCRIPT, demoTrail } from "./script.ts";

export class MockIncident {
  private timer?: NodeJS.Timeout;
  private next = 0; // index of the next scripted call to deliver

  constructor(
    private store: IncidentStore,
    private live: LiveIncident,
    private ingest: Ingest,
    private tickMs: number,
  ) {}

  /** Stopped, minute 0, no fire, no reports. */
  reset(): void {
    this.stop();
    this.next = 0;
    this.live.reset();
  }

  /** Reset, deliver the minute-0 calls, then advance one minute per tick until minute 30. */
  async replay(): Promise<void> {
    this.reset();
    await this.deliver(0);
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    const minute = this.store.get().simMinute + 1;
    if (minute > FORECAST_MINUTES) return this.stop();
    this.live.goTo(minute);
    await this.deliver(minute);
  }

  /** Deliver every scripted call due at or before `minute` that hasn't been delivered yet. */
  private async deliver(minute: number): Promise<void> {
    while (this.next < SCRIPT.length && SCRIPT[this.next].minute <= minute) {
      const call = SCRIPT[this.next++];
      try {
        const out = await this.ingest({ caller: call.caller, text: call.text });
        // A real agent supplies its own trail; otherwise show an illustrative one.
        if (!out.result.trail?.length) {
          const state = this.store.get();
          this.store.patch({ trail: [...(state.trail ?? []), ...demoTrail(call, out, state)] });
        }
      } catch (err) {
        console.error("[mock] scripted call failed", err);
      }
    }
  }
}
