// The building the live incident runs on: shared/building.json (the contract) plus the
// records the contract has no field for yet (sprinklers, occupants), from data/out/.
// Read from disk so the server needs no dependency on the data workspace.
import { readFileSync } from "node:fs";
import type { Building, Occupant } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };

interface Meta {
  sprinklers: Record<string, "active" | "impaired" | "none">;
  occupants: Occupant[];
}

const meta = JSON.parse(
  readFileSync(new URL("../../../data/out/building.meta.json", import.meta.url), "utf8"),
) as Meta;

export const building = sharedBuilding as Building;
/** Sprinkler status per room id. */
export const sprinklers: Record<string, "active" | "impaired" | "none"> = meta.sprinklers;
/** Rooms whose sprinklers work (impaired and none excluded). */
export const sprinklerRooms: string[] = Object.entries(meta.sprinklers)
  .filter(([, status]) => status === "active")
  .map(([id]) => id);
export const occupants: Occupant[] = meta.occupants;
