// The one way a caller's message enters FireSight from outside the server process: the Photon
// adapter and the QR form both call ingest(), which hands the report to the server's
// POST /ingest (server/API.md). The server runs the agent (AGENT=1) or its rule-based locator,
// updates the incident, and returns the text to send back to the caller.
import { serverUrl } from "./server.ts";

export interface IngestInput {
  text: string;
  /** Stable id for the person: phone number or iMessage handle, or a per-browser id from the form. */
  caller: string;
}

export interface IngestResult {
  ok: boolean;
  /** Text to send back: a follow-up question, or what to do. */
  reply?: string;
  roomId?: string;
  confidence?: number;
  error?: string;
}

/** The agent can take ~5 s; the server gives it 20 s before falling back to its own locator. */
const TIMEOUT_MS = 30_000;

export async function ingest({ text, caller }: IngestInput): Promise<IngestResult> {
  try {
    const res = await fetch(`${serverUrl()}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, caller }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; reply?: string; report?: { roomId?: string; confidence?: number }; errors?: string[] }
      | undefined;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.errors?.join("; ") ?? `HTTP ${res.status}` };
    }
    return { ok: true, reply: body.reply, roomId: body.report?.roomId, confidence: body.report?.confidence };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Sent when the server can't be reached: never leave a caller with no answer. */
export const FALLBACK_REPLY =
  "We received your report. If you can, leave the building by a stairwell that is clear of smoke. Do not use the elevator. Call 911 if you are in danger.";
