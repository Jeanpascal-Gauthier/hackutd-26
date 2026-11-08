// Import the team's contract directly so server and headset cannot drift apart.
// These are type-only imports; no server implementation enters the browser bundle.
import type { Building, IncidentState, Occupant } from '../../shared/types';
export type {
  Building, Room, Link, Vertical, Occupant, Report, RoomState,
  Recommendation, FloorExit, TrailStep, IncidentState, LogEntry, MapIncident,
} from '../../shared/types';
export type { ClientEvent, ServerEvent } from '../../shared/events';
export type Dispatch = NonNullable<IncidentState['dispatches']>[number];
export type AcceptedRecommendation = NonNullable<IncidentState['accepted']>;

export interface BuildingInfo {
  building: Building;
  occupants: Occupant[];
  sprinklers: Record<string, 'active' | 'impaired' | 'none'>;
}
