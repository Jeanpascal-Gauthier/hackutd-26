// Shared domain types. Types only — no runtime code.
// Tell the team before changing anything here.

export interface Room {
  id: string; // e.g. "7-break"
  floor: number;
  name: string;
  // Footprint in metres, floor-plan coordinates.
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Link {
  a: string; // Room id
  b: string; // Room id
  kind: "door" | "wall";
  fireRated: boolean;
  closed: boolean;
}

export interface Vertical {
  id: string;
  kind: "stair" | "elevator";
  floors: [number, number]; // [lowest, highest]
  doorsClosed: boolean;
}

export interface Occupant {
  room: string; // Room id
  count: number;
  flags: string[]; // e.g. "mobility", "child"
}

export interface Report {
  id: string;
  caller: string;
  text: string;
  roomId?: string;
  confidence?: number; // 0..1
  time: number; // epoch ms
  /** What FireSight said back to the caller (follow-up question or advice), for transcripts. */
  reply?: string;
  /** How the report arrived. Absent on older reports. */
  channel?: "voice" | "sms" | "form" | "console";
}

export interface RoomState {
  roomId: string;
  fire: number; // 0..1 intensity
  smoke: number; // 0..1 density
}

export interface Recommendation {
  actions: string[];
  callerReply?: string;
}

/** Evacuation picture for one occupied floor, over the whole 0..30 min forecast. */
export interface FloorExit {
  floor: number;
  people: number;
  flags: string[]; // union of occupant flags on the floor
  stair: string | null; // recommended stairwell id, e.g. "stair-a"; null if none
  blockedAt: Record<string, number | null>; // stairwell id -> first minute its smoke >= 0.3 (null = stays clear)
  atRiskAt: number | null; // first minute an occupied room on this floor reaches smoke >= 0.3
  /** Rooms to light green: hall -> clear stairwell -> down to floor 1. Empty if no stair. */
  route?: string[];
}

/** One logged agent tool call, for the console's agent trail. */
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
  /** Most likely fire origin, merged from all reports. */
  origin?: { roomId: string; confidence: number };
  /** Per occupied floor: which stairwell is clear and when smoke arrives. */
  exits?: FloorExit[];
  /** Agent tool calls, oldest first. */
  trail?: TrailStep[];
  /** The recommendation the commander accepted (the route stays lit after accepting). */
  accepted?: { recommendation: Recommendation; time: number };
  /** Crews sent from the headset/console (`dispatch` events). */
  dispatches?: { roomId: string; time: number }[];
  /** Ready-made incident log for the console, oldest first (last 200). */
  log?: LogEntry[];
}

export interface LogEntry {
  time: number; // epoch ms
  kind: "report" | "origin" | "recommendation" | "accepted" | "dispatch";
  text: string;
}

/** Shape of shared/building.json. */
export interface Building {
  rooms: Room[];
  links: Link[];
  verticals: Vertical[];
}
