import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { IncidentState, Report } from "@firewatch/shared/types";
import { BuildingProvider, roomPeople, useActiveBuildingSource, useBuilding, type ActiveBuilding } from "./activeBuilding";
import { BuildingPanel } from "./BuildingPanel";
import { devFixture } from "./devFixture";
import { SurroundingsMap } from "./SurroundingsMap";
import { Building3DPanel } from "./building3d";
import { AgentTrail } from "./AgentTrail";
import { ExitAnalysis } from "./ExitAnalysis";
import { IncidentDecisions, IncidentLog } from "./IncidentActivity";
import { EvacuationPriorities, IncidentSummary, PriorityActions } from "./IncidentPriority";
import { Empty, PanelHeading, PeopleCount, Timestamp, formatTime as time } from "./ui";
import { FlameIcon, MoonIcon, PauseIcon, PinIcon, PlayIcon, ReplayIcon, SendIcon, SunIcon } from "./Icons";
import { useIncident } from "./useIncident";
import { useTheme } from "./theme";
import "./styles.css";
import "./dispatch.css";

const PLAY_END = 30;
const PLAY_STEP_MS = 400;
const logId = (entry: { time: number; kind: string; text: string }) => `${entry.time}-${entry.kind}-${entry.text}`;

function useFreshIds(ids: string[] | null): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const signature = ids?.join("\n");
  useLayoutEffect(() => {
    if (!ids) return;
    if (!known.current) { known.current = new Set(ids); return; }
    if (!ids.length) { known.current.clear(); setFresh(new Set()); return; }
    const added = ids.filter((id) => !known.current!.has(id));
    if (!added.length) return;
    known.current = new Set(ids);
    setFresh((previous) => new Set([...previous, ...added].filter((id) => known.current!.has(id))));
    // The signature tracks the identifiers without rerunning for unchanged snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return fresh;
}

export function App() {
  const { state: liveState, connected, mode, send, request, lastUpdated } = useIncident();
  // Dev-only fixtures (?fixture=lookup | tower) stand in for a server with the building endpoints.
  const fixture = useMemo(() => import.meta.env.DEV ? devFixture() : null, []);
  const state = fixture?.state ?? liveState;
  const { active, sync } = useActiveBuildingSource(state, fixture?.building);
  const { floors } = active;
  const { theme, toggle: toggleTheme } = useTheme();
  const [floor, setFloor] = useState(floors.includes(7) ? 7 : floors[floors.length - 1]!);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "3d">(() => fixture?.view ?? (new URLSearchParams(location.search).get("view") === "map" ? "map" : "3d"));
  const [showAllReports, setShowAllReports] = useState(false);
  const floorTabs = useRef<HTMLDivElement>(null);
  const [caller, setCaller] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const playhead = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;

  const minute = state?.simMinute ?? 0;
  const reports = [...(state?.reports ?? [])].sort((a, b) => b.time - a.time);
  const visibleReports = showAllReports ? reports : reports.slice(0, 3);
  const freshReports = useFreshIds(state ? state.reports.map((report) => report.id) : null);
  const freshLog = useFreshIds(state?.log ? state.log.map(logId) : null);
  const selected = active.roomsById.get(selectedRoom ?? "");
  const selectedState = state?.rooms.find((room) => room.roomId === selectedRoom);
  const selectedOccupants = state?.occupants.filter((occupant) => occupant.room === selectedRoom) ?? [];
  const selectedPeople = roomPeople(state, selectedRoom ?? "");
  const floorStatus = statusByFloor(state, active);

  // Another building became active: clear the selection and show the fire floor (else the lowest floor).
  const geometrySeen = useRef(active.geometryKey);
  useLayoutEffect(() => {
    if (geometrySeen.current === active.geometryKey) return;
    geometrySeen.current = active.geometryKey;
    setSelectedRoom(null);
    setFloor(fireFloor(state, active));
    // Only a geometry change resets the view; later state updates keep the operator's floor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.geometryKey]);
  const trailErrors = state?.trail?.filter((step) => typeof step.output === "object" && step.output !== null && "error" in step.output && Boolean(step.output.error)).length ?? 0;

  useEffect(() => {
    const tabs = floorTabs.current;
    if (!tabs) return;
    const revealActiveFloor = () => {
      const active = tabs.querySelector<HTMLElement>("[aria-pressed=true]");
      if (!active) return;
      const offset = active.getBoundingClientRect().left - tabs.getBoundingClientRect().left;
      if (offset < 0 || offset + active.offsetWidth > tabs.clientWidth) tabs.scrollLeft += offset - 8;
    };
    revealActiveFloor();
    const resize = new ResizeObserver(revealActiveFloor);
    resize.observe(tabs);
    return () => resize.disconnect();
  }, [floor, view]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = playhead.current + 1;
      if (next > PLAY_END || !sendRef.current({ type: "setSimMinute", minute: next })) { setPlaying(false); return; }
      playhead.current = next;
      if (next >= PLAY_END) setPlaying(false);
    }, PLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [playing]);
  useEffect(() => { if (!connected) setPlaying(false); }, [connected]);

  function transmit(event: Parameters<typeof send>[0]) {
    // Fixtures never reach the real server.
    if (fixture) { console.info("[fixture] not sent:", event); return true; }
    const ok = send(event);
    if (!ok) setNotice({ kind: "error", text: "Connection lost. Wait for reconnection, then try again." });
    return ok;
  }

  function scrub(value: number) {
    setPlaying(false);
    transmit({ type: "setSimMinute", minute: value });
  }

  function togglePlayback() {
    if (playing) { setPlaying(false); return; }
    const start = minute >= PLAY_END ? 0 : minute;
    if (start !== minute && !transmit({ type: "setSimMinute", minute: start })) return;
    playhead.current = start;
    setPlaying(true);
  }

  function focusRoom(id: string) {
    const room = active.roomsById.get(id);
    if (room) { setView("3d"); setFloor(room.floor); setSelectedRoom(id); }
  }

  function selectFloor(value: number) {
    if (!floors.includes(value)) return;
    setView("3d");
    setFloor(value);
    setSelectedRoom((id) => active.roomsById.get(id ?? "")?.floor === value ? id : null);
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !caller.trim() || !text.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await request("/ingest", { caller: caller.trim(), text: text.trim() });
      setText("");
      setNotice({ kind: "success", text: "Report received by the server." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not submit report." });
    } finally { setSubmitting(false); }
  }

  async function demoAction(action: "reset" | "replay") {
    setPlaying(false);
    setDemoBusy(true);
    setNotice(null);
    try {
      await request(`/mock/${action}`);
      setNotice({ kind: "success", text: action === "reset" ? "Demo reset to minute 0." : "Demo replay started." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Demo control failed." });
    } finally { setDemoBusy(false); }
  }

  return (
    <BuildingProvider value={active}>
    <div className="app-shell dispatch-shell">
      <a className="skip-link" href="#main">Skip to incident</a>
      <header className="app-header">
        <a className="brand" href="#main"><span className="brand-mark" aria-hidden="true"><FlameIcon size={22} /></span><span>FireWatch<small>Dispatch</small></span></a>
        <div className="header-meta">
          <span className="mode-badge">{mode === "mock" ? "Scripted demo" : mode === "live" ? "Server connected" : "Connecting"}</span>
          <span className={`connection ${connected ? "online" : "offline"}`} role="status"><i aria-hidden="true" />{connected ? "Connected" : "Disconnected"}</span>
          <button className="icon-button" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>{theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}</button>
        </div>
      </header>

      <main id="main" className="dispatch-page">
        <div className="dispatch-heading">
          <div><h1>Incident overview</h1><p>{reports.length} caller report{reports.length === 1 ? "" : "s"}{lastUpdated !== null && <> · Last update <Timestamp value={lastUpdated} /></>}</p></div>
          <div className={`forecast-context ${minute > 0 ? "forecast-ahead" : ""}`}><strong>Forecast +{minute} min</strong>{minute > 0 && <button className="text-button" disabled={!connected} onClick={() => scrub(0)}>Back to 0 min</button>}</div>
        </div>
        {!connected && <div className="connection-banner" role="alert"><strong>Server disconnected.</strong> {state ? "Showing the last received state. Controls are paused." : "Waiting for incident data."}</div>}
        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}

        <IncidentSummary state={state} onLocate={focusRoom} />

        <div className="dispatch-layout">
          <aside className="command-column" aria-label="Actions and evacuation priorities">
            <BuildingPanel state={state} connected={connected} mode={mode} sync={sync} onSend={transmit} />
            <PriorityActions state={state} connected={connected} onAccept={() => transmit({ type: "acceptRecommendation" })} />
            <EvacuationPriorities state={state} floor={floor} onFloor={selectFloor} />
          </aside>

          <div className="workspace-column">
            <section id="building-view" className="panel primary-map" aria-labelledby="building-heading">
              <div className="panel-heading map-heading">
                <h2 id="building-heading">{view === "3d" ? `${active.isDemo ? "Building" : active.profile.name} · Floor ${floor}` : "Address surroundings"}</h2>
                <div className="view-switch" role="group" aria-label="Building view">
                  <button aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D building</button>
                  <button aria-pressed={view === "map"} onClick={() => setView("map")}>Surroundings</button>
                </div>
              </div>
              {view === "3d" && <div className="floor-toolbar"><span className="floor-strip-label">Floor</span><div ref={floorTabs} className="floor-tabs" role="group" aria-label="Select floor">
                {floors.map((value) => {
                  const status = floorStatus.get(value);
                  return <button key={value} className={floor === value ? "active" : ""} aria-pressed={floor === value} aria-label={`Floor ${value}${status ? `, ${status}` : ""}`} onClick={() => selectFloor(value)}>{status && <i className={`floor-dot ${status}`} aria-hidden="true" />}{value}</button>;
                })}
              </div></div>}
              {view === "map" ? <SurroundingsMap lookup={state?.buildingLookup} />
                : <Building3DPanel state={state} floor={floor} selectedRoom={selectedRoom} onSelectRoom={focusRoom} onSelectFloor={selectFloor} onUnavailable={() => { setView("map"); setNotice({ kind: "info", text: "3D view is unavailable on this device. Showing the surroundings map." }); }} />}
              {view === "3d" && (selected ? (
                <div className="room-inspector">
                  <div className="inspector-heading"><h3>{selected.name}</h3><button className="text-button" onClick={() => setSelectedRoom(null)}>Close details</button></div>
                  <div className="room-stats"><span>Fire<strong>{selectedState ? `${Math.round(selectedState.fire * 100)}%` : "No data"}</strong></span><span>Smoke<strong>{selectedState ? `${Math.round(selectedState.smoke * 100)}%` : "No data"}</strong></span><span>Occupants<strong>{selectedPeople.known ? <PeopleCount count={selectedPeople.count} estimated={selectedPeople.estimated} unit="" /> : "Unrecorded"}</strong></span></div>
                  {selectedOccupants.some((item) => item.flags.length) && <p className="assistance-note">Assistance: {[...new Set(selectedOccupants.flatMap((item) => item.flags))].join(", ")}</p>}
                </div>
              ) : <p className="map-hint">Select a room to see conditions and occupants.</p>)}

              <div className="compact-timeline">
                <div className="timeline-heading"><div><h3>Forecast +{minute} min</h3><span className="subtle">Changes all connected screens</span></div><button className="button secondary play-button" disabled={!connected || !state} onClick={togglePlayback} aria-label={playing ? "Pause forecast playback" : "Play forecast"}>{playing ? <><PauseIcon size={18} />Pause</> : <><PlayIcon size={18} />Play</>}</button></div>
                <label className="sr-only" htmlFor="timeline">Forecast minute</label><input id="timeline" type="range" min={0} max={PLAY_END} step={1} value={Math.min(minute, PLAY_END)} disabled={!connected || !state} onChange={(event) => scrub(Number(event.target.value))} aria-valuetext={`Forecast ${minute} minutes`} />
                <div className="timeline-scale"><span>0 min</span><span>+30 min</span></div>
              </div>
            </section>

            <div className="reports-workspace">
              <section className="panel reports-panel" aria-labelledby="reports-heading">
                <PanelHeading title="Latest caller reports" id="reports-heading" count={reports.length} />
                <div id="report-list" className="report-list" role="log" aria-label="Caller reports" aria-live="polite" aria-relevant="additions">
                  {visibleReports.length ? visibleReports.map((report) => <ReportCard key={report.id} report={report} fresh={freshReports.has(report.id)} selected={report.roomId === selectedRoom} onSelect={focusRoom} />) : <Empty title="Waiting for reports" text="Incoming caller reports will appear here." />}
                </div>
                {reports.length > 3 && <button className="show-reports" aria-expanded={showAllReports} aria-controls="report-list" onClick={() => setShowAllReports(!showAllReports)}>{showAllReports ? "Show latest 3" : `Show all ${reports.length} reports`}</button>}
              </section>
              <section className="panel manual-panel" aria-labelledby="manual-heading">
                <PanelHeading title="Add caller report" id="manual-heading" />
                <form className="report-form" onSubmit={submitReport}>
                  <label htmlFor="caller">Caller<input id="caller" value={caller} onChange={(event) => setCaller(event.target.value)} placeholder="Name or phone number" required maxLength={100} disabled={submitting} /></label>
                  <label htmlFor="report">Report<textarea id="report" value={text} onChange={(event) => setText(event.target.value)} placeholder="Location, smoke or fire, people needing help…" required maxLength={2000} rows={3} disabled={submitting} /></label>
                  <button className="button primary full-width" disabled={!connected || submitting || !caller.trim() || !text.trim()}>{submitting ? "Submitting…" : <>Submit report<SendIcon size={18} /></>}</button>
                </form>
              </section>
            </div>
          </div>
        </div>

        <section className="supporting-details" aria-label="Additional incident details">
          <h2>Additional details</h2>
          <Disclosure title="Detailed forecasts" note="Smoke-arrival times and assistance flags" badge={`${state?.exits?.length ?? 0} floors`}>
            <ExitAnalysis state={state} floor={floor} onSelectRoom={focusRoom} onSelectFloor={selectFloor} />
          </Disclosure>
          <Disclosure title="Activity & decisions" note="Accepted actions, dispatches, and shared history" badge={`${countLabel(state?.dispatches?.length ?? 0, "dispatch", "dispatches")} · ${countLabel(state?.log?.length ?? 0, "event")}`}>
            <div className="activity-details"><IncidentDecisions state={state} onSelectRoom={focusRoom} /><IncidentLog entries={state?.log} freshIds={freshLog} /></div>
          </Disclosure>
          <Disclosure title="Agent activity" note="Recorded tool calls and results" badge={`${countLabel(state?.trail?.length ?? 0, "call")}${trailErrors ? ` · ${countLabel(trailErrors, "error")}` : ""}`}>
            <AgentTrail steps={state?.trail} demo={mode === "mock"} />
          </Disclosure>
          {mode === "mock" && <Disclosure title="Demo controls" note="Reset or replay the scripted incident" badge="Demo only"><div className="demo-controls"><p>These controls reset the shared incident for all clients.</p><div><button className="button quiet" disabled={!connected || demoBusy} onClick={() => void demoAction("reset")}>Reset demo</button><button className="button secondary" disabled={!connected || demoBusy} onClick={() => void demoAction("replay")}><ReplayIcon size={18} />Replay demo</button></div></div></Disclosure>}
        </section>
        <footer className="app-footer"><span>FireWatch · Dispatch workspace</span><span>Illustrative model forecast{mode === "mock" ? " · Scripted reports" : ""}</span></footer>
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

function ReportCard({ report, selected, fresh, onSelect }: { report: Report; selected: boolean; fresh: boolean; onSelect: (id: string) => void }) {
  const { roomsById, roomName } = useBuilding();
  const canLocate = roomsById.has(report.roomId ?? "");
  const uncertain = !report.roomId || report.confidence === undefined || report.confidence < 0.7;
  return (
    <article className={`report-card${selected ? " selected-report" : ""}${fresh ? " is-new" : ""}`}>
      <div className="report-meta"><strong>{report.caller}</strong><time dateTime={new Date(report.time).toISOString()}>{time(report.time)}</time></div>
      <p>{report.text}</p>
      <div className="report-location"><button disabled={!canLocate} onClick={() => report.roomId && onSelect(report.roomId)}><PinIcon size={16} />{roomName(report.roomId)}</button>{uncertain && <span className="pill warn">Location uncertain</span>}</div>
    </article>
  );
}

/** Floor to show for a newly active building: the origin's floor, else the hottest room's, else the lowest. */
function fireFloor(state: IncidentState | null, active: ActiveBuilding): number {
  const origin = active.roomsById.get(state?.origin?.roomId ?? "");
  if (origin) return origin.floor;
  const hottest = [...(state?.rooms ?? [])].filter((room) => room.fire > 0.05 && active.roomsById.has(room.roomId)).sort((a, b) => b.fire - a.fire)[0];
  if (hottest) return active.roomsById.get(hottest.roomId)!.floor;
  return active.floors.includes(1) ? 1 : active.floors[0] ?? 1;
}

function statusByFloor(state: IncidentState | null, active: ActiveBuilding): Map<number, "fire" | "smoke"> {
  const out = new Map<number, "fire" | "smoke">();
  for (const room of state?.rooms ?? []) {
    const floor = active.roomsById.get(room.roomId)?.floor;
    if (floor === undefined) continue;
    if (room.fire > 0.05) out.set(floor, "fire");
    else if (room.smoke > 0.05 && out.get(floor) !== "fire") out.set(floor, "smoke");
  }
  return out;
}
