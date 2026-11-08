// Incident building: which building the incident runs on, the address lookup that finds it, and the
// operator's confirmation of one mapped outline (an action item, styled like a pending decision).
// It sits below the evacuation priorities while idle and moves to the top of the column (CSS order,
// so typing focus survives) while a lookup is in progress, failed, or waiting for confirmation.
import { useEffect, useState, type FormEvent } from "react";
import type { ClientEvent } from "@firewatch/shared/events";
import type { BuildingCandidateSummary, BuildingLookup, IncidentState } from "@firewatch/shared/types";
import { useBuilding, type BuildingSync } from "./activeBuilding";
import { PinIcon, SendIcon } from "./Icons";
import "./BuildingPanel.css";

const OSM = "© OpenStreetMap contributors";
const capitalize = (text: string) => text ? text[0]!.toUpperCase() + text.slice(1).replace(/[_-]/g, " ") : text;
const candidateTitle = (c: BuildingCandidateSummary) => c.name ?? c.address ?? `Unnamed ${c.use && c.use !== "yes" ? `${c.use.replace(/[_-]/g, " ")} ` : ""}building`;
const distance = (metres: number) => metres <= 0.5 ? "At the address" : `${Math.round(metres)} m away`;

function footprint(points: [number, number][]) {
  const xs = points.map(([x]) => x), zs = points.map(([, z]) => z);
  return `${Math.round(Math.max(...xs) - Math.min(...xs))} × ${Math.round(Math.max(...zs) - Math.min(...zs))} m`;
}

export function BuildingPanel({ state, connected, mode, sync, onSend }: {
  state: IncidentState | null;
  connected: boolean;
  mode: "mock" | "live" | "unknown";
  sync: BuildingSync;
  onSend: (event: ClientEvent) => boolean;
}) {
  const active = useBuilding();
  const { profile } = active;
  const lookup = state?.buildingLookup;
  const [address, setAddress] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const mock = mode === "mock";
  const canSend = connected && !mock;
  const needs = lookup?.status === "needs_confirmation";
  const attribution = profile.source === "osm" && !(profile.attribution ?? "").includes("OpenStreetMap")
    ? [profile.attribution, OSM].filter(Boolean).join(" · ") : profile.attribution;
  const shape = profile.outline && profile.outline.length >= 3 ? profile.outline : active.rooms.flatMap((r): [number, number][] => [[r.x, r.z], [r.x + r.w, r.z + r.d]]);
  // A confirmation in flight stays marked until the server moves the lookup on.
  useEffect(() => { setChosen(null); setHovered(null); }, [lookup?.time, lookup?.status]);
  const pendingSync = sync === "loading" && state?.building && state.building.id !== profile.id;

  function lookupAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = address.trim();
    if (!value || !canSend) return;
    if (onSend({ type: "lookupAddress", address: value })) setAddress("");
  }
  function confirm(id: string) {
    if (!canSend || chosen) return;
    if (onSend({ type: "confirmBuilding", buildingId: id })) setChosen(id);
  }

  return (
    <section className={`panel building-panel ${needs ? "needs-decision" : ""}`} aria-labelledby="building-panel-heading" style={{ order: lookup && lookup.status !== "active" ? -1 : 1 }}>
      <div className="panel-heading">
        <div><span className="eyebrow">INCIDENT BUILDING</span><h2 id="building-panel-heading">{profile.name}</h2></div>
        <div className="panel-heading-aside building-badges">
          {needs && <span className="pill warn">Needs confirmation</span>}
          {profile.layoutEstimated ? <span className="pill warn" title="Rooms, doors and stairs were generated, not mapped">Estimated layout</span> : active.isDemo ? <span className="pill">Demo building</span> : null}
        </div>
      </div>
      <div className="building-body">
        {lookup && needs && <ConfirmBuilding lookup={lookup} hovered={hovered} chosen={chosen} disabled={!canSend} onHover={setHovered} onPick={confirm} />}
        {lookup && !needs && <LookupStatus lookup={lookup} canRetry={canSend} onRetry={() => onSend({ type: "lookupAddress", address: lookup.query })} />}
        {pendingSync && <p className="lookup-status" role="status"><i className="lookup-spinner" aria-hidden="true" />Loading {state?.building?.name ?? "the new building"} from the server…</p>}
        {sync === "error" && <p className="lookup-status lookup-warn" role="status">Could not load the active building from the server. Showing the last one; retrying.</p>}

        <dl className="building-facts">
          <div><dt>Address</dt><dd>{profile.address ?? (active.isDemo ? "Synthetic demo building" : "Not recorded")}</dd></div>
          <div><dt>Use</dt><dd>{capitalize(profile.use)}</dd></div>
          <div><dt>Floors</dt><dd>{profile.floors}{profile.floors !== active.floors.length && ` (${active.floors.length} modelled)`}</dd></div>
          <div><dt>Footprint</dt><dd>{footprint(shape)}{profile.outline ? " · mapped outline" : ""}</dd></div>
        </dl>

        {profile.assumptions.length > 0 && <details className="building-notes">
          <summary>{profile.assumptions.length} layout assumption{profile.assumptions.length === 1 ? "" : "s"}</summary>
          <ul>{profile.assumptions.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </details>}

        {attribution && <p className="building-attribution">{attribution}</p>}

        <form className="address-form" onSubmit={lookupAddress}>
          <label htmlFor="incident-address">Incident address</label>
          <div className="address-row">
            <input id="incident-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder={lookup?.query ?? "Street address, city"} maxLength={300} disabled={!canSend} autoComplete="off" />
            <button className="button secondary" disabled={!canSend || !address.trim()}>Find<SendIcon size={16} /></button>
          </div>
          {mock ? <p className="address-note">Address lookup is off in the scripted demo.</p> : !connected ? <p className="address-note">Reconnect to look up an address.</p> : null}
        </form>

        {(!active.isDemo || (lookup && lookup.status !== "active")) && (confirmDemo ? (
          <div className="demo-switch" role="group" aria-label="Confirm switching to the demo building">
            <p>This clears the incident on every screen.</p>
            <div><button className="button quiet" onClick={() => setConfirmDemo(false)}>Cancel</button><button className="button secondary" disabled={!canSend} onClick={() => { if (onSend({ type: "useDemoBuilding" })) setConfirmDemo(false); }}>Use demo building</button></div>
          </div>
        ) : <button className="text-button demo-link" disabled={!canSend} onClick={() => setConfirmDemo(true)}>Use demo building instead</button>)}
      </div>
    </section>
  );
}

function Caller({ lookup }: { lookup: BuildingLookup }) {
  return <p className="lookup-caller">{lookup.caller ? <>Address from caller <strong>{lookup.caller}</strong></> : "Address entered on a console"}: “{lookup.query}”</p>;
}

function LookupStatus({ lookup, canRetry, onRetry }: { lookup: BuildingLookup; canRetry: boolean; onRetry: () => void }) {
  if (lookup.status === "failed") return <div className="lookup-error" role="alert">
    <strong>Building lookup failed</strong>
    <Caller lookup={lookup} />
    <p>{lookup.error ?? "No building was found for this address."}</p>
    <button className="button secondary" disabled={!canRetry} onClick={onRetry}>Retry lookup</button>
  </div>;
  if (lookup.status === "active") return <Caller lookup={lookup} />;
  const text = lookup.status === "searching" ? `Finding “${lookup.query}”…` : `Generating the building model${lookup.match ? ` for ${lookup.match.formatted}` : ""}…`;
  return <div className="lookup-progress"><p className="lookup-status" role="status"><i className="lookup-spinner" aria-hidden="true" />{text}</p><Caller lookup={lookup} /></div>;
}

function ConfirmBuilding({ lookup, hovered, chosen, disabled, onHover, onPick }: {
  lookup: BuildingLookup;
  hovered: string | null;
  chosen: string | null;
  disabled: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const { candidates } = lookup;
  return (
    <div className="lookup-confirm">
      <h3>Confirm the incident building</h3>
      <Caller lookup={lookup} />
      {lookup.match && <p className="lookup-match"><PinIcon size={15} />{lookup.match.formatted}</p>}
      {candidates.length ? <>
        <CandidateMap candidates={candidates} hovered={hovered} chosen={chosen} disabled={disabled} onHover={onHover} onPick={onPick} />
        <ol className="candidate-list" aria-label="Mapped buildings near the address, nearest first">
          {candidates.map((candidate, index) => (
            <li key={candidate.id}>
              <button className={`candidate ${hovered === candidate.id ? "is-hover" : ""} ${chosen === candidate.id ? "is-chosen" : ""}`} disabled={disabled || (chosen !== null && chosen !== candidate.id)} aria-pressed={chosen === candidate.id}
                onMouseEnter={() => onHover(candidate.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(candidate.id)} onBlur={() => onHover(null)} onClick={() => onPick(candidate.id)}>
                <span className="candidate-index" aria-hidden="true">{index + 1}</span>
                <span className="candidate-text">
                  <strong>{candidateTitle(candidate)}</strong>
                  <small>{[candidate.name && candidate.address, candidate.floors ? `${candidate.floors} floor${candidate.floors === 1 ? "" : "s"}` : "Floors unknown", candidate.use && candidate.use !== "yes" ? capitalize(candidate.use) : null, distance(candidate.distanceMeters)].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="candidate-action">{chosen === candidate.id ? "Confirming…" : "Confirm"}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="lookup-footnote">Select the outline that matches the caller's building. Outlines {OSM}.</p>
      </> : <p className="lookup-footnote">No mapped building outlines near this address. Correct the address below or use the demo building.</p>}
    </div>
  );
}

const NICE = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** Outlines around the geocoded point (pin at 0,0), north up, scaled to fit. Decorative twin of the list. */
function CandidateMap({ candidates, hovered, chosen, disabled, onHover, onPick }: {
  candidates: BuildingCandidateSummary[];
  hovered: string | null;
  chosen: string | null;
  disabled: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const points = [[0, 0] as [number, number], ...candidates.flatMap((c) => c.outline)];
  let minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
  let minZ = Math.min(...points.map(([, z]) => z)), maxZ = Math.max(...points.map(([, z]) => z));
  const pad = Math.max(8, 0.12 * Math.max(maxX - minX, maxZ - minZ));
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  // Widen the shorter side to a 16:10 frame, centred.
  const ASPECT = 1.6;
  let w = maxX - minX, h = maxZ - minZ;
  if (w / h < ASPECT) { minX -= (h * ASPECT - w) / 2; w = h * ASPECT; } else { minZ -= (w / ASPECT - h) / 2; h = w / ASPECT; }
  const unit = w / 320; // metres per nominal pixel at 320 px wide
  const bar = NICE.find((value) => value >= w / 6) ?? NICE[NICE.length - 1]!;
  return (
    <svg className="candidate-map" viewBox={`${minX} ${minZ} ${w} ${h}`} aria-hidden="true">
      <rect x={minX} y={minZ} width={w} height={h} className="mini-bg" />
      {candidates.map((candidate, index) => {
        const cx = candidate.outline.reduce((sum, [x]) => sum + x, 0) / (candidate.outline.length || 1);
        const cz = candidate.outline.reduce((sum, [, z]) => sum + z, 0) / (candidate.outline.length || 1);
        const state = chosen === candidate.id ? "is-chosen" : hovered === candidate.id ? "is-hover" : "";
        return <g key={candidate.id} className={`mini-outline ${state} ${disabled ? "is-disabled" : ""}`} onMouseEnter={() => onHover(candidate.id)} onMouseLeave={() => onHover(null)} onClick={() => { if (!disabled) onPick(candidate.id); }}>
          <title>{candidateTitle(candidate)}</title>
          <polygon points={candidate.outline.map(([x, z]) => `${x},${z}`).join(" ")} strokeWidth={1.5 * unit} />
          <circle cx={cx} cy={cz} r={8 * unit} className="mini-index-bg" />
          <text x={cx} y={cz} fontSize={10 * unit} className="mini-index">{index + 1}</text>
        </g>;
      })}
      <g className="mini-pin" transform={`translate(0 0) scale(${unit})`}>
        <path d="M0 0c-4-5.5-7-9-7-13a7 7 0 0 1 14 0c0 4-3 7.5-7 13Z" />
        <circle cy={-13} r={2.6} className="mini-pin-dot" />
      </g>
      <g className="mini-scale" transform={`translate(${minX + 12 * unit} ${minZ + h - 12 * unit})`}>
        <path d={`M 0 ${-4 * unit} V 0 H ${bar} V ${-4 * unit}`} strokeWidth={1.2 * unit} />
        <text x={bar / 2} y={-6 * unit} fontSize={9 * unit}>{bar} m</text>
      </g>
      <g className="mini-north" transform={`translate(${minX + w - 16 * unit} ${minZ + 16 * unit}) scale(${unit})`}>
        <path d="M0 -9 L5 5 L0 2 L-5 5 Z" />
        <text y={16} fontSize={9}>N</text>
      </g>
    </svg>
  );
}
