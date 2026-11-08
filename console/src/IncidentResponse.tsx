// What the operator does about the selected incident: dispatch, on scene, resolve.
import { useState, type FormEvent } from "react";
import type { ClientEvent } from "@firewatch/shared/events";
import type { MapIncident } from "@firewatch/shared/types";
import { SendIcon } from "./Icons";
import { PhasePill } from "./IncidentQueue";
import { PanelHeading, Timestamp } from "./ui";

export function ResponseControls({ incident, connected, onSend }: {
  incident: MapIncident;
  connected: boolean;
  onSend: (event: ClientEvent) => boolean;
}) {
  const [unit, setUnit] = useState("");
  const resolved = incident.phase === "resolved";
  const dispatches = incident.dispatches ?? [];

  function dispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = unit.trim();
    if (onSend({ type: "dispatchIncident", incidentId: incident.id, ...(name && { unit: name }) })) setUnit("");
  }
  const setPhase = (phase: MapIncident["phase"]) => onSend({ type: "setIncidentPhase", incidentId: incident.id, phase });

  return (
    <section className="panel response-controls" aria-labelledby="response-heading">
      <PanelHeading title="Response" id="response-heading" aside={<PhasePill phase={incident.phase} />} />
      <div className="response-body">
        {!resolved && (
          <form className="address-form" onSubmit={dispatch}>
            <label htmlFor="dispatch-unit">Unit (optional)</label>
            <div className="address-row">
              <input id="dispatch-unit" value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={incident.kind === "fire" ? "Engine 3" : incident.kind === "crash" ? "EMS 2, Traffic 1" : "Response unit"} maxLength={100} autoComplete="off" disabled={!connected} />
              <button className="button primary" disabled={!connected}>Dispatch<SendIcon size={16} /></button>
            </div>
          </form>
        )}
        <div className="response-actions">
          {resolved
            ? <button className="button secondary" disabled={!connected} onClick={() => setPhase("open")}>Reopen incident</button>
            : <>
              <button className="button secondary" disabled={!connected || incident.phase === "on_scene"} onClick={() => setPhase("on_scene")}>On scene</button>
              <button className="button quiet" disabled={!connected} onClick={() => setPhase("resolved")}>Resolve</button>
            </>}
        </div>
        {dispatches.length > 0 && (
          <ul className="response-units" aria-label="Units sent, newest first">
            {[...dispatches].reverse().map((item, index) => <li key={`${item.time}-${index}`}><span>{item.unit ?? "Unit not named"}</span><Timestamp value={item.time} /></li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
