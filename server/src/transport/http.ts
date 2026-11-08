// HTTP API (see server/API.md):
//   POST /ingest      report in (optionally with the agent's own result) -> shared ingest path
//   GET  /state       current IncidentState
//   GET  /building    building + occupants + sprinklers + doors + inspections
//   GET  /inspections inspection records, filtered by ?floor= &system= &status=
//   POST /forecast    what-if forecast from an origin (or several), state unchanged (agent tools)
//   POST /voice/report phone-call webhook (ElevenLabs tool), token-protected; replies in speakable text
//   POST /voice/address phone-call webhook: the caller's address starts a building lookup
//   POST /voice/incident phone-call webhook: any emergency, placed on the map (incidents/service.ts)
//   POST /map-incidents  the same report from a screen or script, without the voice token
//   POST /incident/address, /incident/building, /incident/building/demo  building lookup (live/lookup.ts)
//   GET  /health      POST /live/reset      POST /mock/reset, /mock/replay (mock mode)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Building, IncidentState, LanesBlocked, Occupant, Recommendation, TrailStep } from "@firewatch/shared/types";
import type { Forecast } from "../live/forecast.ts";
import type { DoorRating, InspectionRecord } from "../live/buildingData.ts";
import type { IngestInput, ProcessResult } from "../state/processor.ts";
import type { Ingest } from "../state/ingest.ts";
import { hasVoiceToken, speakable, VOICE_ADDRESS_PROMPT, VOICE_ADDRESS_REPLY, VOICE_INCIDENT_FALLBACK, VOICE_INCIDENT_WHAT } from "./voice.ts";
import type { MapIncidents, MapIncidentInput } from "../incidents/service.ts";
import type { LookupResult } from "../live/lookup.ts";
import { createBuildingRoutes } from "../buildings/routes.ts";
import type { BuildingService } from "../buildings/service.ts";

const MAX_BODY = 256 * 1024; // room for an agent trail
const MAX_TRAIL = 50;
const MAX_ACTIONS = 5;
const MAX_TEXT = 2000;
const MAX_CALLER = 100;

export interface HttpDeps {
  ingest: Ingest;
  getState(): IncidentState;
  /** GET /building: the active building (with `profile`) and its records. Read on every request. */
  getBuildingInfo(): BuildingInfo;
  /** Runs a forecast (one or more fires) without touching incident state. Throws on an unknown origin. */
  forecast(origin: string | string[], minutes: number): Forecast;
  /** POST /live/reset: clear the incident (no fire, no reports). Also stops a running demo. */
  resetLive(): void;
  /** Present only in mock mode: POST /mock/reset and /mock/replay drive the scripted demo. */
  mock?: { reset(): void; replay(): void };
  /** Shared secret for POST /voice/report (env VOICE_TOKEN). Unset: the endpoint answers 503. */
  voiceToken?: string;
  /** Public building lookups (GET /buildings/...), separate from the active incident. */
  buildings?: BuildingService;
  /** Address -> confirmed building -> active incident building (POST /incident/..., /voice/address). */
  lookups?: {
    lookupAddress(address: unknown, caller?: string): LookupResult;
    confirmBuilding(buildingId: unknown): LookupResult;
    useDemoBuilding(): LookupResult;
  };
  /** Emergencies on the map (POST /voice/incident, /map-incidents). */
  mapIncidents?: Pick<MapIncidents, "report">;
}

export interface BuildingInfo {
  building: Building;
  occupants: Occupant[];
  sprinklers: Record<string, string>;
  doors: DoorRating[];
  inspections: InspectionRecord[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number) => typeof v === "string" && v.trim() !== "" && v.length <= max;

/**
 * Optional fields an agent sends when it already did the work: roomId, confidence,
 * recommendation, trail, reply. Returns undefined when none are present.
 */
function validateAgentResult(b: Record<string, unknown>, roomIds: ReadonlySet<string>, errors: string[]): ProcessResult | undefined {
  const keys = ["roomId", "confidence", "recommendation", "trail", "reply"] as const;
  if (!keys.some((k) => b[k] !== undefined)) return undefined;
  const out: ProcessResult = {};

  if (b.roomId !== undefined) {
    if (typeof b.roomId === "string" && roomIds.has(b.roomId)) out.roomId = b.roomId;
    else errors.push("`roomId` must be a room id from GET /building");
  }
  if (b.confidence !== undefined) {
    if (typeof b.confidence === "number" && b.confidence >= 0 && b.confidence <= 1) out.confidence = b.confidence;
    else errors.push("`confidence` must be a number from 0 to 1");
  }
  if (out.roomId && out.confidence === undefined) errors.push("`confidence` is required with `roomId`");
  if (b.recommendation !== undefined) {
    const r = b.recommendation;
    if (isObj(r) && Array.isArray(r.actions) && r.actions.length >= 1 && r.actions.length <= MAX_ACTIONS && r.actions.every((a) => isStr(a, 300)) && (r.callerReply === undefined || isStr(r.callerReply, MAX_TEXT)))
      out.recommendation = { actions: r.actions as string[], ...(r.callerReply !== undefined && { callerReply: r.callerReply as string }) } satisfies Recommendation;
    else errors.push(`\`recommendation\` must be { actions: 1-${MAX_ACTIONS} strings, callerReply?: string }`);
  }
  if (b.trail !== undefined) {
    const t = b.trail;
    if (Array.isArray(t) && t.length <= MAX_TRAIL && t.every((s) => isObj(s) && isStr(s.tool, 100) && typeof s.ms === "number"))
      out.trail = t.map((s) => ({ tool: s.tool, input: s.input ?? null, output: s.output ?? null, ms: s.ms }) as TrailStep);
    else errors.push(`\`trail\` must be at most ${MAX_TRAIL} steps of { tool: string, input, output, ms: number }`);
  }
  if (b.reply !== undefined) {
    if (isStr(b.reply, MAX_TEXT)) out.reply = b.reply as string;
    else errors.push(`\`reply\` must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  return out;
}

/** Returns validated input or a list of problems. */
export function validateIngest(body: unknown, roomIds: ReadonlySet<string> = new Set()): IngestInput | string[] {
  if (!isObj(body)) return ["body must be a JSON object"];
  const { text, caller } = body;
  const errors: string[] = [];
  if (typeof text !== "string" || text.trim() === "") errors.push("`text` must be a non-empty string");
  else if (text.length > MAX_TEXT) errors.push(`\`text\` must be at most ${MAX_TEXT} characters`);
  if (typeof caller !== "string" || caller.trim() === "") errors.push("`caller` must be a non-empty string");
  else if (caller.length > MAX_CALLER) errors.push(`\`caller\` must be at most ${MAX_CALLER} characters`);
  const preprocessed = validateAgentResult(body, roomIds, errors);
  if (errors.length) return errors;
  return { text: (text as string).trim(), caller: (caller as string).trim(), ...(preprocessed && { preprocessed }) };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.find((item) => item === text) ?? fallback;
};
const optionalText = (value: unknown, max: number): string | undefined => {
  const text = typeof value === "string" ? value.trim().slice(0, max) : "";
  return text || undefined;
};

/** A voice agent often leaves `lanes_blocked` out even when the caller said it, so their words count too. */
function lanesFrom(value: unknown, description: string): LanesBlocked {
  const stated = oneOf(value, ["all", "some", "unknown"], "unknown");
  if (stated !== "unknown") return stated;
  const words = `${typeof value === "string" ? value : ""} ${description}`;
  const everyLane = /\b(all|both|every)\b.{0,12}\blanes?\b|\b(completely|fully|totally)\s+(blocked|closed)\b/i;
  return everyLane.test(words) && !/\bnot\s+(all|both|every|completely|fully|totally)\b/i.test(words) ? "all" : "unknown";
}

/** Reads a report of any emergency. A voice agent's tool values are loose, so unknown enums fall back. */
export function parseMapIncident(body: unknown, channel: MapIncidentInput["channel"]): MapIncidentInput | string[] {
  const b = isObj(body) ? body : {};
  const description = optionalText(b.description, MAX_TEXT);
  if (!description) return ["`description` must be a non-empty string"];
  const inBuilding = b.in_building === true || (typeof b.in_building === "string" && /^(true|yes)$/i.test(b.in_building.trim()));
  return {
    kind: oneOf(b.type, ["fire", "crash", "other"], "other"),
    what: optionalText(b.what, 60),
    address: optionalText(b.address, 500),
    description,
    severity: oneOf(b.severity, ["minor", "serious", "critical", "unknown"], "unknown"),
    lanesBlocked: lanesFrom(b.lanes_blocked, description),
    inBuilding,
    caller: optionalText(b.caller, MAX_CALLER),
    channel,
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*", // dev: console/headset run on other ports
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** GET /inspections query: optional floor, system, status (exact match). Returns errors as string[]. */
export function filterInspections(
  records: InspectionRecord[],
  query: URLSearchParams,
): { ok: true; inspections: InspectionRecord[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const floorQ = query.get("floor");
  const floor = floorQ === null ? undefined : Number(floorQ);
  if (floor !== undefined && !(Number.isInteger(floor) && records.some((r) => r.floor === floor)))
    errors.push("`floor` must be a floor number that has inspection records");
  const system = query.get("system");
  if (system !== null && !records.some((r) => r.system === system)) errors.push("`system` must be sprinkler, fire-door, fire-alarm or standpipe");
  const status = query.get("status");
  if (status !== null && !["pass", "overdue", "deficient"].includes(status)) errors.push("`status` must be pass, overdue or deficient");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    inspections: records.filter(
      (r) => (floor === undefined || r.floor === floor) && (system === null || r.system === system) && (status === null || r.status === status),
    ),
  };
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { ok: false, error: "body too large" });
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    json(res, 400, { ok: false, error: "invalid JSON" });
    return { ok: false };
  }
}

export function createHttpServer({ ingest, getState, getBuildingInfo, forecast, resetLive, mock, voiceToken, buildings, lookups, mapIncidents }: HttpDeps) {
  // The active building can change (address lookup), so room ids are read per request.
  const activeRoomIds = () => new Set(getBuildingInfo().building.rooms.map((r) => r.id));
  const lookupReply = (res: ServerResponse, r: LookupResult | undefined) =>
    !r ? json(res, 404, { ok: false, error: "building lookup is not available" })
      : r.ok ? json(res, 200, { ok: true, lookup: r.lookup ?? null, ...(r.unchanged && { unchanged: true }) })
      : json(res, r.status, { ok: false, error: r.error });
  const handleBuildingRequest = buildings && createBuildingRoutes(buildings);
  return createServer(async (req, res) => {
    const method = req.method;
    const url = (req.url ?? "").split("?")[0];
    if (method === "OPTIONS") return json(res, 204, null);
    if (handleBuildingRequest && await handleBuildingRequest(req, res)) return;
    if (method === "GET" && url === "/health") return json(res, 200, { ok: true, mock: !!mock });
    if (method === "GET" && url === "/state") return json(res, 200, getState());
    if (method === "GET" && url === "/building") return json(res, 200, getBuildingInfo());
    if (method === "GET" && url === "/inspections") {
      const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const r = filterInspections(getBuildingInfo().inspections, query);
      return json(res, r.ok ? 200 : 400, r);
    }

    if (method === "POST" && url === "/forecast") {
      const r = await readJson(req, res);
      if (!r.ok) return;
      const b = isObj(r.body) ? r.body : {};
      const minutes = b.minutes ?? 30;
      // `origin`: one room id; or `origins`: several room ids (separate fires, all burning at minute 0).
      const origins = Array.isArray(b.origins) ? b.origins : [b.origin];
      const roomIds = activeRoomIds();
      if (!origins.length || origins.length > 20 || !origins.every((o) => typeof o === "string" && roomIds.has(o)))
        return json(res, 400, { ok: false, errors: ["`origin` (or every entry of `origins`) must be a room id from GET /building"] });
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 60)
        return json(res, 400, { ok: false, errors: ["`minutes` must be an integer from 1 to 60"] });
      const f = forecast(origins as string[], minutes);
      // Snapshots are left out (108 rooms x 31 minutes); the summary and exits are what tools need.
      return json(res, 200, { ok: true, origin: f.origin, origins: f.origins, minutes: f.minutes, summary: f.summary, exits: f.exits, recommendation: f.recommendation });
    }

    if (method === "POST" && url === "/live/reset") {
      resetLive();
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && (url === "/mock/reset" || url === "/mock/replay")) {
      if (!mock) return json(res, 404, { ok: false, error: "mock mode is off" });
      url === "/mock/reset" ? mock.reset() : mock.replay();
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/voice/report") {
      if (!voiceToken) return json(res, 503, { ok: false, error: "voice is off: start the server with VOICE_TOKEN set" });
      if (!hasVoiceToken(req, voiceToken)) return json(res, 401, { ok: false, error: "missing or wrong x-firesight-token" });
      const r = await readJson(req, res);
      if (!r.ok) return;
      // Only the caller's words and number are taken from a call; never agent-result fields.
      const b = isObj(r.body) ? r.body : {};
      const caller = typeof b.caller === "string" && b.caller.trim() ? b.caller : "voice caller";
      const input = validateIngest({ text: b.text, caller }, activeRoomIds());
      if (Array.isArray(input)) return json(res, 400, { ok: false, errors: input, reply: speakable(undefined) });
      try {
        const { report, reply } = await ingest({ ...input, channel: "voice" });
        return json(res, 200, { ok: true, reply: speakable(reply), roomId: report.roomId ?? null });
      } catch (err) {
        console.error("[voice] processing failed", err);
        // Still give the voice agent something safe to say.
        return json(res, 200, { ok: false, reply: speakable(undefined), roomId: null });
      }
    }

    if (method === "POST" && url === "/voice/address") {
      if (!voiceToken) return json(res, 503, { ok: false, error: "voice is off: start the server with VOICE_TOKEN set" });
      if (!hasVoiceToken(req, voiceToken)) return json(res, 401, { ok: false, error: "missing or wrong x-firesight-token" });
      const r = await readJson(req, res);
      if (!r.ok) return;
      const b = isObj(r.body) ? r.body : {};
      const caller = typeof b.caller === "string" && b.caller.trim() ? b.caller.trim().slice(0, MAX_CALLER) : "voice caller";
      const address = typeof b.address === "string" ? b.address.trim() : "";
      if (address.length < 3) return json(res, 200, { ok: false, reply: VOICE_ADDRESS_PROMPT });
      // Starts the lookup and answers at once: the voice agent must not wait on Overpass.
      const started = lookups?.lookupAddress(address, caller);
      if (started && !started.ok && started.status === 400) return json(res, 200, { ok: false, reply: VOICE_ADDRESS_PROMPT });
      return json(res, 200, { ok: !!started?.ok, reply: VOICE_ADDRESS_REPLY });
    }

    if (method === "POST" && url === "/voice/incident") {
      if (!voiceToken) return json(res, 503, { ok: false, error: "voice is off: start the server with VOICE_TOKEN set" });
      if (!hasVoiceToken(req, voiceToken)) return json(res, 401, { ok: false, error: "missing or wrong x-firesight-token" });
      const r = await readJson(req, res);
      if (!r.ok) return;
      const input = parseMapIncident(r.body, "voice");
      if (Array.isArray(input)) return json(res, 200, { ok: false, reply: VOICE_INCIDENT_WHAT });
      try {
        const out = await mapIncidents!.report(input);
        return json(res, 200, { ok: true, reply: out.reply, incidentId: out.incident.id, status: out.incident.status });
      } catch (err) {
        console.error("[voice] incident failed", err);
        return json(res, 200, { ok: false, reply: VOICE_INCIDENT_FALLBACK });
      }
    }

    if (method === "POST" && url === "/map-incidents") {
      const r = await readJson(req, res);
      if (!r.ok) return;
      const input = parseMapIncident(r.body, "console");
      if (Array.isArray(input)) return json(res, 400, { ok: false, errors: input });
      try {
        const out = await mapIncidents!.report(input);
        return json(res, 200, { ok: true, incident: out.incident, reply: out.reply });
      } catch (err) {
        console.error("[map-incidents] failed", err);
        return json(res, 502, { ok: false, error: "could not record the incident" });
      }
    }

    if (method === "POST" && url === "/incident/address") {
      const r = await readJson(req, res);
      if (!r.ok) return;
      const b = isObj(r.body) ? r.body : {};
      if (b.caller !== undefined && !isStr(b.caller, MAX_CALLER)) return json(res, 400, { ok: false, error: "caller must be a non-empty string of at most 100 characters" });
      return lookupReply(res, lookups?.lookupAddress(b.address, b.caller as string | undefined));
    }

    if (method === "POST" && url === "/incident/building/demo") return lookupReply(res, lookups?.useDemoBuilding());

    if (method === "POST" && url === "/incident/building") {
      const r = await readJson(req, res);
      if (!r.ok) return;
      return lookupReply(res, lookups?.confirmBuilding(isObj(r.body) ? r.body.buildingId : undefined));
    }

    if (method === "POST" && url === "/ingest") {
      const r = await readJson(req, res);
      if (!r.ok) return;
      const input = validateIngest(r.body, activeRoomIds());
      if (Array.isArray(input)) return json(res, 400, { ok: false, errors: input });

      try {
        const { report, reply } = await ingest(input);
        return json(res, 200, { ok: true, report, reply });
      } catch (err) {
        console.error("[ingest] processor failed", err);
        return json(res, 502, { ok: false, error: "processing failed" });
      }
    }

    json(res, 404, { ok: false, error: "not found" });
  });
}
