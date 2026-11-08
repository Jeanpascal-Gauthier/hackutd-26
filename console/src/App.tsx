import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { LogEntry, MapIncident } from "@firewatch/shared/types";
import { BuildingProvider, useActiveBuildingSource } from "./activeBuilding";
import { AgentTrail } from "./AgentTrail";
import { BRAND_NAME } from "./brand";
import { CallerReports } from "./CallerReports";
import { devFixture } from "./devFixture";
import { IncidentTools } from "./IncidentTools";
import { IncidentDecisions, IncidentLog } from "./IncidentActivity";
import { PriorityActions } from "./IncidentPriority";
import { IncidentQueue, IncidentStrip } from "./IncidentQueue";
import { buildingDecisions, buildCallQueue, buildQueue, type IncidentSelection } from "./incidents";
import { MapPanel } from "./MapPanel";
import { MoonIcon, ReplayIcon, SceneIcon, SunIcon } from "./Icons";
import { HTTP_URL, useIncident } from "./useIncident";
import type { PortfolioBuilding } from "./map/portfolioModel";
import { useTheme } from "./theme";
import { Timestamp, useFreshIds } from "./ui";
import "./styles.css";
import "./dispatch.css";
import "./IncidentWorkspace.css";

const logId = (entry: { time: number; kind: string; text: string }) => `${entry.time}-${entry.kind}-${entry.text}`;

export function App() {
  const { state: liveState, connected: liveConnected, mode, send, request, lastUpdated } = useIncident();
  // Dev-only fixtures (?fixture=lookup | tower | map) stand in for a server.
  const fixture = useMemo(() => import.meta.env.DEV ? devFixture() : null, []);
  const state = fixture?.state ?? liveState;
  const connected = fixture ? true : liveConnected;
  const { active } = useActiveBuildingSource(state, fixture?.building);
  const { theme, toggle: toggleTheme } = useTheme();
  const [demoBusy, setDemoBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  const [selection, setSelection] = useState<IncidentSelection | null>(null);
  const [portfolioBuildings, setPortfolioBuildings] = useState<PortfolioBuilding[]>([]);
  useEffect(() => {
    if (fixture || !liveConnected) return;
    const controller = new AbortController();
    void fetch(`${HTTP_URL}/portfolio`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error("Portfolio unavailable");
        const result = await response.json();
        if (!controller.signal.aborted && result.ok && Array.isArray(result.buildings)) setPortfolioBuildings(result.buildings);
      }).catch(() => { /* Published summary and actions still work without the optional building cost details. */ });
    return () => controller.abort();
  }, [fixture, liveConnected]);

  const incidents = useMemo(() => state?.mapIncidents ?? [], [state?.mapIncidents]);
  const queue = useMemo(() => buildQueue(state, active), [state, active]);
  const selected: MapIncident | null = selection?.kind === "map" ? incidents.find((incident) => incident.id === selection.id) ?? null : null;
  const buildingSelected = selection?.kind === "building";
  const ownerSelected = selected !== null && selected.id === queue.ownerId;

  // Pick the first incident only when nothing valid is selected, so new arrivals never steal focus.
  useLayoutEffect(() => {
    setSelection((current) => {
      if (current?.kind === "map" && incidents.some((incident) => incident.id === current.id)) return current;
      if (current?.kind === "building") {
        if (queue.building) return current;
        if (queue.ownerId) return { kind: "map", id: queue.ownerId };
      }
      return queue.active[0]?.selection ?? null;
    });
  }, [queue, incidents]);

  function transmit(event: Parameters<typeof send>[0]) {
    // Fixtures never reach the real server.
    if (fixture) { console.info("[fixture] not sent:", event); return true; }
    const ok = send(event);
    if (!ok) setNotice({ kind: "error", text: "Connection lost. Wait for reconnection, then try again." });
    return ok;
  }

  async function submitRequest(path: string, body?: unknown) {
    if (fixture) { console.info("[fixture] not sent:", path, body); return {}; }
    return request(path, body);
  }

  async function demoAction(action: "reset" | "replay") {
    setDemoBusy(true);
    setNotice(null);
    try {
      await submitRequest(`/mock/${action}`);
      setNotice({ kind: "success", text: action === "reset" ? "Demo reset to minute 0." : "Demo replay started." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Demo control failed." });
    } finally { setDemoBusy(false); }
  }

  const allReports = state?.reports ?? [];
  // Building-pipeline records have no incidentId; they belong to whichever entry holds the building.
  const inScope = (record: { incidentId?: string }) => selected ? record.incidentId === selected.id || (ownerSelected && !record.incidentId) : buildingSelected ? !record.incidentId : true;
  const calls = useMemo(() => buildCallQueue(state, queue), [state, queue]);
  const log: LogEntry[] | undefined = state?.log?.filter(inScope);
  const freshReports = useFreshIds(state ? state.reports.map((report) => report.id) : null);
  const freshLog = useFreshIds(state?.log ? state.log.map(logId) : null);
  const buildingActions = buildingDecisions(state);
  const decisions = selected
    ? { accepted: selected.accepted, dispatches: selected.dispatches ?? [] }
    : { accepted: buildingActions.accepted, dispatches: state?.dispatches ?? [] };
  const trailErrors = state?.trail?.filter((step) => typeof step.output === "object" && step.output !== null && "error" in step.output && Boolean(step.output.error)).length ?? 0;

  return (
    <BuildingProvider value={active}>
    <div className="app-shell dispatch-shell">
      <a className="skip-link" href="#main">Skip to incident</a>
      <header className="app-header">
        <a className="brand" href="#main"><span className="brand-mark" aria-hidden="true"><SceneIcon size={22} /></span><span>{BRAND_NAME}<small>Dispatch</small></span></a>
        <div className="header-meta">
          <span className="mode-badge">{fixture ? "Fixture demo" : mode === "mock" ? "Scripted demo" : mode === "live" ? "Server connected" : "Connecting"}</span>
          <span className={`connection ${connected ? "online" : "offline"}`} role="status"><i aria-hidden="true" />{connected ? "Connected" : "Disconnected"}</span>
          <button className="icon-button" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>{theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}</button>
        </div>
      </header>

      <main id="main" className="dispatch-page">
        <div className="dispatch-heading">
          <div><h1>Incident overview</h1><p>{allReports.length} caller report{allReports.length === 1 ? "" : "s"}{lastUpdated !== null && <> · Last update <Timestamp value={lastUpdated} /></>}</p></div>
        </div>
        {!connected && <div className="connection-banner" role="alert"><strong>Server disconnected.</strong> {state ? "Showing the last received state. Controls are paused." : "Waiting for incident data."}</div>}
        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}

        <IncidentStrip queue={queue} selected={selected} selection={selection} />

        <div className="dispatch-layout incident-layout">
          <aside className="command-column" aria-label="Incident queue and actions">
            <IncidentQueue queue={queue} state={state} selection={selection} onSelect={setSelection} />
            {selected
              ? <PriorityActions pending={selected.recommendation} accepted={selected.accepted} connected={connected} onAccept={() => transmit({ type: "acceptRecommendation", incidentId: selected.id })} variant="incident" />
              : buildingSelected && <PriorityActions pending={buildingActions.recommendation} accepted={buildingActions.accepted} connected={connected} onAccept={() => transmit({ type: "acceptRecommendation" })} />}
            <CallerReports calls={calls} selection={selection} onSelect={setSelection} freshIds={freshReports} />
          </aside>

          <div className="workspace-column">
            <MapPanel key={fixture?.mapScenario?.id ?? "live"} incidents={incidents} selected={selected} scenario={fixture?.mapScenario} portfolio={fixture ? undefined : liveState?.portfolioImpact} portfolioBuildings={portfolioBuildings} activity={state?.log} connected={connected} onExecuteAction={async (actionId) => { await request(`/portfolio/actions/${encodeURIComponent(actionId)}/execute`); }} onSelect={(id) => setSelection({ kind: "map", id })} />
            {selected && <IncidentTools key={selected.id} incident={selected} />}
            {buildingSelected && <div className="notice info" role="status">This report uses the legacy building-fire intake. Its caller reports and decisions remain available.</div>}
          </div>
        </div>

        <section className="supporting-details" aria-label="Additional incident details">
          <h2>Additional details</h2>
          <Disclosure title="Activity & decisions" note="Accepted actions, dispatches, and shared history" badge={`${countLabel(decisions.dispatches.length, "dispatch", "dispatches")} · ${countLabel(log?.length ?? 0, "event")}`}>
            <div className="activity-details"><IncidentDecisions accepted={decisions.accepted} dispatches={decisions.dispatches} /><IncidentLog entries={log} freshIds={freshLog} /></div>
          </Disclosure>
          {buildingSelected && <Disclosure title="Legacy agent activity" note="Building-fire pipeline only" badge={`${countLabel(state?.trail?.length ?? 0, "call")}${trailErrors ? ` · ${countLabel(trailErrors, "error")}` : ""}`}>
            <AgentTrail steps={state?.trail} demo={mode === "mock"} />
          </Disclosure>}
          {mode === "mock" && <Disclosure title="Demo controls" note="Reset or replay the scripted incident" badge="Demo only"><div className="demo-controls"><p>These controls reset the shared incident for all clients.</p><div><button className="button quiet" disabled={!connected || demoBusy} onClick={() => void demoAction("reset")}>Reset demo</button><button className="button secondary" disabled={!connected || demoBusy} onClick={() => void demoAction("replay")}><ReplayIcon size={18} />Replay demo</button></div></div></Disclosure>}
        </section>
        <footer className="app-footer"><span>{BRAND_NAME} · Dispatch workspace</span><span>Caller reports & response{mode === "mock" ? " · Scripted reports" : ""}</span></footer>
      </main>
    </div>
    </BuildingProvider>
  );
}

function Disclosure({ title, note, badge, children }: { title: string; note: string; badge: string; children: ReactNode }) {
  return <details className="support-panel"><summary><span><strong>{title}</strong><small>{note}</small></span><span className="disclosure-badge">{badge}</span></summary><div className="support-content">{children}</div></details>;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
