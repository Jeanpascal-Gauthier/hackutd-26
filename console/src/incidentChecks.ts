// Incident-wide operator checks. These read the selected snapshot; they do not call an LLM.
import type { MapIncident } from "@firewatch/shared/types";
import { lanesText, phaseText, severityText } from "./incidents";

export interface SituationCheck {
  label: string;
  value: string;
  source: string;
  attention: boolean;
}

export function situationChecks(incident: MapIncident): SituationCheck[] {
  const located = incident.status === "located" && !!incident.location;
  const reports = incident.reports.length;
  const dispatches = incident.dispatches?.length ?? 0;
  const checks: SituationCheck[] = [
    {
      label: "Location",
      value: located ? incident.formatted ?? incident.query ?? "Coordinates available" : incident.status === "locating" ? "Location lookup in progress" : "Location needs confirmation",
      source: located ? "Geocoder match · confirm with caller" : incident.query ? `Caller said: ${incident.query}` : "No address recorded",
      attention: !located,
    },
    {
      label: "Severity",
      value: severityText[incident.severity],
      source: "Recorded at intake · reassess as reports arrive",
      attention: incident.severity === "unknown" || incident.severity === "critical",
    },
    {
      label: "Caller evidence",
      value: `${reports} report${reports === 1 ? "" : "s"} recorded`,
      source: "Caller statements · not independently verified",
      attention: reports === 0,
    },
    {
      label: "Response",
      value: phaseText[incident.phase],
      source: `${dispatches} dispatch record${dispatches === 1 ? "" : "s"} · ${incident.phase === "resolved" ? "Incident closed" : "Delivery to crews is not tracked"}`,
      attention: incident.phase !== "resolved" && dispatches === 0,
    },
  ];
  if (incident.kind === "crash") checks.push({
    label: "Road obstruction",
    value: lanesText[incident.lanesBlocked ?? "unknown"],
    source: "Reported at intake · confirm lane direction and access",
    attention: !incident.lanesBlocked || incident.lanesBlocked === "unknown" || incident.lanesBlocked === "all",
  });
  return checks;
}

/** Questions are prompts for an operator, never inferred answers or instructions to a caller. */
export function followUpQuestions(incident: MapIncident): string[] {
  const questions = [
    incident.status === "located" && incident.location
      ? `Can you confirm the incident is at ${incident.formatted ?? incident.query ?? `${incident.location.lat.toFixed(5)}, ${incident.location.lon.toFixed(5)}`}?`
      : "What is the exact address, nearest cross street, or landmark?",
    "How many people are involved, and what injuries or immediate dangers can you see?",
  ];
  switch (incident.kind) {
    case "fire":
      questions.push("Where can you see flames or smoke, and has that changed?", "Is anyone trapped or unable to leave without assistance?");
      break;
    case "crash":
      questions.push("How many vehicles are involved, and is anyone trapped?", "Which direction and lanes are blocked? Is there visible fire, smoke, or a spill?");
      break;
    case "other":
      questions.push("What happened, when did it start, and is it getting worse?", "What hazards or access restrictions should arriving responders know about?");
      break;
  }
  return questions;
}

export function situationText(incident: MapIncident): string {
  return [
    `${incident.label} · ${incident.id}`,
    `Snapshot updated ${new Date(incident.updated).toISOString()}`,
    ...situationChecks(incident).map((check) => `${check.label}: ${check.value}\nSource: ${check.source}`),
  ].join("\n\n");
}
