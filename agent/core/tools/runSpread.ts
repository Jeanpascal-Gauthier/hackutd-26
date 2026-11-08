// run_spread: the fire origin -> the server's spread forecast (POST /forecast), summarised for
// the model. The full forecast stays in run.forecast for find_clear_exits and later tools.
import type OpenAI from "openai";
import type { Building } from "@firewatch/shared/types";
import { isCirculation } from "../rooms.ts";
import type { AgentTool, BuildingInfo, Forecast, ToolEnv } from "./types.ts";

export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 60;
/** Burning rooms listed by name before the rest are counted. */
const MAX_BURNING = 8;

export type Sprinkler = BuildingInfo["sprinklers"][string];

export interface StairSmoke {
  /** First minute this stairwell fills with smoke on any floor. */
  firstSmokyMinute: number;
  /** Floors where it fills, as ranges: "6-12", "3, 5-7". */
  floors: string;
}

export interface SpreadSummary {
  origin: string;
  originName?: string;
  minutes: number;
  /** Sprinkler status in the origin room, when GET /building answered. */
  originSprinkler?: Sprinkler;
  floorsAtRisk: number[];
  peopleAtRisk: number;
  roomsBurningAtEnd: string[];
  /** Stairwells that fill with smoke somewhere during the forecast. */
  stairsSmoky: Record<string, StairSmoke>;
  /** Stairwells that stay clear on every floor. */
  stairsClear: string[];
  /** True when the forecast was reused from an earlier call in this run. */
  cached?: boolean;
}

export const runSpreadSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "run_spread",
    description:
      "Run the fire and smoke spread model from the fire origin. Returns the floors and people at risk, " +
      "rooms still burning at the end, and when each stairwell fills with smoke and on which floors.",
    parameters: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Room id of the fire origin (from locate_room or merge_reports). Omit to use the origin from merge_reports.",
        },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MINUTES,
          description: `How many minutes to forecast (1-${MAX_MINUTES}). Default ${DEFAULT_MINUTES}.`,
        },
      },
    },
  },
};

/** [6,7,8,10,12] -> "6-8, 10, 12". */
export function floorRanges(floors: number[]): string {
  const sorted = [...new Set(floors)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    parts.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
  }
  return parts.join(", ");
}

/** The forecast, compressed for the model: no per-floor exits (find_clear_exits does those). */
export function summariseForecast(forecast: Forecast, building: Building, sprinkler?: Sprinkler): SpreadSummary {
  const { summary } = forecast;
  const stairsSmoky: Record<string, StairSmoke> = {};
  for (const [stair, byFloor] of Object.entries(summary.stairBlocked)) {
    const entries = Object.entries(byFloor);
    if (!entries.length) continue;
    stairsSmoky[stair] = {
      firstSmokyMinute: Math.min(...entries.map(([, m]) => m)),
      floors: floorRanges(entries.map(([f]) => Number(f))),
    };
  }
  const stairs = building.verticals.filter((v) => v.kind === "stair").map((v) => v.id);
  const burning = summary.roomsBurningAtEnd;
  return {
    origin: forecast.origin,
    originName: building.rooms.find((r) => r.id === forecast.origin)?.name,
    minutes: forecast.minutes,
    ...(sprinkler ? { originSprinkler: sprinkler } : {}),
    floorsAtRisk: summary.floorsAtRisk,
    peopleAtRisk: summary.peopleAtRisk,
    roomsBurningAtEnd:
      burning.length > MAX_BURNING
        ? [...burning.slice(0, MAX_BURNING), `+${burning.length - MAX_BURNING} more`]
        : burning,
    stairsSmoky,
    stairsClear: stairs.filter((s) => !stairsSmoky[s]),
  };
}

/** Minutes from the model: an integer 1-60 (a numeric string is fine), default 30. */
function parseMinutes(raw: unknown): number | { error: string } {
  if (raw === undefined || raw === null) return DEFAULT_MINUTES;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES) return n;
  return { error: `minutes must be an integer from 1 to ${MAX_MINUTES} (got ${JSON.stringify(raw)})` };
}

/** Origin sprinkler status; optional, so a failed GET /building just leaves it out. */
async function sprinklerFor(env: ToolEnv, origin: string): Promise<Sprinkler | undefined> {
  try {
    return (await env.ctx.server.getBuilding()).sprinklers?.[origin];
  } catch {
    return undefined;
  }
}

/** The run_spread tool: stores the full forecast in run.forecast and returns a summary. */
export const runSpreadTool: AgentTool = {
  schema: runSpreadSchema,
  async run(args, env) {
    const { ctx, run } = env;
    const minutes = parseMinutes(args.minutes);
    if (typeof minutes !== "number") return minutes;

    const given = typeof args.origin === "string" && args.origin.trim() ? args.origin.trim() : undefined;
    const origin = given ?? run.origin?.roomId;
    if (!origin) return { error: "no fire origin yet: call merge_reports first" };
    if (!ctx.building.rooms.some((r) => r.id === origin)) {
      const example = run.origin?.roomId ?? ctx.building.rooms.find((r) => !isCirculation(r))?.id ?? ctx.building.rooms[0]?.id;
      return { error: `unknown room id "${origin}": use a room id from this building, e.g. "${example}", or omit origin to use the one from merge_reports` };
    }

    const cached = run.forecast?.origin === origin && run.forecast.minutes === minutes;
    const sprinkler = sprinklerFor(env, origin);
    if (!cached) {
      try {
        run.forecast = await ctx.server.forecast(origin, minutes);
      } catch (err) {
        return { error: `forecast failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const summary = summariseForecast(run.forecast!, ctx.building, await sprinkler);
    return cached ? { ...summary, cached: true } : summary;
  },
};
