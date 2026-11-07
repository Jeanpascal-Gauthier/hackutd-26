// Authoritative incident state. Everything that changes the incident goes through here;
// subscribers (the WebSocket layer) are told after every change.
import type { IncidentState, Recommendation, Report } from "@firewatch/shared/types";

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

  /** Operator accepted the current recommendation: it is consumed. Returns it (or undefined). */
  acceptRecommendation(): Recommendation | undefined {
    const accepted = this.state.recommendation;
    if (accepted) this.patch({ recommendation: undefined });
    return accepted;
  }

  reset(next: IncidentState = emptyState()): void {
    this.state = next;
    for (const fn of this.listeners) fn(this.state);
  }
}
