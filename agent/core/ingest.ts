// The one way a caller's message enters FireSight from outside the server process: the Photon
// adapter and the QR form both call ingest(), which reports it as an incident on the map via the
// server's POST /map-incidents (server/API.md). The console shows state.mapIncidents.
//
// A text is free-form, so this reads what it can from the words: the kind of emergency and an
// address. The server asks for a location when there is none ("Where is it?"); the caller's next
// text then goes in as the address, with the same kind, so it joins (and places) that incident.
import { serverUrl } from "./server.ts";

export interface IngestInput {
  text: string;
  /** Stable id for the person: phone number or iMessage handle, or a per-browser id from the form. */
  caller: string;
  /** Where the report came from. Default "sms" (the Photon line). */
  channel?: "sms" | "form";
  /** An address the reporter gave separately (the form's address field). */
  address?: string;
}

export interface IngestResult {
  ok: boolean;
  /** Text to send back: a follow-up question, or what to do. */
  reply?: string;
  incidentId?: string;
  /** The incident's location status: "locating", "located", "needs_location" or "failed". */
  status?: string;
  error?: string;
}

export type IncidentKind = "fire" | "crash" | "other";

/** The parts of a report this module reads from a caller's words. */
export interface ReadReport {
  kind: IncidentKind;
  what?: string;
  address?: string;
  inBuilding: boolean;
}

/** Geocoding plus the server's forecast can take a while; the server answers without waiting on a slow geocoder. */
const TIMEOUT_MS = 30_000;
/** Same window the server uses to tie a caller's follow-up to their incident. */
const FOLLOW_UP_MS = 30 * 60 * 1000;
const MAX_CALLERS = 1000;

const CRASH_WORDS = /\b(crash(ed|es)?|collision|collided|wreck(ed)?|car accident|accident|pile-?up|rear[- ]ended|hit and run|overturned|flipped|t-?boned|ran off the road)\b/i;
const FIRE_WORDS = /\b(fire|smoke|smoky|flames?|burning|on fire|blaze)\b/i;
const FLOOD_WORDS = /\b(flood(s|ed|ing)?|water ?mains?|burst (water )?(pipe|main)s?|pipe burst|broken (water )?(pipe|main)|high water)\b/i;
const BUILDING_WORDS = /\b(floor|apartment|apt|building|office|house|home|room|suite|kitchen|garage|basement|hallway|stairwell|unit)\b/i;

const SUFFIX = "st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|ct|court|pl|place|cir|circle|trl|trail|fwy|freeway|expy|expressway|pike|tpke|loop|sq|square|ter|terrace";
/** "800 W Campbell Rd": a number, one to three name words, a street suffix. */
const STREET_ADDRESS = new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9.']+\\s+){1,3}?(?:${SUFFIX})\\b\\.?`, "i");
/** ", Richardson" right after a street address (capitalized: a city name, not more of the sentence). */
const CITY = /^,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/;
/** "at Coit and Campbell", "near Main St & 5th Ave": each street starts with a capital or a number. */
const CROSS_STREETS = /\b(?:at|on|near|by)\s+(?:the\s+)?(?:corner of\s+)?([A-Z0-9][\w.']*(?:\s+[A-Z0-9][\w.']*){0,3})\s+(?:and|&|@)\s+([A-Z0-9][\w.']*(?:\s+[A-Z0-9][\w.']*){0,3})/;

/** The kind of emergency, an address if the words hold one, and whether a fire is inside a building. */
export function readReport(text: string): ReadReport {
  const kind: IncidentKind = CRASH_WORDS.test(text) ? "crash" : FIRE_WORDS.test(text) ? "fire" : "other";
  const what = kind === "other" && FLOOD_WORDS.test(text) ? "flood" : undefined;
  return { kind, ...(what && { what }), ...optional("address", findAddress(text)), inBuilding: kind === "fire" && BUILDING_WORDS.test(text) };
}

export function findAddress(text: string): string | undefined {
  const street = STREET_ADDRESS.exec(text);
  if (street) {
    const city = CITY.exec(text.slice(street.index + street[0].length))?.[1];
    return `${street[0].replace(/[.\s]+$/, "")}${city ? `, ${city}` : ""}`;
  }
  const cross = CROSS_STREETS.exec(text);
  return cross ? `${cross[1]} & ${cross[2]}` : undefined;
}

const optional = <K extends string>(key: K, value: string | undefined) => (value ? ({ [key]: value } as Record<K, string>) : {});

/** Each caller's latest incident: a follow-up text keeps its kind and, when asked, gives its location. */
interface Open { kind: IncidentKind; what?: string; needsLocation: boolean; at: number }
const open = new Map<string, Open>();

/** Forgets every caller's open incident (tests; a demo reset). */
export function resetIngest(): void {
  open.clear();
}

export async function ingest({ text, caller, channel = "sms", address }: IngestInput, now: () => number = Date.now): Promise<IngestResult> {
  const read = readReport(text);
  const before = open.get(caller);
  const prior = before && now() - before.at < FOLLOW_UP_MS ? before : undefined;
  // Asked "where is it?", the whole answer is the place unless an address can be picked out of it.
  const where = address?.trim() || read.address || (prior?.needsLocation ? text.trim() : undefined);
  const kind = prior?.kind ?? read.kind;
  const what = prior ? prior.what : read.what;
  try {
    const res = await fetch(`${serverUrl()}/map-incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: kind,
        ...(what && { what }),
        ...(where && { address: where }),
        description: text,
        ...(kind === "fire" && { in_building: read.inBuilding }),
        caller,
        channel,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; reply?: string; incident?: { id?: string; status?: string }; errors?: string[]; error?: string }
      | undefined;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.errors?.join("; ") ?? body?.error ?? `HTTP ${res.status}` };
    }
    const status = body.incident?.status;
    remember(caller, { kind, ...(what && { what }), needsLocation: status === "needs_location" || status === "failed", at: now() });
    return { ok: true, reply: body.reply, incidentId: body.incident?.id, status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function remember(caller: string, entry: Open): void {
  open.delete(caller);
  open.set(caller, entry);
  if (open.size > MAX_CALLERS) open.delete(open.keys().next().value!);
}

/** Sent when the server can't be reached: never leave a caller with no answer. */
export const FALLBACK_REPLY =
  "We received your report. Move somewhere safe if you can; if there is smoke or fire, leave by a clear stairwell. Do not use the elevator. Call 911 if you are in danger.";
