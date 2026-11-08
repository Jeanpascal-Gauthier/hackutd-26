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
  /** The map incident this report belongs to. Absent on building-pipeline reports. */
  incidentId?: string;
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
  /** What the map incidents do to the building portfolio: who is hit, what fails, the $ at risk, what to do. */
  portfolioImpact?: PortfolioImpact;
}

export interface LogEntry {
  time: number; // epoch ms
  kind: "report" | "origin" | "recommendation" | "accepted" | "dispatch" | "building";
  text: string;
  /** The map incident this entry is about. Absent for building-pipeline entries. */
  incidentId?: string;
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

export type MapIncidentKind = "fire" | "crash" | "flood" | "other";
export type IncidentSeverity = "minor" | "serious" | "critical" | "unknown";
export type LanesBlocked = "all" | "some" | "unknown";
/** Where the response to an incident stands. Separate from `status`, which tracks geocoding. */
export type IncidentPhase = "open" | "dispatched" | "on_scene" | "resolved";

/** One emergency on the map. Fires, crashes and floods get a forecast; `other` is a pin only. */
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
  /** Every caller's words, oldest first. `reply` is what the caller was told back. */
  reports: { caller: string; text: string; time: number; channel?: Report["channel"]; reply?: string }[];
  time: number; // epoch ms of the first report
  updated: number; // epoch ms of the last change
  phase: IncidentPhase;
  /** This incident's pending recommendation. Moves to `accepted` when the operator accepts it. */
  recommendation?: Recommendation;
  accepted?: { recommendation: Recommendation; time: number };
  /** Units the operator sent, oldest first. `unit` is free text, e.g. "Engine 3". */
  dispatches?: { unit?: string; time: number }[];
  /** Operator notes, oldest first. Kept separate from the caller-only responder brief. */
  notes?: { text: string; time: number }[];
  /** `none` for `other` incidents and until there is a location. */
  forecastStatus: "none" | "running" | "ready" | "failed";
  /** Epoch ms the current forecast was built. Forecast minutes count from here. */
  forecastAt?: number;
  fire?: FireForecast;
  crash?: CrashForecast;
  flood?: FloodForecast;
  /** How far this incident's effects reach, and why. Set once the incident is located. */
  impact?: BlastImpact;
  /** Red road sections: crash queues and flooded roads. */
  affectedRoads?: AffectedRoad[];
  /** Portfolio buildings this incident reaches (a view of `portfolioImpact.properties`). Highest cost first. */
  affectedProperties?: AffectedProperty[];
  /** The ~500 m city cell this incident sits in. Incidents in one zone are neighbours. */
  zoneId?: string;
  /** Ids of nearby incidents of a different kind. Linked, not merged. */
  related?: string[];
}

/** Modeled flood spread. Minutes count from the forecast's start. */
export interface FloodForecast {
  /** Ascending by minute. Polygons are closed rings without the first point repeated. */
  steps: { minute: number; water: GeoPoint[] }[];
  summary?: string;
  assumptions?: string[];
}

/** How far an incident's effects reach. */
export interface BlastImpact {
  /** Where the radius is measured from (the incident location). */
  center: GeoPoint;
  /** Base radius in metres (the circle to draw). */
  radiusMeters: number;
  /** Wind or water flow stretches the zone: it reaches `radiusMeters * factor` toward `towardDegrees`. */
  stretch?: { towardDegrees: number; factor: number };
  /** Plain-language reasons, shown to operators. */
  reasons: string[];
}

/** One red road section. */
export interface AffectedRoad {
  path: GeoPoint[];
  road: string | null;
  reason: "crash" | "flood" | "closure";
  /** Forecast minute the section turns red. */
  fromMinute: number;
}

/** One link in a building's failure chain, in time order. */
export interface FailureStep {
  /** Unique within the property, e.g. "dc-1:hvac". */
  id: string;
  /** Forecast minute it happens (0 = now). May exceed the horizon for slow effects like fuel running out. */
  minute: number;
  /** The PortfolioSystem.id that fails, or "building" for whole-building effects. */
  systemId: string;
  /** Short display text: "Smoke reaches HVAC intake". */
  label: string;
  hazard: "fire" | "smoke" | "water" | "access" | "power" | "heat";
  /** The step this one follows from (null for the first contact with the hazard). */
  causedBy: string | null;
  incidentId: string;
}

/** One concrete step for a facility manager. */
export interface PlannedAction {
  /** Unique within the property, e.g. "dc-1:close-dampers". */
  id: string;
  /** Imperative: "Close outside-air dampers". */
  text: string;
  /** Do it before this forecast minute. 0 = now. */
  deadlineMinute: number;
  /** FailureStep ids this action stops. */
  prevents: string[];
  /** USD this action saves on its own. */
  savesUsd: number;
  /** Why this works, one line. */
  reason: string;
  /** Flipped when the operator presses Execute. */
  status: "pending" | "done";
}

export interface CostBreakdown {
  slaUsd: number;
  lostRentUsd: number;
  damageUsd: number;
  totalUsd: number;
}

export type PortfolioUse = "data_center" | "hospital" | "office" | "retail" | "residential" | "industrial";

/** One portfolio building an incident reaches. */
export interface AffectedProperty {
  /** PortfolioBuilding.id */
  id: string;
  name: string;
  use: PortfolioUse;
  location: GeoPoint;
  risk: "high" | "moderate" | "low";
  /** Every incident that touches this building. */
  incidentIds: string[];
  /** Time ordered. */
  chain: FailureStep[];
  /** People in the building now who are affected. */
  people: number;
  /** Estimated downtime if nothing is done. */
  downtimeHours: number;
  cost: CostBreakdown;
  /** True when every access road is blocked. */
  accessCut: boolean;
  /** Ordered by deadline. */
  actions: PlannedAction[];
  /** Plain-language reasons for the risk level. */
  reasons: string[];
}

/** Portfolio-wide totals for the impact card. */
export interface ImpactSummary {
  buildings: number;
  people: number;
  usdAtRisk: number;
  /** usdAtRisk minus what the done actions save. */
  usdAtRiskAfterActions: number;
  horizonMinutes: number;
  /** "6 buildings · 1,240 people · ~$380K at risk in the next 30 min" */
  headline: string;
}

/** What every incident together does to the portfolio. Recomputed when an incident changes or an action runs. */
export interface PortfolioImpact {
  properties: AffectedProperty[];
  summary: ImpactSummary;
  /** One paragraph for the operator. */
  briefing: string;
  /** "llm": Nemotron ran the tools. "rules": the deterministic path did. */
  mode: "llm" | "rules";
  /** The agent's tool calls, oldest first, for the console's agent trail. */
  trail?: TrailStep[];
  /** Epoch ms. */
  time: number;
}

export type SystemKind =
  | "utility_power"
  | "electrical_room"
  | "generator"
  | "fuel_supply"
  | "ups"
  | "hvac"
  | "air_intake"
  | "cooling"
  | "servers"
  | "life_safety"
  | "elevators"
  | "water"
  | "access_control"
  | "medical_gas"
  | "refrigeration";

/** One building system and what it depends on. The dependency list IS the dependency graph. */
export interface PortfolioSystem {
  /** Unique within the building, e.g. "hvac". */
  id: string;
  kind: SystemKind;
  label: string;
  /** System ids this one needs. If any fails (and no backup covers it), this one fails too. */
  dependsOn: string[];
  /** This system keeps running if ANY of these is up, even when a `dependsOn` entry has failed. */
  backups?: string[];
  /** Where it sits. Basement systems flood first; roof/ground air intakes take smoke. */
  level: "basement" | "ground" | "roof";
  /** Which side of the building it faces, compass degrees. */
  facingDegrees?: number;
  /** Minutes between its dependency failing and it failing. Default 0. */
  lagMinutes?: number;
  /** Generators: hours of fuel on site. */
  runtimeHours?: number;
  /** Hours to restore it once it has failed. */
  restoreHours: number;
  /** Physical damage if it fails. 0 if it only stops. */
  damageUsd: number;
}

export interface PortfolioTenant {
  name: string;
  /** Contractual penalty per hour of downtime. 0 when the lease has no SLA. */
  slaPenaltyPerHour: number;
  rentPerMonth: number;
  /** The systems this tenant needs. */
  dependsOn: string[];
}

/** A building in the portfolio: its systems, leases and access. Synthetic demo data. */
export interface PortfolioBuilding {
  id: string;
  name: string;
  address: string;
  use: PortfolioUse;
  location: GeoPoint;
  /** Metres above sea level at grade. Lower ground floods first. */
  elevationM: number;
  /** People inside by time of day. */
  occupancy: { day: number; night: number };
  systems: PortfolioSystem[];
  tenants: PortfolioTenant[];
  access: {
    /** Road names the building is reached by. All blocked = access cut. */
    roads: string[];
    /** The road the generator's fuel truck uses. */
    fuelRoute?: string;
  };
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
  /** What the place is, when it matters to responders: "hospital", "school", "nursing home", ... */
  use?: string | null;
}

/** Modeled, not observed. Show `assumptions` with it. Minutes count from the forecast's start. */
export interface CrashForecast {
  /** Name of the road the crash is on. Null when unnamed or none is mapped nearby. */
  road: string | null;
  /** Short stretches of road. Draw those with `queueMinute` <= the forecast minute. */
  segments: CongestionSegment[];
  /** Ascending by minute. */
  steps: { minute: number; queueMeters: number; roads: string[] }[];
  /** Modeled: when the road is assumed to reopen, and when the queue is gone (null: beyond the model's range). */
  clearance?: { reopenMinute: number; clearedMinute: number | null };
  /** Named nearby roads outside the queue that traffic could divert to, best first. */
  alternateRoads?: string[];
  summary: string;
  assumptions: string[];
}

export interface CongestionSegment {
  path: GeoPoint[];
  road: string | null;
  queueMinute: number;
  level: "blocked" | "heavy" | "moderate";
}
