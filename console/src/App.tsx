import { useState, type CSSProperties, type FormEvent } from "react";
import building from "@firewatch/shared/building.json";
import type { FloorExit, IncidentState, Report, TrailStep } from "@firewatch/shared/types";
import { FloorPlan } from "./FloorPlan";
import { AgentTrail, type AgentStep } from "./AgentTrail";
import { CheckIcon, FlameIcon, PinIcon, PulseIcon, ReplayIcon, SendIcon, StairsIcon, UsersIcon } from "./Icons";
import { useIncident } from "./useIncident";
import "./styles.css";

const floors = [...new Set(building.rooms.map((room) => room.floor))].sort((a, b) => b - a);
const roomName = (id?: string) => building.rooms.find((room) => room.id === id)?.name ?? id ?? "Location pending";
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function App() {
  const { state, connected, mode, send, request, log } = useIncident();
  const [floor, setFloor] = useState(floors.includes(7) ? 7 : floors[0]);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
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
  const maxMinute = Math.max(30, minute);
  const floorStatus = statusByFloor(state);
  const exits = state?.exits ?? [];
  const peopleAtRisk = exits.filter(isAtRisk).reduce((sum, exit) => sum + exit.people, 0);
  const steps = (state?.trail ?? []).map(toStep);
  const serverLog = state?.log;

  function focusRoom(id: string) {
    const room = building.rooms.find((item) => item.id === id);
    if (room) { setFloor(room.floor); setSelectedRoom(id); }
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
    if (!send(event)) setNotice({ kind: "error", text: "Connection lost. Wait for the server to reconnect, then try again." });
  }

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#main"><span className="brand-mark" aria-hidden="true"><FlameIcon size={22} /></span><span>FireSight<small>INCIDENT COMMAND</small></span></a>
      <div className="header-meta"><span className="workspace-label">DISPATCH WORKSPACE</span><span className={`connection ${connected ? "online" : "offline"}`} role="status"><i />{connected ? "Connected" : "Reconnecting"}</span></div>
    </header>
    <main id="main">
      <section className="page-heading">
        <div>
          <div className="eyebrow">OPERATIONS / BUILDING OVERVIEW</div>
          <h1>Every report. One clear picture.</h1>
          <p>Track the incident, inspect rooms, and review the next action.</p>
        </div>
        <span className="mode-badge">
          {mode === "mock" ? "SCRIPTED DEMO" : mode === "live" ? "LIVE SERVER" : connected ? "SERVER MODE UNAVAILABLE" : "CONNECTING TO SERVER"}
        </span>
      </section>
      {!connected && <div className="connection-banner" role="status">Connecting to the incident server. {state ? "Showing the last received state; controls are paused." : "The dashboard will update as soon as a connection is established."}</div>}
      {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      <section className="metrics" aria-label="Incident summary">
        <Metric label="SIMULATION TIME" value={state ? `${minute.toString().padStart(2, "0")} min` : "—"} detail={mode === "mock" ? "10-minute scripted incident" : "Shared across connected clients"} />
        <Metric label="ROOMS AFFECTED" value={state ? String(affected).padStart(2, "0") : "—"} detail="Fire or smoke reported in state" accent />
        <Metric label="OCCUPANTS RECORDED" value={state ? String(occupants).padStart(2, "0") : "—"} detail={exits.length ? `${peopleAtRisk} on floors at risk` : "From current incident data"} />
        <Metric label="REPORTS RECEIVED" value={state ? String(reports.length).padStart(2, "0") : "—"} detail="Caller reports in this timeline" />
      </section>
      <div className="dashboard-grid">
        <aside className="column reports-column">
          <section className="panel reports-panel" aria-labelledby="reports-heading"><PanelHeading label="INBOUND" title="Caller reports" id="reports-heading" count={reports.length} /><div className="report-list">{reports.length ? reports.map((report) => <ReportCard key={report.id} report={report} selected={report.roomId === selectedRoom} onSelect={focusRoom} />) : <Empty title="Listening for reports" text="Incoming reports will appear here as the incident unfolds." />}</div></section>
          <section className="panel" aria-labelledby="manual-heading"><PanelHeading label="OPERATOR INPUT" title="Add a report" id="manual-heading" /><form className="report-form" onSubmit={submitReport}>
            <label htmlFor="caller">Caller name<input id="caller" value={caller} onChange={(event) => setCaller(event.target.value)} placeholder="e.g. Dana · floor 7" required maxLength={100} disabled={submitting} /></label>
            <label htmlFor="report">What are they reporting?<textarea id="report" value={text} onChange={(event) => setText(event.target.value)} placeholder="Smoke coming from the break room on floor 7…" required maxLength={2000} rows={4} disabled={submitting} /></label>
            <div className="form-footer"><span>{text.length}/2000</span><button className="button primary" disabled={!connected || submitting || !caller.trim() || !text.trim()}>{submitting ? "Submitting…" : <>Submit report<SendIcon size={14} /></>}</button></div>
          </form></section>
        </aside>
        <section className="column building-column" aria-label="Building and timeline">
          <section className="panel building-panel" aria-labelledby="building-heading">
            <div className="building-heading"><PanelHeading label="SPATIAL OVERVIEW" title="Building view" id="building-heading" /><span className="subtle">{floors.length} floors in current dataset</span></div>
            <div className="floor-toolbar"><div className="floor-tabs" role="group" aria-label="Select floor">{floors.map((value) => { const status = floorStatus.get(value); return <button key={value} className={floor === value ? "active" : ""} aria-pressed={floor === value} aria-label={`Floor ${value}${status ? `, ${status}` : ""}`} onClick={() => { setFloor(value); setSelectedRoom(null); }}>{status && <i className={`floor-dot ${status}`} aria-hidden="true" />}Floor {value}</button>; })}</div><span className="view-label">FLOOR PLAN / METRES</span></div>
            <FloorPlan floor={floor} state={state} selectedRoom={selectedRoom} onSelect={setSelectedRoom} />
            <div className="map-legend"><span><i className="swatch neutral" />No fire / smoke</span><span><i className="swatch smoke" />Smoke</span><span><i className="swatch fire" />Fire</span><span><i className="swatch selected" />Selected</span><span><i className="swatch origin" />Likely origin</span><span><i className="swatch route" />Evacuation route</span></div>
            <div className="room-inspector">{selected ? <>
              <div className="inspector-heading"><div><span className="eyebrow">ROOM DETAILS</span><h3>{selected.name}</h3></div><code>{selected.id}</code></div>
              <div className="room-stats"><span>Fire<strong>{selectedState ? `${Math.round(selectedState.fire * 100)}%` : "No data"}</strong></span><span>Smoke<strong>{selectedState ? `${Math.round(selectedState.smoke * 100)}%` : "No data"}</strong></span><span>Occupants<strong>{selectedOccupants.length ? selectedOccupants.reduce((sum, item) => sum + item.count, 0) : "Unrecorded"}</strong></span></div>
              {selectedOccupants.some((item) => item.flags.length) && <p className="assistance-note">Assistance flags: {[...new Set(selectedOccupants.flatMap((item) => item.flags))].join(", ")}</p>}
              <p className="subtle">{selectedReports.length} report{selectedReports.length === 1 ? "" : "s"} linked to this room.</p>
            </> : <Empty title="Inspect a room" text="Select a room on the floor plan or a location in the report feed." />}</div>
          </section>
          <section className="panel timeline-panel" aria-labelledby="timeline-heading">
            <div className="timeline-heading"><div><span className="eyebrow">SHARED TIMELINE</span><h2 id="timeline-heading">Explore the incident</h2></div><span className="minute-badge">+{minute} min</span></div>
            <label className="sr-only" htmlFor="timeline">Simulation minute</label><input id="timeline" type="range" min={0} max={maxMinute} step={1} value={Math.min(minute, maxMinute)} disabled={!connected || !state} onChange={(event) => transmit({ type: "setSimMinute", minute: Number(event.target.value) })} aria-valuetext={`${minute} minutes`} />
            <div className="timeline-scale"><span>NOW / 0 MIN</span><span>+{maxMinute} MIN</span></div>
            {mode === "mock" && <div className="demo-controls"><span>Replay uses scripted reports and estimates.</span><div><button className="button quiet" disabled={!connected || demoBusy} onClick={() => void demoAction("reset")}>Reset</button><button className="button secondary" disabled={!connected || demoBusy} onClick={() => void demoAction("replay")}><ReplayIcon size={14} />Replay demo</button></div></div>}
            <p className="model-note">Illustrative fire and smoke estimates. Timeline changes are shared with all connected clients.</p>
          </section>
        </section>
        <aside className="column activity-column">
          <section className="panel recommendation-panel" aria-labelledby="recommendation-heading"><PanelHeading label="DECISION SUPPORT" title="Recommended actions" id="recommendation-heading" />{state?.recommendation ? <div className="recommendation-content" key={state.recommendation.actions.join("|")}>
            <span className="review-badge enter" style={stagger(0)}><i className="review-dot" aria-hidden="true" />AWAITING OPERATOR REVIEW</span><ol className="action-list enter" style={stagger(1)}>{state.recommendation.actions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}</ol>
            {state.recommendation.callerReply && <div className="caller-reply enter" style={stagger(2)}><span className="eyebrow">SUGGESTED CALLER REPLY</span><p>“{state.recommendation.callerReply}”</p></div>}
            <div className="enter" style={stagger(3)}><button className="button primary full-width" disabled={!connected} onClick={() => transmit({ type: "acceptRecommendation" })}><CheckIcon size={15} />Accept recommendation</button><p className="subtle">Lights the evacuation route on every screen. Crew dispatch and caller replies are handled separately.</p></div>
          </div> : state?.accepted ? <Accepted accepted={state.accepted} /> : <Empty title="No recommendation pending" text="New suggested actions will appear here for operator review." />}</section>
          {exits.length > 0 && <Evacuation exits={exits} active={!!state?.accepted} onFloor={(value) => { setFloor(value); setSelectedRoom(null); }} />}
          <AgentTrail steps={steps} />
          {serverLog ? <section className="panel" aria-labelledby="log-heading"><PanelHeading label="SHARED" title="Incident log" id="log-heading" count={serverLog.length} /><p className="log-caption">Recorded by the server, the same on every screen.</p><ol className="incident-log">{[...serverLog].reverse().map((entry, index) => <li key={`${entry.time}-${serverLog.length - index}`} className="enter-quick"><span className={`log-dot ${entry.kind}`} /><div><p>{entry.text}</p><time dateTime={new Date(entry.time).toISOString()}>{time(entry.time)}</time></div></li>)}</ol>{!serverLog.length && <Empty title="Waiting for activity" text="Reports, recommendations, and actions will be recorded here." />}</section>
          : <section className="panel" aria-labelledby="log-heading"><PanelHeading label="THIS SESSION" title="Incident log" id="log-heading" count={log.length} /><p className="log-caption">Activity observed in this browser session.</p><ol className="incident-log">{log.map((entry) => <li key={entry.id}><span className={`log-dot ${entry.kind}`} /><div><p>{entry.message}</p><time dateTime={new Date(entry.time).toISOString()}>{time(entry.time)}</time></div></li>)}</ol>{!log.length && <Empty title="Waiting for activity" text="Connections, new reports, and actions will be recorded here." />}</section>}
        </aside>
      </div>
      <footer className="app-footer"><span><b>FIRESIGHT</b> · A shared view for faster decisions.</span><span>{mode === "mock" ? "Synthetic building · Scripted incident" : "Incident state supplied by server"}</span></footer>
    </main>
  </div>;
}

function Metric({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <div className={`metric ${accent ? "accent" : ""}`}><span className="eyebrow">{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></div>;
}
function PanelHeading({ label, title, id, count }: { label: string; title: string; id?: string; count?: number }) {
  return <div className="panel-heading"><div><span className="eyebrow">{label}</span><h2 id={id}>{title}</h2></div>{count !== undefined && <span className="count-badge">{count.toString().padStart(2, "0")}</span>}</div>;
}
function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span className="empty-symbol" aria-hidden="true"><PulseIcon size={22} /></span><strong>{title}</strong><p>{text}</p></div>;
}
function ReportCard({ report, selected, onSelect }: { report: Report; selected: boolean; onSelect: (id: string) => void }) {
  const canLocate = building.rooms.some((room) => room.id === report.roomId);
  return <article className={`report-card enter ${selected ? "selected-report" : ""}`}><div className="report-meta"><strong>{report.caller}</strong><time dateTime={new Date(report.time).toISOString()}>{time(report.time)}</time></div><p>{report.text}</p><div className="report-location"><button disabled={!canLocate} onClick={() => report.roomId && onSelect(report.roomId)}><PinIcon size={13} />{roomName(report.roomId)}</button>{report.confidence !== undefined && <span className={report.confidence < 0.7 ? "confidence low" : "confidence"}>{Math.round(report.confidence * 100)}% confidence</span>}</div></article>;
}

/** Entrance order for a staggered group (see .enter in styles.css). */
const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

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

/** Short, human summary of one agent tool call for the trail panel. */
function toStep(step: TrailStep, index: number): AgentStep {
  const out = step.output as Record<string, unknown> | null;
  let summary: string;
  if (out && typeof out === "object" && "roomId" in out && typeof out.roomId === "string") {
    summary = `${out.roomId}${typeof out.confidence === "number" ? ` · ${Math.round(out.confidence * 100)}% confidence` : ""}`;
  } else if (out && typeof out === "object" && "followUp" in out) {
    summary = `Asked caller: ${String(out.followUp)}`;
  } else if (Array.isArray(out)) {
    summary = `${out.length} floor${out.length === 1 ? "" : "s"} checked`;
  } else if (out && typeof out === "object" && Array.isArray((out as { actions?: unknown }).actions)) {
    summary = String((out as { actions: string[] }).actions[0] ?? "Recommendation written");
  } else {
    const text = JSON.stringify(out);
    summary = text && text.length > 110 ? `${text.slice(0, 110)}…` : text ?? "Done";
  }
  return { id: `${index}-${step.tool}`, tool: step.tool, summary: `${summary} · ${step.ms} ms`, status: "completed" };
}

function Accepted({ accepted }: { accepted: NonNullable<IncidentState["accepted"]> }) {
  return <div className="accepted-state">
    <span className="accepted-check" aria-hidden="true"><CheckIcon size={20} /></span>
    <strong>Recommendation accepted · {time(accepted.time)}</strong>
    <ol className="action-list compact">{accepted.recommendation.actions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}</ol>
    <p className="subtle">The evacuation route is lit on the floor plan. New suggestions will appear here.</p>
  </div>;
}

function Evacuation({ exits, active, onFloor }: { exits: FloorExit[]; active: boolean; onFloor: (floor: number) => void }) {
  const rows = exits.filter(isAtRisk).sort((a, b) => b.floor - a.floor);
  if (!rows.length) return null;
  return <section className="panel" aria-labelledby="evac-heading">
    <PanelHeading label={active ? "ROUTE ACTIVE" : "FORECAST · 30 MIN"} title="Evacuation by floor" id="evac-heading" count={rows.length} />
    <ul className="evac-list">{rows.map((exit) => {
      const blocked = Object.entries(exit.blockedAt).filter(([id, minute]) => minute !== null && id !== exit.stair) as [string, number][];
      return <li key={exit.floor}>
        <button className="evac-floor" onClick={() => onFloor(exit.floor)} aria-label={`Show floor ${exit.floor}`}>{exit.floor.toString().padStart(2, "0")}</button>
        <div className="evac-body">
          <span className={`stair-chip ${active ? "active" : ""}`}><StairsIcon size={13} />{stairLabel(exit.stair)}</span>
          {blocked.map(([id, minute]) => <span key={id} className="blocked-chip"><FlameIcon size={12} />{stairLabel(id)} smoke at {minute} min</span>)}
        </div>
        <span className="evac-people" title={exit.flags.length ? `Assistance: ${exit.flags.join(", ")}` : undefined}><UsersIcon size={13} />{exit.people}{exit.flags.includes("mobility") && <span className="assist-flag">ASSIST</span>}</span>
      </li>;
    })}</ul>
  </section>;
}
