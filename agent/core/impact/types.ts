// The contract for Person C's CBRE "Invisible Network" work: which buildings an emergency hits,
// which of their systems fail in what order, what that costs, and what to do about it.
// Types only. Every file in agent/core/impact/ builds against this one.
//
// MIRROR TYPES: the "Step 0" fields planned for shared/types.ts (flood, impact, zoneId, related,
// affectedRoads, affectedProperties) have not landed yet. They are mirrored here so the agent can
// be built now. When Step 0 merges, import them from @firewatch/shared/types and delete the mirror.
import type OpenAI from "openai";
import type {
  CrashForecast,
  FireForecast,
  GeoPoint,
  IncidentSeverity,
  LanesBlocked,
  MapIncidentKind,
  TrailStep,
  WindReading,
} from "@firewatch/shared/types";

// =================================================================================================
// Mirror of the planned shared/types.ts additions (Step 0)
// =================================================================================================

/** MapIncidentKind plus "flood" (Step 0). */
export type IncidentKind = MapIncidentKind | "flood";

/** How far an incident's effects reach, and why. Step 0 field `MapIncident.impact`. */
export interface BlastImpact {
  /** Where the radius is measured from (the incident location). */
  center: GeoPoint;
  /** Base radius in metres (the circle the console draws). */
  radiusMeters: number;
  /**
   * Set when wind (or water flow) stretches the zone. The zone then reaches `radiusMeters * factor`
   * in the `towardDegrees` direction (compass degrees the hazard moves TOWARD).
   */
  stretch?: { towardDegrees: number; factor: number };
  /** Plain-language reasons, shown to operators: ["critical fire", "building involved", "15 mph wind → stretched downwind"]. */
  reasons: string[];
}

/** One red road section. Step 0 field `MapIncident.affectedRoads`. */
export interface AffectedRoad {
  path: GeoPoint[];
  road: string | null;
  reason: "crash" | "flood" | "closure";
  /** Forecast minute the section turns red. */
  fromMinute: number;
}

/** Modeled flood spread (Person B's server builds it). Minutes count from the forecast's start. */
export interface FloodForecast {
  /** Ascending by minute. Polygons are closed rings without the first point repeated. */
  steps: { minute: number; water: GeoPoint[] }[];
  summary?: string;
  assumptions?: string[];
}

/** One link in a building's failure chain, in time order. */
export interface FailureStep {
  /** Unique within the property, e.g. "dc-1:hvac". */
  id: string;
  /** Forecast minute it happens (0 = now). May exceed the horizon for slow effects like fuel running out. */
  minute: number;
  /** The PortfolioSystem.id that fails, or "building" for whole-building effects (evacuation). */
  systemId: string;
  /** Short display text: "Smoke reaches HVAC intake". */
  label: string;
  /** The hazard behind it. */
  hazard: "fire" | "smoke" | "water" | "access" | "power" | "heat";
  /** The step this one follows from (null for the first contact with the hazard). */
  causedBy: string | null;
  /** The incident that starts this chain. */
  incidentId: string;
}

/** One concrete step for a facility manager. */
export interface PlannedAction {
  /** Unique within the property, e.g. "dc-1:close-dampers". */
  id: string;
  /** Imperative: "Close outside-air dampers". */
  text: string;
  /** Do it before this forecast minute. 0 = now. */
  deadlineMinute: number;
  /** FailureStep ids this action stops (each stops its downstream steps too). */
  prevents: string[];
  /** USD this action saves on its own: total cost - cost with `prevents` stopped. */
  savesUsd: number;
  /** Why this works, one line, for trust: "Keeps smoke out of the air handlers". */
  reason: string;
  /** The console flips this when the operator presses Execute. */
  status: "pending" | "done";
}

/** USD at risk for one property, from impact/cost.ts. */
export interface CostBreakdown {
  slaUsd: number;
  lostRentUsd: number;
  damageUsd: number;
  totalUsd: number;
}

/** One building hit by an incident. Step 0 field `MapIncident.affectedProperties[]`. */
export interface AffectedProperty {
  /** PortfolioBuilding.id */
  id: string;
  name: string;
  use: PortfolioUse;
  location: GeoPoint;
  risk: "high" | "moderate" | "low";
  /** Every incident that touches this building (linked incidents compound). */
  incidentIds: string[];
  /** Time ordered. */
  chain: FailureStep[];
  /** People in the building now (time-of-day occupancy) who are affected. */
  people: number;
  /** Estimated downtime if nothing is done. */
  downtimeHours: number;
  cost: CostBreakdown;
  /** True when every access road is blocked (crash or flood). */
  accessCut: boolean;
  /** Ordered by deadline. Filled by plan_actions; [] until then. */
  actions: PlannedAction[];
  /** Plain-language reasons for the risk level. */
  reasons: string[];
}

// =================================================================================================
// Input: the building portfolio (agent-owned fixture until Person B ships theirs)
// =================================================================================================

export type PortfolioUse = "data_center" | "hospital" | "office" | "retail" | "residential" | "industrial";

export type SystemKind =
  | "utility_power"
  | "electrical_room"
  | "generator"
  | "fuel_supply"
  | "ups"
  | "hvac" // air handlers; pull outside air through `air_intake`
  | "air_intake"
  | "cooling" // chillers / CRAC units
  | "servers"
  | "life_safety" // fire alarm, sprinklers, emergency lighting
  | "elevators"
  | "water"
  | "access_control"
  | "medical_gas"
  | "refrigeration";

/** One building system and what it depends on. The dependency list IS the dependency graph. */
export interface PortfolioSystem {
  /** Unique within the building, e.g. "hvac". */
  id: string;
  kind: SystemKind;
  label: string;
  /** System ids this one needs. If any of them fails (and no backup covers it), this one fails too. */
  dependsOn: string[];
  /**
   * Alternatives: this system keeps running if ANY of these is up, even when a `dependsOn` entry
   * has failed. e.g. servers dependsOn ["cooling","ups"], electrical_room backups ["generator"].
   */
  backups?: string[];
  /** Where it sits. Basement systems flood first; roof/ground air intakes take smoke. */
  level: "basement" | "ground" | "roof";
  /** Which side of the building it faces, compass degrees (air intakes, loading docks). Optional. */
  facingDegrees?: number;
  /** Minutes between its dependency failing and it failing (thermal mass, UPS battery). Default 0. */
  lagMinutes?: number;
  /** Generators: hours of fuel on site. */
  runtimeHours?: number;
  /** Hours to restore it once it has failed. */
  restoreHours: number;
  /** Physical damage if it fails (water in switchgear, smoke in servers). 0 if it only stops. */
  damageUsd: number;
}

export interface PortfolioTenant {
  name: string;
  /** Contractual penalty per hour of downtime. 0 when the lease has no SLA. */
  slaPenaltyPerHour: number;
  rentPerMonth: number;
  /** The systems this tenant needs. The tenant is down while any of them is down. */
  dependsOn: string[];
}

export interface PortfolioBuilding {
  id: string;
  name: string;
  address: string;
  use: PortfolioUse;
  location: GeoPoint;
  /** Metres above sea level at grade. Lower ground floods first. */
  elevationM: number;
  /** People inside by time of day. */
  occupancy: { day: number; night: number };
  systems: PortfolioSystem[];
  tenants: PortfolioTenant[];
  access: {
    /** Road names the building is reached by. All blocked = access cut. */
    roads: string[];
    /** The road the generator's fuel truck uses. */
    fuelRoute?: string;
  };
}

// =================================================================================================
// Input: the incidents (a lean view of MapIncident plus the Step 0 fields)
// =================================================================================================

export interface AgentIncident {
  id: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  location: GeoPoint;
  description?: string;
  /** Fires: inside a building. */
  inBuilding?: boolean;
  /** Crashes. */
  lanesBlocked?: LanesBlocked;
  /** Floods: e.g. "water main burst". */
  source?: string;
  /** Null when weather was unavailable. */
  wind?: WindReading | null;
  fire?: FireForecast;
  crash?: CrashForecast;
  flood?: FloodForecast;
  /** Red road sections from the server (crash queue, flooded roads). */
  affectedRoads?: AffectedRoad[];
  /** Step 0: ids of linked (nearby, different type) incidents. */
  related?: string[];
  zoneId?: string;
  /** Number of calls merged into this incident. */
  calls?: number;
  /** Epoch ms of the first report. */
  time?: number;
}

// =================================================================================================
// The three tools as plain functions (deterministic; same input -> same output)
// =================================================================================================

/** classify_blast_radius: impact/blastRadius.ts */
export type ClassifyBlastRadius = (incident: AgentIncident) => BlastImpact;

export interface AssessOptions {
  /** Forecast horizon in minutes. Steps after it still appear (fuel running out), but only if caused within it. Default 30. */
  horizonMinutes?: number;
  /** Epoch ms "now", for day/night occupancy. Default Date.now(). */
  now?: number;
  /** Blast impact per incident id, from classify_blast_radius. Computed if missing. */
  impacts?: Record<string, BlastImpact>;
}

/**
 * assess_property_impact: impact/propertyImpact.ts
 * Every portfolio building any incident reaches, highest cost first, with `actions: []`.
 */
export type AssessPropertyImpact = (
  incidents: AgentIncident[],
  portfolio: PortfolioBuilding[],
  opts?: AssessOptions,
) => AffectedProperty[];

/** plan_actions: impact/planActions.ts. Ordered by deadline, then savings. */
export type PlanActions = (property: AffectedProperty, building: PortfolioBuilding, incidents: AgentIncident[]) => PlannedAction[];

// =================================================================================================
// The orchestrator's result (impact/assess.ts)
// =================================================================================================

export interface ImpactSummary {
  buildings: number;
  people: number;
  usdAtRisk: number;
  /** usdAtRisk minus what the done actions save. */
  usdAtRiskAfterActions: number;
  horizonMinutes: number;
  /** "6 buildings · 1,240 people · ~$380K at risk in the next 30 min" */
  headline: string;
}

export interface IncidentImpactResult {
  /** Per incident id. */
  impacts: Record<string, BlastImpact>;
  /** Highest cost first, each with its actions. */
  affectedProperties: AffectedProperty[];
  summary: ImpactSummary;
  /** Agent tool calls, oldest first, for the console's agent trail. */
  trail: TrailStep[];
  /** "llm": Nemotron ran the tools. "rules": the deterministic fallback did (no key, timeout, bad output). */
  mode: "llm" | "rules";
  /** One-paragraph briefing for the operator (model-written when mode is llm, templated otherwise). */
  briefing: string;
}

// =================================================================================================
// Nemotron tool wrappers (same pattern as agent/core/tools/types.ts, own scratchpad)
// =================================================================================================

/** Scratchpad for one assessIncident() run. Tools read and write it so big data never passes through the model. */
export interface ImpactRun {
  incidents: AgentIncident[];
  portfolio: PortfolioBuilding[];
  opts: Required<Pick<AssessOptions, "horizonMinutes" | "now">>;
  /** Set by classify_blast_radius, per incident id. */
  impacts: Record<string, BlastImpact>;
  /** Set by assess_property_impact. */
  properties?: AffectedProperty[];
  /** Set by plan_actions: property id -> actions. */
  actions: Record<string, PlannedAction[]>;
}

export interface ImpactTool {
  /** OpenAI-format function schema sent to Nemotron. */
  schema: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  /** Validate `args` (unchecked model JSON). Return a SMALL JSON summary for the model; write full data to `run`. */
  run(args: Record<string, unknown>, run: ImpactRun): unknown;
}
