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

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 2000);
const MOCK = process.env.MOCK !== "0"; // default on: scripted demo calls, no API keys needed
const AUTOPLAY = process.env.AUTOPLAY !== "0";

export const store = new IncidentStore();
const live = new LiveIncident(store);
live.reset(); // minute 0, no fire, so the first client sees a valid state

// Person C: either POST the agent's result to /ingest (see server/API.md), or call
// setReportProcessor(agentFn) to replace the rule-based locator (live/locate.ts) in-process.
let processor: ReportProcessor = live.processor;
export const setReportProcessor = (p: ReportProcessor) => void (processor = p);

const ingest = createIngest(store, () => processor, live);
const mock = MOCK ? new MockIncident(store, live, ingest, TICK_MS) : undefined;

const httpServer = createHttpServer({
  ingest,
  getState: () => store.get(),
  buildingInfo: { building: live.data.building, occupants: live.data.occupants, sprinklers },
  forecast: (origin, minutes) => forecast(origin, live.data, minutes),
  resetLive: () => (mock ? mock.reset() : live.reset()),
  mock,
});
attachWebSocket(httpServer, store, {
  setSimMinute: (minute) => live.goTo(minute),
});

httpServer.listen(PORT, () => {
  console.log(`[server] ws://localhost:${PORT}  POST /ingest  mode=${MOCK ? "mock (scripted calls)" : "live"}`);
  if (mock && AUTOPLAY) void mock.replay();
});
