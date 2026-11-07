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

export interface IncidentState {
  simMinute: number;
  rooms: RoomState[];
  reports: Report[];
  occupants: Occupant[];
  recommendation?: Recommendation;
}

/** Shape of shared/building.json. */
export interface Building {
  rooms: Room[];
  links: Link[];
  verticals: Vertical[];
}
