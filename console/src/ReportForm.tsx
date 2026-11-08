// Every console report uses the multi-incident intake (POST /map-incidents).
import { useState, type FormEvent } from "react";
import type { IncidentSeverity, LanesBlocked, MapIncidentKind } from "@firewatch/shared/types";
import { SendIcon } from "./Icons";
import { PanelHeading } from "./ui";

type Notice = { kind: "success" | "error"; text: string };

export function ReportForm({ connected, request, onCreated, onNotice }: {
  connected: boolean;
  request: (path: string, body?: unknown) => Promise<{ incident?: { id?: string }; reply?: string }>;
  onCreated: (incidentId: string) => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const [type, setType] = useState<MapIncidentKind>("fire");
  const [what, setWhat] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("unknown");
  const [lanes, setLanes] = useState<LanesBlocked>("unknown");
  const [inBuilding, setInBuilding] = useState(false);
  const [caller, setCaller] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const ready = connected && !submitting && description.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    onNotice(null);
    const name = caller.trim();
    try {
      const result = await request("/map-incidents", {
        type,
        ...(type === "other" && what.trim() && { what: what.trim() }),
        ...(address.trim() && { address: address.trim() }),
        description: description.trim(),
        severity,
        ...(type === "crash" && { lanes_blocked: lanes }),
        ...(type === "fire" && { in_building: inBuilding }),
        ...(name && { caller: name }),
      });
      setAddress("");
      setWhat("");
      setSeverity("unknown");
      setLanes("unknown");
      setInBuilding(false);
      if (result.incident?.id) onCreated(result.incident.id);
      onNotice({ kind: "success", text: result.reply ? `Report received. Tell the caller: ${result.reply}` : "Report received by the server." });
      setDescription("");
    } catch (error) {
      onNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not submit report." });
    } finally { setSubmitting(false); }
  }

  return (
    <section className="panel manual-panel" aria-labelledby="manual-heading">
      <PanelHeading title="Report an incident" id="manual-heading" />
      <form className="report-form" onSubmit={submit}>
        <div className="view-switch report-switch" role="group" aria-label="Incident type">
          {(["fire", "crash", "other"] as const).map((kind) => <button key={kind} type="button" disabled={submitting} aria-pressed={type === kind} onClick={() => setType(kind)}>{kind === "fire" ? "Fire" : kind === "crash" ? "Crash" : "Other"}</button>)}
        </div>
        {type === "other" && <label htmlFor="incident-what">What is it<input id="incident-what" value={what} onChange={(event) => setWhat(event.target.value)} placeholder="Gas leak, flooding, downed line…" maxLength={60} disabled={submitting} /></label>}
        <label htmlFor="incident-place">Address or landmark<input id="incident-place" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Street address, cross street, or landmark" maxLength={500} autoComplete="off" disabled={submitting} /></label>
        <label htmlFor="report">What the caller says<textarea id="report" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What happened, who is hurt or in danger…" required maxLength={2000} rows={3} disabled={submitting} /></label>
        <div className="report-form-row">
          <label htmlFor="incident-severity">Severity<select id="incident-severity" value={severity} onChange={(event) => setSeverity(event.target.value as IncidentSeverity)} disabled={submitting}>
            <option value="unknown">Unknown</option><option value="minor">Minor</option><option value="serious">Serious</option><option value="critical">Critical</option>
          </select></label>
          {type === "crash" && <label htmlFor="incident-lanes">Lanes blocked<select id="incident-lanes" value={lanes} onChange={(event) => setLanes(event.target.value as LanesBlocked)} disabled={submitting}>
            <option value="unknown">Unknown</option><option value="some">Some lanes</option><option value="all">All lanes</option>
          </select></label>}
        </div>
        {type === "fire" && <label className="report-check" htmlFor="incident-building"><input id="incident-building" type="checkbox" checked={inBuilding} onChange={(event) => setInBuilding(event.target.checked)} disabled={submitting} />Inside a building</label>}
        <label htmlFor="caller">Caller (optional)<input id="caller" value={caller} onChange={(event) => setCaller(event.target.value)} placeholder="Name or phone number" maxLength={100} disabled={submitting} /></label>
        <button className="button primary full-width" disabled={!ready}>{submitting ? "Submitting…" : <>Submit report<SendIcon size={18} /></>}</button>
      </form>
    </section>
  );
}
