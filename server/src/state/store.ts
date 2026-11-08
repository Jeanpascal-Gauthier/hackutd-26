// Authoritative incident state. Everything that changes the incident goes through here;
// subscribers (the WebSocket layer) are told after every change.
import type { IncidentState, LogEntry, Recommendation, Report } from "@firewatch/shared/types";

export const MAX_LOG = 200;

export type Listener = (state: IncidentState) => void;

export const emptyState = (): IncidentState => ({
  simMinute: 0,
  rooms: [],
  reports: [],
  occupants: [],
});

export class IncidentStore {
  private state: IncidentState = emptyState();
  private listeners = new Set<Listener>();

  get(): IncidentState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Shallow-merge a change and notify subscribers. State objects are never mutated. */
  patch(change: Partial<IncidentState>): void {
    this.state = { ...this.state, ...change };
    for (const fn of this.listeners) fn(this.state);
  }

  addReport(report: Report): void {
    this.patch({ reports: [...this.state.reports, report] });
  }

  setRecommendation(recommendation: Recommendation | undefined): void {
    this.patch({ recommendation });
  }

  /** Commander accepted the pending recommendation: it moves to `accepted`. Returns it (or undefined). */
  acceptRecommendation(): Recommendation | undefined {
    const accepted = this.state.recommendation;
    if (!accepted) return undefined;
    this.patch({ recommendation: undefined, accepted: { recommendation: accepted, time: Date.now() } });
    this.log("accepted", `Commander accepted: ${accepted.actions[0]}`);
    return accepted;
  }

  addDispatch(roomId: string): void {
    this.patch({ dispatches: [...(this.state.dispatches ?? []), { roomId, time: Date.now() }] });
    this.log("dispatch", `Crew dispatched to ${roomId}`);
  }

  /** Append to the incident log (keeps the last MAX_LOG entries). */
  log(kind: LogEntry["kind"], text: string): void {
    const log = [...(this.state.log ?? []), { time: Date.now(), kind, text }];
    this.patch({ log: log.slice(-MAX_LOG) });
  }

  reset(next: IncidentState = emptyState()): void {
    this.state = next;
    for (const fn of this.listeners) fn(this.state);
  }
}
