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
