// The scripted CBRE demo: the agent's three demo incidents (agent/fixtures/demoIncidents.ts: a fire
// behind the strip mall on Campbell Rd, a crash on Coit Rd, a water main burst on Lookout Dr) put on
// the map one call at a time, with their hand-built forecasts, so the judged run shows the same
// story every time whatever today's wind and time of day. While it runs, the portfolio service
// assesses occupancy at the fixture's weekday 2 pm (DEMO_NOW). Routes: POST /portfolio/demo/step,
// /run, /reset (transport/http.ts). The fixtures load like the agent (portfolio/bridge.ts): by
// relative path, guarded; if they can't load, step and run answer 503 and nothing else changes.
import type { AgentIncident } from "../../../agent/core/impact/types.ts";
import type { MapIncidents } from "../incidents/service.ts";
import type { MapIncidentPlus, PortfolioImpact } from "../incidents/stepZero.ts";
import { zoneId } from "../incidents/zones.ts";
import type { PortfolioImpactService } from "./service.ts";

const DEMO_URL = new URL("../../../agent/fixtures/demoIncidents.ts", import.meta.url);

export interface DemoFixtures {
  /** Fire, crash, flood: the order the calls come in. */
  incidents: AgentIncident[];
  /** Epoch ms: the occupancy clock while the demo runs (a weekday 2 pm Central). */
  now: number;
}

/** What each call sounds like and where it is, by kind. */
const SCRIPT: Record<"fire" | "crash" | "flood", { caller: string; text: string; query: string; formatted: string }> = {
  fire: {
    caller: "demo caller 1",
    text: "Fire behind the strip mall on Campbell Rd, smoke everywhere",
    query: "the strip mall on Campbell Rd at Coit",
    formatted: "Campbell Coit Plaza, Campbell Road, Richardson, TX 75080, United States",
  },
  crash: {
    caller: "demo caller 2",
    text: "Crash on Coit, all lanes blocked",
    query: "Coit Rd and Campbell Rd",
    formatted: "Coit Road & Campbell Road, Richardson, TX 75080, United States",
  },
  flood: {
    caller: "demo caller 3",
    text: "Water main burst, the street is flooding",
    query: "Lookout Dr near Coit Rd",
    formatted: "Lookout Drive, Richardson, TX 75080, United States",
  },
};
const ORDER = ["fire", "crash", "flood"] as const;
const LABEL = { fire: "Fire", crash: "Car crash", flood: "Flood" } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIncident = (v: unknown): v is AgentIncident =>
  isObj(v) && typeof v.id === "string" && typeof v.kind === "string" && isObj(v.location) && Number.isFinite(v.location.lat) && Number.isFinite(v.location.lon);

/** The fixtures from a loaded module, or undefined (with why) when they are missing or malformed. */
export function demoFixturesFrom(mod: Record<string, unknown> | undefined): { fixtures?: DemoFixtures; problem?: string } {
  if (!mod) return { problem: "agent/fixtures/demoIncidents.ts could not be loaded" };
  const { DEMO_INCIDENTS, DEMO_NOW } = mod;
  if (!Array.isArray(DEMO_INCIDENTS) || !DEMO_INCIDENTS.every(isIncident)) return { problem: "DEMO_INCIDENTS is missing or malformed" };
  if (typeof DEMO_NOW !== "number" || !Number.isFinite(DEMO_NOW)) return { problem: "DEMO_NOW is missing or not a number" };
  const incidents = ORDER.map((kind) => DEMO_INCIDENTS.find((i) => i.kind === kind));
  if (!incidents.every((i) => i)) return { problem: "DEMO_INCIDENTS needs a fire, a crash and a flood" };
  return { fixtures: { incidents: incidents as AgentIncident[], now: DEMO_NOW } };
}

/** Loads the demo fixtures. Never throws: undefined (logged) when they can't be used. */
export async function loadDemoFixtures(url: URL = DEMO_URL): Promise<DemoFixtures | undefined> {
  let mod: Record<string, unknown> | undefined;
  try {
    mod = (await import(url.href)) as Record<string, unknown>;
  } catch (err) {
    console.error(`[cbre-demo] could not load ${url.pathname}: ${(err as Error).message}`);
  }
  const { fixtures, problem } = demoFixturesFrom(mod);
  if (problem) console.warn(`[cbre-demo] ${problem}; the scripted demo is off`);
  return fixtures;
}

/**
 * A demo AgentIncident as the full MapIncident the server holds: located, forecast ready as of
 * `at`, one caller report. Floods are kind "other", label "Flood", with `flood` and `source`.
 * fromMapIncident() reads it back to the same location, severity, forecasts and roads.
 */
export function demoMapIncident(i: AgentIncident, at: number): MapIncidentPlus {
  const kind = i.kind as (typeof ORDER)[number]; // demoFixturesFrom() checked there is one of each
  const script = SCRIPT[kind];
  return {
    id: i.id,
    kind: kind === "flood" ? "other" : kind,
    label: LABEL[kind],
    severity: i.severity,
    status: "located",
    query: script.query,
    location: { lat: i.location.lat, lon: i.location.lon },
    formatted: script.formatted,
    ...(kind === "fire" && { inBuilding: i.inBuilding ?? false }),
    ...(kind === "crash" && { lanesBlocked: i.lanesBlocked ?? "all" }),
    reports: [{ caller: script.caller, text: script.text, time: at, channel: "voice" }],
    time: at,
    updated: at,
    phase: "open",
    forecastStatus: "ready",
    forecastAt: at,
    ...(i.fire && { fire: i.fire }),
    ...(i.crash && { crash: i.crash }),
    ...(i.flood && { flood: i.flood }),
    ...(kind === "flood" && { source: i.source ?? "water main burst" }),
    ...(i.affectedRoads && { affectedRoads: i.affectedRoads }),
    zoneId: zoneId(i.location),
  };
}

export type DemoOutcome =
  | { ok: true; step: number; of: number; done?: true; added: { id: string; label: string }[]; portfolioImpact: PortfolioImpact | null }
  | { ok: false; status: number; error: string };

export interface CbreDemoDeps {
  mapIncidents: Pick<MapIncidents, "inject">;
  portfolio: Pick<PortfolioImpactService, "setClock" | "recompute" | "impact">;
  /** Clears the map and the portfolio impact (the /live/reset path). */
  resetLive(): void;
  /** Default: loadDemoFixtures(). Called once, on the first step. */
  load?: () => Promise<DemoFixtures | undefined>;
  now?: () => number;
}

export class CbreDemo {
  private step_ = 0;
  private fixtures: Promise<DemoFixtures | undefined> | undefined;
  private clock: (() => number) | undefined;
  private now: () => number;

  constructor(private deps: CbreDemoDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** How many calls are in (0-3). */
  get step(): number {
    return this.step_;
  }

  /** The next call. Past the last: ok, done, nothing added. */
  next(): Promise<DemoOutcome> {
    return this.advance(1);
  }

  /** Every call not yet in, at once. */
  all(): Promise<DemoOutcome> {
    return this.advance(Infinity);
  }

  /** Clears the map like /live/reset, starts the script over and restores the real clock. */
  reset(): void {
    this.deps.resetLive();
    this.forget();
  }

  /** Every other reset (/live/reset, mock): the script starts over and the real clock is back. */
  forget(): void {
    this.step_ = 0;
    this.deps.portfolio.setClock(undefined);
  }

  private async advance(count: number): Promise<DemoOutcome> {
    const fixtures = await (this.fixtures ??= (this.deps.load ?? loadDemoFixtures)().catch(() => undefined));
    if (!fixtures) return { ok: false, status: 503, error: "the scripted demo is off: agent/fixtures/demoIncidents.ts (DEMO_INCIDENTS, DEMO_NOW) could not be loaded" };
    const of = fixtures.incidents.length;
    const pending = fixtures.incidents.slice(this.step_, this.step_ + Math.min(count, of));
    if (!pending.length) return { ok: true, step: this.step_, of, done: true, added: [], portfolioImpact: this.deps.portfolio.impact() ?? null };

    this.clock ??= () => fixtures.now;
    this.deps.portfolio.setClock(this.clock);
    const at = this.now();
    const added = pending.map((i) => this.deps.mapIncidents.inject(demoMapIncident(i, at)));
    this.step_ += pending.length;
    this.deps.portfolio.recompute(); // the rules result now, not after the debounce
    return { ok: true, step: this.step_, of, added: added.map((m) => ({ id: m.id, label: m.label })), portfolioImpact: this.deps.portfolio.impact() ?? null };
  }
}
