// Builds a brief from the caller's words only. No inferred fields, forecasts, or operator actions.
import type { MapIncident } from "@firewatch/shared/types";

export interface BriefSection { heading: string; lines: string[] }
export interface ResponderBrief { sections: BriefSection[]; text: string }

/** Keep the source wording and uncertainty; only collapse whitespace for a compact readout. */
const compact = (text: string) => text.replace(/\s+/g, " ").trim();

export function buildResponderBrief(incident: MapIncident): ResponderBrief {
  const sections: BriefSection[] = [];
  // `query` is the stated location. Geocoded addresses and coordinates are external data.
  const location = compact(incident.query ?? "");
  if (location) sections.push({ heading: "Reported location", lines: [location] });

  // Keep every follow-up in order: earlier reports can contain critical details or be corrected later.
  // Do not rewrite, infer missing details, or repeat the agent's reply as a caller observation.
  const reports = incident.reports.filter((report) => compact(report.text));
  if (reports.length) sections.push({
    heading: "Callers report",
    lines: reports.map((report) => `${report.caller}: ${compact(report.text)}`),
  });

  return { sections, text: sections.map((section) => `${section.heading}\n${section.lines.join("\n")}`).join("\n\n") };
}
