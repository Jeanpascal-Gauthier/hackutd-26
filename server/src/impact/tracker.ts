// Keeps the portfolio impact current. After any change to the map incidents it re-links them
// (zone + nearby incidents of another kind), re-assesses the portfolio, and writes the result into
// the state: per incident `impact`, `affectedProperties`, `zoneId`, `related`, and the portfolio-wide
// `portfolioImpact`. The rules answer lands at once; when Nemotron is available its answer, with the
// agent's tool trail, replaces it a few seconds later. Execute marks one planned action done and
// re-assesses, so the dollars at risk drop.
import type { MapIncident, PortfolioBuilding, PortfolioImpact } from "@firewatch/shared/types";
import type { IncidentStore } from "../state/store.ts";
import type { ImpactComputation, ImpactEngine, ImpactOptions } from "./engine.ts";
import { linkIncidents } from "./zones.ts";

export interface ImpactTrackerOptions {
  now?: () => number;
  horizonMinutes?: number;
  /** Ask Nemotron too when the engine can. Default true. */
  llm?: boolean;
  /** Give up on Nemotron after this long and keep the rules answer. */
  llmTimeoutMs?: number;
}

type ActionOutcome = { ok: boolean; error?: string };

/** Fire, crash and flood incidents that are placed and still open: the ones that can reach a building. */
const hazardous = (incident: MapIncident) => incident.status === "located" && incident.location !== undefined && incident.phase !== "resolved" && incident.kind !== "other";

export class ImpactTracker {
  private done = new Set<string>();
  private pending = false;
  /** Bumped by every change, so an answer that arrives late is recognised and dropped. */
  private generation = 0;
  private loaded = false;
  private broken = false;
  private now: () => number;
  private horizonMinutes: number;
  private llm: boolean;
  private llmTimeoutMs: number;

  constructor(
    private store: IncidentStore,
    private engine: ImpactEngine,
    private portfolio: PortfolioBuilding[],
    options: ImpactTrackerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.horizonMinutes = options.horizonMinutes ?? 30;
    this.llm = options.llm ?? true;
    this.llmTimeoutMs = options.llmTimeoutMs ?? 25_000;
  }

  private get list(): MapIncident[] {
    return this.store.get().mapIncidents ?? [];
  }

  /** Something changed: re-link and re-assess, once per tick however many changes came. */
  refresh(): void {
    this.generation++;
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      void this.run();
    });
  }

  /** Forget every executed action and the result (a new demo run). */
  clear(): void {
    this.generation++;
    this.done.clear();
    if (this.store.get().portfolioImpact) this.store.patch({ portfolioImpact: undefined });
  }

  /** Executes one planned action on one building: marks it done and lowers the dollars at risk. */
  execute(propertyId: string, actionId: string): ActionOutcome {
    const impact = this.store.get().portfolioImpact;
    const property = impact?.properties.find((p) => p.id === propertyId);
    if (!property) return { ok: false, error: `unknown property ${propertyId}` };
    const action = property.actions.find((a) => a.id === actionId);
    if (!action) return { ok: false, error: `unknown action ${actionId} on ${propertyId}` };
    if (this.done.has(actionId)) return { ok: true };
    this.done.add(actionId);
    this.generation++;
    try {
      this.apply(this.compute());
    } catch (err) {
      this.done.delete(actionId);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const after = this.store.get().portfolioImpact;
    const saved = Math.max(0, (impact?.summary.usdAtRiskAfterActions ?? 0) - (after?.summary.usdAtRiskAfterActions ?? 0));
    this.store.log("dispatch", `Executed at ${property.name}: ${action.text}${saved ? ` (saves about $${saved.toLocaleString("en-US")})` : ""}`, property.incidentIds[0]);
    // Nemotron's answer for the state before this action is stale now; ask again with it counted.
    void this.upgrade(this.generation);
    return { ok: true };
  }

  private options(): ImpactOptions {
    return { doneActionIds: [...this.done], now: this.now(), horizonMinutes: this.horizonMinutes };
  }

  private compute(): ImpactComputation {
    return this.engine.rules(this.list.filter(hazardous), this.portfolio, this.options());
  }

  private async run(): Promise<void> {
    const generation = this.generation;
    this.relink();
    if (this.broken) return;
    if (!this.list.some(hazardous)) {
      if (this.store.get().portfolioImpact) this.store.patch({ portfolioImpact: undefined, mapIncidents: this.list.map(clearImpact) });
      return;
    }
    try {
      if (!this.loaded) {
        await this.engine.load();
        this.loaded = true;
      }
      if (generation !== this.generation) return; // changed while loading; that change queued its own run
      this.apply(this.compute());
    } catch (err) {
      this.broken = !this.loaded;
      console.error(`[impact] ${this.broken ? "the impact agent could not be loaded; no portfolio impact" : "assessment failed"}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    void this.upgrade(generation);
  }

  /** Writes zone and links onto the incidents, only where they changed. */
  private relink(): void {
    const links = linkIncidents(this.list);
    const next = this.list.map((incident) => {
      const link = links.get(incident.id);
      if (!link) return incident.zoneId === undefined && incident.related === undefined ? incident : { ...incident, zoneId: undefined, related: undefined };
      const related = link.related.length ? link.related : undefined;
      if (incident.zoneId === link.zoneId && sameIds(incident.related, related)) return incident;
      return { ...incident, zoneId: link.zoneId, related };
    });
    if (next.some((incident, i) => incident !== this.list[i])) this.store.patch({ mapIncidents: next });
  }

  /** Nemotron's answer: the same tools, run by the model, with their trail. Replaces the rules answer if still current. */
  private async upgrade(generation: number): Promise<void> {
    if (!this.llm || !this.engine.llm || generation !== this.generation) return;
    const incidents = this.list.filter(hazardous);
    if (!incidents.length) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${this.llmTimeoutMs} ms`)), this.llmTimeoutMs)));
      const result = await Promise.race([this.engine.llm(incidents, this.portfolio, this.options()), timeout]);
      if (generation !== this.generation) return; // something changed while the model worked
      if (result.mode === "llm") this.apply(result);
    } catch (err) {
      console.error(`[impact] Nemotron did not answer; keeping the rules result: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private apply(result: ImpactComputation): void {
    const portfolioImpact: PortfolioImpact = {
      properties: result.affectedProperties,
      summary: result.summary,
      briefing: result.briefing,
      mode: result.mode,
      trail: result.trail,
      time: this.now(),
    };
    const mapIncidents = this.list.map((incident) => {
      if (!hazardous(incident)) return clearImpact(incident);
      const impact = result.impacts[incident.id];
      const properties = result.affectedProperties.filter((p) => p.incidentIds.includes(incident.id));
      return { ...incident, ...(impact && { impact }), affectedProperties: properties };
    });
    this.store.patch({ portfolioImpact, mapIncidents });
  }
}

function clearImpact(incident: MapIncident): MapIncident {
  if (incident.impact === undefined && incident.affectedProperties === undefined) return incident;
  return { ...incident, impact: undefined, affectedProperties: undefined };
}

function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  return (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((id, i) => id === b![i]);
}
