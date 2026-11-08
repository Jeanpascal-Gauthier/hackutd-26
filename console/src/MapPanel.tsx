// The primary incident map: forecast, building impact, and a fixture-backed action loop.
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, MapIncident } from "@firewatch/shared/types";
import { IncidentMap } from "./map/IncidentMap";
import { StreetScene } from "./map/StreetScene";
import { locationIssue, placeOf } from "./incidents";
import { buildingImpact, buildingRisk, buildForecastScene, executeMitigation, money, readExecutions, totalImpact, type Execution, type ForecastScenario } from "./map/forecastModel";
import { liveMapLayers, portfolioScenario, type PortfolioBuilding, type PortfolioImpact, type MapIncidentPlus } from "./map/portfolioModel";
import "./MapPanel.css";

const EMPTY_PORTFOLIO: PortfolioBuilding[] = [];

export function MapPanel({ incidents, selected, onSelect, scenario: fixtureScenario, portfolio, portfolioBuildings = EMPTY_PORTFOLIO, activity, connected = true, onExecuteAction }: {
  incidents: MapIncident[];
  selected: MapIncident | null;
  onSelect: (id: string) => void;
  scenario?: ForecastScenario;
  portfolio?: PortfolioImpact;
  portfolioBuildings?: PortfolioBuilding[];
  activity?: LogEntry[];
  connected?: boolean;
  onExecuteAction?: (actionId: string) => Promise<void>;
}) {
  const scenario = useMemo(() => fixtureScenario ?? portfolioScenario(portfolio, incidents, portfolioBuildings), [fixtureScenario, portfolio, incidents, portfolioBuildings]);
  const live = !fixtureScenario;
  const layers = liveMapLayers(incidents);
  const [view, setView] = useState<"map" | "street">("map");
  const [showTraffic, setShowTraffic] = useState(false);
  const [offline, setOffline] = useState(() => new URLSearchParams(window.location.search).get("map") === "offline");
  const [minute, setMinute] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const drilldown = useRef<HTMLElement>(null);
  useEffect(() => {
    if (buildingId) drilldown.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [buildingId]);
  const storageKey = `firesight:actions:${scenario?.id ?? "live"}`;
  const [executions, setExecutions] = useState<Execution[]>(() => {
    try { return fixtureScenario ? readExecutions(fixtureScenario, sessionStorage.getItem(storageKey)) : []; }
    catch { return []; }
  });
  useEffect(() => {
    if (!fixtureScenario) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(executions)); } catch { /* In-memory demo still works when browser storage is unavailable. */ }
  }, [fixtureScenario, storageKey, executions]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (minute >= 30) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setMinute((value) => Math.min(30, value + 1)), 800);
    return () => window.clearTimeout(timer);
  }, [playing, minute]);
  const location = selected?.location;
  const street = view === "street" && !!location;
  const selectedId = selected?.id ?? null;
  // Resolved incidents leave the map unless the operator is looking at one.
  const shown = useMemo(() => incidents.filter((incident) => incident.phase !== "resolved" || incident.id === selectedId), [incidents, selectedId]);
  const issue = selected ? locationIssue(selected) : null;
  const scene = useMemo(() => buildForecastScene(shown, minute, scenario, executions, buildingId), [shown, minute, scenario, executions, buildingId]);
  const building = scenario?.buildings.find((item) => item.id === buildingId);
  const impact = live && portfolio ? { buildings: portfolio.summary.buildings, people: portfolio.summary.people, loss: portfolio.summary.usdAtRiskAfterActions } : scenario ? totalImpact(scenario, executions, minute) : null;
  const baseline = live && portfolio ? { buildings: portfolio.summary.buildings, people: portfolio.summary.people, loss: portfolio.summary.usdAtRisk } : scenario ? totalImpact(scenario, [], minute) : null;
  const buildingRemaining = building ? buildingImpact(building, executions) : null;
  const done = new Set(live ? [...(portfolio?.done ?? []), ...(scenario?.buildings.flatMap((item) => item.actions.filter((action) => action.status === "done").map((action) => action.id)) ?? [])] : executions.map((event) => event.actionId));
  const hasForecast = !!scenario || layers.forecast;
  const executionHistory = (activity ?? []).filter((entry) => /^(Executed|Undone): /.test(entry.text));
  const actionCount = live ? done.size : executions.length;
  const riskOrder = scenario ? [...scenario.buildings].sort((a, b) => buildingImpact(b, executions).loss - buildingImpact(a, executions).loss) : [];

  function reset() {
    setExecutions([]);
    setMinute(10);
    setPlaying(false);
    setBuildingId(null);
  }

  async function execute(buildingId: string, actionId: string) {
    if (!scenario || pendingAction) return;
    if (!live) { setExecutions((current) => executeMitigation(scenario, current, buildingId, actionId, minute)); return; }
    if (!connected || !onExecuteAction) return;
    setPendingAction(actionId);
    setActionMessage(null);
    try {
      await onExecuteAction(actionId);
      setActionMessage({ error: false, text: "Action recorded by the server. Impact and execution history update for all connected screens." });
    } catch (error) {
      setActionMessage({ error: true, text: error instanceof Error ? error.message : "Could not execute the action. Try again." });
    } finally { setPendingAction(null); }
  }

  return (
    <section className="panel primary-map map-panel" aria-labelledby="map-heading">
      <div className="panel-heading map-heading">
        <h2 id="map-heading">{scenario ? "Impact & response map" : selected ? selected.label : "Incident map"}<small className="map-place">{scenario ? scenario.label ?? "Downtown Dallas · forecast → prioritize → act" : selected && placeOf(selected)}</small></h2>
        <div className="map-controls">
          {scenario && !street && <button className="text-button map-schematic-toggle" aria-pressed={offline} onClick={() => setOffline(!offline)}>{offline ? "Use Google map" : "Use schematic"}</button>}
          {!street && !offline && <div className="view-switch" role="group" aria-label="Map layers"><button aria-pressed={showTraffic} onClick={() => setShowTraffic(!showTraffic)}>Live traffic</button></div>}
          <div className="view-switch" role="group" aria-label="Scene view">
            <button aria-pressed={!street} onClick={() => setView("map")}>Map</button>
            <button aria-pressed={street} disabled={!location} onClick={() => setView("street")}>Street view</button>
          </div>
        </div>
      </div>
      {scenario && <div className="map-demo-banner"><span><i />{live ? `Server analysis · ${portfolio?.mode === "llm" ? "Agent assisted" : "Rules model"}` : "Simulated scenario · actions run locally"}</span>{!live && <button className="text-button" onClick={reset}>Reset scenario</button>}</div>}
      {impact && baseline && <div className="map-impact-card">
        <div><span className="map-eyebrow">Projected impact · next {live ? portfolio?.summary.horizonMinutes ?? 30 : 30} min</span><p><strong>{impact.buildings} buildings</strong><span> · </span><strong>{impact.people.toLocaleString("en-US")} people</strong></p></div>
        <div className="map-impact-value" role="status" aria-live="polite" aria-atomic="true"><strong>~{money(impact.loss)}</strong><span>at risk{baseline.loss > impact.loss && <b> ↓ {money(baseline.loss - impact.loss)} avoided</b>}</span></div>
      </div>}
      {issue && <p className="map-hint">{issue}. This incident is not on the map yet.</p>}
      {street && selected && location
        ? <StreetScene location={location} label={placeOf(selected) ?? selected.label} />
        : <IncidentMap incidents={shown} selectedId={selectedId} showTraffic={showTraffic} onSelect={onSelect} scene={scene} scenario={scenario} onSelectBuilding={setBuildingId} offline={offline} />}
      {!street && hasForecast && <>
        <div className="map-forecast-control">
          <div className="map-forecast-heading"><div><span className="map-eyebrow">Forecast preview</span><strong>{minute === 0 ? "Now" : `+${minute} min`}</strong></div><button className="button secondary" aria-label={playing ? "Pause forecast" : "Play forecast"} onClick={() => { if (minute >= 30) setMinute(0); setPlaying(!playing); }}>{playing ? "Pause" : "Play forecast"}</button></div>
          <label className="sr-only" htmlFor="map-forecast-minute">Forecast minute</label>
          <input id="map-forecast-minute" type="range" min="0" max="30" step="1" value={minute} aria-valuetext={minute === 0 ? "Now" : `${minute} minutes from now`} onChange={(event) => { setMinute(Number(event.target.value)); setPlaying(false); }} />
          <div className="map-time-ticks" aria-hidden="true"><span>Now</span><span>+10 min</span><span>+20 min</span><span>+30 min</span></div>
        </div>
        <div className="map-layer-legend" aria-label="Map legend"><span><i className="legend-fire" />Fire</span><span><i className="legend-smoke" />Smoke</span>{(fixtureScenario || layers.flood) && <span><i className="legend-flood" />Flood</span>}<span><i className="legend-road" />Blocked / queue</span>{(fixtureScenario || layers.impact) && <span><i className="legend-blast" />{live ? "Impact radius" : "Blast radius · 140 m"}</span>}{(fixtureScenario || layers.links) && <span><i className="legend-link" />Linked incidents</span>}</div>
        <p className="map-model-note">{live ? "Modeled forecasts, not observed hazard boundaries. Portfolio building locations use point markers where mapped footprints are unavailable. Executed actions change modeled exposure; hazard footprints show the baseline forecast." : "Illustrative forecasts and street geometry. Executed actions reduce modeled exposure; hazard footprints remain the baseline forecast."}</p>
        {live && (shown as MapIncidentPlus[]).filter((incident) => incident.fire || incident.crash || incident.flood).map((incident) => <details className="map-forecast-assumptions" key={incident.id}><summary>{incident.label} · forecast assumptions</summary><ul>{[...(incident.fire?.assumptions ?? []), ...(incident.crash?.assumptions ?? []), ...(incident.flood?.assumptions ?? [])].map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></details>)}
      </>}
      {scenario && <div className="map-building-workspace">
        <div className="map-buildings-heading"><h3>Prioritize buildings</h3><span>Highest financial exposure first</span></div>
        <div className="map-risk-key"><span className="risk-high">● High</span><span className="risk-moderate">● Moderate</span><span className="risk-low">● Low</span><span>{live ? "Server assessment" : `at +${minute} min`} · click to inspect</span></div>
        <div className="map-building-list">{riskOrder.map((item) => {
          const risk = buildingRisk(item, executions, minute);
          const number = scenario.buildings.indexOf(item) + 1;
          return <button key={item.id} className={`map-building-choice risk-${risk}${buildingId === item.id ? " selected" : ""}`} aria-pressed={buildingId === item.id} onClick={() => setBuildingId(item.id)}><span className="map-building-index">{number}</span><span><strong>{item.name}</strong><small>{risk.charAt(0).toUpperCase() + risk.slice(1)} risk · {money(buildingImpact(item, executions).loss)}</small></span><span aria-hidden="true">↗</span></button>;
        })}</div>
        {building && buildingRemaining ? <section ref={drilldown} className="map-building-detail" aria-label={`${building.name} failure chain and actions`}>
          <div className="map-drilldown-heading"><div><span className="map-eyebrow">Building drill-down</span><h3>{building.name}</h3><p>{buildingRemaining.people.toLocaleString("en-US")} people exposed · ~{money(buildingRemaining.loss)} {building.server?.remainingLoss === null ? "baseline risk" : "at risk"}</p></div><button className="text-button" onClick={() => setBuildingId(null)} aria-label="Close building details">Close</button></div>
          <div className="map-risk-score"><span>{live ? "Financial exposure remaining" : "Modeled risk"}</span><strong>{Math.round(buildingRemaining.loss / Math.max(1, building.loss) * 100)}<small>{live ? "%" : " / 100"}</small></strong><meter min={0} max={100} low={30} high={65} optimum={0} value={Math.round(buildingRemaining.loss / Math.max(1, building.loss) * 100)} aria-label={`${building.name} modeled risk score`} /></div>
          {!!building.reasons?.length && <details className="map-risk-reasons"><summary>Why this building is at risk</summary><ul>{building.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></details>}
          <h4>Predicted failure chain</h4>
          <ol className="map-failure-chain">{building.chain.map((event, index) => {
            const prevented = event.interrupted || (event.preventedBy && done.has(event.preventedBy));
            return <li key={index} className={prevented ? "interrupted" : event.minute <= minute ? "reached" : ""}><span className="chain-minute">{event.minute === 0 ? "Now" : `+${event.minute}m`}</span><div><strong>{event.title}{prevented && <span>Interrupted</span>}</strong><p>{event.detail}</p></div></li>;
          })}</ol>
          <div className="map-action-heading"><h4>Actions to break the chain</h4><span>{building.actions.filter((action) => done.has(action.id)).length}/{building.actions.length} done</span></div>
          <ul className="map-mitigation-list">{building.actions.map((action) => <li key={action.id} className={done.has(action.id) ? "completed" : ""}><div><strong>{action.label}</strong><small>{action.owner} · {money(action.lossReduction)} {live ? "potential savings" : "risk reduction"}{action.deadlineMinute !== undefined && ` · ${action.deadlineMinute === 0 ? "Act now" : `Before +${action.deadlineMinute} min`}`}</small>{action.reason && <small>{action.reason}</small>}</div><button className="button" disabled={done.has(action.id) || !!pendingAction || (live && (!connected || !onExecuteAction))} aria-label={done.has(action.id) ? `Done: ${action.label}` : `Execute: ${action.label}`} onClick={() => void execute(building.id, action.id)}>{done.has(action.id) ? "✓ Done" : pendingAction === action.id ? "Executing…" : "Execute"}</button></li>)}</ul>
          {actionMessage && <p className={`map-action-message${actionMessage.error ? " error" : ""}`} role={actionMessage.error ? "alert" : "status"}>{actionMessage.text}</p>}
          {live && !connected && <p className="map-action-message error" role="status">Reconnect to the server to execute actions.</p>}
        </section> : <p className="map-drilldown-prompt">Select a building on the map or above to trace its failure chain and execute a response.</p>}
        <section className="map-execution-log" aria-label="Execution history"><div className="map-action-heading"><h4>Execution history</h4><span>{actionCount} action{actionCount === 1 ? "" : "s"}</span></div>
          {live ? executionHistory.length === 0 ? <p>Server-confirmed executions appear here with their time and modeled impact.</p> : <ol>{[...executionHistory].reverse().map((event, index) => <li key={`${event.time}-${index}`}><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><strong>{event.text}</strong></div></li>)}</ol> : executions.length === 0 ? <p>Executed actions appear here with their time and modeled impact.</p> : <ol>{[...executions].reverse().map((event) => {
            const target = scenario.buildings.find((item) => item.id === event.buildingId)!;
            const action = target.actions.find((item) => item.id === event.actionId)!;
            return <li key={event.actionId}><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><strong>{action.label}</strong><span>{target.name} · preview +{event.forecastMinute} min</span></div><b>−{money(action.lossReduction)}</b></li>;
          })}</ol>}
        </section>
      </div>}
    </section>
  );
}
