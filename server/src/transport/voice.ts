// Helpers for POST /voice/report, the webhook tool an ElevenLabs voice agent calls during a phone
// call (Photon number -> SIP -> ElevenLabs -> here). See server/API.md, "Phone calls".
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Said when FireSight has nothing to say yet (no reply and no recommendation). */
export const VOICE_FALLBACK = "Help is on the way. Which floor are you on, and which room is the smoke or fire in?";

/**
 * The shared secret from `x-firesight-token: <token>` or `Authorization: Bearer <token>`.
 * Compared in constant time. A tunnel makes the endpoint public, so it is never open without one.
 */
export function hasVoiceToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers["x-firesight-token"];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const given = (Array.isArray(header) ? header[0] : header) ?? bearer;
  if (!given) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Turns a reply written for screens into one a text-to-speech voice reads well:
 * "floors 6–12" -> "floors 6 to 12", parentheticals and markup dropped, at most 3 sentences.
 */
export function speakable(text: string | undefined): string {
  if (!text?.trim()) return VOICE_FALLBACK;
  const cleaned = text
    .replace(/(\d+)\s*[–—-]\s*(\d+)/g, "$1 to $2")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[*_#`"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  let out = sentences.slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(out)) out += ".";
  return out;
}

/** POST /voice/address: the address was heard and the lookup started. */
export const VOICE_ADDRESS_REPLY = "Thank you, I have the address. Which floor is the fire or smoke on, and which room?";
/** POST /voice/address with no usable address. */
export const VOICE_ADDRESS_PROMPT = "What is the address of the building?";

/** POST /voice/incident: what the voice agent says back. */
export const VOICE_INCIDENT_WHAT = "What is happening?";
export const VOICE_INCIDENT_WHERE = "Where is it? Give me the address, or the nearest cross street or landmark.";
export const VOICE_INCIDENT_NOT_FOUND = "I could not find that location. What is the nearest cross street or landmark?";
export const VOICE_INCIDENT_FALLBACK = "Help is on the way. Move somewhere safe if you can.";
export const VOICE_INCIDENT_UPDATE = "Thank you, I have passed that on. Stay on the line if it is safe.";
export const VOICE_INCIDENT_NEW: Record<"fire" | "buildingFire" | "crash" | "other", string> = {
  fire: "Help is on the way. Move away from the fire and smoke. Is anyone hurt or trapped?",
  buildingFire: "Help is on the way. Leave the building by the nearest stairwell. Do not use the elevator. Is anyone hurt or trapped?",
  crash: "Help is on the way. Stay clear of traffic. Is anyone hurt or trapped?",
  other: "Help is on the way. Move somewhere safe if you can. Is anyone hurt or in danger?",
};
