// write_recommendation: the model writes the commander's actions and the text for callers;
// this checks them against the exit plan before accepting. The reply is texted to people in a
// burning building, so a stairwell the plan does not clear must never be sent as a way out.
// The model writes, the code verifies; after 3 rejections the server's rule-based draft is used.
import type OpenAI from "openai";
import type { Building, FloorExit, Recommendation } from "@firewatch/shared/types";
import type { AgentTool, RunState } from "./types.ts";

export const MAX_ACTIONS = 3;
export const MAX_ACTION_CHARS = 160;
export const MAX_REPLY_CHARS = 280;
/** Rejected attempts per run before the server's draft is used instead. */
export const MAX_ATTEMPTS = 3;
/** Problems sent back per attempt, so the result stays small. */
const MAX_PROBLEMS = 4;
/** Characters looked at before a stairwell/elevator mention for "do not use" and the like. */
const WINDOW = 30;

export interface RecommendationDraft {
  actions?: unknown;
  callerReply?: unknown;
}

const stairName = (id: string) => `Stairwell ${id.replace(/^stair-/, "").toUpperCase()}`;

/** [6,7,8,10] -> "6-8, 10". */
function floorRange(floors: number[]): string {
  const runs: [number, number][] = [];
  for (const f of [...floors].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && f === last[1] + 1) last[1] = f;
    else runs.push([f, f]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** Same rule as the server (server/src/live/recommend.ts): fire floor, smoky rooms, or a stair fills. */
const isAtRisk = (e: FloorExit, originFloor: number) =>
  e.floor === originFloor || e.atRiskAt !== null || Object.values(e.blockedAt).some((m) => m !== null);

// ---- Reading the text ----

interface Mention {
  kind: "stair" | "elevator";
  /** Stairwell ids, e.g. ["stair-b"]; empty for the elevator. */
  ids: string[];
  start: number;
  end: number;
  use: boolean;
}

/** "Stairwell A", "stairs b", "stair-B", "Stairwells A and B", "east stairwell" (A is west, B is east). */
const STAIR_RE =
  /\b(?:(west|east)(?:ern)?\s+stair(?:well|way|case)?s?\b|stair(?:well|way|case)?s?\s*[-_]?\s*([a-z])(?:\s*(?:and|or|&|,|\/)\s*([a-z]))?\b)/g;
const ELEVATOR_RE = /\belevators?\b/g;

/** Negation, with the verb it negates swallowed, so "do not use" is one cue. */
const NEG =
  String.raw`(?:do\s+not|don['’]?t|never|cannot|can['’]?t|not|no|avoid(?:ing)?|stay\s+(?:out\s+of|away\s+from)|keep\s+(?:out\s+of|away\s+from)|instead\s+of|rather\s+than)` +
  String.raw`(?:\s+(?:use|using|take|taking|enter|entering|go(?:ing)?\s+(?:down|in|into|to)|head(?:ing)?\s+(?:in)?to))?`;
const POS = String.raw`(?:use|using|take|taking|via|by|through|down|leave|exit|evacuate|go|head|enter|to|toward|towards)`;
const CUE_RE = new RegExp(String.raw`\b(?:(${NEG})|${POS})\b`, "g");
/** Words after a mention that mark it as a warning: "Stairwell B fills with smoke", "is blocked". */
const AFTER_NEG_RE =
  /\b(?:blocked|smoky|smoke-filled|fill(?:s|ing)?|full of smoke|has smoke|unsafe|not safe|closed|shut|off[- ]limits|out of service|impassable|compromised|dangerous|is not|isn['’]t)\b/;
/** Only a conjunction between two mentions: "do not use Stairwell B or the elevator". */
const CONJ_ONLY_RE = /^[\s,]*(?:or|and|nor|&|\/)?\s*(?:the\s+)?$/;
/** Clause ends: a cue before one of these does not reach the next mention. */
const BOUNDARY_RE = /[.;:!?()\n]/g;

/** Last cue in the text before a mention: "avoid" for a negation, "use" for a verb like take/use/by. */
function lastCue(before: string): "avoid" | "use" | undefined {
  let cue: "avoid" | "use" | undefined;
  for (const m of before.matchAll(CUE_RE)) cue = m[1] ? "avoid" : "use";
  return cue;
}

/** Up to 5 words after a mention, stopping at the end of the clause. */
function wordsAfter(text: string, end: number): string {
  const rest = text.slice(end, end + 60).split(/[.;!?()\n]/)[0] ?? "";
  return rest.trim().split(/\s+/).slice(0, 5).join(" ");
}

/**
 * Every stairwell and elevator mention, each marked use or avoid. A simple heuristic:
 * 1. look at up to WINDOW characters before the mention, cut at the clause start and at the
 *    previous mention; the last cue there decides ("do not use" -> avoid, "take"/"by" -> use);
 * 2. with no cue and only "or"/"and" since the previous mention, it shares that mention's
 *    polarity ("do not use Stairwell B or the elevator");
 * 3. otherwise words right after it decide ("Stairwell B fills with smoke", "is blocked");
 * 4. a bare mention counts as "use": anything not clearly a warning is treated as advice.
 */
export function findMentions(text: string): Mention[] {
  const lower = text.toLowerCase();
  const found: Omit<Mention, "use">[] = [];
  for (const m of lower.matchAll(STAIR_RE)) {
    const ids = m[1]
      ? [m[1] === "west" ? "stair-a" : "stair-b"]
      : [m[2], m[3]].filter((x): x is string => !!x).map((l) => `stair-${l}`);
    found.push({ kind: "stair", ids, start: m.index, end: m.index + m[0].length });
  }
  for (const m of lower.matchAll(ELEVATOR_RE)) {
    found.push({ kind: "elevator", ids: [], start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);

  const out: Mention[] = [];
  for (const m of found) {
    let from = Math.max(0, m.start - WINDOW);
    for (const b of lower.slice(0, m.start).matchAll(BOUNDARY_RE)) from = Math.max(from, b.index + 1);
    const prev = out.at(-1);
    const afterPrev = prev !== undefined && prev.end > from;
    if (afterPrev) from = prev.end;
    const before = lower.slice(from, m.start);
    const warned = AFTER_NEG_RE.test(wordsAfter(lower, m.end));

    const cue = lastCue(before);
    let use: boolean;
    if (cue) use = cue === "use";
    else if (afterPrev && CONJ_ONLY_RE.test(before) && !warned) use = prev.use;
    else use = !warned;
    out.push({ ...m, use });
  }
  return out;
}

/** Floors named in the text: "floor 7", "floors 8-12", "floors 6–12", "floors 8 and 10", "7th floor". */
export function findFloors(text: string): { floors: number[]; raw: string }[] {
  const out: { floors: number[]; raw: string }[] = [];
  const range = String.raw`\d+(?:\s*(?:-|–|—|to|through|thru)\s*\d+)?`;
  const listRe = new RegExp(String.raw`\bfloors?\s+(${range}(?:\s*(?:,\s*and|,\s*or|,|and|&|or)\s*${range})*)`, "gi");
  for (const m of text.matchAll(listRe)) {
    for (const part of m[1]!.split(/\s*(?:,\s*and|,\s*or|,|\band\b|&|\bor\b)\s*/i)) {
      const r = part.match(/(\d+)\s*(?:-|–|—|to|through|thru)\s*(\d+)/i);
      const floors = r ? [Number(r[1]), Number(r[2])] : [Number(part)];
      if (floors.every(Number.isFinite)) out.push({ floors, raw: part.trim() });
    }
  }
  for (const m of text.matchAll(/\b(\d+)(?:st|nd|rd|th)\s+floors?\b/gi)) out.push({ floors: [Number(m[1])], raw: m[0] });
  return out;
}

// ---- The checks ----

/**
 * Pure: every problem with a recommendation, as short sentences the model can act on.
 * Empty means accepted. `floors` is the building's top floor.
 */
export function checkRecommendation(
  rec: RecommendationDraft,
  exits: FloorExit[],
  originFloor: number,
  floors: number,
): string[] {
  const problems: string[] = [];

  // 1. Shape and length.
  const actions = Array.isArray(rec.actions) ? rec.actions : undefined;
  if (!actions) problems.push(`actions must be an array of 1-${MAX_ACTIONS} short strings.`);
  else if (actions.length < 1 || actions.length > MAX_ACTIONS)
    problems.push(`Give 1-${MAX_ACTIONS} actions, not ${actions.length}: keep the most urgent.`);
  const texts: { where: string; text: string }[] = [];
  (actions ?? []).forEach((a, i) => {
    const text = typeof a === "string" ? a.trim() : "";
    if (!text) problems.push(`Action ${i + 1} is empty or not a string.`);
    else if (text.length > MAX_ACTION_CHARS)
      problems.push(`Action ${i + 1} is ${text.length} characters: keep each under ${MAX_ACTION_CHARS}.`);
    if (text) texts.push({ where: `Action ${i + 1}`, text });
  });
  const reply = typeof rec.callerReply === "string" ? rec.callerReply.trim() : "";
  if (!reply) problems.push("callerReply is empty: write 1-2 sentences for people in the building.");
  else if (reply.length > MAX_REPLY_CHARS)
    problems.push(`callerReply is ${reply.length} characters: keep it under ${MAX_REPLY_CHARS}.`);
  if (reply) texts.push({ where: "callerReply", text: reply });

  // 2. Stairwells: only one the plan recommends to an at-risk floor may be given as a way out.
  const atRisk = exits.filter((e) => isAtRisk(e, originFloor));
  const planned = atRisk.length ? atRisk : exits;
  const known = new Set(exits.flatMap((e) => [...Object.keys(e.blockedAt), ...(e.stair ? [e.stair] : [])]));
  const clear = [...new Set(planned.map((e) => e.stair).filter((s): s is string => s !== null))].sort();
  const clearNames = clear.length ? clear.map(stairName).join(" or ") : "none";
  const mentions = texts.map((t) => ({ ...t, mentions: findMentions(t.text) }));
  for (const { where, mentions: ms } of mentions) {
    for (const m of ms.filter((x) => x.kind === "stair")) {
      for (const id of m.ids) {
        if (!known.has(id)) {
          problems.push(`${where}: ${stairName(id)} does not exist. The building has ${[...known].sort().map(stairName).join(" and ")}.`);
        } else if (m.use && !clear.includes(id)) {
          const fills = atRisk.filter((e) => e.blockedAt[id] != null).map((e) => e.floor);
          const why = fills.length ? `it fills with smoke on floors ${floorRange(fills)}` : "no at-risk floor is sent to it";
          problems.push(
            `${where} reads as telling people to use ${stairName(id)}, but ${why}. Clear: ${clearNames}. ` +
              `Name ${stairName(id)} only as "do not use ${stairName(id)}".`,
          );
        }
      }
    }
  }

  // 3. Elevator: never advised; the caller reply must warn against it.
  for (const { where, mentions: ms } of mentions) {
    if (ms.some((m) => m.kind === "elevator" && m.use))
      problems.push(`${where} reads as telling people to use the elevator: say "do not use the elevator".`);
  }
  const replyMentions = mentions.find((t) => t.where === "callerReply")?.mentions ?? [];
  if (reply && !replyMentions.some((m) => m.kind === "elevator" && !m.use))
    problems.push(`callerReply must tell people not to use the elevator, e.g. "Do not use the elevator."`);

  // 4. Floors must exist.
  const named = new Set<number>();
  for (const { where, text } of texts) {
    for (const { floors: fs, raw } of findFloors(text)) {
      const bad = fs.filter((f) => !Number.isInteger(f) || f < 1 || f > floors);
      if (bad.length) problems.push(`${where} names floor ${raw}, but the building has floors 1-${floors}.`);
      else if (where !== "callerReply") for (let f = Math.min(...fs); f <= Math.max(...fs); f++) named.add(f);
    }
  }

  // 5. A floor with no clear stairwell must not be left out of the actions.
  for (const e of atRisk.filter((x) => x.stair === null)) {
    if (!named.has(e.floor))
      problems.push(`Floor ${e.floor} (${e.people} people) has no clear stairwell: an action must name floor ${e.floor}, e.g. a rescue crew.`);
  }

  // 6. Every floor at risk must be covered by the actions (the fire floor most of all).
  const missing = atRisk.filter((e) => e.stair !== null && !named.has(e.floor)).map((e) => e.floor);
  if (actions && missing.length)
    problems.push(
      `The actions leave out ${missing.length === 1 ? "floor" : "floors"} ${floorRange(missing)}, which ` +
        `${missing.length === 1 ? "is" : "are"} at risk: evacuate floors ${floorRange(atRisk.map((e) => e.floor))}.`,
    );

  const unique = [...new Set(problems)];
  return unique.length > MAX_PROBLEMS
    ? [...unique.slice(0, MAX_PROBLEMS), `(${unique.length - MAX_PROBLEMS} more problems not shown)`]
    : unique;
}

// ---- The tool ----

export const writeRecommendationSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "write_recommendation",
    description:
      "Submit the final recommendation, after find_clear_exits. It is checked against the exit plan: " +
      "if accepted is false, fix every listed problem and call again (the server's draft is included as a safe reference).",
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_ACTIONS,
          description:
            `1-${MAX_ACTIONS} short imperative actions for the incident commander (each under ${MAX_ACTION_CHARS} characters), ` +
            "based only on the find_clear_exits result: which floors evacuate by which clear stairwell, where to send the " +
            "first crew, who needs help (mobility, children), and every floor listed in noClearStair. " +
            "E.g. 'Evacuate floors 8-12 by Stairwell A'.",
        },
        callerReply: {
          type: "string",
          description:
            `One or two sentences (under ${MAX_REPLY_CHARS} characters) texted to people inside the building: the clear ` +
            "stairwell from find_clear_exits to leave by, any stairwell that fills with smoke as 'do not use Stairwell X', " +
            "and always 'do not use the elevator'. Never name a stairwell find_clear_exits does not recommend as a way out.",
        },
      },
      required: ["actions", "callerReply"],
    },
  },
};

/** Floor of a room id: from the building, else its "7-..." prefix. */
const floorOf = (roomId: string, building: Building) =>
  building.rooms.find((r) => r.id === roomId)?.floor ?? (Number.parseInt(roomId, 10) || 0);

/** Rejected attempts per run. */
const rejections = new WeakMap<RunState, number>();

/**
 * The server's draft, made safe: it is shown to the model as a reference and used as the fallback,
 * so it must pass the same checks. Its callerReply can say "Leave now by Stairwell B or the
 * elevator" (server/src/live/recommend.ts, when no other stairwell fills); a failing reply is
 * replaced with fixed wording built from the exit plan.
 */
export function safeDraft(
  draft: Recommendation | undefined,
  exits: FloorExit[],
  originFloor: number,
  floors: number,
): Recommendation | undefined {
  if (!draft) return undefined;
  if (!checkRecommendation(draft, exits, originFloor, floors).length) return draft;
  const atRisk = exits.filter((e) => isAtRisk(e, originFloor));
  const counts = new Map<string, number>();
  for (const e of atRisk) if (e.stair) counts.set(e.stair, (counts.get(e.stair) ?? 0) + e.people);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const reply = main
    ? `Fire crews are on the way. Leave now by ${stairName(main)}. Do not use the elevator. Stay low if there is smoke.`
    : "Fire crews are on the way. Do not use the elevator. Stay low if there is smoke and follow firefighters' directions.";
  return { actions: [...draft.actions], callerReply: reply };
}

/** The write_recommendation tool: stores run.recommendation once it passes, or the server's draft. */
export const writeRecommendationTool: AgentTool = {
  schema: writeRecommendationSchema,
  run(args, { ctx, run }) {
    const exits = run.exits ?? run.forecast?.exits;
    if (!exits?.length) return { accepted: false, error: "no exit plan yet: call find_clear_exits first" };
    const originId = run.origin?.roomId ?? run.forecast?.origin;
    const originFloor = originId ? floorOf(originId, ctx.building) : 0;
    const floors = Math.max(...ctx.building.rooms.map((r) => r.floor));

    const problems = checkRecommendation(args, exits, originFloor, floors);
    if (!problems.length) {
      run.recommendation = {
        actions: (args.actions as string[]).map((a) => a.trim()),
        callerReply: (args.callerReply as string).trim(),
      };
      return { accepted: true };
    }

    const attempts = (rejections.get(run) ?? 0) + 1;
    rejections.set(run, attempts);
    const draft = safeDraft(run.forecast?.recommendation, exits, originFloor, floors);
    if (attempts >= MAX_ATTEMPTS) {
      if (draft) run.recommendation = { actions: [...draft.actions], callerReply: draft.callerReply };
      return { accepted: false, usedServerDraft: draft !== undefined, problems };
    }
    return { accepted: false, problems, ...(draft ? { draft } : {}) };
  },
};
