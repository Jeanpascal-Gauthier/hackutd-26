// Applies validated client actions (shared/events.ts ClientEvent) to the incident.
import type { ClientEvent } from "@firewatch/shared/events";
import { DEMO } from "../live/buildingData.ts";
import type { IncidentStore } from "./store.ts";

const demoRoomIds = new Set(DEMO.building.rooms.map((r) => r.id));
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;

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
      return { type: "acceptRecommendation" };
    case "dispatch":
      return typeof e.roomId === "string" && roomIds.has(e.roomId)
        ? { type: "dispatch", roomId: e.roomId }
        : "dispatch needs a known `roomId`";
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
}

export function applyClientEvent(event: ClientEvent, store: IncidentStore, hooks: ActionHooks): void {
  const lookupResult = (what: string, r: { ok: boolean; error?: string } | undefined) =>
    console.log(r?.ok ? `[action] ${what}` : `[action] ${what} ignored: ${r?.error ?? "building lookup unavailable"}`);
  switch (event.type) {
    case "setSimMinute":
      hooks.setSimMinute(event.minute);
      break;
    case "acceptRecommendation": {
      const accepted = store.acceptRecommendation();
      console.log(accepted ? "[action] recommendation accepted" : "[action] accept ignored: none pending");
      break;
    }
    case "dispatch":
      store.addDispatch(event.roomId);
      console.log(`[action] dispatch -> ${event.roomId}`);
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
