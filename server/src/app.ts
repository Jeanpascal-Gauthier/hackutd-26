// The server's parts wired together, without listening: one store, the active building, the live
// incident, building lookups, the ingest path, mock mode, HTTP and the WebSocket. index.ts reads
// the environment and loads the agent; tests build the same app with fakes.
import { IncidentStore } from "./state/store.ts";
import type { ReportProcessor } from "./state/processor.ts";
import { createIngest } from "./state/ingest.ts";
import { createHttpServer } from "./transport/http.ts";
import { attachWebSocket } from "./transport/ws.ts";
import { LiveIncident } from "./live/incident.ts";
import { forecast } from "./live/forecast.ts";
import { ActiveBuilding } from "./live/buildingData.ts";
import { BuildingLookups, type LookupDeps } from "./live/lookup.ts";
import { MockIncident } from "./mock/controller.ts";
import { onActiveBuilding, type OccupancyEstimator } from "./agent/bridge.ts";
import { createBuildingService, type BuildingService } from "./buildings/service.ts";
import { MapIncidents } from "./incidents/service.ts";
import { defaultMapProviders, type MapProviders } from "./incidents/providers.ts";

export interface AppOptions {
  /** Scripted demo calls on the demo building; building lookups are ignored. */
  mock?: boolean;
  tickMs?: number;
  /** Enables POST /voice/report and /voice/address. */
  voiceToken?: string;
  buildings?: BuildingService;
  synthesize?: LookupDeps["synthesize"];
  summarize?: LookupDeps["summarize"];
  estimateOccupancy?: OccupancyEstimator;
  /** Geocoding, roads, nearby buildings and wind for the map. Default: the real providers. */
  mapProviders?: MapProviders;
  /** WebSocket: at most one broadcast per this many ms. 0 sends on every change. Default 100. */
  broadcastMs?: number;
  /** Called by every reset (forgets the agent's per-caller memory). */
  resetAgent?(): void;
}

export function createApp(options: AppOptions = {}) {
  const store = new IncidentStore();
  const active = new ActiveBuilding();
  const live = new LiveIncident(store, active);
  live.reset(); // minute 0, no fire, so the first client sees a valid state

  // Who turns a caller's words into a room: the rule-based locator (live/locate.ts) unless
  // setReportProcessor() plugs in the agent. Either way it is told the active building, and a
  // room the active building doesn't have falls back to the locator.
  let processor: ReportProcessor = live.processor;
  const setReportProcessor = (p: ReportProcessor) => void (processor = p);
  const activeProcessor = onActiveBuilding(
    (input) => processor({ ...input, building: active.get().building }),
    live.processor,
    () => active.roomIds(),
  );

  const buildings = options.buildings ?? createBuildingService();
  const lookups = new BuildingLookups({
    store,
    live,
    buildings,
    getProcessor: () => activeProcessor,
    synthesize: options.synthesize,
    summarize: options.summarize,
    estimateOccupancy: () => options.estimateOccupancy,
    mock: options.mock,
  });
  const ingest = createIngest(store, () => activeProcessor, live, {
    holdReply: () => lookups.holdReply(),
    onHeld: (report) => lookups.onHeld(report),
  });
  const mock = options.mock ? new MockIncident(store, live, ingest, options.tickMs ?? 2000) : undefined;
  const mapIncidents = new MapIncidents(store, options.mapProviders ?? defaultMapProviders(buildings), lookups);
  const resetAgent = () => options.resetAgent?.();

  const httpServer = createHttpServer({
    ingest,
    getState: () => store.get(),
    getBuildingInfo: () => {
      const d = active.get();
      return { building: d.building, occupants: d.occupants, sprinklers: d.sprinklers, doors: d.doors, inspections: d.inspections };
    },
    forecast: (origin, minutes) => forecast(origin, live.data, minutes),
    voiceToken: options.voiceToken,
    buildings,
    lookups,
    mapIncidents,
    // Between judges: back to the demo building, no lookup, no fire, no reports, an empty map.
    resetLive: () => {
      resetAgent();
      if (mock) mock.reset();
      else lookups.resetToDemo();
      mapIncidents.clear();
    },
    mock: mock && {
      reset: () => {
        resetAgent();
        mock.reset();
        mapIncidents.clear();
      },
      replay: () => {
        resetAgent();
        mapIncidents.clear();
        void mock.replay();
      },
    },
  });
  attachWebSocket(httpServer, store, {
    setSimMinute: (minute) => live.goTo(minute),
    roomIds: () => active.roomIds(),
    lookups,
    mapIncidents,
  }, { broadcastMs: options.broadcastMs });

  return { store, active, live, lookups, ingest, mock, httpServer, setReportProcessor, mapIncidents };
}

export type App = ReturnType<typeof createApp>;
