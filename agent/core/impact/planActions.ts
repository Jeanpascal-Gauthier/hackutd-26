// plan_actions: turns one building's failure chain into concrete, ordered steps for the facility
// manager, each with a deadline that breaks a chain step before it happens. A fixed rule table keyed
// on (hazard, system kind) of the step being prevented; every action is priced with the one cost
// model (cost.ts), so "saves $X" here matches what the console's Execute button takes off.
import type OpenAI from "openai";
import type { GeoPoint } from "@firewatch/shared/types";
import { type CostResult, estimateCost, residualCost } from "./cost.ts";
import { bearingDegrees } from "./geo.ts";
import type {
  AffectedProperty,
  AgentIncident,
  FailureStep,
  ImpactTool,
  PlanActions,
  PlannedAction,
  PortfolioBuilding,
  PortfolioSystem,
  SystemKind,
} from "./types.ts";

/** Most actions kept per building. */
export const MAX_ACTIONS_PER_BUILDING = 6;
/** Minutes of margin before the step each kind of action must beat. */
export const LEAD_MINUTES = { dampers: 1, barriers: 3, fuel: 60, shedLoad: 2, reserve: 2 } as const;

// ---- Helpers ----

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

/** 100 -> "east". */
export const compassName = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;

/** ["a","b","c"] -> "a, b and c". */
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const norm = (road: string) => road.trim().toLowerCase();
const before = (minute: number, lead: number) => Math.max(0, Math.floor(minute - lead));

/** Every road any incident blocks or queues: red road sections, the crash road and its queue. */
export function blockedRoads(incidents: AgentIncident[]): Set<string> {
  const out = new Set<string>();
  const add = (r: string | null | undefined) => r && out.add(norm(r));
  for (const inc of incidents) {
    for (const r of inc.affectedRoads ?? []) add(r.road);
    add(inc.crash?.road);
    for (const s of inc.crash?.segments ?? []) add(s.road);
    for (const s of inc.crash?.steps ?? []) for (const r of s.roads) add(r);
  }
  return out;
}

/**
 * An open road for the fuel truck: one of the building's own access roads (not its usual fuel
 * route), else a crash's suggested alternate. Undefined when every option is blocked.
 */
export function alternateRoad(building: PortfolioBuilding, incidents: AgentIncident[]): string | undefined {
  const blocked = blockedRoads(incidents);
  const fuel = building.access.fuelRoute ? norm(building.access.fuelRoute) : undefined;
  const candidates = [...building.access.roads, ...incidents.flatMap((i) => i.crash?.alternateRoads ?? [])];
  return candidates.find((r) => !blocked.has(norm(r)) && norm(r) !== fuel);
}

/** Steps in `matched` that no other matched step leads to: preventing these stops the rest too. */
function roots(chain: FailureStep[], matched: FailureStep[]): FailureStep[] {
  const byId = new Map(chain.map((s) => [s.id, s]));
  const ids = new Set(matched.map((s) => s.id));
  return matched.filter((s) => {
    const seen = new Set<string>();
    for (let c = s.causedBy; c !== null && !seen.has(c); c = byId.get(c)?.causedBy ?? null) {
      if (ids.has(c)) return false;
      seen.add(c);
    }
    return true;
  });
}

/** Every step that follows from `id` (not including it). */
function descendants(chain: FailureStep[], id: string): FailureStep[] {
  const out = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of chain) if (s.causedBy !== null && out.has(s.causedBy) && !out.has(s.id)) (out.add(s.id), (changed = true));
  }
  return chain.filter((s) => s.id !== id && out.has(s.id));
}

/** Short labels of the systems the steps hit, deduped, "building" left out. */
function labelsOf(steps: FailureStep[], sys: Map<string, PortfolioSystem>): string[] {
  return [...new Set(steps.map((s) => sys.get(s.systemId)?.label).filter((l): l is string => !!l))];
}

// ---- The rule table ----

/** What a rule sees. */
interface RuleCtx {
  property: AffectedProperty;
  building: PortfolioBuilding;
  incidents: AgentIncident[];
  chain: FailureStep[];
  sys: Map<string, PortfolioSystem>;
  kindOf(step: FailureStep): SystemKind | "building" | undefined;
  incidentOf(step: FailureStep): AgentIncident | undefined;
}

/** A rule's action before pricing. `slug` becomes the id suffix. */
type Draft = Omit<PlannedAction, "id" | "savesUsd" | "status"> & { slug: string };

interface Rule {
  slug: string;
  /** Plain-language trigger, for the docs and the report. */
  when: string;
  build(c: RuleCtx): Draft | undefined;
}

/** Side of the building facing away from an incident ("west" for a fire to the east). */
const awaySide = (from: GeoPoint, inc: AgentIncident | undefined) =>
  inc ? compassName(bearingDegrees(from, inc.location) + 180) : undefined;

export const RULES: Rule[] = [
  {
    slug: "close-dampers",
    when: "smoke -> air_intake / hvac",
    build(c) {
      const hit = c.chain.filter((s) => s.hazard === "smoke" && ["air_intake", "hvac"].includes(c.kindOf(s) ?? ""));
      if (!hit.length) return;
      const first = roots(c.chain, hit);
      const intakes = hit.map((s) => c.sys.get(s.systemId)).filter((s) => s?.kind === "air_intake");
      const facing = intakes.find((s) => s?.facingDegrees !== undefined)?.facingDegrees;
      const where = facing !== undefined ? ` on the ${compassName(facing)}-facing intake` : "";
      const ahus = c.building.systems.filter((s) => s.kind === "hvac").map((s) => s.label);
      const spared = labelsOf(first.flatMap((s) => [s, ...descendants(c.chain, s.id)]), c.sys);
      return {
        slug: "close-dampers",
        text: `Close outside-air dampers${where} and switch ${ahus.length ? list(ahus) : "air handlers"} to recirculate`,
        deadlineMinute: before(Math.min(...hit.map((s) => s.minute)), LEAD_MINUTES.dampers),
        prevents: first.map((s) => s.id),
        reason: `Keeps smoke out of the air handlers, so ${list(spared.slice(0, 3)) || "the systems they feed"} stay clean`,
      };
    },
  },
  {
    slug: "flood-barriers",
    when: "water -> electrical_room / basement or ground-level systems",
    build(c) {
      const hit = c.chain.filter((s) => {
        const sys = c.sys.get(s.systemId);
        return s.hazard === "water" && !!sys && (sys.kind === "electrical_room" || sys.level !== "roof");
      });
      if (!hit.length) return;
      const first = roots(c.chain, hit);
      const side = (() => {
        const inc = c.incidentOf(first[0]!);
        return inc ? `${compassName(bearingDegrees(c.building.location, inc.location))}-side ` : "";
      })();
      return {
        slug: "flood-barriers",
        text: `Deploy flood barriers at the ${side}loading dock and basement entrances to protect ${list(labelsOf(first, c.sys))}`,
        deadlineMinute: before(Math.min(...hit.map((s) => s.minute)), LEAD_MINUTES.barriers),
        prevents: first.map((s) => s.id),
        reason: "Keeps water out of the basement, so the equipment there stays dry and powered",
      };
    },
  },
  {
    slug: "start-generator",
    when: "power loss downstream of electrical_room / utility_power, building has a generator not failing first",
    build(c) {
      const gen = c.building.systems.find((s) => s.kind === "generator");
      if (!gen) return;
      const feeds = c.chain.filter((s) => ["electrical_room", "utility_power"].includes(c.kindOf(s) ?? ""));
      const feedIds = new Set(feeds.map((s) => s.id));
      const losses = c.chain.filter(
        (s) => s.causedBy !== null && feedIds.has(s.causedBy) && !feedIds.has(s.id) && (s.hazard === "power" || s.hazard === "heat"),
      );
      if (!losses.length) return;
      // A generator that is itself down before the first load would drop can't carry it.
      const genStep = c.chain.find((s) => s.systemId === gen.id);
      const firstLoss = Math.min(...losses.map((s) => s.minute));
      if (genStep && genStep.minute <= firstLoss) return;
      const room = c.sys.get(feeds[0]!.systemId)?.label ?? "the electrical room";
      const fuel = gen.runtimeHours ? ` (${gen.runtimeHours} h of fuel on site)` : "";
      return {
        slug: "start-generator",
        text: `Start ${gen.label} and transfer critical load off ${room} now${fuel}`,
        deadlineMinute: 0,
        prevents: roots(c.chain, losses).map((s) => s.id),
        reason: `Backup power keeps ${list(labelsOf(losses, c.sys).slice(0, 3))} running when ${room} goes down`,
      };
    },
  },
  {
    slug: "reroute-fuel",
    when: "access -> fuel_supply, with an unblocked alternate road",
    build(c) {
      const hit = c.chain.filter((s) => s.hazard === "access" && c.kindOf(s) === "fuel_supply");
      if (!hit.length) return;
      const road = alternateRoad(c.building, c.incidents);
      if (!road) return;
      const usual = c.building.access.fuelRoute;
      const cut = usual && blockedRoads(c.incidents).has(norm(usual)) ? ` (${usual} is blocked)` : "";
      return {
        slug: "reroute-fuel",
        text: `Reroute fuel delivery via ${road}${cut}`,
        deadlineMinute: before(Math.min(...hit.map((s) => s.minute)), LEAD_MINUTES.fuel),
        prevents: roots(c.chain, hit).map((s) => s.id),
        reason: `The fuel truck reaches the generator by ${road} before the tank runs dry`,
      };
    },
  },
  {
    slug: "shed-load",
    when: "heat -> servers / cooling",
    build(c) {
      const hit = c.chain.filter((s) => s.hazard === "heat" && ["servers", "cooling"].includes(c.kindOf(s) ?? ""));
      if (!hit.length) return;
      return {
        slug: "shed-load",
        text: `Shed non-critical server load and open hot-aisle containment in ${list(labelsOf(hit, c.sys))}`,
        deadlineMinute: before(Math.min(...hit.map((s) => s.minute)), LEAD_MINUTES.shedLoad),
        prevents: roots(c.chain, hit).map((s) => s.id),
        reason: "Less heat output buys the room time to stay under its thermal limit",
      };
    },
  },
  {
    slug: "medical-gas",
    when: "any hazard -> medical_gas",
    build(c) {
      const hit = c.chain.filter((s) => c.kindOf(s) === "medical_gas");
      if (!hit.length) return;
      return {
        slug: "medical-gas",
        text: `Confirm medical gas pressure and switch ${list(labelsOf(hit, c.sys))} to reserve cylinders`,
        deadlineMinute: before(Math.min(...hit.map((s) => s.minute)), LEAD_MINUTES.reserve),
        prevents: roots(c.chain, hit).map((s) => s.id),
        reason: "Reserve cylinders need no power or piping, so oxygen keeps flowing to patients",
      };
    },
  },
  {
    slug: "cold-chain",
    when: "any hazard -> refrigeration",
    build(c) {
      const hit = c.chain.filter((s) => c.kindOf(s) === "refrigeration");
      if (!hit.length) return;
      return {
        slug: "cold-chain",
        text: `Move stock from ${list(labelsOf(hit, c.sys))} to backup refrigeration or reefer trucks`,
        deadlineMinute: before(Math.min(...hit.map((s) => s.minute)), LEAD_MINUTES.reserve),
        prevents: roots(c.chain, hit).map((s) => s.id),
        reason: "Stock that leaves before the units warm up is not lost",
      };
    },
  },
  {
    slug: "move-patients",
    when: "hospital with power-loss steps (life safety, prevents no cost)",
    build(c) {
      if (c.building.use !== "hospital") return;
      const power = c.chain.some((s) => s.hazard === "power" || ["electrical_room", "utility_power", "generator"].includes(c.kindOf(s) ?? ""));
      if (!power) return;
      return {
        slug: "move-patients",
        text: "Move critical patients off generator-dependent wings and put ventilated patients on battery units",
        deadlineMinute: 0,
        prevents: [],
        reason: "Life safety: patients on life support must not depend on power that may fail",
      };
    },
  },
  {
    slug: "evacuate",
    when: "fire or building-wide step (life safety, prevents no cost)",
    build(c) {
      const hit = c.chain.find((s) => s.systemId === "building" || s.hazard === "fire");
      if (!hit) return;
      const inc = c.incidentOf(hit) ?? c.incidents.find((i) => c.property.incidentIds.includes(i.id));
      const side = awaySide(c.building.location, inc);
      return {
        slug: "evacuate",
        text: `Evacuate ${c.building.name} via the ${side ? `${side}-side` : "nearest safe"} exits and notify tenants`,
        deadlineMinute: 0,
        prevents: [],
        reason: side ? `Life safety: the ${side} side faces away from the incident` : "Life safety: get people out before conditions worsen",
      };
    },
  },
  {
    slug: "notify-sla",
    when: "tenants with SLAs depend on a failing system (prevents no cost)",
    build(c) {
      const failed = new Set(c.chain.map((s) => s.systemId));
      const names = c.building.tenants
        .filter((t) => t.slaPenaltyPerHour > 0 && (failed.has("building") || t.dependsOn.some((d) => failed.has(d))))
        .map((t) => t.name);
      if (!names.length) return;
      return {
        slug: "notify-sla",
        text: `Notify tenants with SLAs: ${list(names)}`,
        deadlineMinute: 0,
        prevents: [],
        reason: "Early notice lets tenants fail over and is often required by the SLA",
      };
    },
  },
];

// ---- planActions ----

/** Rule slugs never dropped by the cap. */
const LIFE_SAFETY = new Set(["evacuate", "move-patients"]);

/** Order for the final list: deadline, then savings, then id. */
const byDeadline = (a: PlannedAction, b: PlannedAction) =>
  a.deadlineMinute - b.deadlineMinute || b.savesUsd - a.savesUsd || a.id.localeCompare(b.id);

/**
 * plan_actions as a pure function: one action per matching rule (deduped by rule), priced with
 * estimateCost, capped at MAX_ACTIONS_PER_BUILDING (biggest savers and life safety kept),
 * ordered by deadline then savings. Actions that prevent cost but save $0 are kept only when
 * they stop a real step.
 */
export const planActions: PlanActions = (property, building, incidents) => {
  const chain = property.chain;
  const sys = new Map(building.systems.map((s) => [s.id, s]));
  const incById = new Map(incidents.map((i) => [i.id, i]));
  const ctx: RuleCtx = {
    property,
    building,
    incidents,
    chain,
    sys,
    kindOf: (s) => (s.systemId === "building" ? "building" : sys.get(s.systemId)?.kind),
    incidentOf: (s) => incById.get(s.incidentId),
  };

  const base = estimateCost(building, chain).totalUsd;
  const ids = new Set(chain.map((s) => s.id));
  const seen = new Set<string>();
  const out: PlannedAction[] = [];
  for (const rule of RULES) {
    const d = rule.build(ctx);
    if (!d) continue;
    const prevents = [...new Set(d.prevents)].filter((id) => ids.has(id));
    const lifeSafety = d.prevents.length === 0;
    if (!lifeSafety && !prevents.length) continue;
    const id = `${property.id}:${d.slug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      text: d.text,
      deadlineMinute: Math.max(0, d.deadlineMinute),
      prevents,
      savesUsd: prevents.length ? base - estimateCost(building, chain, prevents).totalUsd : 0,
      reason: d.reason,
      status: "pending",
    });
  }

  // Over the cap, keep life safety first, then the biggest savers, then notices.
  const rank = (a: PlannedAction) => (LIFE_SAFETY.has(a.id.slice(property.id.length + 1)) ? 0 : a.prevents.length ? 1 : 2);
  const kept = [...out].sort((a, b) => rank(a) - rank(b) || b.savesUsd - a.savesUsd).slice(0, MAX_ACTIONS_PER_BUILDING);
  return kept.sort(byDeadline);
};


/**
 * Marks `doneIds` done (actions already done stay done) and returns the cost still at risk.
 * `property.cost` is left as the do-nothing baseline; the console shows both.
 */
export function applyActions(
  property: AffectedProperty,
  building: PortfolioBuilding,
  doneIds: string[],
): { property: AffectedProperty; cost: CostResult } {
  const done = new Set(doneIds);
  const actions = property.actions.map((a) => (done.has(a.id) ? { ...a, status: "done" as const } : a));
  return { property: { ...property, actions }, cost: residualCost(building, property.chain, actions) };
}

// ---- The tool ----

export const planActionsSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "plan_actions",
    description:
      "After assess_property_impact: plan concrete, deadline-ordered actions for each affected building " +
      "(close dampers, start generator, flood barriers, reroute fuel, evacuate, notify SLA tenants), each priced " +
      "by the dollars it saves. Returns the actions per building and the total saved if all are done.",
    parameters: {
      type: "object",
      properties: {
        property_ids: {
          type: "array",
          items: { type: "string" },
          description: "Building ids from assess_property_impact to plan for. Omit for every affected building.",
        },
      },
      required: [],
    },
  },
};

/** The plan_actions tool: writes run.actions[id] and property.actions; returns a small summary. */
export const planActionsTool: ImpactTool = {
  schema: planActionsSchema,
  run(args, run) {
    if (!run.properties) return { error: "no affected properties yet: call assess_property_impact first" };
    const raw = args.property_ids;
    const wanted =
      Array.isArray(raw) && raw.length ? new Set(raw.filter((x): x is string => typeof x === "string")) : undefined;
    const buildings = new Map(run.portfolio.map((b) => [b.id, b]));
    const unknown = wanted ? [...wanted].filter((id) => !run.properties!.some((p) => p.id === id)) : [];

    const results: { id: string; name: string; actions: { text: string; deadlineMinute: number; savesUsd: number }[] }[] = [];
    let totalSavesUsd = 0;
    for (const p of run.properties) {
      if (wanted && !wanted.has(p.id)) continue;
      const b = buildings.get(p.id);
      if (!b) {
        unknown.push(p.id);
        continue;
      }
      const actions = planActions(p, b, run.incidents);
      run.actions[p.id] = actions;
      p.actions = actions;
      // All done together, overlap counted once.
      const all = actions.map((a) => ({ ...a, status: "done" as const }));
      totalSavesUsd += estimateCost(b, p.chain).totalUsd - residualCost(b, p.chain, all).totalUsd;
      results.push({
        id: p.id,
        name: p.name,
        actions: actions.map(({ text, deadlineMinute, savesUsd }) => ({ text, deadlineMinute, savesUsd })),
      });
    }
    return { properties: results, totalSavesUsd, ...(unknown.length ? { unknown } : {}) };
  },
};
