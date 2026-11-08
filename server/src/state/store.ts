// Authoritative incident state. Everything that changes the incident goes through here;
// subscribers (the WebSocket layer) are told after every change.
import type { IncidentState, LogEntry, MapIncident, Recommendation, Report } from "@firewatch/shared/types";

export const MAX_LOG = 200;

/** Marks caller reports that came from a map incident: they outlive a change of active building. */
export const MAP_REPORT_PREFIX = "map-";
export const isMapReport = (report: Report) => report.id.startsWith(MAP_REPORT_PREFIX);
/** Recommendations written for a map incident, which also outlive a change of active building. */
export const mapRecommendations = new WeakSet<Recommendation>();

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

  /**
   * Commander accepted the pending recommendation: it moves to `accepted`. Returns it (or undefined).
   * If it is a map incident's recommendation, that incident is marked accepted in the same change.
   */
  acceptRecommendation(): Recommendation | undefined {
    const accepted = this.state.recommendation;
    if (!accepted) return undefined;
    const time = Date.now();
    const owner = this.state.mapIncidents?.find((incident) => incident.recommendation === accepted);
    this.patch({
      recommendation: undefined,
      accepted: { recommendation: accepted, time },
      ...(owner && { mapIncidents: this.withIncidentAccepted(owner.id, accepted, time) }),
    });
    this.log("accepted", `Commander accepted: ${accepted.actions[0]}`, owner?.id);
    return accepted;
  }

  /** Accepts one map incident's pending recommendation, and the global one too if it is the same object. */
  acceptIncidentRecommendation(incidentId: string): Recommendation | undefined {
    const pending = this.state.mapIncidents?.find((incident) => incident.id === incidentId)?.recommendation;
    if (!pending) return undefined;
    if (this.state.recommendation === pending) return this.acceptRecommendation();
    this.patch({ mapIncidents: this.withIncidentAccepted(incidentId, pending, Date.now()) });
    this.log("accepted", `Commander accepted: ${pending.actions[0]}`, incidentId);
    return pending;
  }

  private withIncidentAccepted(id: string, recommendation: Recommendation, time: number): MapIncident[] {
    return (this.state.mapIncidents ?? []).map((incident) =>
      incident.id === id ? { ...incident, recommendation: undefined, accepted: { recommendation, time }, updated: time } : incident,
    );
  }

  /** A duplicate map incident was merged into another: its reports and log entries follow it. */
  reassignIncident(from: string, to: string): void {
    const { reports, log } = this.state;
    this.patch({
      reports: reports.map((report) => (report.incidentId === from ? { ...report, incidentId: to } : report)),
      ...(log && { log: log.map((entry) => (entry.incidentId === from ? { ...entry, incidentId: to } : entry)) }),
    });
  }

  addDispatch(roomId: string): void {
    this.patch({ dispatches: [...(this.state.dispatches ?? []), { roomId, time: Date.now() }] });
    this.log("dispatch", `Crew dispatched to ${roomId}`);
  }

  /** Append to the incident log (keeps the last MAX_LOG entries). */
  log(kind: LogEntry["kind"], text: string, incidentId?: string): void {
    const log = [...(this.state.log ?? []), { time: Date.now(), kind, text, ...(incidentId && { incidentId }) }];
    this.patch({ log: log.slice(-MAX_LOG) });
  }

  reset(next: IncidentState = emptyState()): void {
    this.state = next;
    for (const fn of this.listeners) fn(this.state);
  }
}
