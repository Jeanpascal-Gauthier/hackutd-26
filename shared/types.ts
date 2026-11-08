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
  /** What the room is used for; drives occupancy estimates. Absent on the demo building: infer from id/name. */
  kind?: RoomKind;
}

export type RoomKind =
  | "office"
  | "open-office"
  | "conference"
  | "break"
  | "storage"
  | "utility"
  | "lobby"
  | "hall"
  | "stair"
  | "elevator"
  | "residential"
  | "hotel-room"
  | "classroom"
  | "lab"
  | "retail"
  | "dining"
  | "patient"
  | "assembly";

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
  /** True when the count is an estimate (room kind x building use x time of day), not a record. */
  estimated?: boolean;
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
  /**
   * The building this incident runs on. Clients fetch GET /building again whenever `id` or
   * `version` changes. Absent from older servers: assume the demo building.
   */
  building?: { id: string; name: string; version: number; layoutEstimated: boolean };
  /** An address lookup in progress, waiting for the operator to confirm a building, or just finished. */
  buildingLookup?: BuildingLookup;
  /** Every reported emergency for the map view, oldest first. Survives a change of active building. */
  mapIncidents?: MapIncident[];
}

export interface LogEntry {
  time: number; // epoch ms
  kind: "report" | "origin" | "recommendation" | "accepted" | "dispatch" | "building";
  text: string;
}

/** Shape of shared/building.json, and of GET /building's `building` for any active building. */
export interface Building {
  rooms: Room[];
  links: Link[];
  verticals: Vertical[];
  /** Who and where the building is. Absent from the demo building file (treat as the demo). */
  profile?: BuildingProfile;
}

export interface BuildingProfile {
  id: string; // "demo", or the lookup id, e.g. "osm:way:123"
  name: string; // display name
  address?: string;
  source: "demo" | "osm";
  /** Building use: "office", "residential", "school", "university", "hospital", "hotel", "retail", "mixed", ... */
  use: string;
  floors: number;
  location?: { lat: number; lon: number };
  /** IANA time zone at the building, for time-of-day occupancy (e.g. "America/Chicago"). */
  timezone?: string;
  /**
   * The real footprint, in the same local metre frame as the rooms (x, z), as one closed ring
   * without repeating the first point. Rooms lie inside it.
   */
  outline?: [number, number][];
  /** True when rooms, doors and stairs were generated rather than mapped. */
  layoutEstimated: boolean;
  /** Plain-language notes on what was assumed, shown on the console. */
  assumptions: string[];
  /** Attribution to display, e.g. "© OpenStreetMap contributors (ODbL)". */
  attribution?: string;
}

export interface BuildingLookup {
  /** The address as heard or typed. */
  query: string;
  caller?: string;
  status: "searching" | "needs_confirmation" | "loading" | "active" | "failed";
  /** Best geocoded match for the query. */
  match?: { formatted: string; lat: number; lon: number };
  /** Building outlines near the match, nearest first. Empty while searching or when none are mapped. */
  candidates: BuildingCandidateSummary[];
  error?: string;
  time: number; // epoch ms the lookup started
}

export interface BuildingCandidateSummary {
  id: string; // "osm:way:123"
  name: string | null;
  address: string | null;
  floors: number | null;
  heightMeters: number | null;
  /** OSM `building` tag value, e.g. "office", "apartments", "yes". */
  use: string | null;
  /** From the geocoded point to the outline (0 when the point is inside it). */
  distanceMeters: number;
  /** Footprint in metres relative to the geocoded point (x = east, z = south), for a mini map. */
  outline: [number, number][];
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type MapIncidentKind = "fire" | "crash" | "other";
export type IncidentSeverity = "minor" | "serious" | "critical" | "unknown";
export type LanesBlocked = "all" | "some" | "unknown";

/** One emergency on the map. Fires and crashes get a forecast; `other` is a pin only. */
export interface MapIncident {
  id: string;
  kind: MapIncidentKind;
  /** Short display name: "Fire", "Car crash", "Gas leak", ... */
  label: string;
  severity: IncidentSeverity;
  /**
   * locating: geocoding `query`. located: `location` is set. needs_location: nothing usable was
   * given or found, so the caller is asked again. failed: the geocoder was unavailable (`error`).
   */
  status: "locating" | "located" | "needs_location" | "failed";
  /** The place as the caller said it. */
  query?: string;
  location?: GeoPoint;
  formatted?: string;
  error?: string;
  /** Fires: true when the fire is inside a building, which also starts the building lookup. */
  inBuilding?: boolean;
  /** Crashes: how much of the road is blocked. */
  lanesBlocked?: LanesBlocked;
  /** Every caller's words, oldest first. */
  reports: { caller: string; text: string; time: number; channel?: Report["channel"] }[];
  time: number; // epoch ms of the first report
  updated: number; // epoch ms of the last change
  /** `none` for `other` incidents and until there is a location. */
  forecastStatus: "none" | "running" | "ready" | "failed";
  fire?: FireForecast;
  crash?: CrashForecast;
}

export interface WindReading {
  speedMps: number;
  /** Compass degrees the wind blows from. */
  fromDegrees: number;
}

/** Modeled, not observed. Show `assumptions` with it. Minutes count from the forecast's start. */
export interface FireForecast {
  /** Null when weather was unavailable: smoke is then an even circle, not a plume. */
  wind: WindReading | null;
  /** Ascending by minute. Polygons are closed rings without the first point repeated. */
  steps: { minute: number; fire: GeoPoint[]; smoke: GeoPoint[] }[];
  /** Nearby buildings, soonest fire arrival first. */
  exposures: FireExposure[];
  summary: string;
  assumptions: string[];
}

export interface FireExposure {
  id: string;
  name: string | null;
  /** The building's position, always present. */
  location: GeoPoint;
  /** Footprint ring. Empty when the data source only gave a point: draw a marker instead. */
  outline: GeoPoint[];
  distanceMeters: number;
  /** True for the building the fire started in. */
  origin: boolean;
  fireEtaMinutes: number;
  /** Null when the plume does not reach it within 30 minutes. */
  smokeEtaMinutes: number | null;
  risk: "high" | "moderate" | "low";
}

/** Modeled, not observed. Show `assumptions` with it. Minutes count from the forecast's start. */
export interface CrashForecast {
  /** Name of the road the crash is on. Null when unnamed or none is mapped nearby. */
  road: string | null;
  /** Short stretches of road. Draw those with `queueMinute` <= the forecast minute. */
  segments: CongestionSegment[];
  /** Ascending by minute. */
  steps: { minute: number; queueMeters: number; roads: string[] }[];
  summary: string;
  assumptions: string[];
}

export interface CongestionSegment {
  path: GeoPoint[];
  road: string | null;
  queueMinute: number;
  level: "blocked" | "heavy" | "moderate";
}
