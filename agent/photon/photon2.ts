// Photon 2.0 (beta, project ids "pho_prj_...") over its SDK, @photon-ai/api.
// Inbound: poll listMessages every couple of seconds (the pattern in Photon's own iMessage
// walkthrough): no webhook, no public URL, no tunnel. Outbound: sendMessage into the same space,
// as the agent user that received the message. https://photon.codes/docs/beta/get-started/imessage
import type { ChatMessage, ChatSpace } from "./handler.ts";

/** The fields of a Photon 2.0 message this adapter reads (the SDK types are per-platform unions). */
export interface PhotonMessage {
  id: string;
  platform: string;
  status?: string;
  createdAt: string;
  content: { type: string; text?: string };
  sentBy?: { id?: string; handle?: string; kind?: string };
  receivedBy?: { id?: string; handle?: string; kind?: string };
  addressedTo?: { id?: string };
  space: { id: string };
}

/** The two SDK calls used, so tests can pass a fake. Shapes follow @photon-ai/api 0.5.0. */
export interface PhotonApi {
  projects: {
    listMessages(input: {
      path: { id: string };
      query?: Record<string, string | number | undefined>;
    }): Promise<{ items: unknown[]; nextPageToken?: string }>;
    sendMessage(input: {
      path: { id: string };
      headers: { "idempotency-key": string };
      body: { spaceId: string; senderId: string; parentMessageId?: string; content: Record<string, unknown> };
    }): Promise<unknown>;
  };
}

/** Content types that carry what a person wrote. Read receipts and typing updates also arrive as messages. */
const PERSON_CONTENT = new Set(["text", "attachment", "group", "voice"]);

/** A received message from a person, as the handler sees it; undefined for anything to ignore. */
export function toChatMessage(m: PhotonMessage): ChatMessage | undefined {
  if (m.status !== undefined && m.status !== "received") return undefined;
  if (m.sentBy?.kind === "agent") return undefined;
  if (!PERSON_CONTENT.has(m.content?.type)) return undefined;
  const caller = m.sentBy?.handle ?? m.sentBy?.id;
  return {
    id: m.id,
    direction: "inbound",
    sender: caller ? { id: caller } : undefined,
    content: { type: m.content.type, text: m.content.text },
  };
}

/** Replies go into the message's space, sent as the agent user that received it. */
export function replySpace(api: PhotonApi, projectId: string, m: PhotonMessage): ChatSpace {
  const senderId = m.receivedBy?.id ?? m.addressedTo?.id;
  const send = (key: string, content: Record<string, unknown>, parent = true) => {
    if (!senderId) return Promise.reject(new Error(`message ${m.id} has no receivedBy agent to reply as`));
    return api.projects.sendMessage({
      path: { id: projectId },
      headers: { "idempotency-key": `firesight:${key}:${m.id}` },
      body: { spaceId: m.space.id, senderId, ...(parent ? { parentMessageId: m.id } : {}), content },
    });
  };
  let replies = 0;
  return {
    id: m.space.id,
    // One key per reply, so a retried request is not sent twice but a second reply still goes out.
    send: (text) => send(`reply${replies++}`, { type: "text", format: "plain", text }),
    startTyping: () => send("typing-on", { type: "space.typing.update", typing: true }, false).then(() => {}),
    stopTyping: () => send("typing-off", { type: "space.typing.update", typing: false }, false).then(() => {}),
  };
}

export interface PollerOptions {
  api: PhotonApi;
  projectId: string;
  onMessage: (space: ChatSpace, message: ChatMessage) => void;
  /** Only messages created after this are handled (default: now, so old texts are not answered). */
  since?: Date;
  log?: (line: string) => void;
}

/** listMessages is eventually consistent: look back this far each poll and dedupe by id. */
const OVERLAP_MS = 30_000;
const SEEN_LIMIT = 2000;

/**
 * Returns pollOnce(): fetches received messages since the last poll (with overlap), hands each new
 * person message to onMessage, and returns how many it handed over.
 */
export function createPoller({ api, projectId, onMessage, since = new Date(), log = console.log }: PollerOptions) {
  let cursor = since.getTime();
  const seen = new Set<string>();

  return async function pollOnce(): Promise<number> {
    let handed = 0;
    let pageToken: string | undefined;
    let newest = cursor;
    do {
      const page = await api.projects.listMessages({
        path: { id: projectId },
        query: {
          direction: "received",
          order: "asc",
          orderBy: "created_at",
          createdSince: new Date(cursor - OVERLAP_MS).toISOString(),
          pageSize: 50,
          pageToken,
        },
      });
      for (const raw of page.items as PhotonMessage[]) {
        const created = Date.parse(raw.createdAt);
        if (Number.isFinite(created)) {
          if (created < cursor - OVERLAP_MS || created < since.getTime()) continue;
          newest = Math.max(newest, created);
        }
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
        const msg = toChatMessage(raw);
        if (!msg) continue;
        handed++;
        onMessage(replySpace(api, projectId, raw), msg);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    cursor = newest;
    if (handed) log(`[photon] ${handed} new message(s)`);
    return handed;
  };
}
