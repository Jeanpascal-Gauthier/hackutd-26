// three.js-free heat source helpers, so the floor plan can compute sources without pulling
// three into the main bundle (the WebGL overlay itself is lazy-loaded).
import type { IncidentState } from "@firewatch/shared/types";

/** Below this a room counts as clear. */
export const HEAT_FLOOR = 0.01;

export interface HeatSource { x: number; z: number; w: number; d: number; fire: number; smoke: number }
/** [minX, minZ, maxX, maxZ] in building metres. */
export type HeatRect = [number, number, number, number];

/** Heat sources for the given rooms from the incident state (values clamped to 0..1). */
export function heatSources(rooms: { id: string; x: number; z: number; w: number; d: number }[], state: IncidentState | null): HeatSource[] {
  const byId = new Map((state?.rooms ?? []).map((room) => [room.roomId, room]));
  const clamp = (v: number | undefined) => Math.min(1, Math.max(0, v ?? 0));
  return rooms.map((room) => ({ x: room.x, z: room.z, w: room.w, d: room.d, fire: clamp(byId.get(room.id)?.fire), smoke: clamp(byId.get(room.id)?.smoke) }));
}

export const hasHeat = (sources: HeatSource[]) => sources.some((s) => s.fire > HEAT_FLOOR || s.smoke > HEAT_FLOOR);
