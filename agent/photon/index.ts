// Photon 2.0 line -> FireSight. Each inbound text goes through ingest() to the server, and the
// reply is texted back into the same conversation.
//
//   npm run photon -w agent                # needs PHOTON_PROJECT_ID (pho_prj_...) + PHOTON_API_KEY (pho_sk_...)
//   npm run photon -w agent -- --terminal  # no credentials: type messages in this terminal instead
//
// Polls the project's received messages every 2 s (app.beta.photon.codes): no webhook or tunnel.
// Works for any channel the project has (iMessage, SMS, WhatsApp, ...). The server must be running.
// Errors are logged and retried, and missing credentials idle instead of exiting, because
// `npm run demo` stops everything when one process exits. Voice calls are not handled.
import { createInterface } from "node:readline";
import { Photon } from "@photon-ai/api";
import { ingest } from "../core/ingest.ts";
import { serverUrl } from "../core/server.ts";
import { createHandler, type ChatMessage, type ChatSpace } from "./handler.ts";
import { createPoller, type PhotonApi } from "./photon2.ts";

const POLL_MS = 2000;
const BACKOFF_MS = 15_000;
const handle = createHandler(ingest);
const onMessage = (space: ChatSpace, message: ChatMessage) => {
  // Don't await: one caller's ~5 s agent run must not hold up everyone else's texts.
  void handle(space, message).catch((err) => console.error(`[photon] handler error: ${String(err)}`));
};

// On Ctrl+C, stop polling and let Node exit on its own: process.exit() right after an SDK request
// can crash Node on Windows (libuv "UV_HANDLE_CLOSING" assertion).
let stopping = false;
let wake: (() => void) | undefined;
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    wake = () => (clearTimeout(t), r());
  });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(130); // second Ctrl+C: force it
    stopping = true;
    process.exitCode = 0;
    wake?.();
  });
}

/** Logs once and idles: exiting would stop the whole demo. */
async function idle(message: string): Promise<never> {
  console.error(`${message}\n  The Photon line is OFF; the rest of the demo keeps running.`);
  await new Promise(() => setInterval(() => {}, 1 << 30)); // the timer keeps Node alive
  throw new Error("unreachable");
}

// ---- --terminal: the same handler, with this terminal as the conversation ----
if (process.argv.includes("--terminal")) {
  console.log(`[photon] terminal mode: type a message and press Enter; reports go to ${serverUrl()}/ingest`);
  const pending: Promise<unknown>[] = [];
  let n = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const space: ChatSpace = { id: "terminal", send: async (text) => void console.log(`< ${text}`) };
    pending.push(handle(space, { id: `t${n++}`, direction: "inbound", sender: { id: "terminal-user" }, content: { type: "text", text: line } }));
  }
  await Promise.allSettled(pending);
  process.exit(0);
}

// ---- the real line ----
const projectId = process.env.PHOTON_PROJECT_ID;
const apiKey = process.env.PHOTON_API_KEY;
if (!projectId || !apiKey) {
  await idle(
    "[photon] PHOTON_PROJECT_ID and PHOTON_API_KEY must be set in the root .env.\n" +
      "  Project id: Settings at https://app.beta.photon.codes (pho_prj_...).\n" +
      "  API key: the project's API keys page -> New API key (pho_sk_..., shown once).",
  );
}
if (!projectId!.startsWith("pho_prj_")) await idle(`[photon] PHOTON_PROJECT_ID should start with pho_prj_, not "${projectId!.slice(0, 8)}...".`);
if (!apiKey!.startsWith("pho_sk_") && !apiKey!.startsWith("pho_ask_")) {
  console.warn(`[photon] PHOTON_API_KEY usually starts with pho_sk_; got "${apiKey!.slice(0, 6)}...". Trying anyway.`);
}

const api = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } }) as unknown as PhotonApi;
const pollOnce = createPoller({ api, projectId: projectId!, onMessage });
console.log(`[photon] listening: Photon 2.0 project ${projectId} (polling every ${POLL_MS / 1000} s); reports go to ${serverUrl()}/ingest`);

let failing = false;
while (!stopping) {
  try {
    await pollOnce();
    if (failing) console.log("[photon] line reconnected");
    failing = false;
    await sleep(POLL_MS);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    console.error(`[photon] poll failed${e.status ? ` (HTTP ${e.status}${e.code ? ` ${e.code}` : ""})` : ""}: ${e.message ?? String(err)}`);
    if (e.status === 401 || e.status === 403) {
      console.error("[photon]   check PHOTON_API_KEY: a project key (pho_sk_) for this project, with project:read and project:write");
    }
    failing = true;
    await sleep(BACKOFF_MS);
  }
}
console.log("[photon] stopped");
