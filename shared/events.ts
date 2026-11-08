// WebSocket message types. Types only — no runtime code.
// Tell the team before changing anything here.

import type { IncidentPhase, IncidentState } from "./types.ts";

/** server -> client */
export type ServerEvent = { type: "state"; state: IncidentState };

/** client -> server */
export type ClientEvent =
  | { type: "setSimMinute"; minute: number }
  /** With `incidentId`: accepts that map incident's recommendation. Without: the building's. */
  | { type: "acceptRecommendation"; incidentId?: string }
  | { type: "dispatch"; roomId: string }
  /** Send a unit to a map incident. Moves an `open` incident to `dispatched`. */
  | { type: "dispatchIncident"; incidentId: string; unit?: string }
  | { type: "setIncidentPhase"; incidentId: string; phase: IncidentPhase }
  | { type: "addIncidentNote"; incidentId: string; text: string }
  /** Run one planned action on a portfolio building: marks it done and lowers the $ at risk. */
  | { type: "executeAction"; propertyId: string; actionId: string }
  /** Start an address lookup (operator typed it, or corrected the one heard on a call). */
  | { type: "lookupAddress"; address: string }
  /** Operator confirms one of `buildingLookup.candidates`: the server builds it and makes it active. */
  | { type: "confirmBuilding"; buildingId: string }
  /** Go back to the demo building (clears the incident). */
  | { type: "useDemoBuilding" };
