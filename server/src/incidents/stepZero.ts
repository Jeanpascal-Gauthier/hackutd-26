// The planned "Step 0" shared fields, as the server emits them until they land in shared/types.ts.
// Types only. The shapes come from the agent's mirror (agent/core/impact/types.ts) so server and
// agent can't drift. When Step 0 merges: import from @firewatch/shared/types and delete this file.
//
// Floods: MapIncident.kind stays "other" (label "Flood") until Step 0 adds "flood", so today's
// console and headset keep working. An incident is a flood when `flood` is set; the agent's
// fromMapIncident() maps that to kind "flood".
import type { IncidentState, MapIncident } from "@firewatch/shared/types";
import type {
  AffectedProperty,
  AffectedRoad,
  BlastImpact,
  FloodForecast,
  ImpactSummary,
} from "../../../agent/core/impact/types.ts";

export type {
  AffectedProperty,
  AffectedRoad,
  BlastImpact,
  FailureStep,
  FloodForecast,
  ImpactSummary,
  PlannedAction,
  PortfolioBuilding,
} from "../../../agent/core/impact/types.ts";

/** Fields the server adds to each MapIncident. All optional. */
export interface StepZeroFields {
  /** Floods only: modeled water spread, minutes 0..30. */
  flood?: FloodForecast;
  /** Floods only: what caused it ("water main burst"). The agent reads the label when absent. */
  source?: string;
  /** ~500 m grid cell, e.g. "z:6594:-19354". Incidents in the same or a neighbouring cell are "close by". */
  zoneId?: string;
  /** Ids of linked incidents: close by but a different kind (a fire and a crash near one data center). */
  related?: string[];
  /** Red road sections: crash queues and flooded roads. */
  affectedRoads?: AffectedRoad[];
  /** This incident's blast radius and its reasons (classify_blast_radius). */
  impact?: BlastImpact;
  /** Portfolio buildings this incident touches (alone or with its linked incidents), highest $ first. */
  affectedProperties?: AffectedProperty[];
}

export type MapIncidentPlus = MapIncident & StepZeroFields;

/** state.portfolioImpact: the whole portfolio picture across every open incident. */
export interface PortfolioImpact {
  summary: ImpactSummary;
  affectedProperties: AffectedProperty[];
  briefing: string;
  /** llm: Nemotron ran the tools. rules: the deterministic path did. */
  mode: "llm" | "rules";
  /** Executed action ids (PlannedAction.id), oldest first. */
  done: string[];
  /** Epoch ms of the last recompute. */
  updated: number;
}

export type IncidentStatePlus = IncidentState & { mapIncidents?: MapIncidentPlus[]; portfolioImpact?: PortfolioImpact };
