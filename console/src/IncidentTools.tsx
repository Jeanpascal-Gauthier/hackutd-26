import { useState } from "react";
import type { MapIncident } from "@firewatch/shared/types";
import { writeClipboard } from "./clipboard";
import { AlertIcon, CopyIcon, PinIcon, SendIcon, UsersIcon } from "./Icons";
import { followUpQuestions, situationChecks, situationText } from "./incidentChecks";
import { ResponderBrief } from "./ResponderBrief";
import { PanelHeading, Timestamp } from "./ui";

const tools = [
  { id: "situation", label: "Situation check", detail: "What we know", Icon: PinIcon },
  { id: "follow-up", label: "Caller follow-up", detail: "What to ask next", Icon: UsersIcon },
  { id: "handoff", label: "Responder handoff", detail: "What to relay", Icon: SendIcon },
] as const;
type Tool = typeof tools[number]["id"];

function CopyResult({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try { await writeClipboard(text); setStatus("Copied to clipboard."); }
    catch { setStatus("Could not copy. Select the text to copy it manually."); }
  }
  return <div className="incident-tool-copy"><button className="button secondary" onClick={() => void copy()}><CopyIcon size={16} />{label}</button><span role="status">{status}</span></div>;
}

export function IncidentTools({ incident }: {
  incident: MapIncident;
}) {
  const [selected, setSelected] = useState<Tool>("situation");
  const checks = situationChecks(incident);
  const questions = followUpQuestions(incident);
  const attention = checks.filter((check) => check.attention).length;
  return (
    <section className="panel incident-tools" aria-labelledby="incident-tools-heading">
      <PanelHeading title="Incident tools" id="incident-tools-heading" aside={<span className="pill">{incident.label}</span>} />
      <p className="incident-tools-intro">Review the situation, fill information gaps, and prepare the response.</p>
      <div className="incident-tool-picker" role="group" aria-label="Incident tools">
        {tools.map(({ id, label, detail, Icon }) => <button key={id} aria-pressed={selected === id} aria-controls={`tool-${id}`} onClick={() => setSelected(id)}><Icon size={19} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}
      </div>

      {/* Keep panels mounted so switching tools preserves their local state. */}
      <div id="tool-situation" hidden={selected !== "situation"} className="incident-tool-body">
        <div className="incident-tool-heading"><h3>Situation check</h3><span className={`pill${attention ? " warn" : ""}`}>{attention ? `${attention} to review` : "Snapshot available"}</span></div>
        <p className="incident-tool-note">Updated <Timestamp value={incident.updated} />. Checks use recorded incident fields; injuries and hazards still need caller or on-scene confirmation.</p>
        <dl className="situation-checks">{checks.map((check) => <div key={check.label}>
          <dt>{check.label}{check.attention && <AlertIcon size={14} />}</dt><dd><strong>{check.value}</strong><small>{check.source}</small></dd>
        </div>)}</dl>
        <CopyResult key={incident.updated} text={situationText(incident)} label="Copy situation check" />
      </div>

      <div id="tool-follow-up" hidden={selected !== "follow-up"} className="incident-tool-body">
        <div className="incident-tool-heading"><h3>Caller follow-up</h3><span className="pill">Operator prompts</span></div>
        <p className="incident-tool-note">Suggested questions for this incident type. Review the caller reports first; record new answers as caller reports. Only stated details enter the responder handoff.</p>
        <ol className="follow-up-questions">{questions.map((question) => <li key={question}>{question}</li>)}</ol>
        <CopyResult key={questions.join()} text={`${incident.label} · ${incident.id}\nFollow-up questions (not yet answered)\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`} label="Copy questions" />
      </div>

      <div id="tool-handoff" hidden={selected !== "handoff"}><ResponderBrief incident={incident} /></div>
    </section>
  );
}
