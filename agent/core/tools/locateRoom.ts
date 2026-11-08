// locate_room: the caller's floor + place (already pulled out of the message by Nemotron)
// -> a room id in the building, with a confidence, or a follow-up question to text back.
// Deterministic on purpose: the model reads the messy text, this picks a real room id.
import type OpenAI from "openai";
import type { Building, Room } from "@firewatch/shared/types";

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

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];

/** True if the text names this floor: "7", "7th", "seven", "seventh". */
export function mentionsFloor(text: string, floor: number): boolean {
  const t = text.toLowerCase();
  const words = [NUMBER_WORDS[floor - 1], ORDINAL_WORDS[floor - 1]].filter(Boolean);
  return new RegExp(`(^|\\D)${floor}(st|nd|rd|th)?(\\D|$)`).test(t) || words.some((w) => new RegExp(`\\b${w}\\b`).test(t));
}

export const locateRoomTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "locate_room",
    description:
      "Find the room in the building where the caller reports fire or smoke. Returns a room id and confidence, " +
      "or a follow-up question to ask the caller when the location is unclear.",
    parameters: {
      type: "object",
      properties: {
        floor: {
          type: "integer",
          description: "Floor number (1-12) the caller named or clearly implied. Omit if they did not say.",
        },
        place: {
          type: "string",
          description:
            "The room or area where the fire or smoke is, in the caller's words, e.g. 'break room', " +
            "'east side', 'stairwell B', 'hallway'. Omit if they gave no place.",
        },
      },
    },
  },
};

/**
 * Place words -> room kinds (a room id without its floor prefix, e.g. "7-stair-a" -> "stair-a").
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

/** "Floor 7 Stairwell A" -> "Stairwell A". */
const shortName = (room: Room) => room.name.replace(/^Floor \d+\s+/, "");

/**
 * @param heard Everything the caller actually said (plus "floor N" if their floor is known).
 *   When given, a floor or place the model passed that is not in it is dropped: a guessed
 *   location must never become a confident red room.
 */
export function locateRoom(args: LocateArgs, building: Building, heard?: string): LocateResult {
  const ignored: string[] = [];
  const floors = Math.max(...building.rooms.map((r) => r.floor));
  let floor =
    typeof args.floor === "number" && Number.isInteger(args.floor) && args.floor >= 1 && args.floor <= floors
      ? args.floor
      : undefined;
  if (floor !== undefined && heard !== undefined && !mentionsFloor(heard, floor)) {
    ignored.push(`floor ${floor}: the caller never said it`);
    floor = undefined;
  }

  const place = (args.place ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  let match = place ? PLACES.find(([re]) => re.test(place)) : undefined;
  if (match && heard !== undefined && !match[0].test(heard.toLowerCase())) {
    ignored.push(`place "${args.place}": the caller never said it`);
    match = undefined;
  }
  const kinds = match?.[1] ?? [];
  const extra = ignored.length ? { ignored } : {};

  if (floor === undefined) {
    return {
      ...extra,
      confidence: 0,
      followUp: kinds.length
        ? "Which floor are you on?"
        : "Which floor are you on, and which room or side of the building is the smoke or fire in?",
    };
  }

  const byId = new Map(building.rooms.map((r) => [r.id, r]));
  const matches = kinds.map((k) => byId.get(`${floor}-${k}`)).filter((r): r is Room => r !== undefined);
  const hall = byId.get(`${floor}-hall`);

  if (matches.length === 1) {
    const room = matches[0]!;
    return { ...extra, roomId: room.id, roomName: room.name, confidence: 0.85, floor };
  }
  if (matches.length > 1) {
    const names = matches.map(shortName);
    return {
      ...extra,
      roomId: hall?.id,
      roomName: hall?.name,
      confidence: 0.5,
      floor,
      candidates: matches.map((r) => r.id),
      followUp: `Which one on floor ${floor}: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`,
    };
  }
  return {
    ...extra,
    roomId: hall?.id,
    roomName: hall?.name,
    confidence: 0.4,
    floor,
    followUp: `Where on floor ${floor} are you, and which room is the smoke or fire in?`,
  };
}
