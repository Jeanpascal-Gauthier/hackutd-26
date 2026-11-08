// Person C's impact agent (agent/core/impact) as the server uses it: which portfolio buildings the
// incidents reach, what fails in what order, what it costs, and what to do about it.
// Loaded by relative path with no package dependency, like server/src/agent/bridge.ts, and loaded
// lazily: if the agent can't be loaded the server keeps running, just without the portfolio impact.
import type { AffectedProperty, BlastImpact, ImpactSummary, MapIncident, PortfolioBuilding, TrailStep } from "@firewatch/shared/types";

export interface ImpactOptions {
  /** Ids of the planned actions the operator has already executed. */
  doneActionIds: string[];
  /** Epoch ms "now", for day or night occupancy. */
  now: number;
  /** Forecast horizon in minutes. */
  horizonMinutes: number;
}

/** What one assessment returns (the agent's IncidentImpactResult, as the server reads it). */
export interface ImpactComputation {
  /** Blast radius per incident id. */
  impacts: Record<string, BlastImpact>;
  /** Highest cost first. */
  affectedProperties: AffectedProperty[];
  summary: ImpactSummary;
  trail: TrailStep[];
  mode: "llm" | "rules";
  briefing: string;
}

export interface ImpactEngine {
  /** Loads the agent once. Rejects when it can't be loaded. */
  load(): Promise<void>;
  /** Deterministic, instant. Throws if `load()` has not resolved. */
  rules(incidents: MapIncident[], portfolio: PortfolioBuilding[], opts: ImpactOptions): ImpactComputation;
  /** Nemotron runs the tools; falls back to the rules inside the agent. Absent when there is no API key. */
  llm?(incidents: MapIncident[], portfolio: PortfolioBuilding[], opts: ImpactOptions): Promise<ImpactComputation>;
}

type Dict = Record<string, unknown>;
const ASSESS_URL = new URL("../../../agent/core/impact/assess.ts", import.meta.url);
const CONVERT_URL = new URL("../../../agent/core/impact/fromMapIncident.ts", import.meta.url);

// ---- Road names ----
// A building's access road and an incident's red road must be spelled alike for the agent to see
// that one blocks the other, and OSM writes "W Campbell Rd" where a lease record says "West Campbell
// Road". Both are rewritten to the portfolio's spelling, on the copy the agent reads.
const ABBREVIATIONS: Record<string, string> = { rd: "road", st: "street", ave: "avenue", blvd: "boulevard", expy: "expressway", dr: "drive", pkwy: "parkway", ln: "lane", hwy: "highway", fwy: "freeway" };
const DIRECTIONS = new Set(["n", "s", "e", "w", "north", "south", "east", "west", "ne", "nw", "se", "sw"]);
const TYPES = new Set(["road", "street", "avenue", "boulevard", "expressway", "drive", "parkway", "lane", "highway", "freeway", "way", "court", "circle"]);

/** "W Campbell Rd" and "West Campbell Road" both give "campbell". */
export function roadKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word);
  const core = words.filter((word, i) => !(DIRECTIONS.has(word) && words.length > 1 && (i === 0 || i === words.length - 1)) && !(TYPES.has(word) && i === words.length - 1 && words.length > 1));
  return core.join(" ");
}

function portfolioRoads(portfolio: PortfolioBuilding[]): Map<string, string> {
  const spelling = new Map<string, string>();
  for (const building of portfolio) for (const road of [...building.access.roads, ...(building.access.fuelRoute ? [building.access.fuelRoute] : [])]) spelling.set(roadKey(road), road);
  return spelling;
}

/** The incident with each road name spelled as the portfolio spells it. Names the portfolio doesn't use stay as they are. */
function alignRoads(incident: Dict, spelling: Map<string, string>): Dict {
  const fix = (name: unknown) => (typeof name === "string" ? (spelling.get(roadKey(name)) ?? name) : name);
  const copy: Dict = { ...incident };
  if (Array.isArray(copy.affectedRoads)) copy.affectedRoads = (copy.affectedRoads as Dict[]).map((road) => ({ ...road, road: fix(road.road) }));
  const crash = copy.crash as Dict | undefined;
  if (crash) {
    copy.crash = {
      ...crash,
      road: fix(crash.road),
      segments: ((crash.segments as Dict[] | undefined) ?? []).map((segment) => ({ ...segment, road: fix(segment.road) })),
      steps: ((crash.steps as Dict[] | undefined) ?? []).map((step) => ({ ...step, roads: ((step.roads as unknown[] | undefined) ?? []).map(fix) })),
      alternateRoads: ((crash.alternateRoads as unknown[] | undefined) ?? []).map(fix),
    };
  }
  return copy;
}

/** The agent as an engine. `llm` is on when NVIDIA_API_KEY is set. */
export function agentImpactEngine(env: NodeJS.ProcessEnv = process.env): ImpactEngine {
  let assess: Dict | undefined;
  let convert: Dict | undefined;

  const prepare = (incidents: MapIncident[], portfolio: PortfolioBuilding[]) => {
    const spelling = portfolioRoads(portfolio);
    const toAgent = convert!.fromMapIncidents as (list: unknown[]) => Dict[];
    return toAgent(incidents).map((incident) => alignRoads(incident, spelling));
  };
  const call = (name: "assessIncidentRules" | "assessIncident") => (incidents: MapIncident[], portfolio: PortfolioBuilding[], opts: ImpactOptions) =>
    (assess![name] as (i: unknown, p: unknown, o: unknown) => unknown)(prepare(incidents, portfolio), portfolio, opts);

  const engine: ImpactEngine = {
    async load() {
      if (assess && convert) return;
      assess = (await import(ASSESS_URL.href)) as Dict;
      convert = (await import(CONVERT_URL.href)) as Dict;
      for (const [mod, names] of [[assess, ["assessIncidentRules", "assessIncident"]], [convert, ["fromMapIncidents"]]] as const)
        for (const name of names) if (typeof mod[name] !== "function") throw new Error(`agent impact module does not export ${name}()`);
    },
    rules(incidents, portfolio, opts) {
      if (!assess || !convert) throw new Error("impact agent is not loaded");
      return call("assessIncidentRules")(incidents, portfolio, opts) as ImpactComputation;
    },
  };
  if (env.NVIDIA_API_KEY) {
    engine.llm = async (incidents, portfolio, opts) => {
      if (!assess || !convert) throw new Error("impact agent is not loaded");
      return (await call("assessIncident")(incidents, portfolio, opts)) as ImpactComputation;
    };
  }
  return engine;
}
