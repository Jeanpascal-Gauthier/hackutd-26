// Plays the CBRE demo against a running server, so the team can rehearse it without typing calls:
//   1. fire behind the strip mall on Campbell      -> blast radius, buildings light up
//   2. crash on Coit                               -> linked, not merged; the data center's only road is cut
//   3. water main burst, street flooding           -> water spreads toward the basement electrical rooms
//   4. execute the top building's first action     -> the dollars at risk drop
//
//   npm run demo:cbre -w server                    # server on :8080
//   SERVER_URL=http://localhost:8099 npm run demo:cbre -w server
//   npm run demo:cbre -w server -- --no-execute    # stop before step 4
import { WebSocket } from "ws";
import type { IncidentState, MapIncident } from "@firewatch/shared/types";

const BASE = process.env.SERVER_URL ?? "http://localhost:8080";
const WS = BASE.replace(/^http/, "ws");
const PLACE = process.env.DEMO_PLACE ?? "Campbell Rd and Coit Rd, Richardson, TX";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json() as Promise<Record<string, any>>;
}

async function state(): Promise<IncidentState> {
  return (await (await fetch(BASE + "/state")).json()) as IncidentState;
}

/** Waits until every incident has its forecast and the impact has been worked out. */
async function settled(): Promise<IncidentState> {
  let last = await state();
  for (let i = 0; i < 80; i++) {
    const incidents = last.mapIncidents ?? [];
    const busy = incidents.some((incident) => incident.status === "locating" || incident.forecastStatus === "running");
    if (!busy && incidents.length > 0) {
      await sleep(600); // the impact follows the forecast by a moment
      return state();
    }
    await sleep(500);
    last = await state();
  }
  return last;
}

function show(title: string, s: IncidentState) {
  console.log(`\n== ${title}`);
  for (const i of s.mapIncidents ?? []) line(i);
  const impact = s.portfolioImpact;
  if (!impact) return console.log("   (no portfolio impact: is the impact agent loading? check the server log)");
  console.log(`   ${impact.summary.headline}  [${impact.mode}]`);
  for (const p of impact.properties.slice(0, 5)) {
    const first = p.chain[0];
    console.log(`   - ${p.name}: ${p.risk}, ${p.people} people, ${money(p.cost.totalUsd)}${p.accessCut ? ", ACCESS CUT" : ""}${first ? `, first: min ${first.minute} ${first.label}` : ""}`);
  }
}

function line(i: MapIncident) {
  const links = i.related?.length ? ` linked to ${i.related.join(", ")}` : "";
  console.log(`   ${i.id} ${i.kind} (${i.status}) radius ${i.impact?.radiusMeters ?? "-"} m, ${i.affectedRoads?.length ?? 0} red road sections, zone ${i.zoneId ?? "-"}${links}`);
}

async function execute(propertyId: string, actionId: string): Promise<void> {
  const socket = new WebSocket(WS);
  await new Promise<void>((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
  socket.send(JSON.stringify({ type: "executeAction", propertyId, actionId }));
  await sleep(800);
  socket.close();
}

async function main() {
  console.log(`CBRE demo against ${BASE}, around "${PLACE}"`);
  await post("/live/reset", {}).catch(() => undefined);

  await post("/map-incidents", { type: "fire", address: PLACE, description: "fire behind the strip mall on Campbell, heavy smoke", severity: "critical" });
  show("1. A fire is reported", await settled());
  await sleep(1500);

  await post("/map-incidents", { type: "crash", address: PLACE, description: "two cars, all lanes blocked on Coit", severity: "serious", lanes_blocked: "all" });
  show("2. A crash on Coit: linked, not merged", await settled());
  await sleep(1500);

  await post("/map-incidents", { type: "flood", what: "water main burst", address: PLACE, description: "water main burst, street flooding", severity: "serious" });
  const before = await settled();
  show("3. A water main bursts", before);

  if (process.argv.includes("--no-execute")) return;
  const top = before.portfolioImpact?.properties.find((p) => p.actions.some((a) => a.status === "pending"));
  const next = top?.actions.find((a) => a.status === "pending");
  if (!top || !next) return console.log("\n(nothing to execute)");
  console.log(`\n== 4. Execute at ${top.name}: ${next.text}`);
  await execute(top.id, next.id);
  const after = await state();
  console.log(`   before: ${before.portfolioImpact!.summary.headline}`);
  console.log(`   after:  ${after.portfolioImpact?.summary.headline}`);
  console.log(`   at risk ${money(before.portfolioImpact!.summary.usdAtRiskAfterActions)} -> ${money(after.portfolioImpact?.summary.usdAtRiskAfterActions ?? 0)}`);
}

main().catch((err) => {
  console.error("demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
