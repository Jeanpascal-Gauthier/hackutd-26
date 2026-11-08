// find_building: the caller named a street address or a building -> ask the server to look it up
// (POST /incident/address). The operator confirms the outline on the console; until then this
// report waits, and the server re-processes it on the confirmed building. So once a lookup
// starts, the agent stops and the caller gets FIND_BUILDING_REPLY (fixed wording).
import type OpenAI from "openai";
import type { Building, BuildingLookup } from "@firewatch/shared/types";
import { describeBuilding } from "../rooms.ts";
import type { AgentTool } from "./types.ts";

/** What a caller is told while the operator confirms the building. */
export const FIND_BUILDING_REPLY = "Help is on the way. We are confirming the building now. Do not use the elevator.";

const MIN_CHARS = 3;
const MAX_CHARS = 200;

/** Lookups still running: a repeat of the same query is not started again. */
const IN_PROGRESS: BuildingLookup["status"][] = ["searching", "needs_confirmation", "loading"];

/** Words that are spelled many ways in addresses -> one spelling. */
const ABBREV: Record<string, string> = {
  street: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  parkway: "pkwy",
  highway: "hwy",
  suite: "ste",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};
const FILLER = new Set(["the", "a", "an", "at", "in", "on", "of", "building", "bldg", "usa", "us", "united", "states"]);

/** "1313 Broadway Street, Tacoma, WA" -> ["1313", "broadway", "st", "tacoma", "wa"]. */
export function addressTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !FILLER.has(t))
    .map((t) => ABBREV[t] ?? t);
}

/**
 * True when two addresses or names are the same place as far as text can tell: equal after
 * normalising, or one is the start of the other ("1313 Broadway" vs "1313 Broadway, Tacoma, WA").
 */
export function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const x = addressTokens(a).join(" ");
  const y = addressTokens(b).join(" ");
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

/** Why no new lookup is needed for `address`, or undefined when one is. */
export function alreadyKnown(address: string, building: Building, lookup?: BuildingLookup): string | undefined {
  const b = describeBuilding(building);
  if (building.profile && building.profile.source !== "demo") {
    const confirmed = lookup?.status === "active" && (sameAddress(address, lookup.query) || sameAddress(address, lookup.match?.formatted));
    if (confirmed || sameAddress(address, b.address) || sameAddress(address, b.name)) return `it is the active building (${b.name})`;
  }
  if (lookup && IN_PROGRESS.includes(lookup.status) && (sameAddress(address, lookup.query) || sameAddress(address, lookup.match?.formatted))) {
    return `a lookup for "${lookup.query}" is already ${lookup.status.replace("_", " ")}`;
  }
  return undefined;
}

/** True if the caller said at least one telling word of the address (a number, or a word of 3+ letters). */
export function heardAddress(address: string, heard: string): boolean {
  const said = new Set(addressTokens(heard));
  return addressTokens(address).some((t) => (/\d/.test(t) || t.length >= 3) && said.has(t));
}

export const findBuildingSchema: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "find_building",
    description:
      "Start looking up the building at a street address or building name the caller gave, so the operator can " +
      "confirm it on the map. Only when it is not the active building or the lookup already in progress. " +
      "After it starts a lookup, stop: call no other tools. The report is processed again once the building is confirmed.",
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "The street address, building name or landmark exactly as the caller gave it, with the city if they said one, " +
            "e.g. '800 W Campbell Rd, Richardson' or 'Tacoma Municipal Building'.",
        },
      },
      required: ["address"],
    },
  },
};

/** The find_building tool: sets run.lookup when a lookup starts (the agent then stops). */
export const findBuildingTool: AgentTool = {
  schema: findBuildingSchema,
  async run(args, { ctx, heard, run }) {
    const address = typeof args.address === "string" ? args.address.replace(/\s+/g, " ").trim() : "";
    if (address.length < MIN_CHARS || address.length > MAX_CHARS) {
      return { error: `address must be ${MIN_CHARS}-${MAX_CHARS} characters, as the caller said it` };
    }
    if (!heardAddress(address, heard)) {
      return { error: `the caller never said "${address.slice(0, 60)}": only look up an address they gave` };
    }
    const known = alreadyKnown(address, ctx.building, run.currentLookup);
    if (known) return { started: false, reason: `no new lookup: ${known}. Continue with locate_room.` };

    let lookup: BuildingLookup;
    try {
      lookup = await ctx.server.lookupAddress(address, run.report.caller);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { error: `lookup failed (${why.slice(0, 120)}): continue with locate_room on the active building` };
    }
    run.lookup = lookup;
    return {
      started: true,
      query: lookup.query,
      status: lookup.status,
      ...(lookup.match ? { match: lookup.match.formatted } : {}),
      candidates: lookup.candidates?.length ?? 0,
      next: "Stop now. The operator confirms the building, then this report is processed again.",
    };
  },
};
