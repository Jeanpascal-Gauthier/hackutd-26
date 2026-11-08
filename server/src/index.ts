// FireSight server entry. Wiring only (app.ts): one live incident (real spread model) behind ws +
// http on one port. MOCK=1 (default) also replays scripted calls through it on the demo building;
// MOCK=0 waits for real reports, and an address lookup can switch the incident to a real building.
import { createApp } from "./app.ts";
import { AGENT_EXPORT, guardAgent, loadAgentProcessor, loadAgentReset, loadOccupancyEstimator } from "./agent/bridge.ts";

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 2000);
const MOCK = process.env.MOCK !== "0"; // default on: scripted demo calls, no API keys needed
const AUTOPLAY = process.env.AUTOPLAY !== "0";
const AGENT = process.env.AGENT === "1"; // opt in: Nemotron agent (needs NVIDIA_API_KEY in .env)
const VOICE_TOKEN = process.env.VOICE_TOKEN?.trim() || undefined; // enables POST /voice/report and /voice/address
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 12000); // voice: under the ElevenLabs tool timeout; Nemotron takes ~5 s, 8.5 s worst seen

// Occupancy estimates for looked-up buildings: the agent's estimateOccupancy() is pure code (no
// API key), so it loads whatever AGENT says. Mock mode never leaves the demo building.
const estimateOccupancy = MOCK ? undefined : await loadOccupancyEstimator();

// Clears the agent's memory of each caller's earlier texts, so one demo run doesn't leak into the next.
let resetAgent = () => {};
const app = createApp({ mock: MOCK, tickMs: TICK_MS, voiceToken: VOICE_TOKEN, estimateOccupancy, resetAgent: () => resetAgent() });
export const store = app.store;
export const setReportProcessor = app.setReportProcessor;

// Who turns a caller's words into a room: the rule-based locator (live/locate.ts) by default.
// AGENT=1 registers agent/index.ts's processReport() instead (agent/bridge.ts); a failure or
// timeout on one report falls back to the locator. (The agent can also run as its own
// process and POST its results to /ingest: see server/API.md.)
let agentOn = false;
if (AGENT) {
  const agent = await loadAgentProcessor();
  if (agent) {
    setReportProcessor(guardAgent(agent, app.live.processor, AGENT_TIMEOUT_MS));
    resetAgent = (await loadAgentReset()) ?? resetAgent;
    agentOn = true;
  }
}

app.httpServer.listen(PORT, () => {
  const who = agentOn ? `agent ${AGENT_EXPORT}()` : "rule-based locator";
  const occupancy = MOCK ? "" : `  occupancy->${estimateOccupancy ? "agent estimateOccupancy()" : "unavailable"}`;
  console.log(`[server] ws://localhost:${PORT}  POST /ingest  mode=${MOCK ? "mock (scripted calls)" : "live"}  reports->${who}${occupancy}`);
  if (app.mock && AUTOPLAY) void app.mock.replay();
});
