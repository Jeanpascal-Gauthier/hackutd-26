// The building the live incident runs on. The demo building is shared/building.json (the
// contract) plus the records the contract has no field for (sprinklers, occupants, door ratings,
// inspection records), from data/out/building.meta.json, read from disk so the server needs no
// dependency on the data workspace. An address lookup (live/lookup.ts) can replace it with a
// building synthesized from a public record; ActiveBuilding holds whichever one is current, and
// every reader (live incident, forecast, GET /building, /inspections, client actions) asks it.
import { readFileSync } from "node:fs";
import type { Building, BuildingProfile, IncidentState, Occupant } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };

export type SprinklerStatus = "active" | "impaired" | "none";

/** A door link and its fire rating (data/model.ts DoorMeta). */
export interface DoorRating {
  a: string;
  b: string;
  /** Minutes of fire resistance; 0 = ordinary door. */
  ratingMinutes: number;
}

/** One inspection record (mirrors data/model.ts InspectionRecord). */
export interface InspectionRecord {
  /** `${system}:${target}` */
  id: string;
  system: "sprinkler" | "fire-door" | "fire-alarm" | "standpipe";
  /** Room id (sprinkler), "a|b" door id (fire-door), or "floor-N" (fire-alarm, standpipe). */
  target: string;
  floor: number;
  lastInspected: string; // ISO date
  nextDue: string; // ISO date
  status: "pass" | "overdue" | "deficient";
  finding?: string;
}

/** Everything the incident needs about one building. `building.profile` is always set. */
export interface BuildingData {
  building: Building & { profile: BuildingProfile };
  /** Sprinkler status per room id. */
  sprinklers: Record<string, SprinklerStatus>;
  /** Rooms whose sprinklers work (impaired and none excluded). */
  sprinklerRooms: string[];
  occupants: Occupant[];
  /** Every door link with its fire rating. */
  doors: DoorRating[];
  /** Sprinkler, fire-door, fire-alarm and standpipe inspection records ([] for public buildings). */
  inspections: InspectionRecord[];
}

export function buildingData(input: {
  building: Building & { profile: BuildingProfile };
  sprinklers: Record<string, SprinklerStatus>;
  occupants?: Occupant[];
  doors?: DoorRating[];
  inspections?: InspectionRecord[];
}): BuildingData {
  return {
    building: input.building,
    sprinklers: input.sprinklers,
    sprinklerRooms: Object.entries(input.sprinklers)
      .filter(([, status]) => status === "active")
      .map(([id]) => id),
    occupants: input.occupants ?? [],
    doors: input.doors ?? [],
    inspections: input.inspections ?? [],
  };
}

interface Meta {
  doors: DoorRating[];
  sprinklers: Record<string, SprinklerStatus>;
  occupants: Occupant[];
  inspections: InspectionRecord[];
}

const meta = JSON.parse(
  readFileSync(new URL("../../../data/out/building.meta.json", import.meta.url), "utf8"),
) as Meta;

/** Runtime profile of the demo building (shared/building.json has none). */
export const DEMO_PROFILE: BuildingProfile = {
  id: "demo",
  name: "Meridian Tower (demo)",
  source: "demo",
  use: "office",
  floors: 12,
  layoutEstimated: false,
  assumptions: [],
};

/** The demo building: shared/building.json + data/out/building.meta.json. */
export const DEMO: BuildingData = buildingData({
  building: { ...(sharedBuilding as Building), profile: DEMO_PROFILE },
  sprinklers: meta.sprinklers,
  occupants: meta.occupants,
  doors: meta.doors ?? [],
  inspections: meta.inspections ?? [],
});

/** The building the incident runs on now. Starts on the demo building, version 1. */
export class ActiveBuilding {
  private data: BuildingData;
  private ver = 1;

  constructor(initial: BuildingData = DEMO) {
    this.data = initial;
  }

  get(): BuildingData {
    return this.data;
  }

  get version(): number {
    return this.ver;
  }

  get isDemo(): boolean {
    return this.data === DEMO;
  }

  /** Make `data` the active building; the version always increments. Returns the new version. */
  set(data: BuildingData): number {
    this.data = data;
    return ++this.ver;
  }

  /** `IncidentState.building` for the current building. */
  summary(): NonNullable<IncidentState["building"]> {
    const p = this.data.building.profile;
    return { id: p.id, name: p.name, version: this.ver, layoutEstimated: p.layoutEstimated };
  }

  roomIds(): Set<string> {
    return new Set(this.data.building.rooms.map((r) => r.id));
  }
}
