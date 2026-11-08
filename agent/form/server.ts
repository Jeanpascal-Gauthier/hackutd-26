// The QR fallback form: a phone-friendly page that sends a report through ingest(), the same
// path the Photon line uses. Judges scan the QR on the table card and type what they see.
//   GET  /          report page (with the iMessage sign-up step when `register` is set)
//   POST /report    { text, caller } -> { ok, reply } (or { ok:false, error })
//   POST /imessage  { phone } -> { ok, number, reused } (or { ok:false, error }); 404 without `register`
//   GET  /config    { imessage }: whether the iMessage step is on (diagnostics; the page has it rendered in)
//   GET  /qr        printable QR of the public URL (?url=https://... to encode a tunnel URL)
//   GET  /health    { ok }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import QRCode from "qrcode";
import { FALLBACK_REPLY, type IngestInput, type IngestResult } from "../core/ingest.ts";
import { normalizeHandle, type AssignResult } from "../photon/assign.ts";
import { qrPage, reportPage } from "./page.ts";

const MAX_BODY = 4 * 1024;
const MAX_TEXT = 500;
const MAX_PHONE = 32;
const DEFAULT_MAX_REGISTRATIONS = 40;
const SIGNUPS_FULL = "iMessage sign-ups are full right now: use the form above.";
const SIGNUP_FAILED = "Couldn't sign you up for iMessage right now: use the form above.";

export interface FormOptions {
  ingest: (input: IngestInput) => Promise<IngestResult>;
  /** URL encoded in the QR when /qr has no ?url=. Defaults to the first LAN address. */
  publicUrl?: string;
  log?: (line: string) => void;
  /** Registers a normalized phone on the Photon shared iMessage line. Absent: no iMessage step, /imessage is 404. */
  register?: (handle: string) => Promise<AssignResult>;
  /** Turns typed input into a handle. Defaults to normalizeHandle (tests pass a fake). */
  normalize?: (input: string) => string | undefined;
  /** Cap on NEW (non-reused) registrations per server run; each uses a paid seat. Default FORM_MAX_REGISTRATIONS, else 40. */
  maxRegistrations?: number;
}

/** First non-internal IPv4 address on a real adapter (skips WSL, Docker, VPNs). */
export function lanAddress(): string | undefined {
  const virtual = /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback|Bluetooth|tailscale|zerotier|utun|veth|br-/i;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  }
  return undefined;
}

function maxRegistrationsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FORM_MAX_REGISTRATIONS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_REGISTRATIONS;
}

/**
 * The client's address. Behind a local tunnel (cloudflared, ngrok) every request arrives from
 * loopback, so only then the forwarded header is trusted; a direct client cannot spoof it.
 */
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (/^(::1$|127\.|::ffff:127\.)/.test(remote)) {
    const fwd = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return remote;
}

/** "+14155550123" -> "+1•••••0123", for logs. */
const mask = (handle: string) => (handle.length > 6 ? `${handle.slice(0, 2)}•••••${handle.slice(-4)}` : "•••");

/** An upstream error fit to show a person: one line, short. */
const friendly = (error: unknown) =>
  typeof error === "string" && error.trim() ? error.replace(/\s+/g, " ").trim().slice(0, 200) : SIGNUP_FAILED;

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

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

export function createFormServer({
  ingest,
  publicUrl,
  log = console.log,
  register,
  normalize = normalizeHandle,
  maxRegistrations = maxRegistrationsFromEnv(),
}: FormOptions) {
  const inFlight = new Set<string>(); // callers with a report being handled: one at a time each
  const page = reportPage({ imessage: Boolean(register) });

  // iMessage sign-up limits. A seat is reserved before calling register so parallel requests from
  // different people can't overshoot the cap; reused results give the reservation back.
  const signupInFlight = new Set<string>(); // client IPs with a registration in progress
  const known = new Set<string>(); // handles registered this run: asking again is a reuse, never a new seat
  let created = 0;
  let reserved = 0;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://form.local");

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", page);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/config") return json(res, 200, { imessage: Boolean(register) });

    if (req.method === "GET" && url.pathname === "/qr") {
      const given = url.searchParams.get("url");
      const target = given && /^https?:\/\/\S+$/i.test(given) ? given : publicUrl ?? `http://${req.headers.host ?? "localhost"}/`;
      const svg = await QRCode.toString(target, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      return send(res, 200, "text/html; charset=utf-8", qrPage(target, svg));
    }

    if (req.method === "POST" && url.pathname === "/report") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { ok: false, error: "Send JSON: { text, caller }." });
      }
      const { text, caller } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof text !== "string" || !text.trim()) return json(res, 400, { ok: false, error: "Please type a message." });
      if (text.length > MAX_TEXT) return json(res, 400, { ok: false, error: `Please keep it under ${MAX_TEXT} characters.` });
      if (typeof caller !== "string" || !/^[\w.+-]{1,64}$/.test(caller)) return json(res, 400, { ok: false, error: "Bad caller id." });

      if (inFlight.has(caller)) {
        return json(res, 429, { ok: false, error: "One moment: your last message is still being handled." });
      }
      inFlight.add(caller);
      log(`[form] ${caller}: ${JSON.stringify(text.trim())}`);
      try {
        const result = await ingest({ text: text.trim(), caller: `form:${caller}` });
        if (!result.ok) log(`[form] ingest failed for ${caller}: ${result.error}`);
        else log(`[form] -> ${caller}: room ${result.roomId ?? "-"} (${result.confidence ?? 0})`);
        return json(res, 200, { ok: result.ok, reply: result.reply ?? FALLBACK_REPLY });
      } finally {
        inFlight.delete(caller);
      }
    }

    if (req.method === "POST" && url.pathname === "/imessage" && register) {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { ok: false, error: "Send JSON: { phone }." });
      }
      const { phone } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof phone !== "string" || !phone.trim() || phone.length > MAX_PHONE || phone.includes("@")) {
        return json(res, 400, { ok: false, error: "Enter the phone number you text from." });
      }
      let handle: string | undefined;
      try {
        handle = normalize(phone.trim());
      } catch (err) {
        log(`[form] imessage: normalize failed: ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 500, { ok: false, error: SIGNUP_FAILED });
      }
      if (!handle || !/^\+[1-9]\d{6,14}$/.test(handle)) {
        return json(res, 400, { ok: false, error: "That doesn't look like a phone number. Try 415-555-0123." });
      }

      const ip = clientIp(req);
      if (signupInFlight.has(ip)) {
        return json(res, 429, { ok: false, error: "One moment: your last sign-up is still being handled." });
      }
      const isKnown = known.has(handle);
      if (!isKnown && created + reserved >= maxRegistrations) {
        log(`[form] imessage: cap of ${maxRegistrations} new sign-ups reached, refused ${mask(handle)}`);
        return json(res, 429, { ok: false, error: SIGNUPS_FULL });
      }

      signupInFlight.add(ip);
      if (!isKnown) reserved++;
      try {
        let result: AssignResult;
        try {
          result = await register(handle);
        } catch (err) {
          log(`[form] imessage: register threw for ${mask(handle)}: ${err instanceof Error ? err.message : String(err)}`);
          return json(res, 502, { ok: false, error: SIGNUP_FAILED });
        }
        if (!result.ok) {
          log(`[form] imessage: sign-up failed for ${mask(handle)}: ${result.code ?? "-"} ${result.status ?? "-"} ${friendly(result.error)}`);
          return json(res, 502, { ok: false, error: friendly(result.error) });
        }
        const { assignedPhoneNumber: number, reused } = result.assignment;
        known.add(handle);
        if (!reused) created++;
        log(`[form] imessage: ${mask(handle)} -> ${number}${reused ? " (reused)" : ""} [${created}/${maxRegistrations} new]`);
        return json(res, 200, { ok: true, number, reused: Boolean(reused) });
      } finally {
        if (!isKnown) reserved--;
        signupInFlight.delete(ip);
      }
    }

    return json(res, 404, { ok: false, error: "Not found." });
  });
}
