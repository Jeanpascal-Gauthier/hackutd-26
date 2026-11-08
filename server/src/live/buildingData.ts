// The building the live incident runs on: shared/building.json (the contract) plus the
// records the contract has no field for yet (sprinklers, occupants, door ratings,
// inspection records), from data/out/building.meta.json.
// Read from disk so the server needs no dependency on the data workspace.
import { readFileSync } from "node:fs";
import type { Building, Occupant } from "@firewatch/shared/types";
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

interface Meta {
  doors: DoorRating[];
  sprinklers: Record<string, SprinklerStatus>;
  occupants: Occupant[];
  inspections: InspectionRecord[];
}

const meta = JSON.parse(
  readFileSync(new URL("../../../data/out/building.meta.json", import.meta.url), "utf8"),
) as Meta;

export const building = sharedBuilding as Building;
/** Sprinkler status per room id. */
export const sprinklers: Record<string, SprinklerStatus> = meta.sprinklers;
/** Rooms whose sprinklers work (impaired and none excluded). */
export const sprinklerRooms: string[] = Object.entries(meta.sprinklers)
  .filter(([, status]) => status === "active")
  .map(([id]) => id);
export const occupants: Occupant[] = meta.occupants;
/** Every door link with its fire rating. */
export const doors: DoorRating[] = meta.doors ?? [];
/** Sprinkler, fire-door, fire-alarm and standpipe inspection records (as of 2026-11-07). */
export const inspections: InspectionRecord[] = meta.inspections ?? [];
