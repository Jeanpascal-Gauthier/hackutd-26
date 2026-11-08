// The building the incident runs on. Starts as the bundled demo building and follows the server:
// whenever `state.building` (id or version) changes, GET /building is fetched again. Components read it
// with useBuilding(); App owns the source (useActiveBuildingSource) and provides it.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import demoJson from "@firewatch/shared/building.json";
import type { Building, BuildingProfile, IncidentState, Room } from "@firewatch/shared/types";
import { HTTP_URL } from "./useIncident";

export interface ActiveBuilding {
  building: Building;
  rooms: Room[];
  roomsById: Map<string, Room>;
  /** Floor numbers present in the geometry, ascending. */
  floors: number[];
  /** The building's profile; the demo file has none, so a demo profile is filled in. */
  profile: BuildingProfile;
  isDemo: boolean;
  /** Changes only when the room geometry changes (selection and floor reset on change). */
  geometryKey: string;
  /** Changes when anything the 3D view draws changes (rooms, outline). */
  shapeKey: string;
  roomName(id?: string): string;
}

export type BuildingSync = "bundled" | "loading" | "ready" | "error";

export const demoBuilding = demoJson as Building;

/** 32-bit FNV-1a hash, so keys stay short for large buildings. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export function describeBuilding(building: Building): ActiveBuilding {
  const rooms = building.rooms;
  const roomsById = new Map(rooms.map((room) => [room.id, room]));
  const floors = [...new Set(rooms.map((room) => room.floor))].sort((a, b) => a - b);
  const profile: BuildingProfile = building.profile ?? {
    id: "demo", name: "Demo office building", source: "demo", use: "office", floors: floors.length,
    layoutEstimated: false, assumptions: [],
  };
  const geometry = rooms.map((room) => `${room.id}:${room.floor}:${room.x}:${room.z}:${room.w}:${room.d}`).join("|");
  const geometryKey = `${rooms.length}-${hash(geometry)}`;
  return {
    building, rooms, roomsById, floors, profile,
    isDemo: profile.source === "demo",
    geometryKey,
    shapeKey: `${geometryKey}-${hash(JSON.stringify(profile.outline ?? null))}`,
    roomName: (id) => roomsById.get(id ?? "")?.name ?? id ?? "Location pending",
  };
}

const bundled = describeBuilding(demoBuilding);
const BuildingContext = createContext<ActiveBuilding>(bundled);
export const BuildingProvider = BuildingContext.Provider;
export const useBuilding = () => useContext(BuildingContext);

function isBuilding(value: unknown): value is Building {
  const b = value as Building | null;
  return !!b && Array.isArray(b.rooms) && Array.isArray(b.links) && Array.isArray(b.verticals) && b.rooms.length > 0;
}

/**
 * Owns the active building. `override` (dev fixtures) replaces the server's building.
 * A fetched building only replaces the current object when its content differs, so an unchanged
 * demo building never rebuilds the views.
 */
export function useActiveBuildingSource(state: IncidentState | null, override?: Building | null): { active: ActiveBuilding; sync: BuildingSync } {
  const [active, setActive] = useState<ActiveBuilding>(bundled);
  const [sync, setSync] = useState<BuildingSync>("bundled");
  const contentRef = useRef(JSON.stringify(demoBuilding));
  const want = state?.building ? `${state.building.id}#${state.building.version}` : null;
  const legacy = state !== null && !state.building;

  useEffect(() => {
    const adopt = (building: Building) => {
      const content = JSON.stringify(building);
      if (content === contentRef.current) return;
      contentRef.current = content;
      setActive(building === demoBuilding ? bundled : describeBuilding(building));
    };
    if (override) { adopt(override); setSync("ready"); return; }
    if (!want) {
      // Older servers have no `building` field: they always run the demo building.
      if (legacy) { adopt(demoBuilding); setSync("bundled"); }
      return;
    }
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const load = () => {
      controller = new AbortController();
      setSync("loading");
      fetch(`${HTTP_URL}/building`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        .then(async (response) => {
          if (!response.ok) throw new Error(`GET /building ${response.status}`);
          const body = await response.json() as { building?: unknown };
          if (!isBuilding(body.building)) throw new Error("GET /building returned no rooms");
          if (disposed) return;
          adopt(body.building);
          setSync("ready");
        })
        .catch(() => {
          if (disposed) return;
          setSync("error");
          // Keep the last building on screen and retry with backoff until it loads.
          timer = setTimeout(load, Math.min(1500 * 2 ** attempt++, 15000));
        });
    };
    load();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [want, legacy, override]);

  return { active, sync };
}

/** People recorded in one room, excluding inferred occupancy. */
export function roomPeople(state: IncidentState | null, roomId: string) {
  const items = state?.occupants.filter((item) => item.room === roomId && !item.estimated) ?? [];
  return { count: items.reduce((sum, item) => sum + item.count, 0), known: items.length > 0 };
}

/** Floors whose occupant counts include estimates. */
export function estimatedFloors(state: IncidentState | null, active: ActiveBuilding): Set<number> {
  const out = new Set<number>();
  for (const item of state?.occupants ?? []) {
    if (!item.estimated) continue;
    const floor = active.roomsById.get(item.room)?.floor;
    if (floor !== undefined) out.add(floor);
  }
  return out;
}
