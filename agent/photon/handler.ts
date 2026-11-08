// One inbound Photon 2.0 message -> ingest() -> a text back to the same conversation.
// Kept apart from index.ts so it can be tested without the SDK or credentials.
import { FALLBACK_REPLY, type IngestInput, type IngestResult } from "../core/ingest.ts";

/** The parts of a conversation and a message this handler uses (photon2.ts adapts Photon's to these). */
export interface ChatSpace {
  readonly id: string;
  send(text: string): Promise<unknown>;
  startTyping?(): Promise<void>;
  stopTyping?(): Promise<void>;
}

export interface ChatMessage {
  readonly id: string;
  direction: "inbound" | "outbound";
  sender?: { readonly id: string } | undefined;
  content: { type: string; text?: string };
}

export const NOT_TEXT_REPLY = "Please text us in words: which floor are you on, and where is the smoke or fire?";

/** Remembers recent message ids: Photon delivery is at-least-once. */
const SEEN_LIMIT = 500;

export function createHandler(send: (input: IngestInput) => Promise<IngestResult>, log: (line: string) => void = console.log) {
  const seen = new Set<string>();

  return async function handle(space: ChatSpace, message: ChatMessage): Promise<string | undefined> {
    if (message.direction !== "inbound") return undefined;
    if (seen.has(message.id)) return undefined;
    seen.add(message.id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);

    const caller = message.sender?.id ?? space.id;
    const text = message.content.type === "text" ? (message.content.text ?? "").trim() : "";
    if (!text) {
      await space.send(NOT_TEXT_REPLY).catch((err) => log(`[photon] send failed: ${String(err)}`));
      return NOT_TEXT_REPLY;
    }

    log(`[photon] ${caller}: ${JSON.stringify(text)}`);
    await space.startTyping?.().catch(() => {});
    let reply: string;
    try {
      const result = await send({ text, caller });
      if (!result.ok) log(`[photon] ingest failed for ${caller}: ${result.error}`);
      reply = result.reply ?? FALLBACK_REPLY;
      if (result.ok) log(`[photon] -> ${caller}: room ${result.roomId ?? "-"} (${result.confidence ?? 0}), reply ${JSON.stringify(reply)}`);
    } finally {
      await space.stopTyping?.().catch(() => {});
    }
    await space.send(reply).catch((err) => log(`[photon] send to ${caller} failed: ${String(err)}`));
    return reply;
  };
}
