// One forecast from one or more fire origins: 0..30 min spread, exits per floor, a draft
// recommendation and a compact summary. Pure: used by the live incident and by POST /forecast.
import type { Building, FloorExit, Occupant, Recommendation } from "@firewatch/shared/types";
import { findExits, simulateSpread, type SpreadSnapshot } from "../simulation/index.ts";
import { recommend } from "./recommend.ts";

export const FORECAST_MINUTES = 30;

export interface ForecastData {
  building: Building;
  sprinklerRooms: string[];
  occupants: Occupant[];
}

export interface ForecastSummary {
  /** Floors where people are or will be in danger (fire floor, smoky rooms, or a stair fills). */
  floorsAtRisk: number[];
  peopleAtRisk: number;
  /** Per stairwell: floor -> first minute it fills with smoke (only floors where it does). */
  stairBlocked: Record<string, Record<number, number>>;
  /** Rooms with fire >= 0.3 at the end of the forecast. */
  roomsBurningAtEnd: string[];
}

export interface Forecast {
  /** The primary origin (first of `origins`). */
  origin: string;
  /** Every fire, all ignited at minute 0. */
  origins: string[];
  minutes: number;
  snapshots: SpreadSnapshot[];
  exits: FloorExit[];
  recommendation: Recommendation;
  summary: ForecastSummary;
}

export function forecast(origin: string | readonly string[], data: ForecastData, minutes = FORECAST_MINUTES): Forecast {
  const { building, sprinklerRooms, occupants } = data;
  const origins = [...new Set(typeof origin === "string" ? [origin] : origin)];
  const snapshots = simulateSpread(building, origins, minutes, { sprinklerRooms });
  const exits = findExits(building, snapshots, occupants);
  const fireFloors = new Set(building.rooms.filter((r) => origins.includes(r.id)).map((r) => r.floor));

  const atRisk = exits.filter(
    (e) => fireFloors.has(e.floor) || e.atRiskAt !== null || Object.values(e.blockedAt).some((m) => m !== null),
  );
  const stairBlocked: Record<string, Record<number, number>> = {};
  for (const e of exits)
    for (const [stair, m] of Object.entries(e.blockedAt))
      if (m !== null) (stairBlocked[stair] ??= {})[e.floor] = m;

  return {
    origin: origins[0],
    origins,
    minutes,
    snapshots,
    exits,
    recommendation: recommend(exits, origins, building),
    summary: {
      floorsAtRisk: atRisk.map((e) => e.floor),
      peopleAtRisk: atRisk.reduce((n, e) => n + e.people, 0),
      stairBlocked,
      roomsBurningAtEnd: snapshots[minutes].rooms.filter((r) => r.fire >= 0.3).map((r) => r.roomId),
    },
  };
}
