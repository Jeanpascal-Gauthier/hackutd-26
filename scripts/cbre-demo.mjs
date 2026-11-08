// `npm run demo:cbre`: the scripted CBRE portfolio-impact demo, one call per run (works in any shell).
//   npm run demo:cbre                 next call (1: fire, 2: crash, 3: flood), then the impact card
//   npm run demo:cbre -- --all        all three calls at once
//   npm run demo:cbre -- --execute    execute the data center's dampers + flood barriers: before -> after
//   npm run demo:cbre -- --reset      clear the map and start the script over
// Server routes: POST /portfolio/demo/step|run|reset, GET /portfolio/impact (server/API.md).
const SERVER = process.env.SERVER_URL ?? "http://localhost:8080";
const DATA_CENTER = "dc-lookout";
const EXECUTE = ["close-dampers", "flood-barriers"];
const args = new Set(process.argv.slice(2));

async function call(method, path) {
  const res = await fetch(`${SERVER}${path}`, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw Object.assign(new Error(body.error ?? `${method} ${path}: HTTP ${res.status}`), { http: true });
  return body;
}

const impact = async () => (await call("GET", "/portfolio/impact")).portfolioImpact;
const usd = (n) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1_000)}K`);
const when = (minute) => (minute <= 0 ? "now" : `in ${minute} min`);

function printCard(pi) {
  if (!pi || !pi.summary.buildings) return console.log("Impact:    no portfolio buildings at risk (is the agent loaded? see the server log)");
  const top = pi.affectedProperties[0];
  // A blocked road is a cause, not a failure: lead with the first system that breaks.
  const sorted = [...top.chain].sort((a, b) => a.minute - b.minute);
  const first = sorted.find((s) => s.hazard !== "access") ?? sorted[0];
  const action = [...top.actions].filter((a) => a.status !== "done").sort((a, b) => b.savesUsd - a.savesUsd)[0];
  console.log(`Impact:    ${pi.summary.headline}   [${pi.mode}]`);
  console.log(`Top:       ${top.name} (${top.use.replace("_", " ")}, ${top.risk} risk, ${usd(top.cost.totalUsd)})`);
  if (first) console.log(`First:     ${first.label} ${when(first.minute)}`);
  if (action) console.log(`Do:        ${action.text}${action.deadlineMinute > 0 ? ` by minute ${action.deadlineMinute}` : " now"} (saves ${usd(action.savesUsd)})`);
}

async function execute() {
  const before = await impact();
  const dc = before?.affectedProperties.find((p) => p.id === DATA_CENTER);
  if (!dc) return console.log(`The data center (${DATA_CENTER}) is not at risk yet: run \`npm run demo:cbre\` first.`);
  const picked = EXECUTE.map((suffix) => ({ suffix, action: dc.actions.find((a) => a.id.endsWith(suffix)) }));
  let after = before;
  for (const { suffix, action } of picked) {
    if (!action) {
      console.log(`Skipped:   no ${suffix} action on ${dc.name} yet`);
      continue;
    }
    after = (await call("POST", `/portfolio/actions/${encodeURIComponent(action.id)}/execute`)).portfolioImpact;
    console.log(`Executed:  ${action.text} (${dc.name})`);
  }
  console.log(`Before:    ${before.summary.headline}`);
  console.log(`After:     ${after.summary.headline}`);
  console.log(`Saved:     ${usd(before.summary.usdAtRiskAfterActions - after.summary.usdAtRiskAfterActions)}`);
}

try {
  if (args.has("--reset")) {
    await call("POST", "/portfolio/demo/reset");
    console.log("Reset: empty map, the script starts over at the fire, real clock back.");
  } else if (args.has("--execute")) {
    await execute();
  } else {
    const out = await call("POST", args.has("--all") ? "/portfolio/demo/run" : "/portfolio/demo/step");
    if (out.done) console.log(`All ${out.of} calls are in. Next: \`npm run demo:cbre -- --execute\`, or \`-- --reset\` to start over.`);
    else console.log(`Call ${out.step}/${out.of}: ${out.added.map((a) => a.label).join(", ")} on the map`);
    printCard(out.portfolioImpact ?? (await impact()));
  }
} catch (err) {
  if (err.http) console.error(`Server said: ${err.message}`);
  else console.error(`Could not reach the server at ${SERVER}: ${err.cause?.code ?? err.message}. Is \`npm run demo\` running?`);
  process.exitCode = 1;
}
