// `npm run demo`: the real FireSight demo in one terminal.
//   server  : live mode with the Nemotron agent (AGENT=1 MOCK=0), port 8080
//   console : Vite dev server, port 5173
//   headset : headset/ Vite dev server (IWSDK plugin, self-signed HTTPS), port 8081, all interfaces
//   form    : the QR fallback report form (agent/form), port 8090, all interfaces
//   photon  : the Photon 2.0 line (agent/photon), when PHOTON_PROJECT_ID + PHOTON_API_KEY are in .env
// Env is set through concurrently's JS API (not shell syntax) so it works the same in
// PowerShell, cmd and Git Bash. Ctrl+C stops all three; if one dies, the others are stopped.
//
// Flags (after `--`, e.g. `npm run demo -- --mock --no-headset`):
//   --mock        scripted demo calls, no agent (MOCK=1 AGENT=0): the fallback if the agent/API is down
//   --no-agent    live mode with the rule-based locator (MOCK=0 AGENT=0)
//   --no-headset  server + console only
//   --no-form     don't start the QR report form
//   --no-photon   don't start the Photon line even if its credentials are set
//   --watch       restart the server on file changes (tsx watch); default is a plain start
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";
import { printUrls } from "./urls.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADSET_DIR = path.join(ROOT, "headset");
const PORTS = { server: 8080, console: 5173, headset: 8081, form: 8090 };

const KNOWN = ["--mock", "--no-agent", "--no-headset", "--no-form", "--no-photon", "--watch", "--help", "-h"];
const args = process.argv.slice(2);
const unknown = args.filter((a) => !KNOWN.includes(a));
if (args.includes("--help") || args.includes("-h") || unknown.length) {
  if (unknown.length) console.error(`Unknown flag(s): ${unknown.join(" ")}\n`);
  console.log("Usage: npm run demo -- [--mock] [--no-agent] [--no-headset] [--no-form] [--no-photon] [--watch]");
  process.exit(unknown.length ? 1 : 0);
}
const mock = args.includes("--mock");
const agent = !mock && !args.includes("--no-agent");
const headset = !args.includes("--no-headset");
const watch = args.includes("--watch");
const form = !args.includes("--no-form");
const envText = existsSync(path.join(ROOT, ".env")) ? readFileSync(path.join(ROOT, ".env"), "utf8") : "";
const hasEnv = (name) => !!process.env[name] || new RegExp(String.raw`^\s*${name}\s*=\s*\S`, "m").test(envText);
const photonLine = hasEnv("PHOTON_PROJECT_ID") && hasEnv("PHOTON_API_KEY") ? "Photon 2.0" : undefined;
const photon = !args.includes("--no-photon") && !!photonLine;

function fail(msg) {
  console.error(`\n[demo] ${msg}\n`);
  process.exit(1);
}

// --- preflight -------------------------------------------------------------------------------
if (headset && !existsSync(path.join(HEADSET_DIR, "node_modules"))) {
  fail("headset/node_modules is missing. Run `npm install --prefix headset` once (or use `npm run demo -- --no-headset`).");
}
if (agent) {
  const envFile = path.join(ROOT, ".env");
  const hasKey = process.env.NVIDIA_API_KEY || (existsSync(envFile) && /^\s*NVIDIA_API_KEY\s*=\s*\S/m.test(readFileSync(envFile, "utf8")));
  if (!hasKey) console.warn("[demo] WARNING: no NVIDIA_API_KEY in the root .env. Every report will fall back to the rule-based locator. Use `-- --mock` for the scripted demo.");
}

/** True if something accepts connections on localhost:port (IPv4 or IPv6). */
function inUse(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (v) => (s.destroy(), resolve(v));
      s.setTimeout(500, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.some(Boolean));
}
const wanted = {
  server: PORTS.server,
  console: PORTS.console,
  ...(headset ? { headset: PORTS.headset } : {}),
  ...(form ? { form: PORTS.form } : {}),
};
const busy = [];
for (const [name, port] of Object.entries(wanted)) if (await inUse(port)) busy.push(`${port} (${name})`);
if (busy.length) {
  fail(`Port(s) already in use: ${busy.join(", ")}. Stop the other dev server first (\`netstat -ano | findstr :8080\` shows the PID).`);
}

// --- launch ----------------------------------------------------------------------------------
const commands = [
  {
    name: "server",
    prefixColor: "red",
    command: `npm run ${watch ? "dev" : "start"} -w server`,
    cwd: ROOT,
    env: { MOCK: mock ? "1" : "0", AGENT: agent ? "1" : "0", PORT: String(PORTS.server) },
  },
  { name: "console", prefixColor: "cyan", command: "npm run dev -w console", cwd: ROOT },
];
if (headset) {
  // `npm run dev` in headset/ is `iwsdk dev restart --open --foreground`: it wraps this same
  // script, opens a managed browser and waits for it to register a runtime session. Plain
  // `dev:runtime` (vite) already gets the IWSDK plugin's self-signed HTTPS on 0.0.0.0:8081.
  // IWSDK_DEV_OPEN=false stops the plugin from downloading (~120 MB, first run) and launching
  // its own Playwright Chromium; the Quest and your own browser don't need it.
  commands.push({
    name: "headset",
    prefixColor: "magenta",
    command: "npm run dev:runtime",
    cwd: HEADSET_DIR,
    env: { IWSDK_DEV_OPEN: "false" },
  });
}

if (form) {
  commands.push({ name: "form", prefixColor: "green", command: "npm run form -w agent", cwd: ROOT, env: { FORM_PORT: String(PORTS.form) } });
}
if (photon) {
  // Retries on its own if the line can't connect, so a Photon problem never stops the demo.
  commands.push({ name: "photon", prefixColor: "yellow", command: "npm run photon -w agent", cwd: ROOT });
}

console.log(
  `[demo] server: ${mock ? "MOCK=1 (scripted calls, no agent)" : `MOCK=0 live, ${agent ? "AGENT=1 Nemotron agent" : "AGENT=0 rule-based locator"}`}` +
    `${headset ? "" : "  | headset: off"}${form ? "" : "  | form: off"}` +
    `  | photon: ${photon ? `on (${photonLine})` : photonLine ? "off (--no-photon)" : "off (no Photon credentials in .env)"}  | Ctrl+C stops everything`,
);

const { result, commands: running } = concurrently(commands, {
  prefix: "name",
  killOthersOn: ["failure", "success"],
  restartTries: 0,
});

// Print the URLs once everything says it is up (or after 30 s), so they don't scroll away.
const ready = new Set();
const markers = { server: "[server] ws://", console: "ready in", headset: "ready in", form: "[form] report page", photon: "[photon] listening" };
let printed = false;
const printOnce = () => {
  if (printed) return;
  printed = true;
  printUrls({ headset, form, serverPort: PORTS.server, consolePort: PORTS.console, headsetPort: PORTS.headset, formPort: PORTS.form });
  console.log("[demo] reset between judges: `npm run demo:reset` (second terminal)   check: `npm run demo:check`");
};
const fallbackTimer = setTimeout(printOnce, 30000);
for (const cmd of running) {
  const marker = markers[cmd.name];
  cmd.stdout.subscribe((buf) => {
    if (ready.has(cmd.name) || !String(buf).includes(marker)) return;
    ready.add(cmd.name);
    if (ready.size === running.length) {
      clearTimeout(fallbackTimer);
      setTimeout(printOnce, 300);
    }
  });
}

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
