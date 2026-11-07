// Applies validated client actions (shared/events.ts ClientEvent) to the incident.
import type { ClientEvent } from "@firewatch/shared/events";
import building from "@firewatch/shared/building.json" with { type: "json" };
import type { IncidentStore } from "./store.ts";

const roomIds = new Set(building.rooms.map((r) => r.id));

/** Narrow untrusted JSON to a ClientEvent, or return an error string. */
export function parseClientEvent(raw: unknown): ClientEvent | string {
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
    default:
      return `unknown event type: ${String(e.type)}`;
  }
}

export interface ActionHooks {
  /** Called for setSimMinute. Mock mode: replays the fixture. Real mode: the simulation. */
  setSimMinute(minute: number): void;
}

export function applyClientEvent(event: ClientEvent, store: IncidentStore, hooks: ActionHooks): void {
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
      // No state field for dispatches in shared/types.ts yet; logged only.
      console.log(`[action] dispatch -> ${event.roomId}`);
      break;
  }
}
