// Plugs Person C's impact agent (agent/core/impact/) into the server, in-process, the same way
// agent/bridge.ts plugs in processReport: loaded by relative path (no package dependency), and
// every call guarded. If the agent can't be loaded or lacks an export, the portfolio feature stays
// off; if a call throws, times out or returns something unusable, that one result is skipped.
// The agent exports (agent/index.ts, or the impact files directly):
//   assessIncidentRules(incidents, portfolio, opts?) -> IncidentImpactResult     sync, deterministic
//   assessIncident(incidents, portfolio, ctx?)       -> Promise<IncidentImpactResult>  Nemotron + rules fallback
//   fromMapIncident(mapIncident)                     -> AgentIncident | null
//   summarize(properties, horizon, doneIds, portfolio) -> ImpactSummary          optional
//   residualCost(building, chain, actions)           -> CostBreakdown           optional
//   formatUsd(usd)                                   -> "~$380K"                 optional
import type {
  AffectedProperty,
  AgentIncident,
  CostBreakdown,
  FailureStep,
  ImpactSummary,
  IncidentImpactResult,
  IncidentKind,
  PlannedAction,
  PortfolioBuilding,
} from "../../../agent/core/impact/types.ts";
import type { MapIncidentPlus } from "../incidents/stepZero.ts";

const AGENT_URL = new URL("../../../agent/index.ts", import.meta.url);
/** Tried when agent/index.ts fails to load (another part of the agent is broken) or lacks the exports. */
const IMPACT_URLS = {
  assess: new URL("../../../agent/core/impact/assess.ts", import.meta.url),
  fromMapIncident: new URL("../../../agent/core/impact/fromMapIncident.ts", import.meta.url),
  cost: new URL("../../../agent/core/impact/cost.ts", import.meta.url),
};

/** A map incident as the agent reads it: kind may be "flood" (Step 0). */
export type MapIncidentForAgent = Omit<MapIncidentPlus, "kind"> & { kind: IncidentKind };

export interface RulesOpts {
  now?: number;
  horizonMinutes?: number;
  doneActionIds?: string[];
}
export interface AssessCtx extends RulesOpts {
  timeoutMs?: number;
}

/** The agent functions the portfolio service calls. Tests pass fakes. */
export interface ImpactAgent {
  assessIncidentRules(incidents: AgentIncident[], portfolio: PortfolioBuilding[], opts?: RulesOpts): IncidentImpactResult;
  assessIncident?(incidents: AgentIncident[], portfolio: PortfolioBuilding[], ctx?: AssessCtx): Promise<IncidentImpactResult>;
  fromMapIncident(m: MapIncidentForAgent): AgentIncident | null;
  summarize?(properties: AffectedProperty[], horizonMinutes: number, doneActionIds?: string[], portfolio?: PortfolioBuilding[]): ImpactSummary;
  residualCost?(building: PortfolioBuilding, chain: FailureStep[], actions: PlannedAction[]): CostBreakdown;
  formatUsd?(usd: number): string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A usable IncidentImpactResult: the fields the service reads are there. */
export const isImpactResult = (v: unknown): v is IncidentImpactResult =>
  isObj(v) && isObj(v.impacts) && Array.isArray(v.affectedProperties) && isObj(v.summary) && typeof v.briefing === "string";

async function tryImport(url: URL): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(url.href)) as Record<string, unknown>;
  } catch (err) {
    console.error(`[portfolio] could not load ${url.pathname}: ${(err as Error).message}`);
    return undefined;
  }
}

const fnOf = <T>(mods: (Record<string, unknown> | undefined)[], name: string): T | undefined =>
  mods.map((m) => m?.[name]).find((f) => typeof f === "function") as T | undefined;

/** Builds an ImpactAgent from loaded modules, or undefined (with the missing names) when the core exports are absent. */
export function impactAgentFrom(mods: (Record<string, unknown> | undefined)[]): { agent?: ImpactAgent; missing: string[] } {
  const assessIncidentRules = fnOf<ImpactAgent["assessIncidentRules"]>(mods, "assessIncidentRules");
  const fromMapIncident = fnOf<ImpactAgent["fromMapIncident"]>(mods, "fromMapIncident");
  const missing = [!assessIncidentRules && "assessIncidentRules", !fromMapIncident && "fromMapIncident"].filter((x): x is string => !!x);
  if (!assessIncidentRules || !fromMapIncident) return { missing };
  return {
    missing,
    agent: {
      assessIncidentRules,
      fromMapIncident,
      assessIncident: fnOf(mods, "assessIncident"),
      summarize: fnOf(mods, "summarize"),
      residualCost: fnOf(mods, "residualCost"),
      formatUsd: fnOf(mods, "formatUsd"),
    },
  };
}

/**
 * Loads the impact agent. Returns undefined (and logs why, once) when it can't be loaded or
 * doesn't export assessIncidentRules + fromMapIncident yet; the portfolio feature then stays off.
 */
export async function loadImpactAgent(url: URL = AGENT_URL, fallbacks: URL[] = Object.values(IMPACT_URLS)): Promise<ImpactAgent | undefined> {
  const index = await tryImport(url);
  let { agent, missing } = impactAgentFrom([index]);
  if (!agent && fallbacks.length) ({ agent, missing } = impactAgentFrom([index, ...(await Promise.all(fallbacks.map(tryImport)))]));
  if (!agent) console.warn(`[portfolio] the agent does not export ${missing.join(", ")} yet; portfolio impact is off`);
  return agent;
}

/** Calls `fn`, logging and returning undefined if it throws. */
export function guarded<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    console.error(`[portfolio] ${what} failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** Awaits `work` for at most `timeoutMs`. Undefined (logged) on a throw, a timeout or an unusable result. */
export async function guardedAsync(what: string, work: () => Promise<unknown>, timeoutMs: number): Promise<IncidentImpactResult | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(work), timeout]);
    if (!isImpactResult(result)) throw new Error("returned something that is not an impact result");
    return result;
  } catch (err) {
    console.error(`[portfolio] ${what} failed: ${(err as Error).message}; keeping the rules result`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
