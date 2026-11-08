import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import building from "@firewatch/shared/building.json";
import type { FloorExit, IncidentState, Report } from "@firewatch/shared/types";
import { FloorPlan } from "./FloorPlan";
import { Building3DPanel } from "./building3d";
import { AgentTrail } from "./AgentTrail";
import { ExitAnalysis } from "./ExitAnalysis";
import { IncidentDecisions, IncidentLog } from "./IncidentActivity";
import { Empty, PanelHeading, roomName, formatTime as time } from "./ui";
import { CheckIcon, FlameIcon, MoonIcon, PauseIcon, PinIcon, PlayIcon, ReplayIcon, SendIcon, StairsIcon, SunIcon, UsersIcon } from "./Icons";
import { useIncident } from "./useIncident";
import { useTheme } from "./theme";
import "./styles.css";

const floors = [...new Set(building.rooms.map((room) => room.floor))].sort((a, b) => b - a);
/** Forecast playback: last minute and step interval. */
const PLAY_END = 30;
const PLAY_STEP_MS = 400;
const logId = (entry: { time: number; kind: string; text: string }) => `${entry.time}-${entry.kind}-${entry.text}`;

/**
 * Ids that arrived after the first observation (not the ones present at load). Runs as a layout effect so
 * a new card gets its highlight class before it is first painted.
 */
function useFreshIds(ids: string[] | null): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const signature = ids?.join("\n");
  useLayoutEffect(() => {
    if (!ids) return;
    if (!known.current) { known.current = new Set(ids); return; }
    const added = ids.filter((id) => !known.current!.has(id));
    if (!added.length) return;
    for (const id of added) known.current.add(id);
    setFresh((previous) => new Set([...previous, ...added]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return fresh;
}

export function App() {
  const { state, connected, mode, send, request } = useIncident();
  const { theme, toggle: toggleTheme } = useTheme();
  const [floor, setFloor] = useState(floors.includes(7) ? 7 : floors[0]);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const floorTabs = useRef<HTMLDivElement>(null);
  const [caller, setCaller] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const reports = [...(state?.reports ?? [])].sort((a, b) => b.time - a.time);
  const affected = state?.rooms.filter((room) => room.fire > 0.01 || room.smoke > 0.01).length ?? 0;
  const occupants = state?.occupants.reduce((sum, occupant) => sum + occupant.count, 0) ?? 0;
  const selected = building.rooms.find((room) => room.id === selectedRoom);
  const selectedState = state?.rooms.find((room) => room.roomId === selectedRoom);
  const selectedOccupants = state?.occupants.filter((occupant) => occupant.room === selectedRoom) ?? [];
  const selectedReports = reports.filter((report) => report.roomId === selectedRoom);
  const minute = state?.simMinute ?? 0;
  // The server forecasts 0-30 minutes in both mock and live mode.
  const maxMinute = PLAY_END;
  const floorStatus = statusByFloor(state);
  const exits = state?.exits ?? [];
  const serverLog = state?.log;
  const freshReports = useFreshIds(state ? state.reports.map((report) => report.id) : null);
  const freshLog = useFreshIds(serverLog ? serverLog.map(logId) : null);

  // Draw a newly accepted decision once, including replacement decisions, never on first load.
  // Clear the token after animation so the accepted route stays static.
  const acceptedSeen = useRef<number | null | undefined>(undefined);
  const [routeDraw, setRouteDraw] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!state) return;
    const now = state.accepted?.time ?? null;
    if (acceptedSeen.current !== undefined && now !== null && acceptedSeen.current !== now) setRouteDraw(now);
    if (now === null) setRouteDraw(null);
    acceptedSeen.current = now;
  }, [state]);
  useEffect(() => {
    if (routeDraw === null) return;
    const timer = setTimeout(() => setRouteDraw(null), 2600);
    return () => clearTimeout(timer);
  }, [routeDraw]);

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
  }, [floor]);

  // Forecast playback: step the shared minute once every 400ms up to 30. Stops at the end, on
  // disconnect, when a send fails, or when the operator drags the slider.
  const [playing, setPlaying] = useState(false);
  const playhead = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;
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

  function togglePlayback() {
    if (playing) { setPlaying(false); return; }
    const start = minute >= PLAY_END ? 0 : minute;
    if (start !== minute && !transmit({ type: "setSimMinute", minute: start })) return;
    playhead.current = start;
    setPlaying(true);
  }

  function focusRoom(id: string) {
    const room = building.rooms.find((item) => item.id === id);
    if (room) { setFloor(room.floor); setSelectedRoom(id); }
  }

  function selectFloor(value: number) {
    setFloor(value);
    setSelectedRoom((id) => building.rooms.find((room) => room.id === id)?.floor === value ? id : null);
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
      setNotice({ kind: "success", text: action === "reset" ? "Demo reset to minute 0." : "Scripted incident replay started." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Demo control failed." });
    } finally { setDemoBusy(false); }
  }

  function transmit(event: Parameters<typeof send>[0]) {
    const ok = send(event);
    if (!ok) setNotice({ kind: "error", text: "Connection lost. Wait for the server to reconnect, then try again." });
    return ok;
  }

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#main"><span className="brand-mark" aria-hidden="true"><FlameIcon size={18} /></span><span>FireSight<small>Incident command</small></span></a>
      <div className="header-meta">
        <span className="mode-badge">{mode === "mock" ? "Scripted demo" : mode === "live" ? "Live server" : connected ? "Mode unknown" : "Connecting"}</span>
        <span className={`connection ${connected ? "online" : "offline"}`} role="status"><i aria-hidden="true" />{connected ? "Connected" : "Reconnecting"}</span>
        <button className="icon-button" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}>{theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}</button>
      </div>
    </header>
    <main id="main">
      <section className="page-heading">
        <h1>Incident overview</h1>
        <p>{state ? `Forecast minute ${minute} · ${reports.length} report${reports.length === 1 ? "" : "s"} · ${floors.length} floors` : "Waiting for incident state"}</p>
      </section>
      {!connected && <div className="connection-banner" role="status">Connecting to the incident server. {state ? "Showing the last received state; controls are paused." : "The dashboard will update as soon as a connection is established."}</div>}
      {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      <StatusStrip state={state} affected={affected} occupants={occupants} reports={reports.length} />
      <div className="dashboard-grid">
        <aside className="column reports-column">
          <section className="panel reports-panel" aria-labelledby="reports-heading"><PanelHeading title="Caller reports" id="reports-heading" aside={<span className="count-badge" aria-label={`${reports.length} reports`}>{reports.length}</span>} /><div className="report-list">{reports.length ? reports.map((report) => <ReportCard key={report.id} report={report} fresh={freshReports.has(report.id)} selected={report.roomId === selectedRoom} onSelect={focusRoom} />) : <Empty title="Listening for reports" text="Incoming reports will appear here as the incident unfolds." />}</div></section>
          <section className="panel" aria-labelledby="manual-heading"><PanelHeading title="Add a report" id="manual-heading" /><form className="report-form" onSubmit={submitReport}>
            <label htmlFor="caller">Caller name<input id="caller" value={caller} onChange={(event) => setCaller(event.target.value)} placeholder="e.g. Dana · floor 7" required maxLength={100} disabled={submitting} /></label>
            <label htmlFor="report">What are they reporting?<textarea id="report" value={text} onChange={(event) => setText(event.target.value)} placeholder="Smoke coming from the break room on floor 7…" required maxLength={2000} rows={4} disabled={submitting} /></label>
            <div className="form-footer"><span>{text.length}/2000</span><button className="button primary" disabled={!connected || submitting || !caller.trim() || !text.trim()}>{submitting ? "Submitting…" : <>Submit report<SendIcon size={15} /></>}</button></div>
          </form></section>
        </aside>
        <section className="column building-column" aria-label="Building and timeline">
          <section className="panel building-panel" aria-labelledby="building-heading">
            <PanelHeading title="Building view" id="building-heading" aside={<span className="subtle">{floors.length} floors</span>} />
            <div className="floor-toolbar"><div ref={floorTabs} className="floor-tabs" role="group" aria-label="Select floor">{floors.map((value) => { const status = floorStatus.get(value); return <button key={value} className={floor === value ? "active" : ""} aria-pressed={floor === value} aria-label={`Floor ${value}${status ? `, ${status}` : ""}`} title={status ? `Floor ${value}: ${status}` : undefined} onClick={() => selectFloor(value)}>{status && <i className={`floor-dot ${status}`} aria-hidden="true" />}{value}</button>; })}</div></div>
            <FloorPlan floor={floor} state={state} selectedRoom={selectedRoom} onSelect={setSelectedRoom} drawRoute={routeDraw} />
            <div className="map-legend"><span><i className="swatch neutral" />No fire or smoke</span><span><i className="swatch smoke" />Smoke</span><span><i className="swatch fire" />Fire</span><span><i className="swatch origin" />Likely origin</span><span><i className="swatch route" />Route (forecast)</span><span><i className="swatch route-active" />Route (active)</span><span><i className="swatch selected" />Selected</span></div>
            {state?.accepted && <p className="route-note">Active outlines mark accepted route segments below the smoke threshold with no visible fire at this minute. Hazard colors remain visible.</p>}
            <div className="room-inspector">{selected ? <>
              <div className="inspector-heading"><div><span className="eyebrow">Room details</span><h3>{selected.name}</h3></div><code>{selected.id}</code></div>
              <div className="room-stats"><span>Fire<strong>{selectedState ? `${Math.round(selectedState.fire * 100)}%` : "No data"}</strong></span><span>Smoke<strong>{selectedState ? `${Math.round(selectedState.smoke * 100)}%` : "No data"}</strong></span><span>Occupants<strong>{selectedOccupants.length ? selectedOccupants.reduce((sum, item) => sum + item.count, 0) : "Unrecorded"}</strong></span></div>
              {selectedOccupants.some((item) => item.flags.length) && <p className="assistance-note">Assistance flags: {[...new Set(selectedOccupants.flatMap((item) => item.flags))].join(", ")}</p>}
              <p className="subtle">{selectedReports.length} report{selectedReports.length === 1 ? "" : "s"} linked to this room.</p>
            </> : <Empty title="Inspect a room" text="Select a room on the floor plan or a location in the report feed." />}</div>
          </section>
          <Building3DPanel state={state} floor={floor} selectedRoom={selectedRoom} onSelectRoom={focusRoom} onSelectFloor={selectFloor} />
          <section className="panel timeline-panel" aria-labelledby="timeline-heading">
            <div className="timeline-heading"><div><h2 id="timeline-heading">Forecast timeline</h2><p className="subtle">Shared with every connected screen</p></div><div className="timeline-controls"><button className="button secondary play-button" disabled={!connected || !state} onClick={togglePlayback} aria-label={playing ? "Pause forecast playback" : `Play forecast from minute ${minute >= PLAY_END ? 0 : minute}`}>{playing ? <><PauseIcon size={15} />Pause</> : <><PlayIcon size={15} />Play</>}</button><span className="minute-readout"><strong>{minute}</strong>of {maxMinute} min</span></div></div>
            <label className="sr-only" htmlFor="timeline">Forecast minute</label><input id="timeline" type="range" min={0} max={maxMinute} step={1} value={Math.min(minute, maxMinute)} disabled={!connected || !state} onChange={(event) => { setPlaying(false); transmit({ type: "setSimMinute", minute: Number(event.target.value) }); }} aria-valuetext={`${minute} minutes`} />
            <div className="timeline-scale"><span>Now</span><span>+{maxMinute} min</span></div>
            {mode === "mock" && <div className="demo-controls"><span>Scripted reports run through the spread model.</span><div><button className="button quiet" disabled={!connected || demoBusy} onClick={() => void demoAction("reset")}>Reset</button><button className="button secondary" disabled={!connected || demoBusy} onClick={() => void demoAction("replay")}><ReplayIcon size={15} />Replay demo</button></div></div>}
            <p className="model-note">Illustrative fire and smoke estimates.</p>
          </section>
          <ExitAnalysis state={state} floor={floor} onSelectRoom={focusRoom} onSelectFloor={selectFloor} />
        </section>
        <aside className="column activity-column">
          <section className="panel recommendation-panel" aria-labelledby="recommendation-heading"><PanelHeading title="Recommended actions" id="recommendation-heading" aside={state?.recommendation ? <span className="pill warn">Needs review</span> : state?.accepted ? <span className="pill safe"><CheckIcon size={13} />Accepted</span> : undefined} />{state?.recommendation ? <div className="recommendation-content fade-in" key={state.recommendation.actions.join("|")}>
            <ol className="action-list">{state.recommendation.actions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}</ol>
            {state.recommendation.callerReply && <div className="caller-reply"><span className="eyebrow">Suggested caller reply</span><p>“{state.recommendation.callerReply}”</p></div>}
            <button className="button primary full-width" disabled={!connected} onClick={() => transmit({ type: "acceptRecommendation" })}><CheckIcon size={16} />Accept recommendation</button><p className="subtle">Commander backup control. Acceptance is shared across clients; caller replies and crew dispatch are handled separately.</p>
          </div> : <Empty title="No recommendation pending" text={state?.accepted ? "The last accepted decision remains visible below." : "New suggested actions will appear here for review."} />}</section>
          <IncidentDecisions state={state} onSelectRoom={focusRoom} />
          {exits.length > 0 && <Evacuation exits={exits} active={!!state?.accepted} onFloor={selectFloor} />}
          <AgentTrail steps={state?.trail} demo={mode === "mock"} />
          <IncidentLog entries={serverLog} freshIds={freshLog} />
        </aside>
      </div>
      <footer className="app-footer"><span><b>FireSight</b> · A shared view for faster decisions.</span><span>{mode === "mock" ? "Synthetic building · Scripted reports · Model forecast" : "Incident state supplied by server"}</span></footer>
    </main>
  </div>;
}

/** The three facts a commander needs first, each as a big value + label, with colour always paired with words. */
function StatusStrip({ state, affected, occupants, reports }: { state: IncidentState | null; affected: number; occupants: number; reports: number }) {
  const exits = state?.exits ?? [];
  const atRisk = exits.filter(isAtRisk).sort((a, b) => a.floor - b.floor);
  const peopleAtRisk = atRisk.reduce((sum, exit) => sum + exit.people, 0);
  const origin = state?.origin;
  const originRoom = building.rooms.find((room) => room.id === origin?.roomId);
  // First stairwell to fill: earliest non-null blockedAt for any stair other than that floor's recommended one.
  let firstFill: { minute: number; stair: string; floor: number } | null = null;
  for (const exit of exits) for (const [stair, at] of Object.entries(exit.blockedAt)) {
    if (at === null || stair === exit.stair) continue;
    if (!firstFill || at < firstFill.minute || (at === firstFill.minute && exit.floor < firstFill.floor)) firstFill = { minute: at, stair, floor: exit.floor };
  }
  const fillDetail = firstFill ? `${stairLabel(firstFill.stair)} at floor ${firstFill.floor}${state && firstFill.minute <= state.simMinute ? " · already filled" : ""}` : exits.length ? "No stairwell forecast to fill" : "Waiting for forecast";
  return <section className="status-strip" aria-label="Incident status">
    <div className={`status-cell origin ${originRoom ? "tone-fire" : ""}`}>
      <span className="status-label"><FlameIcon size={15} />Likely origin</span>
      <span className="status-value">{originRoom ? originRoom.name.replace(/^Floor \d+ /, "") : "—"}{originRoom && <small>floor {originRoom.floor}</small>}</span>
      <span className="status-detail">{origin ? `${Math.round(origin.confidence * 100)}% confidence · ${origin.roomId}` : state ? "Not yet located" : "Waiting for incident state"}</span>
    </div>
    <div className={`status-cell ${atRisk.length ? "tone-fire" : state && exits.length ? "tone-safe" : ""}`}>
      <span className="status-label"><UsersIcon size={15} />Floors to evacuate</span>
      <span className="status-value">{state ? atRisk.length : "—"}{atRisk.length > 0 && <small>{atRisk.length === 1 ? "floor" : "floors"}</small>}</span>
      <span className="status-detail">{atRisk.length ? `${floorRange(atRisk.map((exit) => exit.floor))} · ${peopleAtRisk} people` : state ? "No floors at risk" : "Waiting for forecast"}</span>
    </div>
    <div className={`status-cell ${firstFill ? "tone-warn" : ""}`}>
      <span className="status-label"><StairsIcon size={15} />First stairwell fills</span>
      <span className="status-value">{firstFill ? firstFill.minute : "—"}{firstFill && <small>min</small>}</span>
      <span className="status-detail">{fillDetail}</span>
    </div>
    <div className="status-cell facts">
      <dl className="status-facts">
        <div><dt>Rooms affected</dt><dd>{state ? affected : "—"}</dd></div>
        <div><dt>Occupants recorded</dt><dd>{state ? occupants : "—"}</dd></div>
        <div><dt>Caller reports</dt><dd>{state ? reports : "—"}</dd></div>
      </dl>
    </div>
  </section>;
}

/** "Floors 6–12" or "Floors 3, 7–9". */
function floorRange(values: number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return `${sorted.length === 1 ? "Floor" : "Floors"} ${parts.join(", ")}`;
}

function ReportCard({ report, selected, fresh, onSelect }: { report: Report; selected: boolean; fresh: boolean; onSelect: (id: string) => void }) {
  const canLocate = building.rooms.some((room) => room.id === report.roomId);
  const low = report.confidence !== undefined && report.confidence < 0.7;
  return <article className={`report-card${selected ? " selected-report" : ""}${fresh ? " is-new" : ""}`}><div className="report-meta"><strong>{report.caller}</strong><time dateTime={new Date(report.time).toISOString()}>{time(report.time)}</time></div><p>{report.text}</p><div className="report-location"><button disabled={!canLocate} onClick={() => report.roomId && onSelect(report.roomId)}><PinIcon size={14} />{roomName(report.roomId)}</button>{report.confidence !== undefined && <span className={low ? "confidence low" : "confidence"}>{Math.round(report.confidence * 100)}% confidence{low ? " · low" : ""}</span>}</div></article>;
}

/** Worst condition on each floor, for the floor tab dots. */
function statusByFloor(state: IncidentState | null): Map<number, "fire" | "smoke"> {
  const floorOf = new Map(building.rooms.map((room) => [room.id, room.floor]));
  const out = new Map<number, "fire" | "smoke">();
  for (const room of state?.rooms ?? []) {
    const floor = floorOf.get(room.roomId);
    if (floor === undefined) continue;
    if (room.fire > 0.05) out.set(floor, "fire");
    else if (room.smoke > 0.05 && out.get(floor) !== "fire") out.set(floor, "smoke");
  }
  return out;
}

const isAtRisk = (exit: FloorExit) => exit.atRiskAt !== null || Object.values(exit.blockedAt).some((m) => m !== null);
const stairLabel = (id: string | null) => (id ? `Stair ${id.replace(/^stair-/, "").toUpperCase()}` : "No clear stair");

function Evacuation({ exits, active, onFloor }: { exits: FloorExit[]; active: boolean; onFloor: (floor: number) => void }) {
  const rows = exits.filter(isAtRisk).sort((a, b) => b.floor - a.floor);
  if (!rows.length) return null;
  return <section className="panel" aria-labelledby="evac-heading">
    <PanelHeading title="Evacuation by floor" id="evac-heading" aside={active ? <span className="pill safe">Route active</span> : <span className="pill">Forecast · 30 min</span>} />
    <ul className="evac-list">{rows.map((exit) => {
      const blocked = Object.entries(exit.blockedAt).filter(([id, minute]) => minute !== null && id !== exit.stair) as [string, number][];
      return <li key={exit.floor}>
        <button className="evac-floor" onClick={() => onFloor(exit.floor)} aria-label={`Show floor ${exit.floor}`}>{exit.floor}</button>
        <div className="evac-body">
          <span className={`stair-chip ${active ? "active" : ""}`}><StairsIcon size={14} />Use {stairLabel(exit.stair)}</span>
          {blocked.map(([id, minute]) => <span key={id} className="blocked-chip"><FlameIcon size={13} />{stairLabel(id)} smoke at {minute} min</span>)}
        </div>
        <span className="evac-people" title={exit.flags.length ? `Assistance: ${exit.flags.join(", ")}` : undefined}><UsersIcon size={14} />{exit.people}<span className="sr-only"> people</span>{exit.flags.includes("mobility") && <span className="assist-flag">Assist</span>}</span>
      </li>;
    })}</ul>
  </section>;
}
