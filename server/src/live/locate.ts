// Rule-based room locator: caller's words -> room id + confidence, or a follow-up question.
// The fallback when the Nemotron agent isn't plugged in; same job as its locate_room tool.
import type { Building } from "@firewatch/shared/types";

export interface Located {
  roomId?: string;
  confidence: number; // 0 when nothing was found
  floor?: number;
  /** Question to text back when the location is unclear. */
  followUp?: string;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];
const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const WORD = `(\\d{1,2}|${NUMBERS.join("|")})`;

/** Ordered: the first match wins, so specific places come before plain "east"/"west". */
const PLACES: [RegExp, string][] = [
  [/\b(stair(well|way|s)?\s*b|east\s+stair(well|way|s)?)\b/, "stair-b"],
  [/\b(stair(well|way|s)?\s*a|west\s+stair(well|way|s)?)\b/, "stair-a"],
  [/\b(elevators?|lifts?)\b/, "elev-1"],
  [/\b(break\s*room|kitchen|kitchenette|microwaves?|pantry|lunch\s*room|coffee)\b/, "break"],
  [/\b(conference|meeting|board\s*room)\b/, "conf"],
  [/\b(storage|supply|closet|store\s*room)\b/, "storage"],
  [/\b(open\s+(office|plan)|cubicles?|desks?)\b/, "office"],
  [/\beast\b/, "east"],
  [/\bwest\b/, "west"],
  [/\b(hall(way)?|corridor|lobby)\b/, "hall"],
];

/** "7", "seven" or "seventh" -> 7; anything else -> undefined. */
function toNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const i = Math.max(NUMBERS.indexOf(s), ORDINALS.indexOf(s));
  return i >= 0 ? i + 1 : undefined;
}

/** Floor the caller mentions, in order of how explicit the phrasing is. */
export function parseFloor(text: string, floors: number): number | undefined {
  const t = text.toLowerCase();
  const ordinal = `(\\d{1,2}(?:st|nd|rd|th)?|${ORDINALS.join("|")})`;
  const candidates = [
    t.match(new RegExp(`\\b(?:floor|fl\\.?|level)\\s*(?:number\\s*)?${WORD}\\b`))?.[1], // "floor 7"
    t.match(new RegExp(`\\b${ordinal}\\s+(?:floor|fl|level)\\b`))?.[1]?.replace(/^(\d+)(st|nd|rd|th)$/, "$1"), // "7th floor"
    t.match(new RegExp(`\\b(?:on|from)\\s+(?:the\\s+)?${ordinal}\\b`))?.[1]?.replace(/^(\d+)(st|nd|rd|th)$/, "$1"), // "on 7", "on the seventh"
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/)?.[1], // any "7th"
    ORDINALS.find((o) => new RegExp(`\\b${o}\\b`).test(t)), // any "seventh"
  ];
  for (const c of candidates) {
    const f = toNumber(c);
    if (f !== undefined && f >= 1 && f <= floors) return f;
  }
  return undefined;
}

export function locate(text: string, building: Building): Located {
  const floors = Math.max(...building.rooms.map((r) => r.floor));
  const ids = new Set(building.rooms.map((r) => r.id));
  const t = text.toLowerCase();
  const floor = parseFloor(t, floors);
  const place = PLACES.find(([re]) => re.test(t))?.[1];

  if (floor !== undefined && place && ids.has(`${floor}-${place}`)) {
    return { roomId: `${floor}-${place}`, confidence: 0.8, floor };
  }
  if (floor !== undefined) {
    return {
      roomId: `${floor}-hall`,
      confidence: 0.4,
      floor,
      followUp: `Where on floor ${floor} are you, and which room is the smoke or fire in?`,
    };
  }
  return {
    confidence: 0,
    followUp: place ? "Which floor are you on?" : "Which floor are you on, and which room or side of the building?",
  };
}
