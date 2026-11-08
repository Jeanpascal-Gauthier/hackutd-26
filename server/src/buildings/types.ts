// Public-source building records are independent of the rectangular demo simulation model.
export interface Coordinates { lat: number; lon: number }
export type Position = [number, number]; // [longitude, latitude], in degrees
export interface PolygonGeometry { type: "Polygon"; coordinates: Position[][] }
export interface MultiPolygonGeometry { type: "MultiPolygon"; coordinates: Position[][][] }
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;
export interface PointGeometry { type: "Point"; coordinates: Position }
export interface LineStringGeometry { type: "LineString"; coordinates: Position[] }
export type FeatureGeometry = AreaGeometry | PointGeometry | LineStringGeometry;

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role?: string;
  geometry?: Coordinates[];
  lat?: number;
  lon?: number;
}
export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: Coordinates[];
  members?: OsmMember[];
  lat?: number;
  lon?: number;
  center?: Coordinates;
  timestamp?: string;
}

export interface BuildingSource {
  provider: "openstreetmap" | "location";
  id: string | null;
  url: string | null;
  attribution: string;
  license: string | null;
  fetchedAt: string;
  updatedAt: string | null;
}
export interface BuildingCandidate {
  id: string;
  name: string | null;
  address: string | null;
  location: Coordinates;
  footprint: AreaGeometry | null;
  heightMeters: number | null;
  floorsAboveGround: number | null;
  /**
   * The outline's descriptive OSM tags (building, building:use, building:levels, amenity, name, ...),
   * so a candidate list can show what each building is. A full BuildingRecord carries every tag.
   */
  tags?: Record<string, string>;
  source: BuildingSource;
}
export interface FloorRecord {
  id: string;
  sourceLevel: string;
  label: string;
  sourceLabel: string | null;
}
export interface RoomRecord {
  id: string;
  name: string | null;
  number: string | null;
  kind: "room" | "corridor" | "area" | "stair" | "elevator" | "unknown";
  purpose: string | null;
  sourceLevels: string[];
  floorIds: string[];
  geometry: FeatureGeometry | null;
  tags: Record<string, string>;
  source: BuildingSource;
}
export interface ConnectionRecord {
  id: string;
  kind: "door" | "entrance" | "stair" | "elevator";
  roomIds: string[];
  floorIds: string[];
  geometry: FeatureGeometry | null;
  state: "unknown";
  tags: Record<string, string>;
  source: BuildingSource;
}
export interface BuildingRecord extends BuildingCandidate {
  floors: FloorRecord[];
  rooms: RoomRecord[];
  connections: ConnectionRecord[];
  tags: Record<string, string>;
  completeness: {
    footprint: boolean;
    height: boolean;
    floorLabels: boolean;
    interiors: "none" | "partial";
    // Mapped elements alone never establish complete routing or simulation inputs.
    routeReady: false;
  };
  warnings: string[];
}
