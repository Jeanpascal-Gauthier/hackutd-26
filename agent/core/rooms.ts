// Room helpers that work for any Building: the demo building (no `kind`, ids like "7-break")
// and buildings generated from an address (rooms with `kind`). Pure.
import type { Building, Room, RoomKind } from "@firewatch/shared/types";

/** "Floor 7 Stairwell A" -> "Stairwell A". */
export const shortName = (room: Room) => room.name.replace(/^Floor -?\d+\s+/i, "");

/** "7-stair-a" -> "stair-a". */
export const idSuffix = (room: Room) => room.id.replace(/^-?\d+-/, "");

/**
 * Words in the id or name -> room kind, for rooms without `kind` (the demo building).
 * Ordered: the first match wins ("dining hall" is dining, "lecture hall" a classroom, not a hallway).
 */
const KIND_WORDS: [RegExp, RoomKind][] = [
  [/\bstair/, "stair"],
  [/\belev|\blift\b/, "elevator"],
  [/\bcafeteria|\bdining|\brestaurant|\bcaf[eé]\b|\bcanteen|\bfood court/, "dining"],
  [/\bauditorium|\bassembly|\bgym|\btheat(?:er|re)|\bchapel|\bball ?room|\bevent/, "assembly"],
  [/\bclass|\blecture|\bseminar/, "classroom"],
  [/\bconf|\bmeeting|\bboard ?room/, "conference"],
  [/\bbreak|\bkitchen|\bpantry|\blunch/, "break"],
  [/\bhall|\bcorridor/, "hall"],
  [/\blobby|\breception|\bfoyer|\bentrance/, "lobby"],
  [/\bstorage|\bstore ?room|\bsupply|\bcloset|\bjanitor|\barchive/, "storage"],
  [/\bmech|\belectrical|\butility|\bboiler|\bpump/, "utility"],
  [/\blab(?:s|oratory)?\b/, "lab"],
  [/\bpatient|\bward\b|\bicu\b/, "patient"],
  [/\bguest ?room|\bhotel|\bsuite\b/, "hotel-room"],
  [/\bapartment|\bapt\b|\bunit\b|\bflat\b|\bresiden|\bdwelling|\bcondo/, "residential"],
  [/\bretail|\bshop|\bstore\b|\bboutique|\bshowroom/, "retail"],
  [/\bopen\b|\bcubicle|\bbullpen/, "open-office"],
  [/\boffice|\bdesk|\bstudy/, "office"],
];

/** The room's kind: `room.kind`, else read from its id and name; undefined if neither says. */
export function inferKind(room: Room): RoomKind | undefined {
  if (room.kind) return room.kind;
  const text = `${idSuffix(room)} ${shortName(room)}`.toLowerCase().replace(/[-_]/g, " ");
  return KIND_WORDS.find(([re]) => re.test(text))?.[1];
}

/** Halls, stairwells and elevators: ways through a floor, not places people report from. */
export const isCirculation = (room: Room) => {
  const k = inferKind(room);
  return k === "hall" || k === "stair" || k === "elevator";
};

/** Highest and lowest floor that has rooms. */
export function floorSpan(building: Building): { lowest: number; highest: number } {
  const floors = building.rooms.map((r) => r.floor);
  return floors.length ? { lowest: Math.min(...floors), highest: Math.max(...floors) } : { lowest: 1, highest: 1 };
}

/** What the prompt and the trail call the building. Demo defaults when there is no profile. */
export function describeBuilding(building: Building): {
  id: string;
  name: string;
  address?: string;
  use: string;
  floors: number;
  layoutEstimated: boolean;
} {
  const p = building.profile;
  return {
    id: p?.id ?? "demo",
    name: p?.name ?? "FireSight demo building",
    ...(p?.address ? { address: p.address } : {}),
    use: p?.use ?? "office",
    floors: p?.floors ?? floorSpan(building).highest,
    layoutEstimated: p?.layoutEstimated ?? false,
  };
}
