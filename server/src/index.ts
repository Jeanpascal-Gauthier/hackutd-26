// FireSight server entry. Wiring only: one live incident (real spread model) behind ws + http on
// one port. MOCK=1 (default) also replays scripted calls through it; MOCK=0 waits for real reports.
import { IncidentStore } from "./state/store.ts";
import type { ReportProcessor } from "./state/processor.ts";
import { createIngest } from "./state/ingest.ts";
import { createHttpServer } from "./transport/http.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { LiveIncident } from "./live/incident.ts";
import { forecast } from "./live/forecast.ts";
import { sprinklers } from "./live/buildingData.ts";
import { MockIncident } from "./mock/controller.ts";
import { AGENT_EXPORT, guardAgent, loadAgentProcessor, loadAgentReset } from "./agent/bridge.ts";

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 2000);
const MOCK = process.env.MOCK !== "0"; // default on: scripted demo calls, no API keys needed
const AUTOPLAY = process.env.AUTOPLAY !== "0";
const AGENT = process.env.AGENT === "1"; // opt in: Nemotron agent (needs NVIDIA_API_KEY in .env)
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 20000);

export const store = new IncidentStore();
const live = new LiveIncident(store);
live.reset(); // minute 0, no fire, so the first client sees a valid state

// Who turns a caller's words into a room: the rule-based locator (live/locate.ts) by default.
// AGENT=1 registers agent/index.ts's processReport() instead (agent/bridge.ts); a failure or
// timeout on one report falls back to the locator. (The agent can also run as its own
// process and POST its results to /ingest: see server/API.md.)
let processor: ReportProcessor = live.processor;
export const setReportProcessor = (p: ReportProcessor) => void (processor = p);
let agentOn = false;
// Clears the agent's memory of each caller's earlier texts, so one demo run doesn't leak into the next.
let resetAgent = () => {};
if (AGENT) {
  const agent = await loadAgentProcessor();
  if (agent) {
    setReportProcessor(guardAgent(agent, live.processor, AGENT_TIMEOUT_MS));
    resetAgent = (await loadAgentReset()) ?? resetAgent;
    agentOn = true;
  }
}

const ingest = createIngest(store, () => processor, live);
const mock = MOCK ? new MockIncident(store, live, ingest, TICK_MS) : undefined;

const httpServer = createHttpServer({
  ingest,
  getState: () => store.get(),
  buildingInfo: { building: live.data.building, occupants: live.data.occupants, sprinklers },
  forecast: (origin, minutes) => forecast(origin, live.data, minutes),
  resetLive: () => {
    resetAgent();
    mock ? mock.reset() : live.reset();
  },
  mock: mock && {
    reset: () => {
      resetAgent();
      mock.reset();
    },
    replay: () => {
      resetAgent();
      void mock.replay();
    },
  },
});
attachWebSocket(httpServer, store, {
  setSimMinute: (minute) => live.goTo(minute),
});

httpServer.listen(PORT, () => {
  const who = agentOn ? `agent ${AGENT_EXPORT}()` : "rule-based locator";
  console.log(`[server] ws://localhost:${PORT}  POST /ingest  mode=${MOCK ? "mock (scripted calls)" : "live"}  reports->${who}`);
  if (mock && AUTOPLAY) void mock.replay();
});
