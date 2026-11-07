// MOCK fixture (deterministic, no I/O): "7-break" catches fire, smoke spreads to "8-hall".
// Pure functions of simMinute. Not the real spread model.
import type { IncidentState, Occupant, Recommendation, Report, RoomState } from "@firewatch/shared/types";
import building from "@firewatch/shared/building.json" with { type: "json" };

export const SCRIPT_END = 10; // minutes; the replay stops here
const BASE_TIME = Date.UTC(2026, 0, 1, 12, 0, 0); // fixed so output is reproducible
export const MOCK_ID_PREFIX = "mock-";

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function mockRooms(minute: number): RoomState[] {
  const m = minute;
  const scripted: Record<string, { fire: number; smoke: number }> = {
    "7-break": { fire: clamp((m - 1) / 4), smoke: clamp((m - 1) / 2) },
    "7-hall": { fire: 0, smoke: clamp((m - 2) / 4) },
    "8-hall": { fire: 0, smoke: clamp((m - 4) / 4) },
  };
  return building.rooms.map((r) => ({ roomId: r.id, ...(scripted[r.id] ?? { fire: 0, smoke: 0 }) }));
}

const OCCUPANTS: Occupant[] = [
  { room: "7-office", count: 12, flags: [] },
  { room: "8-hall", count: 3, flags: ["mobility"] },
];

interface TimelineReport {
  minute: number;
  caller: string;
  text: string;
  roomId: string;
  confidence: number;
}

const REPORTS: TimelineReport[] = [
  { minute: 1, caller: "Dana (7th floor)", text: "I smell smoke near the break room.", roomId: "7-break", confidence: 0.6 },
  { minute: 2, caller: "Sam (7th floor)", text: "There are flames in the break room, the hall is filling with smoke!", roomId: "7-break", confidence: 0.95 },
  { minute: 5, caller: "Lee (8th floor)", text: "Smoke is coming up in the 8th floor hallway.", roomId: "8-hall", confidence: 0.8 },
];

const RECOMMENDATIONS: { minute: number; rec: Recommendation }[] = [
  {
    minute: 3,
    rec: {
      actions: ["Evacuate floor 7 via stair-a", "Keep 7-hall fire door closed", "Hold elevators at lobby"],
      callerReply: "Leave floor 7 by the stairs now. Do not use the elevator.",
    },
  },
  {
    minute: 6,
    rec: {
      actions: ["Send assistance to 8-hall for mobility-impaired occupant", "Evacuate floor 8 via stair-a"],
      callerReply: "Stay low and move to the stairwell; help is on the way.",
    },
  },
];

export function mockReports(minute: number): Report[] {
  return REPORTS.flatMap((r, i) =>
    r.minute <= minute
      ? [{ id: `${MOCK_ID_PREFIX}${i}`, caller: r.caller, text: r.text, roomId: r.roomId, confidence: r.confidence, time: BASE_TIME + r.minute * 60_000 }]
      : [],
  );
}

/** The latest scripted recommendation at or before `minute` (index identifies it), if any. */
export function mockRecommendation(minute: number): { index: number; rec: Recommendation } | undefined {
  let found: { index: number; rec: Recommendation } | undefined;
  RECOMMENDATIONS.forEach((r, index) => {
    if (r.minute <= minute) found = { index, rec: r.rec };
  });
  return found;
}

/** Everything the fixture says about `minute`, as a full state. */
export function mockState(minute: number): IncidentState {
  return {
    simMinute: minute,
    rooms: mockRooms(minute),
    reports: mockReports(minute),
    occupants: OCCUPANTS,
    recommendation: mockRecommendation(minute)?.rec,
  };
}
