// MOCK scripted incident: "7-break" catches fire, smoke spreads to "8-hall".
// Replace with a real simulation later.
import type { IncidentState, RoomState } from "@firewatch/shared/types";

const SCRIPT_LENGTH = 10; // minutes, then loops

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function mockState(simMinute: number): IncidentState {
  const m = simMinute % SCRIPT_LENGTH;
  const rooms: RoomState[] = [
    // Fire starts at minute 1 and grows.
    { roomId: "7-break", fire: clamp((m - 1) / 4), smoke: clamp((m - 1) / 2) },
    // Smoke reaches the floor 7 hall at minute 2, then floor 8 hall at minute 4.
    { roomId: "7-hall", fire: 0, smoke: clamp((m - 2) / 4) },
    { roomId: "8-hall", fire: 0, smoke: clamp((m - 4) / 4) },
  ];

  return {
    simMinute,
    rooms,
    reports: [],
    occupants: [
      { room: "7-office", count: 12, flags: [] },
      { room: "8-hall", count: 3, flags: ["mobility"] },
    ],
  };
}
