/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Mirrors shared/types.ts and shared/events.ts (server/API.md is the source
 * of truth). headset/ isn't an npm workspace member yet, so these are a
 * plain copy of the wire shapes rather than an import; keep in sync by hand
 * until headset/ joins the workspace.
 */

export interface Room {
  id: string;
  floor: number;
  name: string;
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Link {
  a: string;
  b: string;
  kind: 'door' | 'wall';
  fireRated: boolean;
  closed: boolean;
}

export interface Vertical {
  id: string;
  kind: 'stair' | 'elevator';
  floors: [number, number];
  doorsClosed: boolean;
}

export interface Building {
  rooms: Room[];
  links: Link[];
  verticals: Vertical[];
}

export interface Occupant {
  room: string;
  count: number;
  flags: string[];
}

export interface Report {
  id: string;
  caller: string;
  text: string;
  roomId?: string;
  confidence?: number;
  time: number;
}

export interface RoomState {
  roomId: string;
  fire: number;
  smoke: number;
}

export interface Recommendation {
  actions: string[];
  callerReply?: string;
}

export interface FloorExit {
  floor: number;
  people: number;
  flags: string[];
  stair: string | null;
  blockedAt: Record<string, number | null>;
  atRiskAt: number | null;
  /** Rooms to light green: hall -> clear stairwell -> down to floor 1. */
  route?: string[];
}

export interface Dispatch {
  roomId: string;
  time: number;
}

export interface LogEntry {
  time: number;
  kind: 'report' | 'origin' | 'recommendation' | 'accepted' | 'dispatch';
  text: string;
}

export interface AcceptedRecommendation {
  recommendation: Recommendation;
  time: number;
}

export interface TrailStep {
  tool: string;
  input: unknown;
  output: unknown;
  ms: number;
}

export interface IncidentState {
  simMinute: number;
  rooms: RoomState[];
  reports: Report[];
  occupants: Occupant[];
  recommendation?: Recommendation;
  accepted?: AcceptedRecommendation;
  origin?: { roomId: string; confidence: number };
  exits?: FloorExit[];
  dispatches?: Dispatch[];
  trail?: TrailStep[];
  log?: LogEntry[];
}

export type ServerEvent = { type: 'state'; state: IncidentState };

export type ClientEvent =
  | { type: 'setSimMinute'; minute: number }
  | { type: 'acceptRecommendation' }
  | { type: 'dispatch'; roomId: string };

export interface BuildingInfo {
  building: Building;
  occupants: Occupant[];
  sprinklers: Record<string, 'active' | 'impaired' | 'none'>;
}
