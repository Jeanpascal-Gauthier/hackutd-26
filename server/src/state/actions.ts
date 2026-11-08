// Applies validated client actions (shared/events.ts ClientEvent) to the incident.
import type { ClientEvent } from "@firewatch/shared/events";
import type { IncidentPhase } from "@firewatch/shared/types";
import { DEMO } from "../live/buildingData.ts";
import type { IncidentStore } from "./store.ts";

const demoRoomIds = new Set(DEMO.building.rooms.map((r) => r.id));
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const MAX_INCIDENT_ID = 100;
const MAX_UNIT = 100;
const MAX_NOTE = 500;
const PHASES: readonly IncidentPhase[] = ["open", "dispatched", "on_scene", "resolved"];

/**
 * Narrow untrusted JSON to a ClientEvent, or return an error string. `roomIds` are the active
 * building's rooms (default: the demo building's).
 */
export function parseClientEvent(raw: unknown, roomIds: ReadonlySet<string> = demoRoomIds): ClientEvent | string {
  if (typeof raw !== "object" || raw === null) return "message must be an object";
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case "setSimMinute":
      return typeof e.minute === "number" && Number.isFinite(e.minute)
        ? { type: "setSimMinute", minute: e.minute }
        : "setSimMinute needs a finite number `minute`";
    case "acceptRecommendation":
      if (e.incidentId === undefined) return { type: "acceptRecommendation" };
      return isText(e.incidentId, MAX_INCIDENT_ID)
        ? { type: "acceptRecommendation", incidentId: e.incidentId }
        : "acceptRecommendation: `incidentId` must be a non-empty string";
    case "dispatch":
      return typeof e.roomId === "string" && roomIds.has(e.roomId)
        ? { type: "dispatch", roomId: e.roomId }
        : "dispatch needs a known `roomId`";
    case "dispatchIncident": {
      if (!isText(e.incidentId, MAX_INCIDENT_ID)) return "dispatchIncident needs an `incidentId`";
      if (e.unit !== undefined && typeof e.unit !== "string") return "dispatchIncident: `unit` must be a string";
      const unit = e.unit?.trim(); // a blank unit field from a form means no unit named
      if (unit && unit.length > MAX_UNIT) return `dispatchIncident: \`unit\` must be at most ${MAX_UNIT} characters`;
      return { type: "dispatchIncident", incidentId: e.incidentId, ...(unit && { unit }) };
    }
    case "setIncidentPhase":
      return isText(e.incidentId, MAX_INCIDENT_ID) && PHASES.includes(e.phase as IncidentPhase)
        ? { type: "setIncidentPhase", incidentId: e.incidentId, phase: e.phase as IncidentPhase }
        : `setIncidentPhase needs an \`incidentId\` and a \`phase\` of ${PHASES.join(", ")}`;
    case "addIncidentNote": {
      const text = typeof e.text === "string" ? e.text.trim() : "";
      return isText(e.incidentId, MAX_INCIDENT_ID) && isText(text, MAX_NOTE)
        ? { type: "addIncidentNote", incidentId: e.incidentId, text }
        : `addIncidentNote needs an \`incidentId\` and non-empty \`text\` of at most ${MAX_NOTE} characters`;
    }
    case "executeAction":
      return isText(e.propertyId, MAX_INCIDENT_ID) && isText(e.actionId, MAX_INCIDENT_ID)
        ? { type: "executeAction", propertyId: e.propertyId, actionId: e.actionId }
        : "executeAction needs a `propertyId` and an `actionId`";
    case "lookupAddress":
      return isText(e.address, 500) ? { type: "lookupAddress", address: e.address } : "lookupAddress needs a non-empty `address`";
    case "confirmBuilding":
      return isText(e.buildingId, 100) ? { type: "confirmBuilding", buildingId: e.buildingId } : "confirmBuilding needs a `buildingId`";
    case "useDemoBuilding":
      return { type: "useDemoBuilding" };
    default:
      return `unknown event type: ${String(e.type)}`;
  }
}

export interface ActionHooks {
  /** Called for setSimMinute. Mock mode: replays the fixture. Real mode: the simulation. */
  setSimMinute(minute: number): void;
  /** Room ids of the active building, for validating `dispatch`. Default: the demo building's. */
  roomIds?(): ReadonlySet<string>;
  /** Building lookup (live/lookup.ts). Absent: those events are ignored. */
  lookups?: {
    lookupAddress(address: string): { ok: boolean; error?: string };
    confirmBuilding(buildingId: string): { ok: boolean; error?: string };
    useDemoBuilding(): { ok: boolean; error?: string };
  };
  /** Actions on map incidents (incidents/service.ts). Absent: those events are ignored. */
  mapIncidents?: {
    dispatch(incidentId: string, unit?: string): { ok: boolean; error?: string };
    setPhase(incidentId: string, phase: IncidentPhase): { ok: boolean; error?: string };
    addNote(incidentId: string, text: string): { ok: boolean; error?: string };
    /** Runs one planned action on one portfolio building. */
    executeAction?(propertyId: string, actionId: string): { ok: boolean; error?: string };
  };
}

export function applyClientEvent(event: ClientEvent, store: IncidentStore, hooks: ActionHooks): void {
  const logResult = (what: string, r: { ok: boolean; error?: string } | undefined, missing: string) =>
    console.log(r?.ok ? `[action] ${what}` : `[action] ${what} ignored: ${r?.error ?? missing}`);
  const lookupResult = (what: string, r: { ok: boolean; error?: string } | undefined) => logResult(what, r, "building lookup unavailable");
  const incidentResult = (what: string, r: { ok: boolean; error?: string } | undefined) => logResult(what, r, "map incidents unavailable");
  switch (event.type) {
    case "setSimMinute":
      hooks.setSimMinute(event.minute);
      break;
    case "acceptRecommendation": {
      if (event.incidentId !== undefined) {
        const accepted = store.acceptIncidentRecommendation(event.incidentId);
        console.log(accepted ? `[action] recommendation accepted on ${event.incidentId}` : `[action] accept ignored: nothing pending on ${event.incidentId}`);
        break;
      }
      const accepted = store.acceptRecommendation();
      console.log(accepted ? "[action] recommendation accepted" : "[action] accept ignored: none pending");
      break;
    }
    case "dispatch":
      store.addDispatch(event.roomId);
      console.log(`[action] dispatch -> ${event.roomId}`);
      break;
    case "dispatchIncident":
      incidentResult(`dispatch to ${event.incidentId}`, hooks.mapIncidents?.dispatch(event.incidentId, event.unit));
      break;
    case "setIncidentPhase":
      incidentResult(`phase of ${event.incidentId} -> ${event.phase}`, hooks.mapIncidents?.setPhase(event.incidentId, event.phase));
      break;
    case "addIncidentNote":
      incidentResult(`note on ${event.incidentId}`, hooks.mapIncidents?.addNote(event.incidentId, event.text));
      break;
    case "executeAction":
      incidentResult(`execute ${event.actionId} on ${event.propertyId}`, hooks.mapIncidents?.executeAction?.(event.propertyId, event.actionId));
      break;
    case "lookupAddress":
      lookupResult(`lookup address "${event.address}"`, hooks.lookups?.lookupAddress(event.address));
      break;
    case "confirmBuilding":
      lookupResult(`confirm building ${event.buildingId}`, hooks.lookups?.confirmBuilding(event.buildingId));
      break;
    case "useDemoBuilding":
      lookupResult("use the demo building", hooks.lookups?.useDemoBuilding());
      break;
  }
}
