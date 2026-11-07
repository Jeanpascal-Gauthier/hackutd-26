// FireSight server entry. Wiring only: store <- (mock fixture | real sim) ; ws + http on one port.
import { IncidentStore } from "./state/store.ts";
import type { ReportProcessor } from "./state/processor.ts";
import { createHttpServer } from "./transport/http.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { MockIncident } from "./mock/controller.ts";
import { mockProcessor } from "./mock/processor.ts";

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 2000);
const MOCK = process.env.MOCK !== "0"; // default on: no API keys or simulation needed
const AUTOPLAY = process.env.AUTOPLAY !== "0";

export const store = new IncidentStore();

// Person C: call setReportProcessor(agentFn) to replace the mock.
let processor: ReportProcessor = mockProcessor;
export const setReportProcessor = (p: ReportProcessor) => void (processor = p);

const mock = MOCK ? new MockIncident(store, TICK_MS) : undefined;
if (mock) mock.reset(); // start at minute 0 so the first client sees a valid state

const httpServer = createHttpServer({ store, getProcessor: () => processor, mock });
attachWebSocket(httpServer, store, {
  // Mock: replay the fixture at that minute. Real mode: set minute on the simulation (not built yet).
  setSimMinute: (minute) => (mock ? mock.goTo(minute) : store.patch({ simMinute: minute })),
});

httpServer.listen(PORT, () => {
  console.log(`[server] ws://localhost:${PORT}  POST /ingest  mock=${MOCK}`);
  if (mock && AUTOPLAY) mock.replay();
});
