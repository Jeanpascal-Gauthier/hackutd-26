// find_clear_exits: the forecast's exit picture -> for each occupied floor in danger, which
// stairwell is clear, when the others fill with smoke, and who needs help getting out.
// Deterministic: it only reshapes the forecast (from run_spread) into a small plan for the model.
import type OpenAI from "openai";
import type { Building, FloorExit } from "@firewatch/shared/types";
import type { AgentTool, Forecast } from "./types.ts";

/** One at-risk floor, as the model sees it. */
export interface FloorPlan {
  floor: number;
  people: number;
  /** Recommended stairwell, e.g. "Stairwell A", or "none". */
  stair: string;
  /** Set only when the recommended stairwell itself fills too: its first smoky minute. */
  stairFillsAt?: number;
  /** The other stairwells on this floor -> first minute they fill (null = stays clear). */
  othersFill: Record<string, number | null>;
  /** First minute smoke reaches an occupied room or the hall on this floor (null = never). */
  smokeAt: number | null;
  /** Occupant flags: "mobility" or "child" (people who need help), "sleeping" (homes or hotel rooms at night: wake them door to door). Omitted when none. */
  help?: string[];
}

/** An at-risk floor where no stairwell stays clear for the whole forecast. */
export interface NoClearStair {
  floor: number;
  people: number;
  /** Best stairwell left ("none" if the floor has none), and when it fills. */
  stair: string;
  fillsAt: number | null;
  help?: string[];
}

export interface ExitPlan {
  /** Most critical: at-risk floors with no clear stairwell. Always present, even when empty. */
  noClearStair: NoClearStair[];
  originFloor: number;
  floorsAtRisk: number;
  peopleAtRisk: number;
  /** Per recommended stairwell: the floors using it ("6-12") and their total people. */
  byStair: { stair: string; floors: string; people: number }[];
  /** Per at-risk floor (limited by the `floors` argument when given). */
  floors: FloorPlan[];
  /** Requested floors that are not at risk or have no occupants. */
  requestedNotAtRisk?: number[];
  notAtRisk: { floors: number; people: number };
}

/** "stair-a" -> "Stairwell A"; null -> "none". */
export const stairName = (id: string | null) => (id ? `Stairwell ${id.replace(/^stair-/, "").toUpperCase()}` : "none");

/** [6,7,8,10] -> "6-8, 10". */
export function floorRange(floors: number[]): string {
  const runs: [number, number][] = [];
  for (const f of [...floors].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && f === last[1] + 1) last[1] = f;
    else runs.push([f, f]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** Same rule as the server (server/src/live/forecast.ts): fire floor, smoky rooms, or a stair fills. */
export const isAtRisk = (e: FloorExit, originFloor: number) =>
  e.floor === originFloor || e.atRiskAt !== null || Object.values(e.blockedAt).some((m) => m !== null);

/** Floor of a room id: from the building, else its "7-..." prefix. */
export function floorOf(roomId: string, building?: Building): number {
  const room = building?.rooms.find((r) => r.id === roomId);
  return room?.floor ?? (Number.parseInt(roomId, 10) || 0);
}

const withHelp = (flags: string[]) => (flags.length ? { help: flags } : {});

/** Pure: the exit plan from a forecast's exits. `floors` limits the per-floor list. */
export function planExits(exits: FloorExit[], originFloor: number, floors?: number[]): ExitPlan {
  const atRisk = exits.filter((e) => isAtRisk(e, originFloor)).sort((a, b) => a.floor - b.floor);
  const safe = exits.filter((e) => !isAtRisk(e, originFloor));

  const noClearStair: NoClearStair[] = atRisk
    .filter((e) => e.stair === null || e.blockedAt[e.stair] != null)
    .map((e) => ({
      floor: e.floor,
      people: e.people,
      stair: stairName(e.stair),
      fillsAt: e.stair ? (e.blockedAt[e.stair] ?? null) : null,
      ...withHelp(e.flags),
    }));

  const groups = new Map<string, FloorExit[]>();
  for (const e of atRisk) groups.set(stairName(e.stair), [...(groups.get(stairName(e.stair)) ?? []), e]);
  const byStair = [...groups].map(([stair, g]) => ({
    stair,
    floors: floorRange(g.map((e) => e.floor)),
    people: g.reduce((n, e) => n + e.people, 0),
  }));

  const wanted = floors?.length ? new Set(floors) : undefined;
  const listed = wanted ? atRisk.filter((e) => wanted.has(e.floor)) : atRisk;
  const plan: ExitPlan = {
    noClearStair,
    originFloor,
    floorsAtRisk: atRisk.length,
    peopleAtRisk: atRisk.reduce((n, e) => n + e.people, 0),
    byStair,
    floors: listed.map((e) => {
      const own = e.stair ? e.blockedAt[e.stair] : null;
      return {
        floor: e.floor,
        people: e.people,
        stair: stairName(e.stair),
        ...(own != null ? { stairFillsAt: own } : {}),
        othersFill: Object.fromEntries(
          Object.entries(e.blockedAt)
            .filter(([id]) => id !== e.stair)
            .map(([id, m]) => [stairName(id), m]),
        ),
        smokeAt: e.atRiskAt,
        ...withHelp(e.flags),
      };
    }),
    notAtRisk: { floors: safe.length, people: safe.reduce((n, e) => n + e.people, 0) },
  };
  if (wanted) {
    const missing = [...wanted].filter((f) => !listed.some((e) => e.floor === f)).sort((a, b) => a - b);
    if (missing.length) plan.requestedNotAtRisk = missing;
  }
  return plan;
}

export const findClearExitsSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "find_clear_exits",
    description:
      "From the spread forecast (call run_spread first), list every occupied floor in danger: which stairwell " +
      "stays clear, when the other stairwells fill with smoke, when smoke reaches occupied rooms, and who needs " +
      "help. noClearStair lists floors with no clear stairwell: treat those as the top priority.",
    parameters: {
      type: "object",
      properties: {
        floors: {
          type: "array",
          items: { type: "integer" },
          description: "Only list these floors in the per-floor detail. Omit to list every floor at risk.",
        },
      },
    },
  },
};

/** The find_clear_exits tool: stores the exit list in run.exits for write_recommendation. */
export const findClearExitsTool: AgentTool = {
  schema: findClearExitsSchema,
  async run(args, { ctx, run }) {
    let floors: number[] | undefined;
    if (args.floors !== undefined && args.floors !== null) {
      if (!Array.isArray(args.floors) || !args.floors.every((f) => Number.isInteger(f))) {
        return { error: "floors must be an array of floor numbers, e.g. [7, 8]" };
      }
      floors = args.floors as number[];
    }

    let forecast: Forecast | undefined = run.forecast;
    if (!forecast) {
      if (!run.origin) return { error: "no forecast yet: call run_spread first" };
      try {
        forecast = await ctx.server.forecast(run.origin.roomId);
      } catch (err) {
        return { error: `forecast from ${run.origin.roomId} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      run.forecast = forecast;
    }

    run.exits = forecast.exits;
    return planExits(forecast.exits, floorOf(forecast.origin, ctx.building), floors);
  },
};
