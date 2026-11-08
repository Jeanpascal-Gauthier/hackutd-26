// Import the team's contract directly so server and headset cannot drift apart.
// These are type-only imports; no server implementation enters the browser bundle.
import type { Building, GeoPoint, IncidentState, MapIncident, Occupant } from '../../shared/types';
export type {
  Building, Room, Link, Vertical, Occupant, Report, RoomState,
  Recommendation, FloorExit, TrailStep, IncidentState, LogEntry, MapIncident, GeoPoint,
} from '../../shared/types';
export type { ClientEvent, ServerEvent } from '../../shared/events';
export type Dispatch = NonNullable<IncidentState['dispatches']>[number];
export type AcceptedRecommendation = NonNullable<IncidentState['accepted']>;

export interface BuildingInfo {
  building: Building;
  occupants: Occupant[];
  sprinklers: Record<string, 'active' | 'impaired' | 'none'>;
}

// Flood fields the server adds to map incidents (server/src/incidents/stepZero.ts) until they move
// into shared/types.ts. A flood is an incident with `flood` set; its kind is still "other".
export interface FloodForecast {
  /** Ascending by minute; each ring is closed without the first point repeated. */
  steps: { minute: number; water: GeoPoint[] }[];
  summary?: string;
}

export interface AffectedRoad {
  path: GeoPoint[];
  road: string | null;
  reason: 'crash' | 'flood' | 'closure';
  /** Forecast minute the section goes under water or turns red. */
  fromMinute: number;
}

export type MapIncidentPlus = MapIncident & { flood?: FloodForecast; affectedRoads?: AffectedRoad[] };
