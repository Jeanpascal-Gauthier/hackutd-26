// merge_reports: every located report so far -> one likely fire origin with a confidence,
// plus a short explanation for the agent trail (who supports the winner, who argues against).
// Same rules as the server (server/src/live/merge.ts), so the marker it draws matches ours:
//  - a report of fire/flames counts double compared with a report of smoke;
//  - a smoke-only report from a floor ABOVE a candidate supports it at half weight (smoke rises);
//  - everything else counts against the candidate;
//  - ties go to the lower floor; confidence is capped at 0.95, rounded to 2 decimals.
import type OpenAI from "openai";
import type { Building, Report } from "@firewatch/shared/types";
import type { AgentTool, MergedOrigin } from "./types.ts";

const FIRE = /\b(fire|flames?|burning|blaze|on fire)\b/i;

/** Evidence entries listed per side, so the output stays under ~1 KB. */
const MAX_LISTED = 3;
const EXCERPT = 60;

export interface Evidence {
  roomId: string;
  kind: "fire" | "smoke";
  /** What this report adds to (or takes from) the winner's score. */
  weight: number;
  /** Only present (true) on the report being processed now. */
  current?: true;
  text: string;
}

export interface MergeResult {
  origin: MergedOrigin;
  /** Sum of supporting weights (the score candidates compete on). */
  score: number;
  reportsUsed: number;
  support: Evidence[];
  against: Evidence[];
  /** Evidence entries left out of the lists above, to keep the output small. */
  notListed?: number;
  runnerUp?: { roomId: string; score: number };
  note?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** First 60 chars of a report, on one line. */
export function excerpt(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= EXCERPT ? t : `${t.slice(0, EXCERPT - 3)}...`;
}

/**
 * Earlier reports plus the current one, without counting it twice: if the server already has
 * a report with the same id, the current version (with the latest room) replaces it in place.
 */
export function withCurrent(earlier: Report[], current?: Report): Report[] {
  if (!current) return earlier;
  const i = earlier.findIndex((r) => r.id === current.id);
  if (i < 0) return [...earlier, current];
  return earlier.map((r, j) => (j === i ? current : r));
}

/**
 * @param currentId id of the report being processed now, to flag it in the evidence lists.
 * @returns undefined when no report has a known room with confidence > 0.
 */
export function mergeReports(reports: Report[], building: Building, currentId?: string): MergeResult | undefined {
  const roomOf = new Map(building.rooms.map((r) => [r.id, r]));
  const located = reports.filter(
    (r): r is Report & { roomId: string } => !!r.roomId && roomOf.has(r.roomId) && (r.confidence ?? 0) > 0,
  );
  if (!located.length) return undefined;

  const floorOf = (id: string) => roomOf.get(id)!.floor;
  const isFire = (r: Report) => FIRE.test(r.text);
  const weight = (r: Report) => (isFire(r) ? 2 : 1) * (r.confidence ?? 0);
  const candidates = [...new Set(located.map((r) => r.roomId))];

  // Score every candidate exactly like the server.
  const scored = candidates.map((c) => {
    const cFloor = floorOf(c);
    let support = 0;
    let against = 0;
    let miss = 1; // product of (1 - p) over supporting reports
    for (const r of located) {
      const above = floorOf(r.roomId) > cFloor && !isFire(r);
      if (r.roomId === c) {
        support += weight(r);
        miss *= 1 - (r.confidence ?? 0);
      } else if (above) {
        support += 0.5 * weight(r);
        miss *= 1 - 0.5 * (r.confidence ?? 0);
      } else {
        against += weight(r);
      }
    }
    const confidence = round2(Math.min(0.95, (1 - miss) * (support / (support + against))));
    return { roomId: c, floor: cFloor, score: support, confidence };
  });

  // Same scan as the server: a higher score wins; on a tie, the lower floor; else the earlier one.
  type Scored = (typeof scored)[number];
  const pick = (list: Scored[]) =>
    list.reduce<Scored | undefined>(
      (best, s) => (!best || s.score > best.score || (s.score === best.score && s.floor < best.floor) ? s : best),
      undefined,
    );
  const best = pick(scored)!;
  const second = pick(scored.filter((s) => s !== best));

  // Explain the winner: each report's effect on its score.
  const support: Evidence[] = [];
  const against: Evidence[] = [];
  for (const r of located) {
    const fire = isFire(r);
    const sameRoom = r.roomId === best.roomId;
    const above = !sameRoom && floorOf(r.roomId) > best.floor && !fire;
    const e: Evidence = {
      roomId: r.roomId,
      kind: fire ? "fire" : "smoke",
      weight: round2((above ? 0.5 : 1) * weight(r)),
      ...(r.id === currentId ? { current: true as const } : {}),
      text: excerpt(r.text),
    };
    (sameRoom || above ? support : against).push(e);
  }
  // Heaviest first, but the current report always makes the list.
  const top = (list: Evidence[]) =>
    [...list]
      .sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.weight - a.weight)
      .slice(0, MAX_LISTED);
  const notListed = Math.max(0, support.length - MAX_LISTED) + Math.max(0, against.length - MAX_LISTED);

  const room = roomOf.get(best.roomId)!;
  return {
    origin: { roomId: room.id, roomName: room.name, confidence: best.confidence },
    score: round2(best.score),
    reportsUsed: located.length,
    support: top(support),
    against: top(against),
    ...(notListed ? { notListed } : {}),
    ...(second ? { runnerUp: { roomId: second.roomId, score: round2(second.score) } } : {}),
  };
}

export const mergeReportsSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "merge_reports",
    description:
      "Combine every located fire/smoke report so far (including this one) into the most likely fire origin " +
      "room with a confidence, and explain which reports support it. Call after locate_room. No arguments.",
    parameters: { type: "object", properties: {} },
  },
};

/** The merge_reports tool: sets run.origin for run_spread and the later tools. */
export const mergeReportsTool: AgentTool = {
  schema: mergeReportsSchema,
  async run(_args, { ctx, run }) {
    // Takes no arguments: anything the model passes is ignored.
    let earlier: Report[] = [];
    let note: string | undefined;
    try {
      earlier = (await ctx.server.getState()).reports ?? [];
    } catch (err) {
      note = `server unreachable (${err instanceof Error ? err.message : String(err)}): merged the current report only`.slice(0, 160);
    }
    const result = mergeReports(withCurrent(earlier, run.report), ctx.building, run.report.id);
    if (!result) {
      return { error: "no located reports yet: ask the caller for their floor and room", ...(note ? { note } : {}) };
    }
    run.origin = result.origin;
    return note ? { ...result, note } : result;
  },
};
