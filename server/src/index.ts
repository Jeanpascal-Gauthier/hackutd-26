// FireSight server entry. Wiring only: store <- (mock fixture | real sim) ; ws + http on one port.
import { IncidentStore } from "./state/store.ts";
import type { ReportProcessor } from "./state/processor.ts";
import { createHttpServer } from "./transport/http.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { MockIncident } from "./mock/controller.ts";
import { mockProcessor } from "./mock/processor.ts";
import { LiveIncident } from "./live/incident.ts";

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 2000);
const MOCK = process.env.MOCK !== "0"; // default on: no API keys or simulation needed
const AUTOPLAY = process.env.AUTOPLAY !== "0";

export const store = new IncidentStore();

const mock = MOCK ? new MockIncident(store, TICK_MS) : undefined;
if (mock) mock.reset(); // start at minute 0 so the first client sees a valid state
// Live mode: real spread model, exits and recommendation from reports sent to POST /ingest.
const live = MOCK ? undefined : new LiveIncident(store);
if (live) live.reset();

// Person C: call setReportProcessor(agentFn) to replace the default locator.
// Mock mode defaults to a keyword stub; live mode to the rule-based locator (live/locate.ts).
let processor: ReportProcessor = live ? live.processor : mockProcessor;
export const setReportProcessor = (p: ReportProcessor) => void (processor = p);

const httpServer = createHttpServer({ store, getProcessor: () => processor, mock, live });
attachWebSocket(httpServer, store, {
  // Mock: replay the fixture at that minute. Live: scrub the precomputed forecast.
  setSimMinute: (minute) => (mock ? mock.goTo(minute) : live!.goTo(minute)),
});

httpServer.listen(PORT, () => {
  console.log(`[server] ws://localhost:${PORT}  POST /ingest  mode=${MOCK ? "mock" : "live"}`);
  if (mock && AUTOPLAY) mock.replay();
});
