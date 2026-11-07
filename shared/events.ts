// WebSocket message types. Types only — no runtime code.
// Tell the team before changing anything here.

import type { IncidentState } from "./types.ts";

/** server -> client */
export type ServerEvent = { type: "state"; state: IncidentState };

/** client -> server */
export type ClientEvent =
  | { type: "setSimMinute"; minute: number }
  | { type: "acceptRecommendation" }
  | { type: "dispatch"; roomId: string };
