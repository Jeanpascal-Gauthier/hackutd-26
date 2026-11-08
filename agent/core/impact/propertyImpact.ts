// assess_property_impact: incidents + the building portfolio -> every building an incident reaches,
// with its failure chain (which system fails when, and what it knocks out next), the people inside,
// the dollars at risk (cost.ts) and plain-language reasons. Deterministic and rule-based.
//
// HOW (modeled assumptions, tuned for sense, not measured):
//   touched   inside the incident's blast zone, a hazard reaches it, or one of its roads is red.
//   smoke     the fire forecast's exposure ETA for the building, else the first smoke polygon that
//             holds it; with no forecast, distance / (1.5 + 0.8 x wind x cos(off-axis)) m/s downwind
//             inside the zone, 2 min within 150 m, none upwind beyond that. Hits air intakes
//             (3 min later when they face away), else air handlers.
//   fire      exposure ETA or fire polygon; no forecast: within 100 m at 10 m/min. Hits ground-level
//             systems facing the fire and evacuates the building.
//   water     the first flood polygon that holds it; no forecast: 30 m/min inside the zone, faster on
//             lower ground. Basement systems flood on contact; ground-level ones 10 min later, and
//             only for critical floods.
//   access    a crash (all lanes, or a "blocked" segment), flood or closure on a road it uses. The
//             fuel route blocked cuts fuel_supply; a generator then runs dry runtimeHours after it starts.
//   chain     a system fails at (first failed dependency, or its last backup failing if later) + lag.
//             causedBy is that dependency's step. Smoke drawn into an occupied building's air
//             handlers (not a data center's) evacuates it 2 min later.
//   people    occupancy now (8 am-6 pm Central = day). Low-risk buildings count a quarter of it:
//             they are only near the incident, not in its path.
import type OpenAI from "openai";
import type { GeoPoint } from "@firewatch/shared/types";
import { classifyBlastRadius } from "./blastRadius.ts";
import { estimateCost } from "./cost.ts";
import { angleBetween, bearingDegrees, distanceMeters, downwindOf, insideImpact, insidePolygon } from "./geo.ts";
import type {
  AffectedProperty,
  AgentIncident,
  AssessPropertyImpact,
  BlastImpact,
  FailureStep,
  ImpactTool,
  PortfolioBuilding,
  PortfolioSystem,
  SystemKind,
} from "./types.ts";

export const DEFAULT_HORIZON_MINUTES = 30;
export const SMOKE_BASE_MPS = 1.5;
export const SMOKE_WIND_FACTOR = 0.8;
/** Smoke reaches anything this close to a fire, in any wind. */
export const NEAR_SMOKE_METERS = 150;
export const SMOKE_START_MINUTES = 2;
/** Intakes facing away from the fire take smoke this much later. */
export const FACING_AWAY_MINUTES = 3;
export const FIRE_REACH_METERS = 100;
export const FIRE_SPREAD_M_PER_MIN = 10;
export const WATER_M_PER_MIN = 30;
/** Critical floods reach ground-level systems this long after the water arrives. */
export const GROUND_FLOOD_LAG_MINUTES = 10;
export const EVACUATE_LAG_MINUTES = 2;
/** Share of occupants counted for a low-risk building (near the incident, nothing failing). */
export const LOW_RISK_PEOPLE_SHARE = 0.25;
/** An exposure within this distance of a building is that building. */
export const EXPOSURE_MATCH_METERS = 60;
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 18;
export const TIME_ZONE = "America/Chicago";
/** Above this a building is high risk on cost alone. */
export const HIGH_RISK_USD = 100_000;

type Hazard = FailureStep["hazard"];
const POWER_KINDS = new Set<SystemKind>(["utility_power", "electrical_room", "generator", "ups"]);
const rad = (d: number) => (d * Math.PI) / 180;
/** "Electrical room" -> "electrical room"; acronyms ("UPS battery room") stay. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const usdK = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`);

// ---- Roads ----

const SUFFIX: Record<string, string> = {
  road: "rd", rd: "rd", drive: "dr", dr: "dr", street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave",
  boulevard: "blvd", blvd: "blvd", parkway: "pkwy", pkwy: "pkwy", lane: "ln", ln: "ln", highway: "hwy", hwy: "hwy",
  freeway: "fwy", fwy: "fwy", expressway: "expy", expy: "expy", way: "way", court: "ct", ct: "ct", circle: "cir", cir: "cir",
};
const DIRECTIONS = new Set(["n", "s", "e", "w", "north", "south", "east", "west"]);

function roadKey(name: string): { core: string; suffix?: string } {
  const words = name.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length > 1 && DIRECTIONS.has(words[0]!)) words.shift();
  const last = words.at(-1);
  const suffix = words.length > 1 && last && SUFFIX[last] ? SUFFIX[last] : undefined;
  if (suffix) words.pop();
  return { core: words.join(" "), ...(suffix ? { suffix } : {}) };
}

/** "Coit Rd" = "coit road" = "N Coit Rd" = "Coit". "Campbell Rd" != "Campbell Ave". */
export function sameRoad(a: string, b: string): boolean {
  const x = roadKey(a);
  const y = roadKey(b);
  return x.core !== "" && x.core === y.core && (!x.suffix || !y.suffix || x.suffix === y.suffix);
}

interface RoadEvent {
  road: string;
  minute: number;
  /** False: traffic is slowed (some lanes, a queue), not stopped. */
  blocked: boolean;
}

/** Every named road an incident blocks or slows within the horizon. */
function roadEvents(inc: AgentIncident, horizon: number): RoadEvent[] {
  const out: RoadEvent[] = [];
  const allLanes = inc.lanesBlocked === "all";
  for (const r of inc.affectedRoads ?? []) {
    if (r.road) out.push({ road: r.road, minute: r.fromMinute, blocked: r.reason !== "crash" || allLanes });
  }
  for (const s of inc.crash?.segments ?? []) {
    if (s.road) out.push({ road: s.road, minute: s.queueMinute, blocked: s.level === "blocked" });
  }
  if (inc.kind === "crash" && inc.crash?.road) out.push({ road: inc.crash.road, minute: 0, blocked: allLanes });
  return out.filter((e) => e.minute <= horizon).map((e) => ({ ...e, minute: Math.max(0, e.minute) }));
}

// ---- Incident naming, for reasons ----

const PLACE = /\b(?:on|along|at|near)\s+((?:[NSEW]\.?\s+)?[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*)*?\s+(?:Rd|Road|Dr|Drive|St|Street|Ave|Avenue|Blvd|Boulevard|Pkwy|Parkway|Ln|Lane|Hwy|Highway|Way|Fwy|Expy))\b/;

/** "Campbell Rd fire", "Coit Rd crash", "Lookout Dr water main burst", or just "fire". */
export function incidentName(inc: AgentIncident): string {
  const place = inc.description?.match(PLACE)?.[1] ?? inc.crash?.road ?? inc.affectedRoads?.find((r) => r.road)?.road ?? undefined;
  const noun = inc.kind === "flood" ? (inc.source?.trim() || "flood") : inc.kind === "other" ? "incident" : inc.kind;
  return place ? `${place} ${noun}` : noun;
}

const blockWord = (inc: AgentIncident) => (inc.kind === "crash" ? "crash" : inc.kind === "flood" ? "flooding" : inc.kind === "fire" ? "the fire" : "a closure");

// ---- Hazard arrival ----

function matchExposure(inc: AgentIncident, b: PortfolioBuilding) {
  return inc.fire?.exposures?.find(
    (e) => distanceMeters(e.location, b.location) <= EXPOSURE_MATCH_METERS || (!!e.name && e.name.toLowerCase() === b.name.toLowerCase()),
  );
}

/** First forecast step whose polygon holds `p`. */
function firstStep<T extends { minute: number }>(steps: T[], ring: (s: T) => GeoPoint[], p: GeoPoint): number | undefined {
  return steps.find((s) => ring(s).length >= 3 && insidePolygon(p, ring(s)))?.minute;
}

function smokeEta(inc: AgentIncident, b: PortfolioBuilding, impact: BlastImpact): number | undefined {
  if (inc.kind !== "fire") return undefined;
  const exposure = matchExposure(inc, b);
  if (exposure) return exposure.smokeEtaMinutes ?? undefined;
  const steps = inc.fire?.steps ?? [];
  if (steps.length) return firstStep(steps, (s) => s.smoke, b.location);
  const d = distanceMeters(inc.location, b.location);
  if (d <= NEAR_SMOKE_METERS) return SMOKE_START_MINUTES;
  if (!insideImpact(impact, b.location)) return undefined;
  const wind = inc.wind ?? inc.fire?.wind ?? null;
  let mps = SMOKE_BASE_MPS;
  if (wind && wind.speedMps > 0.5) {
    const off = angleBetween(bearingDegrees(inc.location, b.location), downwindOf(wind.fromDegrees));
    if (off >= 90) return undefined;
    mps += SMOKE_WIND_FACTOR * wind.speedMps * Math.cos(rad(off));
  }
  return SMOKE_START_MINUTES + d / mps / 60;
}

function fireEta(inc: AgentIncident, b: PortfolioBuilding): number | undefined {
  if (inc.kind !== "fire") return undefined;
  const exposure = matchExposure(inc, b);
  if (exposure) return exposure.origin ? 0 : exposure.fireEtaMinutes;
  const steps = inc.fire?.steps ?? [];
  if (steps.length) return firstStep(steps, (s) => s.fire, b.location);
  const d = distanceMeters(inc.location, b.location);
  return d <= FIRE_REACH_METERS ? d / FIRE_SPREAD_M_PER_MIN : undefined;
}

function waterEta(inc: AgentIncident, b: PortfolioBuilding, impact: BlastImpact, meanElevation: number): number | undefined {
  if (inc.kind !== "flood") return undefined;
  const steps = inc.flood?.steps ?? [];
  if (steps.length) return firstStep(steps, (s) => s.water, b.location);
  if (!insideImpact(impact, b.location)) return undefined;
  // Each metre below the portfolio's average ground speeds the water up 10% (x0.5 to x2).
  const factor = Math.min(2, Math.max(0.5, 1 + 0.1 * (meanElevation - b.elevationM)));
  return distanceMeters(inc.location, b.location) / (WATER_M_PER_MIN * factor);
}

// ---- Day / night ----

/** True between 8 am and 6 pm Central. */
export function isDaytime(now: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(now))
      .find((p) => p.type === "hour")?.value,
  );
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

// ---- The failure chain ----

interface Fail {
  minute: number;
  hazard: Hazard;
  label: string;
  incidentId: string;
  /** systemId (or "building") of the step this follows from. */
  cause: string | null;
}

interface DirectHit extends Fail {
  cause: null;
}

/** Keep the earlier of two hits on the same system. */
function hit(map: Map<string, Fail>, systemId: string, f: Fail): void {
  const cur = map.get(systemId);
  if (!cur || f.minute < cur.minute) map.set(systemId, f);
}

function propagatedHazard(s: PortfolioSystem, causeSys: PortfolioSystem | undefined, cause: Fail): Hazard {
  if (s.kind === "servers" || s.kind === "refrigeration") return "heat";
  if (s.kind === "generator" && causeSys?.kind === "fuel_supply") return "access";
  if ((cause.hazard === "smoke" || cause.hazard === "fire") && ["hvac", "cooling", "air_intake"].includes(s.kind)) return "smoke";
  if (causeSys && POWER_KINDS.has(causeSys.kind)) return "power";
  return cause.hazard;
}

function propagatedLabel(s: PortfolioSystem, hazard: Hazard, b: PortfolioBuilding): string {
  switch (s.kind) {
    case "hvac":
      return hazard === "smoke" ? "HVAC pulls smoke inside" : `${s.label} stop: no power`;
    case "cooling":
      return hazard === "smoke" ? "Cooling compromised: smoke in the air handlers" : "Cooling fails: no power";
    case "servers": {
      const sla = b.tenants.some((t) => t.slaPenaltyPerHour > 0 && t.dependsOn.includes(s.id));
      return sla ? "Servers overheat → SLA breach" : "Servers overheat";
    }
    case "ups":
      return s.backups?.length ? "UPS batteries drain: no utility or generator power" : "UPS batteries drain: no power";
    case "generator":
      return hazard === "access" ? `${s.label} runs dry: no fuel resupply (${s.runtimeHours ?? 0} h on site)` : `${s.label} fails`;
    case "electrical_room":
      return `${s.label} loses power`;
    case "refrigeration":
      return `${s.label} warm up: stock starts to spoil`;
    case "elevators":
      return "Elevators stop: no power";
    case "medical_gas":
      return "Medical gas supply fails";
    case "access_control":
      return "Badge access goes offline";
    case "water":
      return "Water pumps stop: no water pressure";
    case "life_safety":
      return `${s.label} lose power`;
    default:
      return hazard === "power" ? `${s.label} fails: no power` : `${s.label} fails`;
  }
}

/**
 * Propagate direct hits through dependsOn/backups to a fixpoint (earliest failure per system).
 * A generator whose fuel_supply is cut fails runtimeHours after it is needed (or after the cut).
 */
function propagate(b: PortfolioBuilding, direct: Map<string, Fail>): Map<string, Fail> {
  const fail = new Map(direct);
  const byId = new Map(b.systems.map((s) => [s.id, s]));
  /** When something the generator backs loses a dependency, i.e. when it starts running. */
  const generatorStart = (gen: PortfolioSystem): number | undefined => {
    let start: number | undefined;
    for (const t of b.systems) {
      if (!t.backups?.includes(gen.id)) continue;
      for (const d of t.dependsOn) {
        const f = fail.get(d);
        if (f && (start === undefined || f.minute < start)) start = f.minute;
      }
    }
    return start;
  };
  const candidate = (s: PortfolioSystem): Fail | undefined => {
    let trigger = Infinity;
    let cause: string | undefined;
    for (const d of s.dependsOn) {
      const f = fail.get(d);
      if (!f) continue;
      let m = f.minute;
      if (s.kind === "generator" && byId.get(d)?.kind === "fuel_supply") {
        m = Math.max(f.minute, generatorStart(s) ?? f.minute) + (s.runtimeHours ?? 0) * 60;
      }
      if (m < trigger) [trigger, cause] = [m, d];
    }
    if (cause === undefined) return undefined;
    const backups = (s.backups ?? []).filter((id) => byId.has(id) && id !== s.id);
    for (const id of backups) {
      const f = fail.get(id);
      if (!f) return undefined; // a backup is still up
      trigger = Math.max(trigger, f.minute);
    }
    const causeFail = fail.get(cause)!;
    const hazard = propagatedHazard(s, byId.get(cause), causeFail);
    return {
      minute: trigger + (s.lagMinutes ?? 0),
      hazard,
      label: propagatedLabel(s, hazard, b),
      incidentId: causeFail.incidentId,
      cause,
    };
  };
  for (let i = 0; i < b.systems.length * 4 + 4; i++) {
    let changed = false;
    for (const s of b.systems) {
      const c = candidate(s);
      const cur = fail.get(s.id);
      if (c && (!cur || c.minute < cur.minute)) {
        fail.set(s.id, c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return fail;
}

/** Steps sorted by minute; at equal minutes a cause comes before what it causes. */
function toChain(b: PortfolioBuilding, fail: Map<string, Fail>): FailureStep[] {
  const depth = (id: string, seen = new Set<string>()): number => {
    const c = fail.get(id)?.cause;
    if (!c || seen.has(c)) return 0;
    seen.add(id);
    return 1 + depth(c, seen);
  };
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return [...fail.entries()]
    .map(([systemId, f]) => ({
      step: {
        id: `${b.id}:${systemId}`,
        minute: r1(f.minute),
        systemId,
        label: f.label,
        hazard: f.hazard,
        causedBy: f.cause === null ? null : `${b.id}:${f.cause}`,
        incidentId: f.incidentId,
      } satisfies FailureStep,
      depth: depth(systemId),
    }))
    .sort((a, b2) => a.step.minute - b2.step.minute || a.depth - b2.depth || a.step.id.localeCompare(b2.step.id))
    .map((x) => x.step);
}

// ---- One building ----

interface Ctx {
  horizon: number;
  day: boolean;
  impacts: Map<string, BlastImpact>;
  meanElevation: number;
}

function assessBuilding(b: PortfolioBuilding, incidents: AgentIncident[], ctx: Ctx): AffectedProperty | undefined {
  const { horizon } = ctx;
  const touched = new Set<string>();
  const direct = new Map<string, Fail>();
  const contactReasons: { minute: number; text: string }[] = [];
  const zoneReasons: string[] = [];
  /** Per access road / fuel route: earliest block (or slowdown) and who caused it. */
  const roadHits = new Map<string, { minute: number; blocked: boolean; inc: AgentIncident }>();
  const occupied = (ctx.day ? b.occupancy.day : b.occupancy.night) > 0;
  const intakes = b.systems.filter((s) => s.kind === "air_intake");
  const smokeTargets = intakes.length ? intakes : b.systems.filter((s) => s.kind === "hvac");

  for (const inc of incidents) {
    const impact = ctx.impacts.get(inc.id)!;
    const name = incidentName(inc);
    let reached = false;
    const toIncident = bearingDegrees(b.location, inc.location);

    const smoke = smokeEta(inc, b, impact);
    if (smoke !== undefined && smoke <= horizon) {
      reached = true;
      const m = Math.max(0, Math.round(smoke));
      for (const s of smokeTargets) {
        const away = s.facingDegrees !== undefined && angleBetween(s.facingDegrees, toIncident) > 90;
        hit(direct, s.id, {
          minute: m + (away ? FACING_AWAY_MINUTES : 0),
          hazard: "smoke",
          label: s.kind === "air_intake" ? "Smoke reaches HVAC intake" : "Smoke reaches the air handlers",
          incidentId: inc.id,
          cause: null,
        });
      }
      const wind = inc.wind ?? inc.fire?.wind ?? null;
      const downwind = !!wind && angleBetween(bearingDegrees(inc.location, b.location), downwindOf(wind.fromDegrees)) <= 60;
      const where = smokeTargets.length ? (intakes.length ? "smoke at HVAC intake" : "smoke at the air handlers") : "smoke reaches the building";
      contactReasons.push({ minute: m, text: `${downwind ? "Downwind of" : "Near"} the ${name}: ${where} in ${m} min` });
    }

    const fire = fireEta(inc, b);
    if (fire !== undefined && fire <= horizon) {
      reached = true;
      const m = Math.max(0, Math.round(fire));
      for (const s of b.systems) {
        if (s.level === "ground" && s.facingDegrees !== undefined && angleBetween(s.facingDegrees, toIncident) <= 90) {
          hit(direct, s.id, { minute: m, hazard: "fire", label: `Fire reaches the ${lowerFirst(s.label)}`, incidentId: inc.id, cause: null });
        }
      }
      hit(direct, "building", { minute: m, hazard: "fire", label: "Fire reaches the building → evacuate", incidentId: inc.id, cause: null });
      contactReasons.push({ minute: m, text: `${upperFirst(name)} reaches the building in ${m} min` });
    }

    const water = waterEta(inc, b, impact, ctx.meanElevation);
    if (water !== undefined && water <= horizon) {
      reached = true;
      const m = Math.max(0, Math.round(water));
      const basement = b.systems.filter((s) => s.level === "basement");
      for (const s of basement) hit(direct, s.id, { minute: m, hazard: "water", label: `${s.label} floods`, incidentId: inc.id, cause: null });
      if (inc.severity === "critical" && m + GROUND_FLOOD_LAG_MINUTES <= horizon) {
        for (const s of b.systems.filter((x) => x.level === "ground")) {
          hit(direct, s.id, { minute: m + GROUND_FLOOD_LAG_MINUTES, hazard: "water", label: `${s.label} floods`, incidentId: inc.id, cause: null });
        }
      }
      const what = basement.length ? `water reaches the basement ${lowerFirst(basement[0]!.label.replace(/^basement\s+/i, ""))}` : "street flooding reaches the building";
      contactReasons.push({ minute: m, text: `${upperFirst(name)}: ${what} in ${m} min` });
    }

    const roads = [...b.access.roads, ...(b.access.fuelRoute ? [b.access.fuelRoute] : [])];
    for (const e of roadEvents(inc, horizon)) {
      const mine = roads.find((r) => sameRoad(r, e.road));
      if (!mine) continue;
      reached = true;
      const key = roadKey(mine).core;
      const cur = roadHits.get(key);
      if (!cur || (e.blocked && !cur.blocked) || (e.blocked === cur.blocked && e.minute < cur.minute)) {
        roadHits.set(key, { minute: e.minute, blocked: e.blocked, inc });
      }
    }

    const inZone = insideImpact(impact, b.location);
    if (inZone || reached) touched.add(inc.id);
    if (inZone && !reached) {
      zoneReasons.push(`Inside the ${name} zone, ${Math.round(distanceMeters(inc.location, b.location))} m away`);
    }
  }
  if (!touched.size) return undefined;

  // Access: every access road blocked = cut off; the fuel route blocked = no fuel deliveries.
  const roadHit = (r: string) => roadHits.get(roadKey(r).core);
  const roadReasons: string[] = [];
  const blockedRoads = b.access.roads.filter((r) => roadHit(r)?.blocked);
  const accessCut = b.access.roads.length > 0 && blockedRoads.length === b.access.roads.length;
  const fuel = b.access.fuelRoute ? roadHit(b.access.fuelRoute) : undefined;
  if (b.access.fuelRoute && fuel?.blocked) {
    const what = blockWord(fuel.inc);
    for (const s of b.systems.filter((x) => x.kind === "fuel_supply")) {
      hit(direct, s.id, { minute: fuel.minute, hazard: "access", label: `Fuel route (${b.access.fuelRoute}) blocked by ${what}`, incidentId: fuel.inc.id, cause: null });
    }
    const gen = b.systems.find((s) => s.kind === "generator" && s.runtimeHours);
    roadReasons.push(`Only fuel route (${b.access.fuelRoute}) blocked by ${what}${gen ? `: generator has ${gen.runtimeHours} h of fuel` : ""}`);
  }
  if (accessCut) {
    roadReasons.push(`All access roads blocked: ${b.access.roads.map((r) => `${r} (${blockWord(roadHit(r)!.inc)})`).join(", ")}`);
  } else {
    for (const r of b.access.roads) {
      const h = roadHit(r);
      if (!h || (fuel && b.access.fuelRoute && sameRoad(r, b.access.fuelRoute) && fuel.blocked)) continue;
      roadReasons.push(h.blocked ? `${r} blocked by ${blockWord(h.inc)}` : `${r} slowed by ${blockWord(h.inc)} traffic`);
    }
  }

  // The chain: direct hits, propagated, then evacuation when smoke gets into occupied air handlers.
  const systemHits = new Map([...direct].filter(([id]) => id !== "building"));
  const fail = propagate(b, systemHits);
  const fireEvac = direct.get("building");
  if (fireEvac) fail.set("building", fireEvac);
  if (b.use !== "data_center" && occupied) {
    const smoky = b.systems
      .filter((s) => s.kind === "hvac" && fail.get(s.id)?.hazard === "smoke")
      .sort((x, y) => fail.get(x.id)!.minute - fail.get(y.id)!.minute)[0];
    if (smoky) {
      const f = fail.get(smoky.id)!;
      hit(fail, "building", {
        minute: f.minute + EVACUATE_LAG_MINUTES,
        hazard: "smoke",
        label: "Smoke drawn inside → building must evacuate",
        incidentId: f.incidentId,
        cause: smoky.id,
      });
    }
  }
  const chain = toChain(b, fail);

  // Cost, risk, people.
  const cost = estimateCost(b, chain);
  const failed = new Set(chain.map((s) => s.systemId));
  const evacuated = failed.has("building");
  const slaHit = b.tenants.filter((t) => t.slaPenaltyPerHour > 0 && (evacuated || t.dependsOn.some((d) => failed.has(d))));
  const risk: AffectedProperty["risk"] = slaHit.length || evacuated || cost.totalUsd > HIGH_RISK_USD ? "high" : chain.length ? "moderate" : "low";
  const occupants = ctx.day ? b.occupancy.day : b.occupancy.night;
  const people = risk === "low" ? Math.round(occupants * LOW_RISK_PEOPLE_SHARE) : occupants;

  // Backups that hold: "Backup generator covers the UPS battery room from minute 12 until minute 252".
  const byId = new Map(b.systems.map((s) => [s.id, s]));
  const backupReasons: string[] = [];
  for (const s of b.systems) {
    const backups = (s.backups ?? []).filter((id) => byId.has(id));
    if (!backups.length) continue;
    const lost = s.dependsOn.map((d) => fail.get(d)?.minute).filter((m): m is number => m !== undefined);
    if (!lost.length) continue;
    const from = Math.min(...lost);
    const own = fail.get(s.id)?.minute;
    if (own !== undefined && own <= from) continue;
    const until = own !== undefined ? ` until minute ${Math.round(own)}` : "";
    backupReasons.push(`${byId.get(backups[0]!)!.label} covers the ${lowerFirst(s.label)} from minute ${Math.round(from)}${until}`);
  }

  const reasons = [
    ...contactReasons.sort((x, y) => x.minute - y.minute).map((r) => r.text),
    ...roadReasons,
    ...backupReasons,
    ...(evacuated ? [`Building must evacuate at minute ${chain.find((s) => s.systemId === "building")!.minute}`] : []),
    ...(slaHit.length ? [`SLA breach: ${slaHit.map((t) => `${t.name} (${usdK(t.slaPenaltyPerHour)}/h)`).join(", ")}`] : []),
    ...zoneReasons,
  ];

  return {
    id: b.id,
    name: b.name,
    use: b.use,
    location: b.location,
    risk,
    incidentIds: incidents.filter((i) => touched.has(i.id)).map((i) => i.id),
    chain,
    people,
    downtimeHours: cost.downtimeHours,
    cost: { slaUsd: cost.slaUsd, lostRentUsd: cost.lostRentUsd, damageUsd: cost.damageUsd, totalUsd: cost.totalUsd },
    accessCut,
    actions: [],
    reasons,
  };
}

// ---- assessPropertyImpact ----

const RISK_RANK = { high: 0, moderate: 1, low: 2 } as const;

/** Every portfolio building any incident reaches, highest cost first, with `actions: []`. */
export const assessPropertyImpact: AssessPropertyImpact = (incidents, portfolio, opts = {}) => {
  const impacts = new Map(incidents.map((inc) => [inc.id, opts.impacts?.[inc.id] ?? classifyBlastRadius(inc)]));
  const ctx: Ctx = {
    horizon: opts.horizonMinutes ?? DEFAULT_HORIZON_MINUTES,
    day: isDaytime(opts.now ?? Date.now()),
    impacts,
    meanElevation: portfolio.length ? portfolio.reduce((s, b) => s + b.elevationM, 0) / portfolio.length : 0,
  };
  return portfolio
    .map((b) => assessBuilding(b, incidents, ctx))
    .filter((p): p is AffectedProperty => p !== undefined)
    .sort((a, b) => b.cost.totalUsd - a.cost.totalUsd || RISK_RANK[a.risk] - RISK_RANK[b.risk] || b.people - a.people || a.id.localeCompare(b.id));
};

// ---- The tool ----

export interface PropertySummary {
  id: string;
  name: string;
  risk: AffectedProperty["risk"];
  people: number;
  totalUsd: number;
  /** "minute 8: Smoke reaches HVAC intake", or null when nothing fails. */
  firstFailure: string | null;
  accessCut: boolean;
}

export interface AssessSummary {
  properties: PropertySummary[];
  totals: { buildings: number; people: number; usdAtRisk: number };
}

export const assessPropertyImpactSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "assess_property_impact",
    description:
      "After classify_blast_radius: find every portfolio building the incidents reach and walk each one's " +
      "hidden dependency chain (smoke into HVAC, water into the basement electrical room, fuel route blocked), " +
      "in time order, with people inside and dollars at risk. Returns per building its risk, people, $ at risk " +
      "and first failure, plus totals; the full chains are stored for plan_actions.",
    parameters: {
      type: "object",
      properties: {
        incident_ids: {
          type: "array",
          items: { type: "string" },
          description: "Only these incidents. Omit to assess all of them together (linked incidents compound).",
        },
      },
      required: [],
    },
  },
};

/** The assess_property_impact tool: stores run.properties and returns a small summary. */
export const assessPropertyImpactTool: ImpactTool = {
  schema: assessPropertyImpactSchema,
  run(args, run) {
    const ids = run.incidents.map((i) => i.id);
    const raw = args.incident_ids;
    let incidents = run.incidents;
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
        return { error: `incident_ids must be an array of incident id strings from: ${ids.join(", ")}` };
      }
      const unknown = raw.filter((x) => !ids.includes(x));
      if (unknown.length) return { error: `unknown incident id ${unknown.map((x) => `"${x}"`).join(", ")}: use ${ids.join(", ")}` };
      if (raw.length) incidents = run.incidents.filter((i) => raw.includes(i.id));
    }
    for (const inc of incidents) run.impacts[inc.id] ??= classifyBlastRadius(inc);
    const properties = assessPropertyImpact(incidents, run.portfolio, { ...run.opts, impacts: run.impacts });
    run.properties = properties;
    const summary: AssessSummary = {
      properties: properties.map((p) => ({
        id: p.id,
        name: p.name,
        risk: p.risk,
        people: p.people,
        totalUsd: p.cost.totalUsd,
        firstFailure: p.chain[0] ? `minute ${p.chain[0].minute}: ${p.chain[0].label}` : null,
        accessCut: p.accessCut,
      })),
      totals: {
        buildings: properties.length,
        people: properties.reduce((s, p) => s + p.people, 0),
        usdAtRisk: properties.reduce((s, p) => s + p.cost.totalUsd, 0),
      },
    };
    return summary;
  },
};
