// CLI demo of the impact agent: the 3-call story, step by step.
//   1. fire only  2. fire + crash  3. fire + crash + flood  4. execute the data center's top actions
//
//   npm run impact -w agent              # Nemotron when NVIDIA_API_KEY is set, else rules
//   npm run impact -w agent -- --rules   # deterministic path only
import { assessIncident, assessIncidentRules, formatUsd, headlineFor, summarize } from "../core/impact/assess.ts";
import type { AffectedProperty, AgentIncident, IncidentImpactResult, PortfolioBuilding } from "../core/impact/types.ts";
import portfolioJson from "../fixtures/portfolio.json" with { type: "json" };
import { DEMO_CRASH, DEMO_FIRE, DEMO_FLOOD, DEMO_NOW } from "../fixtures/demoIncidents.ts";

const portfolio = portfolioJson as unknown as PortfolioBuilding[];
const RULES = process.argv.includes("--rules") || !process.env.NVIDIA_API_KEY;
const HORIZON = 30;

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

async function run(incidents: AgentIncident[], doneActionIds: string[] = []): Promise<IncidentImpactResult> {
  const opts = { now: DEMO_NOW, horizonMinutes: HORIZON, doneActionIds };
  return RULES ? assessIncidentRules(incidents, portfolio, opts) : assessIncident(incidents, portfolio, opts);
}

function printRadius(r: IncidentImpactResult, incidents: AgentIncident[]) {
  console.log("Blast radius");
  for (const i of incidents) {
    const imp = r.impacts[i.id];
    if (!imp) continue;
    const stretch = imp.stretch ? `, x${imp.stretch.factor.toFixed(1)} toward ${Math.round(imp.stretch.towardDegrees)}°` : "";
    console.log(`  ${pad(i.id, 14)} ${pad(i.kind, 6)} ${pad(i.severity, 9)} ${lpad(imp.radiusMeters, 5)} m${stretch}`);
    console.log(`  ${" ".repeat(14)} ${imp.reasons.join("; ")}`);
  }
}

function printTable(props: AffectedProperty[]) {
  console.log("\nAffected buildings");
  console.log(`  ${pad("building", 28)} ${pad("use", 12)} ${pad("risk", 9)} ${lpad("people", 6)}  ${pad("first failure", 34)} ${lpad("$ at risk", 9)}  access`);
  for (const p of props) {
    const f = p.chain[0];
    const first = f ? `m${f.minute} ${f.label}` : "-";
    console.log(
      `  ${pad(p.name, 28)} ${pad(p.use, 12)} ${pad(p.risk, 9)} ${lpad(p.people, 6)}  ${pad(first, 34)} ${lpad(formatUsd(p.cost.totalUsd), 9)}  ${p.accessCut ? "CUT" : "ok"}`,
    );
  }
  if (!props.length) console.log("  (none)");
}

function printChain(p: AffectedProperty) {
  console.log(`\n${p.name}: failure chain (${p.incidentIds.join(" + ")}), downtime ${p.downtimeHours} h`);
  for (const s of p.chain) {
    const cause = s.causedBy ? `  <- ${s.causedBy.split(":").slice(1).join(":")}` : "";
    console.log(`  min ${lpad(s.minute, 4)}  ${pad(s.hazard, 6)} ${s.label}${cause}`);
  }
  console.log(`  cost: SLA ${formatUsd(p.cost.slaUsd)} · rent ${formatUsd(p.cost.lostRentUsd)} · damage ${formatUsd(p.cost.damageUsd)} = ${formatUsd(p.cost.totalUsd)}`);
  console.log("Actions");
  for (const a of p.actions) {
    const by = a.deadlineMinute <= 0 ? "now     " : `by m${pad(a.deadlineMinute, 4)}`;
    console.log(`  [${a.status === "done" ? "x" : " "}] ${by} ${pad(a.text, 46)} saves ${lpad(formatUsd(a.savesUsd), 7)}  ${a.reason}`);
  }
}

const dataCenter = (r: IncidentImpactResult) => r.affectedProperties.find((p) => p.use === "data_center");

function printStep(title: string, r: IncidentImpactResult, incidents: AgentIncident[], ms: number) {
  console.log(`\n${"=".repeat(100)}\n${title}   [mode ${r.mode}, ${ms} ms]\n${"=".repeat(100)}`);
  printRadius(r, incidents);
  printTable(r.affectedProperties);
  const dc = dataCenter(r);
  if (dc) printChain(dc);
  console.log(`\nTrail: ${r.trail.map((s) => `${s.tool} (${s.ms} ms)`).join(" -> ")}`);
  console.log(`Headline: ${r.summary.headline}`);
  console.log(`Briefing: ${r.briefing}`);
}

async function main() {
  console.log(`Impact demo: ${portfolio.length} portfolio buildings, ${RULES ? "rules (deterministic)" : "Nemotron"} mode`);
  const steps: [string, AgentIncident[]][] = [
    ["Step 1: fire only", [DEMO_FIRE]],
    ["Step 2: fire + crash", [DEMO_FIRE, DEMO_CRASH]],
    ["Step 3: fire + crash + flood", [DEMO_FIRE, DEMO_CRASH, DEMO_FLOOD]],
  ];
  let last: IncidentImpactResult | undefined;
  for (const [title, incidents] of steps) {
    const t = Date.now();
    last = await run(incidents);
    printStep(title, last, incidents, Date.now() - t);
  }
  if (!last) return;

  // Step 4: the operator presses Execute on the data center's dampers + generator / barrier actions.
  const dc = dataCenter(last);
  if (!dc) return console.log("\nNo data center affected: nothing to execute.");
  const picked = dc.actions.filter((a) => /damper|generator|barrier/i.test(a.id));
  const done = (picked.length ? picked : [...dc.actions].sort((a, b) => b.savesUsd - a.savesUsd).slice(0, 2)).map((a) => a.id);
  const s = summarize(last.affectedProperties, HORIZON, done, portfolio);
  console.log(`\n${"=".repeat(100)}\nStep 4: execute ${done.join(", ")}\n${"=".repeat(100)}`);
  console.log(`Before:  ${s.headline}`);
  console.log(`After:   ${headlineFor(s.buildings, s.people, s.usdAtRiskAfterActions, HORIZON)}`);
  console.log(`Saved:   ${formatUsd(s.usdAtRisk - s.usdAtRiskAfterActions)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
