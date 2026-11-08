// A plain-language brief the operator reads out or copies. Nothing here reaches responders on its own.
import { useEffect, useMemo, useState } from "react";
import type { MapIncident } from "@firewatch/shared/types";
import { CheckIcon, CopyIcon } from "./Icons";
import { buildResponderBrief } from "./buildResponderBrief";
import { PanelHeading } from "./ui";
import { writeClipboard } from "./clipboard";

export function ResponderBrief({ incident }: { incident: MapIncident }) {
  const brief = useMemo(() => buildResponderBrief(incident), [incident]);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function copy() {
    writeClipboard(brief.text).then(() => setCopied("done"), () => setCopied("failed"));
  }

  return (
    <section className="panel responder-brief" aria-labelledby="brief-heading">
      <PanelHeading title="Responder brief" id="brief-heading" aside={<button className="button secondary" onClick={copy} disabled={!brief.text}>{copied === "done" ? <CheckIcon size={18} /> : <CopyIcon size={18} />}{copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}</button>} />
      <span className="sr-only" role="status">{copied === "done" ? "Brief copied" : copied === "failed" ? "Could not copy the brief" : ""}</span>
      <div className="brief-body">
        <p className="address-note">Caller statements only.</p>
        {!brief.sections.length && <p>No caller details yet.</p>}
        {brief.sections.map((section) => (
          <div key={section.heading} className="brief-section">
            <h3>{section.heading}</h3>
            {section.lines.map((line, index) => <p key={index}>{line}</p>)}
          </div>
        ))}
        <p className="address-note">Not sent to responders. Read it out or copy it.</p>
      </div>
    </section>
  );
}
