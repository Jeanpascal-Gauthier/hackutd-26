// locate_room: the caller's floor + place (already pulled out of the message by Nemotron)
// -> a room id in the building, with a confidence, or a follow-up question to text back.
// Deterministic on purpose: the model reads the messy text, this picks a real room id.
// Works for any building: the demo's room ids ("7-break") first, then room kinds and the words
// in room names (buildings generated from an address).
import type OpenAI from "openai";
import type { Building, Room, RoomKind } from "@firewatch/shared/types";
import { floorSpan, inferKind, isCirculation, shortName } from "../rooms.ts";
import type { AgentTool } from "./types.ts";

/** At or above this, the agent trusts the room; below it, it texts the caller a follow-up. */
export const CONFIDENT = 0.6;

export interface LocateArgs {
  floor?: number;
  place?: string;
}

export interface LocateResult {
  roomId?: string;
  roomName?: string;
  confidence: number; // 0..1, 0 when nothing could be placed
  floor?: number;
  /** Room ids the place could mean, when it is ambiguous on that floor. */
  candidates?: string[];
  /** Question to text back when the location is unclear. */
  followUp?: string;
  /** Arguments dropped because the caller never said them (the model guessed). */
  ignored?: string[];
}

const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const ORDINAL_WORDS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
];

/** Rooms listed by name in a follow-up question before it stops listing. */
const MAX_OPTIONS = 6;

/** True if the text names this floor: "7", "7th", "seven", "seventh" ("ground floor" is floor 1). */
export function mentionsFloor(text: string, floor: number): boolean {
  const t = text.toLowerCase();
  const words = [NUMBER_WORDS[floor - 1], ORDINAL_WORDS[floor - 1]].filter(Boolean);
  return (
    new RegExp(`(^|\\D)${floor}(st|nd|rd|th)?(\\D|$)`).test(t) ||
    words.some((w) => new RegExp(`\\b${w}\\b`).test(t)) ||
    (floor === 1 && /\bground\s+(floor|level)\b/.test(t))
  );
}

export const locateRoomSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "locate_room",
    description:
      "Find the room in the active building where the caller reports fire or smoke. Returns a room id and confidence, " +
      "or a follow-up question to ask the caller when the location is unclear.",
    parameters: {
      type: "object",
      properties: {
        floor: {
          type: "integer",
          description: "Floor number the caller named or clearly implied. Omit if they did not say.",
        },
        place: {
          type: "string",
          description:
            "The room or area where the fire or smoke is, in the caller's words, e.g. 'break room', " +
            "'east side', 'stairwell B', 'hallway', 'apartment 4B'. Omit if they gave no place.",
        },
      },
    },
  },
};

/**
 * Place words -> demo room ids without their floor prefix (e.g. "7-stair-a" -> "stair-a").
 * Ordered: the first match wins, so specific phrases come before plain "east" or "office",
 * and the ambiguous ones ("stairs", "office") come last.
 */
const PLACES: [RegExp, string[]][] = [
  [/\bstair\w*\s*a\b|\bwest\s+stair/, ["stair-a"]],
  [/\bstair\w*\s*b\b|\beast\s+stair/, ["stair-b"]],
  [/\belevator|\blift\b/, ["elev-1"]],
  [/\bbreak|\bkitchen|\bmicrowave|\bpantry|\blunch|\bcoffee|\bcafeteria/, ["break"]],
  [/\bconference|\bmeeting|\bboard\s*room/, ["conf"]],
  [/\bstorage|\bstore\s*room|\bsupply|\bcloset|\bjanitor/, ["storage"]],
  [/\bopen\s+(office|plan)|\bcubicle|\bdesks?\b|\bbullpen/, ["office"]],
  [/\beast\b/, ["east"]],
  [/\bwest\b/, ["west"]],
  [/\bhall|\bcorridor|\blobby/, ["hall"]],
  [/\bstair/, ["stair-a", "stair-b"]],
  [/\boffice/, ["east", "west", "office"]],
];

/** Place words -> room kinds, for buildings whose ids don't follow the demo's. First match wins. */
const PLACE_KINDS: [RegExp, RoomKind[]][] = [
  [/\bstair/, ["stair"]],
  [/\belevator|\blift\b/, ["elevator"]],
  [/\bcafeteria|\bdining|\brestaurant|\bcanteen/, ["dining", "break"]],
  [/\bbreak|\bkitchen|\bmicrowave|\bpantry|\blunch|\bcoffee/, ["break", "dining"]],
  [/\bconference|\bmeeting|\bboard\s*room/, ["conference"]],
  [/\bstorage|\bstore\s*room|\bsupply|\bcloset|\bjanitor/, ["storage"]],
  [/\bmechanical|\belectrical|\bboiler|\butility/, ["utility"]],
  [/\bclass|\blecture/, ["classroom"]],
  [/\blab\b|\blaboratory/, ["lab"]],
  [/\bpatient|\bward\b/, ["patient"]],
  [/\bguest\s*room|\bhotel\s+room|\bsuite\b/, ["hotel-room"]],
  [/\bapartment|\bapt\b|\bunit\b|\bflat\b|\bcondo/, ["residential"]],
  [/\bshop|\bstore\b|\bretail/, ["retail"]],
  [/\bgym|\bauditorium|\btheat(?:er|re)|\bchapel/, ["assembly"]],
  [/\blobby|\breception|\bentrance/, ["lobby", "hall"]],
  [/\bhall|\bcorridor/, ["hall"]],
  [/\bopen\s+(office|plan)|\bcubicle|\bdesks?\b|\bbullpen/, ["open-office"]],
  [/\boffice/, ["office", "open-office"]],
];

/** Words that never pick out a room by themselves. */
const STOP = new Set(["the", "room", "rooms", "near", "by", "in", "on", "at", "of", "floor", "area", "side", "my", "our", "from", "next", "to", "outside", "inside", "and", "or", "fire", "smoke", "there"]);

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** Telling words of the place: "the apartment 4B" -> ["apartment", "4b"]; a leading "a"/"an" is dropped. */
function placeWords(place: string): string[] {
  return words(place).filter((w, i) => !STOP.has(w) && !(i === 0 && (w === "a" || w === "an")));
}

/** Rooms on the floor whose names share the most telling words with the place (none if no word matches). */
function byName(place: string, rooms: Room[], heard?: string): Room[] {
  const said = heard === undefined ? undefined : new Set(words(heard));
  const ws = placeWords(place).filter((w) => !said || said.has(w));
  if (!ws.length) return [];
  const scored = rooms.map((r) => {
    const name = new Set(words(shortName(r)));
    return { r, n: ws.filter((w) => name.has(w)).length };
  });
  const best = Math.max(0, ...scored.map((s) => s.n));
  return best ? scored.filter((s) => s.n === best).map((s) => s.r) : [];
}

/** "A, B or C"; past MAX_OPTIONS: "for example A, B or C". */
function listNames(names: string[]): string {
  const shown = names.slice(0, MAX_OPTIONS);
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}`;
  return names.length > MAX_OPTIONS ? `for example ${list}` : list;
}

/**
 * @param heard Everything the caller actually said (plus "floor N" if their floor is known).
 *   When given, a floor or place the model passed that is not in it is dropped: a guessed
 *   location must never become a confident red room.
 */
export function locateRoom(args: LocateArgs, building: Building, heard?: string): LocateResult {
  const ignored: string[] = [];
  const { lowest, highest } = floorSpan(building);
  let floor =
    typeof args.floor === "number" && Number.isInteger(args.floor) && args.floor >= lowest && args.floor <= highest
      ? args.floor
      : undefined;
  if (floor !== undefined && heard !== undefined && !mentionsFloor(heard, floor)) {
    ignored.push(`floor ${floor}: the caller never said it`);
    floor = undefined;
  }

  const place = (args.place ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const heardLower = heard?.toLowerCase();
  const saidIt = (re: RegExp) => heardLower === undefined || re.test(heardLower);
  let match = place ? PLACES.find(([re]) => re.test(place)) : undefined;
  let kindMatch = place ? PLACE_KINDS.find(([re]) => re.test(place)) : undefined;
  let nameWords = place ? placeWords(place).filter((w) => heardLower === undefined || words(heardLower).includes(w)) : [];
  if (place && (match || kindMatch) && !saidIt((match ?? kindMatch)![0])) {
    ignored.push(`place "${args.place}": the caller never said it`);
    match = undefined;
    kindMatch = undefined;
    nameWords = [];
  }
  const extra = () => (ignored.length ? { ignored } : {});

  if (floor === undefined) {
    return {
      ...extra(),
      confidence: 0,
      followUp:
        match || kindMatch
          ? "Which floor are you on?"
          : "Which floor are you on, and which room or side of the building is the smoke or fire in?",
    };
  }

  const onFloor = building.rooms.filter((r) => r.floor === floor);
  const byId = new Map(onFloor.map((r) => [r.id, r]));
  // 1. The demo building's ids; 2. words in room names ("Apartment 4B", "North Office");
  // 3. room kinds ("apartment" -> any residential room on the floor).
  let matches = (match?.[1] ?? []).map((k) => byId.get(`${floor}-${k}`)).filter((r): r is Room => r !== undefined);
  if (!matches.length && nameWords.length) matches = byName(nameWords.join(" "), onFloor);
  if (!matches.length && kindMatch) {
    const kinds = kindMatch[1];
    matches = onFloor.filter((r) => {
      const k = inferKind(r);
      return k !== undefined && kinds.includes(k);
    });
  }
  const hall = byId.get(`${floor}-hall`) ?? onFloor.find((r) => inferKind(r) === "hall");

  if (matches.length === 1) {
    const room = matches[0]!;
    return { ...extra(), roomId: room.id, roomName: room.name, confidence: 0.85, floor };
  }
  if (matches.length > 1) {
    return {
      ...extra(),
      roomId: hall?.id,
      roomName: hall?.name,
      confidence: 0.5,
      floor,
      candidates: matches.map((r) => r.id),
      followUp: `Which one on floor ${floor}: ${listNames(matches.map(shortName))}?`,
    };
  }
  // Floor known, room not: name the rooms that floor actually has, so the caller can pick one.
  const options = onFloor.filter((r) => !isCirculation(r)).map(shortName);
  const said = place && !ignored.length ? `I couldn't find "${place.slice(0, 40)}" on floor ${floor}. ` : "";
  return {
    ...extra(),
    roomId: hall?.id,
    roomName: hall?.name,
    confidence: 0.4,
    floor,
    followUp: options.length
      ? `${said}Which room on floor ${floor} is the smoke or fire in: ${listNames(options)}?`
      : `Where on floor ${floor} are you, and which room is the smoke or fire in?`,
  };
}

/** The locate_room tool: records where this report is, for merge_reports and the server. */
export const locateRoomTool: AgentTool = {
  schema: locateRoomSchema,
  run(args, { ctx, heard, run }) {
    const result = locateRoom(
      { floor: args.floor as number | undefined, place: typeof args.place === "string" ? args.place : undefined },
      ctx.building,
      heard,
    );
    run.located = result;
    run.report.roomId = result.roomId;
    run.report.confidence = result.confidence;
    return result;
  },
};
