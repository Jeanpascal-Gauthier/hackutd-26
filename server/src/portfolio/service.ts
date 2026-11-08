// Portfolio impact (CBRE "Invisible Network"): which portfolio buildings the open map incidents
// hit, what fails in what order, the $ at risk, and what to do. Watches the store; when the set of
// located, unresolved incidents changes (debounced), it runs the agent's deterministic rules path
// and publishes at once, then runs Nemotron in the background and publishes that too if the
// incidents haven't changed meanwhile. Publishes state.portfolioImpact and, on each map incident,
// `impact` and `affectedProperties` (incidents/stepZero.ts). Executed actions survive recomputes.
import type { IncidentState, LogEntry, MapIncident } from "@firewatch/shared/types";
import type { AffectedProperty, AgentIncident, IncidentImpactResult, PortfolioBuilding } from "../../../agent/core/impact/types.ts";
import type { IncidentStatePlus, MapIncidentPlus, PortfolioImpact } from "../incidents/stepZero.ts";
import { guarded, guardedAsync, isImpactResult, type ImpactAgent, type MapIncidentForAgent } from "./bridge.ts";

/** What the service needs from IncidentStore. */
export interface PortfolioStore {
  get(): IncidentState;
  subscribe(fn: (state: IncidentState) => void): () => void;
  patch(change: Partial<IncidentState>): void;
  log(kind: LogEntry["kind"], text: string, incidentId?: string): void;
}

export interface PortfolioServiceOptions {
  /** Wait this long after the last incident change before recomputing. Default 300. */
  debounceMs?: number;
  /** Run assessIncident (Nemotron) after the rules result. Default true. */
  llm?: boolean;
  /** Nemotron budget (the agent falls back to rules inside it). Default 15000. */
  llmTimeoutMs?: number;
  horizonMinutes?: number;
  now?: () => number;
}

export type ActionOutcome = { ok: true; portfolioImpact: PortfolioImpact } | { ok: false; status: number; error: string };

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_LLM_TIMEOUT_MS = 15_000;

/** The incidents the portfolio is assessed against: located and not resolved. */
export const assessable = (m: MapIncident) => m.status === "located" && !!m.location && m.phase !== "resolved";

/** Changes when any assessable incident is added, removed, moved or updated. "" when there are none. */
export function incidentSignature(state: IncidentState): string {
  return (state.mapIncidents ?? [])
    .filter(assessable)
    .map((m) => [m.id, m.kind, m.location!.lat.toFixed(6), m.location!.lon.toFixed(6), m.severity, m.forecastStatus, m.updated].join("|"))
    .sort()
    .join(";");
}

/** "~$380K" when the agent's formatUsd isn't available. */
export function fallbackUsd(usd: number): string {
  const n = Math.max(0, Math.round(usd));
  if (n < 1_000) return `$${n}`;
  if (n < 1_000_000) return `~$${Math.round(n / 1_000)}K`;
  return `~$${(Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

export class PortfolioImpactService {
  private signature = "";
  /** Bumped by every recompute and clear: a background result from an older run is stale. */
  private run = 0;
  private timer: NodeJS.Timeout | undefined;
  private firstPendingAt = 0;
  /** The latest raw agent result (before `done` is applied) and the incidents it was computed for. */
  private current: { result: IncidentImpactResult; incidentIds: Set<string> } | undefined;
  private done: string[] = [];
  private writing = false;
  private lastLogged = "";
  private unsubscribe: (() => void) | undefined;
  private debounceMs: number;
  private llm: boolean;
  private llmTimeoutMs: number;
  private horizonMinutes: number | undefined;
  private now: () => number;
  /** The scripted demo's clock for occupancy (setClock). Unset: `now`. */
  private clock: (() => number) | undefined;

  constructor(
    private store: PortfolioStore,
    private portfolio: PortfolioBuilding[],
    private agent: ImpactAgent | undefined,
    options: PortfolioServiceOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.llm = options.llm ?? true;
    this.llmTimeoutMs = options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.horizonMinutes = options.horizonMinutes;
    this.now = options.now ?? Date.now;
    if (this.enabled) this.unsubscribe = store.subscribe((state) => this.onChange(state));
  }

  /** On when the agent loaded and the portfolio has buildings. */
  get enabled(): boolean {
    return !!this.agent && this.portfolio.length > 0;
  }

  buildings(): PortfolioBuilding[] {
    return this.portfolio;
  }

  impact(): PortfolioImpact | undefined {
    return (this.store.get() as IncidentStatePlus).portfolioImpact;
  }

  /** Whether a scripted clock (setClock) is in use. */
  get scriptedClock(): boolean {
    return !!this.clock;
  }

  /**
   * The time the agent assesses occupancy at (the scripted CBRE demo's weekday 2 pm), or undefined
   * for the real clock. Recomputes the current incidents. Debounce and `updated` keep the real clock.
   */
  setClock(clock: (() => number) | undefined): void {
    if (clock === this.clock) return;
    this.clock = clock;
    if (!this.signature) return;
    this.signature = "";
    this.recompute();
  }

  /** Stop watching the store (tests). */
  stop(): void {
    clearTimeout(this.timer);
    this.unsubscribe?.();
  }

  // ---- watching ---------------------------------------------------------------------------------

  private onChange(state: IncidentState): void {
    if (this.writing) return; // our own publish
    if (incidentSignature(state) === this.signature) {
      // A reset elsewhere (live/incident.ts, on a change of building) keeps the map but drops
      // portfolioImpact: put the current result back.
      if (this.current && !(state as IncidentStatePlus).portfolioImpact) this.publish(this.current.result);
      return;
    }
    const at = this.now();
    if (!this.timer) this.firstPendingAt = at;
    clearTimeout(this.timer);
    // Debounced, but a steady stream of changes still recomputes every few debounce periods.
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + 3 * this.debounceMs - at));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.recompute();
    }, wait);
  }

  /** Recompute now if the incidents changed since the last run. Public for tests and scripts. */
  recompute(): void {
    if (!this.enabled) return;
    const state = this.store.get();
    const signature = incidentSignature(state);
    if (signature === this.signature) return;
    this.signature = signature;
    const run = ++this.run;
    if (!signature) return this.clearPublished(); // nothing located and open: nothing at risk

    const agent = this.agent!;
    const located = (state.mapIncidents ?? []).filter(assessable) as MapIncidentPlus[];
    const incidents = located
      .map((m) => guarded(`fromMapIncident(${m.id})`, () => agent.fromMapIncident(asAgentKind(m))))
      .filter((i): i is AgentIncident => !!i);
    const opts = { doneActionIds: [...this.done], now: (this.clock ?? this.now)(), ...(this.horizonMinutes && { horizonMinutes: this.horizonMinutes }) };

    // 1. Rules: synchronous, published at once so the console updates within the debounce.
    const rules = guarded("assessIncidentRules", () => agent.assessIncidentRules(incidents, this.portfolio, opts));
    const ids = new Set(incidents.map((i) => i.id));
    if (isImpactResult(rules)) this.publish(rules, ids);

    // 2. Nemotron in the background; replaces the rules result only if nothing changed meanwhile.
    //    On a scripted clock (the demo) it must also agree with the rules numbers, so the story holds.
    if (!this.llm || !agent.assessIncident || incidents.length === 0) return;
    const scripted = !!this.clock;
    void guardedAsync("assessIncident", () => agent.assessIncident!(incidents, this.portfolio, { ...opts, timeoutMs: this.llmTimeoutMs }), this.llmTimeoutMs + 1_000)
      .then((result) => {
        if (!result || run !== this.run || incidentSignature(this.store.get()) !== this.signature) return; // stale or failed
        if (scripted && isImpactResult(rules) && !sameTotals(result, rules)) {
          console.warn(`[portfolio] scripted demo: Nemotron's totals differ from the rules path; keeping the rules result`);
          return;
        }
        this.publish(result, ids);
      });
  }

  // ---- publishing -------------------------------------------------------------------------------

  /** `result` with `done` applied: action statuses and summary.usdAtRiskAfterActions. */
  private withDone(result: IncidentImpactResult): { affectedProperties: AffectedProperty[]; summary: PortfolioImpact["summary"] } {
    const done = new Set(this.done);
    const affectedProperties = result.affectedProperties.map((p) => ({
      ...p,
      actions: (p.actions ?? []).map((a) => ({ ...a, status: done.has(a.id) ? ("done" as const) : ("pending" as const) })),
    }));
    const horizon = result.summary.horizonMinutes;
    const fromAgent = this.agent?.summarize && guarded("summarize", () => this.agent!.summarize!(affectedProperties, horizon, [...done], this.portfolio));
    if (fromAgent && Number.isFinite(fromAgent.usdAtRiskAfterActions)) return { affectedProperties, summary: fromAgent };

    // No summarize export: price what is left per building (residualCost), else subtract savings.
    const buildings = new Map(this.portfolio.map((b) => [b.id, b]));
    let usdAtRisk = 0;
    let after = 0;
    for (const p of affectedProperties) {
      const total = p.cost?.totalUsd ?? 0;
      usdAtRisk += total;
      const building = buildings.get(p.id);
      const residual = building && this.agent?.residualCost && guarded("residualCost", () => this.agent!.residualCost!(building, p.chain ?? [], p.actions));
      if (residual && Number.isFinite(residual.totalUsd)) after += residual.totalUsd;
      else after += Math.max(0, total - p.actions.filter((a) => a.status === "done").reduce((s, a) => s + (a.savesUsd ?? 0), 0));
    }
    return { affectedProperties, summary: { ...result.summary, usdAtRisk, usdAtRiskAfterActions: Math.min(usdAtRisk, after) } };
  }

  private usd(n: number): string {
    const fmt = this.agent?.formatUsd && guarded("formatUsd", () => this.agent!.formatUsd!(n));
    return typeof fmt === "string" ? fmt : fallbackUsd(n);
  }

  /** Writes state.portfolioImpact and each incident's impact/affectedProperties, keeping every other field. */
  private publish(result: IncidentImpactResult, incidentIds: Set<string> = this.current?.incidentIds ?? new Set()): PortfolioImpact {
    this.current = { result, incidentIds };
    const { affectedProperties, summary } = this.withDone(result);
    const portfolioImpact: PortfolioImpact = {
      summary,
      affectedProperties,
      briefing: result.briefing,
      mode: result.mode === "llm" ? "llm" : "rules",
      done: [...this.done],
      updated: this.now(),
    };
    const mapIncidents = ((this.store.get().mapIncidents ?? []) as MapIncidentPlus[]).map((m) => {
      if (!incidentIds.has(m.id)) return strip(m);
      const { impact: _impact, affectedProperties: _props, ...rest } = m;
      const impact = result.impacts[m.id];
      return { ...rest, ...(impact && { impact }), affectedProperties: affectedProperties.filter((p) => p.incidentIds.includes(m.id)) };
    });
    this.write({ portfolioImpact, mapIncidents } satisfies Partial<IncidentStatePlus>);

    const headline = summary.buildings > 0 ? `Portfolio impact: ${summary.headline}` : "";
    if (headline && headline !== this.lastLogged) {
      this.write(() => this.store.log("recommendation", headline, affectedProperties[0]?.incidentIds[0]));
    }
    this.lastLogged = headline;
    return portfolioImpact;
  }

  private clearPublished(): void {
    this.current = undefined;
    this.done = [];
    this.lastLogged = "";
    const state = this.store.get() as IncidentStatePlus;
    const incidents = (state.mapIncidents ?? []) as MapIncidentPlus[];
    if (!state.portfolioImpact && !incidents.some((m) => m.impact || m.affectedProperties)) return;
    this.write({ portfolioImpact: undefined, mapIncidents: incidents.map(strip) } satisfies Partial<IncidentStatePlus>);
  }

  private write(change: Partial<IncidentStatePlus> | (() => void)): void {
    this.writing = true;
    try {
      if (typeof change === "function") change();
      else this.store.patch(change);
    } finally {
      this.writing = false;
    }
  }

  // ---- operator actions -------------------------------------------------------------------------

  private findAction(actionId: string) {
    if (!this.current) return undefined;
    for (const property of this.current.result.affectedProperties)
      for (const action of property.actions ?? []) if (action.id === actionId) return { property, action };
    return undefined;
  }

  /** The operator pressed Execute: the action is done, and what it prevents is off the $ at risk. */
  execute(actionId: string): ActionOutcome {
    return this.setDone(actionId, true);
  }

  /** Takes an executed action back. */
  undo(actionId: string): ActionOutcome {
    return this.setDone(actionId, false);
  }

  private setDone(actionId: string, done: boolean): ActionOutcome {
    if (!this.enabled) return { ok: false, status: 503, error: "portfolio impact is off (no agent or no portfolio)" };
    const found = this.findAction(actionId);
    if (!found) return { ok: false, status: 404, error: `no planned action ${actionId}` };
    const was = this.done.includes(actionId);
    if (was === done) return { ok: true, portfolioImpact: this.impact() ?? this.publish(this.current!.result) };
    this.done = done ? [...this.done, actionId] : this.done.filter((id) => id !== actionId);
    const portfolioImpact = this.publish(this.current!.result);
    const left = this.usd(portfolioImpact.summary.usdAtRiskAfterActions);
    const text = `${done ? "Executed" : "Undone"}: ${found.action.text} (${found.property.name}) → ${left} at risk`;
    this.write(() => this.store.log("recommendation", text, found.property.incidentIds[0]));
    return { ok: true, portfolioImpact };
  }

  /** Every reset: no incidents, so no impact and no executed actions. */
  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.run++;
    this.signature = "";
    this.clearPublished();
  }
}

/** Until Step 0 adds kind "flood", a flood is kind "other" with `flood` set: the agent is told it is a flood. */
export const asAgentKind = (m: MapIncidentPlus): MapIncidentForAgent => (m.flood && m.kind === "other" ? { ...m, kind: "flood" } : m);

const sameTotals = (a: IncidentImpactResult, b: IncidentImpactResult) =>
  a.summary.buildings === b.summary.buildings && a.summary.people === b.summary.people && Math.round(a.summary.usdAtRisk) === Math.round(b.summary.usdAtRisk);

function strip(m: MapIncidentPlus): MapIncidentPlus {
  if (!m.impact && !m.affectedProperties) return m;
  const { impact: _impact, affectedProperties: _props, ...rest } = m;
  return rest;
}
