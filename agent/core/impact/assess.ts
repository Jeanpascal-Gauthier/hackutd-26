// The impact orchestrator: incidents + the building portfolio in -> which buildings are hit, what
// fails in what order, what it costs, and what to do. Two paths, same numbers:
//   assessIncident()      Nemotron calls the three impact tools on an ImpactRun scratchpad.
//   assessIncidentRules() The deterministic path: the same tools, called in order, no model.
// Either way the result is complete (anything the model skipped is filled in by rules), and every
// number comes from the tools, never from the model.
import type OpenAI from "openai";
import type { TrailStep } from "@firewatch/shared/types";
import { createNvidiaClient, NVIDIA_FAST, NVIDIA_MODEL } from "../nvidia.ts";
import { classifyBlastRadius, classifyBlastRadiusTool } from "./blastRadius.ts";
import { residualCost } from "./cost.ts";
import { planActions, planActionsTool } from "./planActions.ts";
import { assessPropertyImpact, assessPropertyImpactTool } from "./propertyImpact.ts";
import type {
  AffectedProperty,
  AgentIncident,
  AssessPropertyImpact,
  ClassifyBlastRadius,
  ImpactRun,
  ImpactSummary,
  ImpactTool,
  IncidentImpactResult,
  PlanActions,
  PlannedAction,
  PortfolioBuilding,
} from "./types.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export const CLASSIFY = "classify_blast_radius";
export const ASSESS = "assess_property_impact";
export const PLAN = "plan_actions";

const DEFAULT_HORIZON = 30;
const DEFAULT_TIMEOUT_MS = 12_000;
/** Model turns: classify (one or more turns), assess, plan, retries, the answer. */
const MAX_TURNS = 10;
/** Longer model text than this is not a briefing: the templated one is used instead. */
const MAX_BRIEFING_CHARS = 600;

/** The tool implementations. Tests inject fakes; by default the real impact tools. */
export interface ImpactImpl {
  classify: ClassifyBlastRadius;
  assess: AssessPropertyImpact;
  plan: PlanActions;
  /** The ImpactTools the model may call (and the rules path runs), by schema name. */
  tools: ImpactTool[];
}

export const defaultImpl: ImpactImpl = {
  classify: classifyBlastRadius,
  assess: assessPropertyImpact,
  plan: planActions,
  tools: [classifyBlastRadiusTool, assessPropertyImpactTool, planActionsTool],
};

export interface RulesOptions {
  /** Epoch ms "now", for day/night occupancy. Default Date.now(). */
  now?: number;
  /** Default 30. */
  horizonMinutes?: number;
  /** Actions the operator has executed: marked done, and taken off usdAtRiskAfterActions. */
  doneActionIds?: string[];
  impl?: Partial<ImpactImpl>;
}

export interface AssessContext extends RulesOptions {
  /** The chat model. Tests pass a fake; by default the NVIDIA client (agent/core/nvidia.ts). */
  llm?: OpenAI;
  /** Whole model loop budget, then the rules path. Default 12000. */
  timeoutMs?: number;
}

// =================================================================================================
// Money and the summary
// =================================================================================================

/**
 * "~$380K", "~$1.2M". Under $1M: thousands (nearest $10K from $100K, else nearest $1K);
 * from $1M: millions with one decimal (trailing ".0" dropped).
 */
export function formatUsd(usd: number): string {
  const n = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  if (n === 0) return "$0";
  if (n < 1_000) return `~$${Math.round(n)}`;
  const k = n < 100_000 ? Math.round(n / 1_000) : Math.round(n / 10_000) * 10;
  if (k < 1_000) return `~$${k}K`;
  const m = (Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "");
  return `~$${m}M`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "6 buildings · 1,240 people · ~$380K at risk in the next 30 min" */
export function headlineFor(buildings: number, people: number, usd: number, horizonMinutes: number): string {
  return `${plural(buildings, "building", "buildings")} · ${plural(people, "person", "people")} · ${formatUsd(usd)} at risk in the next ${horizonMinutes} min`;
}

const isDone = (a: PlannedAction, done: Set<string>) => a.status === "done" || done.has(a.id);

/**
 * Totals over the affected properties. usdAtRiskAfterActions prices each chain with the done
 * actions' steps stopped (residualCost). That needs each property's building: pass `portfolio`.
 * Without it (contract gap: ImpactSummary has no portfolio), a property's done actions' savesUsd
 * are subtracted instead, which can over-count when two actions prevent the same step.
 */
export function summarize(
  properties: AffectedProperty[],
  horizonMinutes: number,
  doneActionIds: string[] = [],
  portfolio: PortfolioBuilding[] = [],
): ImpactSummary {
  const done = new Set(doneActionIds);
  const buildings = new Map(portfolio.map((b) => [b.id, b]));
  let people = 0;
  let usdAtRisk = 0;
  let after = 0;
  for (const p of properties) {
    const total = p.cost?.totalUsd ?? 0;
    people += p.people ?? 0;
    usdAtRisk += total;
    const actions = (p.actions ?? []).map((a) => (isDone(a, done) ? { ...a, status: "done" as const } : a));
    const building = buildings.get(p.id);
    if (building) {
      after += residualCost(building, p.chain ?? [], actions).totalUsd;
    } else {
      const saved = actions.filter((a) => a.status === "done").reduce((s, a) => s + (a.savesUsd ?? 0), 0);
      after += Math.max(0, total - saved);
    }
  }
  return {
    buildings: properties.length,
    people,
    usdAtRisk,
    usdAtRiskAfterActions: Math.min(usdAtRisk, after),
    horizonMinutes,
    headline: headlineFor(properties.length, people, usdAtRisk, horizonMinutes),
  };
}

const when = (minute: number) => (minute <= 0 ? "now" : `by minute ${minute}`);

/** The rules briefing: top building, its first failure, its top action, the $ at risk. */
export function templateBriefing(properties: AffectedProperty[], summary: ImpactSummary, incidents: AgentIncident[]): string {
  const top = properties[0];
  if (!top) {
    const n = plural(incidents.length, "incident", "incidents");
    return `No portfolio buildings are within reach of the ${n} in the next ${summary.horizonMinutes} min.`;
  }
  const parts = [`${top.name} is most at risk (${top.risk}).`];
  const first = top.chain?.[0];
  if (first) parts.push(`First failure: ${first.label} at minute ${first.minute}.`);
  const action = top.actions?.find((a) => a.status !== "done") ?? top.actions?.[0];
  if (action) {
    const saves = action.savesUsd > 0 ? `, saves ${formatUsd(action.savesUsd)}` : "";
    parts.push(`Top action: ${action.text} ${when(action.deadlineMinute)}${saves}.`);
  }
  parts.push(`Portfolio: ${summary.headline}.`);
  return parts.join(" ");
}

// =================================================================================================
// Input checks
// =================================================================================================

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPoint = (v: unknown) => isObj(v) && Number.isFinite(v.lat) && Number.isFinite(v.lon);

/** Usable incidents (id, kind, location), first of each id. Never throws. */
function cleanIncidents(incidents: unknown): AgentIncident[] {
  if (!Array.isArray(incidents)) return [];
  const seen = new Set<string>();
  const out: AgentIncident[] = [];
  for (const i of incidents) {
    if (!isObj(i) || typeof i.id !== "string" || !i.id || typeof i.kind !== "string" || !isPoint(i.location)) continue;
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i as unknown as AgentIncident);
  }
  return out;
}

function cleanPortfolio(portfolio: unknown): PortfolioBuilding[] {
  if (!Array.isArray(portfolio)) return [];
  return portfolio.filter(
    (b): b is PortfolioBuilding => isObj(b) && typeof b.id === "string" && isPoint(b.location) && Array.isArray(b.systems),
  );
}

/** Why there is nothing to assess, or undefined when there is. */
function inputProblem(raw: unknown, incidents: AgentIncident[], portfolio: PortfolioBuilding[]): string | undefined {
  if (!Array.isArray(raw)) return "No incidents were given.";
  if (incidents.length === 0) return raw.length ? "None of the incidents has a location yet." : "No incidents were given.";
  if (portfolio.length === 0) return "No portfolio buildings to assess.";
  return undefined;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

// =================================================================================================
// Running tools on the scratchpad
// =================================================================================================

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

interface Runner {
  impl: ImpactImpl;
  tools: Map<string, ImpactTool>;
  run: ImpactRun;
  trail: TrailStep[];
}

/** Run one tool call (model JSON or rules args) and log it. Never throws. Tools are synchronous (ImpactTool.run). */
function callTool(r: Runner, name: string, rawArgs: string | Record<string, unknown>): unknown {
  const started = Date.now();
  const tool = r.tools.get(name);
  const args = typeof rawArgs === "string" ? parseArgs(rawArgs) : rawArgs;
  let input: unknown = args ?? rawArgs;
  let output: unknown;
  if (!tool) output = { error: `unknown tool ${name}` };
  else if (!args) output = { error: `arguments are not a JSON object: ${String(rawArgs).slice(0, 200)}` };
  else {
    try {
      output = tool.run(args, r.run);
    } catch (err) {
      output = { error: errText(err) };
    }
    input = args;
  }
  r.trail.push({ tool: name, input, output, ms: Date.now() - started });
  return output;
}

/**
 * Fill in whatever is missing from the scratchpad, in pipeline order: impacts for every incident,
 * the affected properties, actions for every property. Each gap is first run as a tool call
 * (logged like a model call); if the tool still leaves it missing, the plain function fills it.
 */
function complete(r: Runner): void {
  const { run, impl } = r;
  for (const inc of run.incidents) {
    if (run.impacts[inc.id]) continue;
    callTool(r, CLASSIFY, { incident_id: inc.id });
    if (!run.impacts[inc.id]) {
      try {
        run.impacts[inc.id] = impl.classify(inc);
      } catch {
        // assess_property_impact computes a missing impact itself.
      }
    }
  }
  if (!run.properties) {
    callTool(r, ASSESS, {});
    if (!run.properties) {
      try {
        run.properties = impl.assess(run.incidents, run.portfolio, { ...run.opts, impacts: run.impacts });
      } catch {
        run.properties = [];
      }
    }
  }
  const unplanned = run.properties.filter((p) => !run.actions[p.id]).map((p) => p.id);
  if (unplanned.length) {
    const all = unplanned.length === run.properties.length;
    callTool(r, PLAN, all ? {} : { property_ids: unplanned });
    const buildings = new Map(run.portfolio.map((b) => [b.id, b]));
    for (const p of run.properties) {
      if (run.actions[p.id]) continue;
      const b = buildings.get(p.id);
      try {
        run.actions[p.id] = b ? impl.plan(p, b, run.incidents) : [];
      } catch {
        run.actions[p.id] = [];
      }
    }
  }
}

function newRunner(incidents: AgentIncident[], portfolio: PortfolioBuilding[], opts: RulesOptions): Runner {
  const impl: ImpactImpl = { ...defaultImpl, ...opts.impl };
  return {
    impl,
    tools: new Map(impl.tools.map((t) => [t.schema.function.name, t])),
    run: {
      incidents,
      portfolio,
      opts: { horizonMinutes: opts.horizonMinutes ?? DEFAULT_HORIZON, now: opts.now ?? Date.now() },
      impacts: {},
      actions: {},
    },
    trail: [],
  };
}

/** The result from a completed scratchpad. Done ids are marked on the actions. */
function resultOf(r: Runner, mode: IncidentImpactResult["mode"], doneActionIds: string[], briefing?: string): IncidentImpactResult {
  const { run } = r;
  const done = new Set(doneActionIds);
  const affectedProperties = (run.properties ?? []).map((p) => ({
    ...p,
    actions: (run.actions[p.id] ?? p.actions ?? []).map((a) => (isDone(a, done) ? { ...a, status: "done" as const } : a)),
  }));
  const summary = summarize(affectedProperties, run.opts.horizonMinutes, doneActionIds, run.portfolio);
  return {
    impacts: run.impacts,
    affectedProperties,
    summary,
    trail: r.trail,
    mode,
    briefing: briefing ?? templateBriefing(affectedProperties, summary, run.incidents),
  };
}

function emptyResult(horizonMinutes: number, reason: string, trail: TrailStep[] = []): IncidentImpactResult {
  return { impacts: {}, affectedProperties: [], summary: summarize([], horizonMinutes), trail, mode: "rules", briefing: reason };
}

// =================================================================================================
// The deterministic path
// =================================================================================================

/**
 * Fully deterministic: classify each incident, assess the portfolio, plan each property, summarize.
 * The trail lists those calls as if a model had made them. Never throws: bad input gives an empty
 * result with the reason as the briefing.
 */
export function assessIncidentRules(incidents: AgentIncident[], portfolio: PortfolioBuilding[], opts: RulesOptions = {}): IncidentImpactResult {
  return rules(incidents, portfolio, opts);
}

/** The rules path, with an optional first trail step saying why the model was not used. */
function rules(incidents: unknown, portfolio: unknown, opts: RulesOptions, note?: TrailStep): IncidentImpactResult {
  const horizon = opts.horizonMinutes ?? DEFAULT_HORIZON;
  const pre = note ? [note] : [];
  try {
    const inc = cleanIncidents(incidents);
    const port = cleanPortfolio(portfolio);
    const problem = inputProblem(incidents, inc, port);
    if (problem) return emptyResult(horizon, problem, pre);
    const r = newRunner(inc, port, opts);
    r.trail.push(...pre);
    complete(r);
    return resultOf(r, "rules", opts.doneActionIds ?? []);
  } catch (err) {
    return emptyResult(horizon, `Impact assessment failed: ${errText(err)}`, pre);
  }
}

// =================================================================================================
// The Nemotron path
// =================================================================================================

export function impactSystemPrompt(horizonMinutes: number): string {
  return `You are Firewatch's facilities-impact analyst for a CBRE-style portfolio of commercial buildings (data centers, hospitals, offices, retail).
Emergencies (fires, crashes, floods) are listed in the user message. Work out which portfolio buildings they hit, which building systems fail in what order, what it costs, and what the facility manager should do in the next ${horizonMinutes} minutes.

1. Call classify_blast_radius once for EACH incident listed, with its incident_id.
2. Then call assess_property_impact once (no arguments needed): it finds the affected buildings, their failure chains and the $ at risk.
3. Then call plan_actions once (no arguments needed): it plans the actions for each affected building.
4. Then answer with a 2-3 sentence briefing for the facility manager: name the top building, its first failure and the minute it happens, the top action and its deadline minute, and the $ at risk.
   Use numbers ONLY from the tool results. Never invent a building, system, minute or dollar amount. No lists, no markdown.`;
}

function userMessage(incidents: AgentIncident[], portfolio: PortfolioBuilding[], horizonMinutes: number): string {
  const lines = [`${plural(incidents.length, "incident", "incidents")}, ${portfolio.length} portfolio buildings, horizon ${horizonMinutes} min:`];
  for (const i of incidents) {
    const extra = [
      i.severity,
      i.inBuilding ? "in a building" : "",
      i.lanesBlocked ? `lanes blocked: ${i.lanesBlocked}` : "",
      i.source ?? "",
      i.description ? JSON.stringify(i.description.slice(0, 120)) : "",
    ].filter(Boolean);
    lines.push(`- incident_id ${i.id}: ${i.kind} at ${i.location.lat.toFixed(5)}, ${i.location.lon.toFixed(5)}${extra.length ? ` (${extra.join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

let client: OpenAI | undefined;

class Cancelled extends Error {}

/** The model loop. Returns the model's final text (may be empty). */
async function modelLoop(llm: OpenAI, r: Runner, signal: AbortSignal): Promise<{ text: string; toolCalls: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: impactSystemPrompt(r.run.opts.horizonMinutes) },
    { role: "user", content: userMessage(r.run.incidents, r.run.portfolio, r.run.opts.horizonMinutes) },
  ];
  const schemas = r.impl.tools.map((t) => t.schema);
  let toolCalls = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal.aborted) throw new Cancelled("cancelled");
    const res = await llm.chat.completions.create(
      {
        model: NVIDIA_MODEL,
        messages,
        tools: schemas,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 1024,
        ...NVIDIA_FAST,
      },
      { signal },
    );
    if (signal.aborted) throw new Cancelled("cancelled");
    const msg = res.choices[0]?.message;
    if (!msg) return { text: "", toolCalls };
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) return { text: (msg.content ?? "").trim(), toolCalls };

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const output = callTool(r, call.function.name, call.function.arguments);
      if (r.tools.has(call.function.name)) toolCalls++;
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output ?? null) });
    }
  }
  return { text: "", toolCalls };
}

/** Model text usable as the briefing: non-empty, short, no reasoning tags. */
function cleanBriefing(text: string): string | undefined {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return t && t.length < MAX_BRIEFING_CHARS ? t : undefined;
}

const fallbackNote = (reason: string, ms = 0): TrailStep => ({
  tool: "nemotron",
  input: { model: NVIDIA_MODEL },
  output: { error: reason, fallback: "rules" },
  ms,
});

/**
 * Nemotron runs the three impact tools; the result is completed by rules if it skipped any, so it
 * is always whole. Falls back to the rules path (mode "rules", reason in the trail) when there is
 * no NVIDIA_API_KEY, the model call throws, or the loop takes longer than `timeoutMs`.
 */
export async function assessIncident(
  incidents: AgentIncident[],
  portfolio: PortfolioBuilding[],
  ctx: AssessContext = {},
): Promise<IncidentImpactResult> {
  const horizon = ctx.horizonMinutes ?? DEFAULT_HORIZON;
  const done = ctx.doneActionIds ?? [];
  const started = Date.now();
  try {
    const inc = cleanIncidents(incidents);
    const port = cleanPortfolio(portfolio);
    const problem = inputProblem(incidents, inc, port);
    if (problem) return emptyResult(horizon, problem);

    let llm: OpenAI;
    try {
      llm = ctx.llm ?? (client ??= createNvidiaClient());
    } catch (err) {
      return rules(inc, port, ctx, fallbackNote(errText(err)));
    }

    const r = newRunner(inc, port, ctx);
    const controller = new AbortController();
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`model timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    let out: { text: string; toolCalls: number };
    try {
      out = await Promise.race([modelLoop(llm, r, controller.signal), timeout]);
    } catch (err) {
      controller.abort();
      return rules(inc, port, ctx, fallbackNote(errText(err), Date.now() - started));
    } finally {
      clearTimeout(timer);
    }

    if (out.toolCalls === 0) {
      return rules(inc, port, ctx, fallbackNote("the model called no impact tools", Date.now() - started));
    }
    complete(r);
    const result = resultOf(r, "llm", done);
    const text = cleanBriefing(out.text);
    return text ? { ...result, briefing: text } : result;
  } catch (err) {
    return rules(incidents, portfolio, ctx, fallbackNote(`impact agent failed: ${errText(err)}`));
  }
}
