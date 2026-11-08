// classify_blast_radius: one incident -> how far its effects reach (a circle, stretched downwind
// for fire smoke), with plain-language reasons for the operator. Deterministic and rule-based.
// Run first, once per incident: assess_property_impact reads run.impacts to find hit buildings.
//
// MODELED ASSUMPTIONS (tuned for sense, not measured):
//   base radius (m)   minor  serious  critical   ("unknown" severity = serious)
//   fire               150     300      450
//   crash               50     100      150
//   flood              200     350      500
//   other              100     100      100      (pin-sized)
//   fire:  building involved ×1.33; explosion/propane/chemical ×1.5;
//          wind > 2 m/s stretches it downwind by 1 + speed/10 (capped at 2.5).
//   crash: fuel/tanker/hazmat/gas ×2; the modeled traffic queue can grow it to queue/2.
//   flood: the modeled water polygon's farthest point at the last step, when larger.
import type OpenAI from "openai";
import type { IncidentSeverity } from "@firewatch/shared/types";
import { distanceMeters, downwindOf } from "./geo.ts";
import type { AgentIncident, BlastImpact, ClassifyBlastRadius, ImpactTool } from "./types.ts";

type Severity = Exclude<IncidentSeverity, "unknown">;

/** Base radius in metres by kind × severity. */
export const BASE_RADIUS_METERS: Record<AgentIncident["kind"], Record<Severity, number>> = {
  fire: { minor: 150, serious: 300, critical: 450 },
  crash: { minor: 50, serious: 100, critical: 150 },
  flood: { minor: 200, serious: 350, critical: 500 },
  other: { minor: 100, serious: 100, critical: 100 },
};

export const IN_BUILDING_FACTOR = 1.33;
export const FIRE_KEYWORD_FACTOR = 1.5;
export const HAZMAT_FACTOR = 2;
/** Wind at or below this (m/s) leaves the zone an even circle. */
export const CALM_WIND_MPS = 2;
export const MAX_STRETCH = 2.5;
const MPS_TO_MPH = 2.237;

const FIRE_KEYWORDS = /\b(explosions?|exploded|propane|chemicals?)\b/i;
// "gas" alone would match "gas station": only a spill, leak or tanker counts.
const HAZMAT_KEYWORDS = /\b(fuel|tankers?|hazmat|gasoline|gas (?:leak|spill|tanker|truck))\b/i;
const WATER_MAIN = /water main|burst/i;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Compass degrees -> 8-point word: 0 -> "N", 225 -> "SW". */
export function compassWord(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS[Math.round(d / 45) % 8]!;
}

const round10 = (m: number) => Math.round(m / 10) * 10;

/** Fire: building, keyword and wind modifiers. Mutates `reasons`; returns radius and stretch. */
function fireModifiers(incident: AgentIncident, radius: number, reasons: string[]): Pick<BlastImpact, "radiusMeters" | "stretch"> {
  if (incident.inBuilding) {
    radius *= IN_BUILDING_FACTOR;
    reasons.push("building involved → larger zone");
  }
  const keyword = incident.description?.match(FIRE_KEYWORDS)?.[0];
  if (keyword) {
    radius *= FIRE_KEYWORD_FACTOR;
    reasons.push(`"${keyword.toLowerCase()}" reported → ×${FIRE_KEYWORD_FACTOR} zone`);
  }
  const wind = incident.wind ?? incident.fire?.wind ?? null;
  if (!wind) {
    reasons.push("wind unknown → even circle");
    return { radiusMeters: radius };
  }
  const mph = Math.round(wind.speedMps * MPS_TO_MPH);
  if (wind.speedMps <= CALM_WIND_MPS) {
    reasons.push(`light wind (${mph} mph) → even circle`);
    return { radiusMeters: radius };
  }
  const towardDegrees = downwindOf(wind.fromDegrees);
  const factor = Math.round(Math.min(MAX_STRETCH, 1 + wind.speedMps / 10) * 100) / 100;
  reasons.push(`${mph} mph wind from the ${compassWord(wind.fromDegrees)} → stretched downwind to the ${compassWord(towardDegrees)}`);
  return { radiusMeters: radius, stretch: { towardDegrees, factor } };
}

/** Crash: hazmat keyword, blocked lanes and the modeled queue. */
function crashModifiers(incident: AgentIncident, radius: number, reasons: string[]): number {
  const keyword = incident.description?.match(HAZMAT_KEYWORDS)?.[0];
  if (keyword) {
    radius *= HAZMAT_FACTOR;
    reasons.push(`"${keyword.toLowerCase()}" reported → possible spill, ×${HAZMAT_FACTOR} zone`);
  }
  if (incident.lanesBlocked === "all") reasons.push("all lanes blocked → road access cut");
  else if (incident.lanesBlocked === "some") reasons.push("some lanes blocked → slow access");
  const steps = incident.crash?.steps ?? [];
  if (steps.length) {
    const queue = Math.max(...steps.map((s) => s.queueMeters));
    const road = incident.crash?.road ? ` on ${incident.crash.road}` : "";
    if (queue / 2 > radius) {
      radius = queue / 2;
      reasons.push(`modeled traffic queue reaches ${Math.round(queue)} m${road} → zone grows to cover it`);
    } else if (queue > 0) {
      reasons.push(`modeled traffic queue ${Math.round(queue)} m${road}`);
    }
  }
  return radius;
}

/** Flood: water main keyword and the modeled water polygon. */
function floodModifiers(incident: AgentIncident, radius: number, reasons: string[]): number {
  if (WATER_MAIN.test(`${incident.source ?? ""} ${incident.description ?? ""}`)) {
    reasons.push("water main burst: steady flow until valve shut");
  }
  const last = incident.flood?.steps.at(-1);
  if (last?.water.length) {
    const reach = Math.max(...last.water.map((p) => distanceMeters(incident.location, p)));
    if (reach > radius) {
      radius = reach;
      reasons.push(`modeled water reaches ${round10(reach)} m by minute ${last.minute}`);
    }
  }
  return radius;
}

/** How far one incident's effects reach. Same input -> same output. */
export const classifyBlastRadius: ClassifyBlastRadius = (incident) => {
  const reasons: string[] = [];
  const severity: Severity = incident.severity === "unknown" ? "serious" : incident.severity;
  const base = BASE_RADIUS_METERS[incident.kind]?.[severity] ?? BASE_RADIUS_METERS.other[severity];
  reasons.push(incident.kind === "other" ? "other incident → pin-sized zone" : `${severity} ${incident.kind}`);
  if (incident.severity === "unknown") reasons.push("severity unknown → treated as serious");

  let radius = base;
  let stretch: BlastImpact["stretch"];
  if (incident.kind === "fire") ({ radiusMeters: radius, stretch } = fireModifiers(incident, radius, reasons));
  else if (incident.kind === "crash") radius = crashModifiers(incident, radius, reasons);
  else if (incident.kind === "flood") radius = floodModifiers(incident, radius, reasons);

  return {
    center: incident.location,
    radiusMeters: round10(radius),
    ...(stretch ? { stretch } : {}),
    reasons,
  };
};

/** Farthest the zone reaches in any direction (straight downwind when stretched). */
export function maxReachMeters(impact: BlastImpact): number {
  return Math.round(impact.radiusMeters * Math.max(1, impact.stretch?.factor ?? 1));
}

export interface BlastSummary {
  incidentId: string;
  kind: AgentIncident["kind"];
  radiusMeters: number;
  /** Compass word the zone is stretched toward, when wind stretches it. */
  stretchedToward?: string;
  maxReachMeters: number;
  reasons: string[];
}

export const classifyBlastRadiusSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "classify_blast_radius",
    description:
      "Call this FIRST, once per incident, before assess_property_impact. Works out how far one incident's " +
      "effects reach: a radius in metres (stretched downwind for fire smoke) and plain-language reasons " +
      "(severity, building involved, wind, blocked lanes, modeled flood water). Returns the radius, the " +
      "farthest reach and the reasons; the full zone is stored for the other tools.",
    parameters: {
      type: "object",
      properties: {
        incident_id: { type: "string", description: "Id of the incident to classify, from the incident list." },
      },
      required: ["incident_id"],
    },
  },
};

/** The classify_blast_radius tool: stores the zone in run.impacts[id] and returns a summary. */
export const classifyBlastRadiusTool: ImpactTool = {
  schema: classifyBlastRadiusSchema,
  run(args, run) {
    const raw = args.incident_id;
    const ids = run.incidents.map((i) => i.id);
    if (typeof raw !== "string" || !raw.trim()) {
      return { error: `incident_id must be a non-empty string, one of: ${ids.join(", ")}` };
    }
    const id = raw.trim();
    const incident = run.incidents.find((i) => i.id === id);
    if (!incident) return { error: `unknown incident id "${id}": use one of ${ids.join(", ")}` };

    const impact = classifyBlastRadius(incident);
    run.impacts[id] = impact;
    const summary: BlastSummary = {
      incidentId: id,
      kind: incident.kind,
      radiusMeters: impact.radiusMeters,
      ...(impact.stretch ? { stretchedToward: compassWord(impact.stretch.towardDegrees) } : {}),
      maxReachMeters: maxReachMeters(impact),
      reasons: impact.reasons,
    };
    return summary;
  },
};
