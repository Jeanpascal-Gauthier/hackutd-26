// The one path every report takes, whether it comes from POST /ingest or the scripted demo:
// processor (or the agent's own result, if it sent one) -> report in the store -> trail -> live incident update.
// While an address lookup is under way (live/lookup.ts), reports are held instead: stored with no
// room and a fixed reply, and located on the new building once it is active.
import { randomUUID } from "node:crypto";
import type { Report } from "@firewatch/shared/types";
import type { IncidentStore } from "./store.ts";
import type { IngestInput, ProcessResult, ReportProcessor } from "./processor.ts";

export interface IngestOutcome {
  report: Report;
  result: ProcessResult;
  /** Text to send back to the caller: the processor's reply, else the recommendation's. */
  reply?: string;
  /** True when the report was held unlocated because a building lookup is under way. */
  held?: boolean;
}

export type Ingest = (input: IngestInput) => Promise<IngestOutcome>;

export interface IngestOptions {
  /**
   * While an address lookup is searching, waiting for confirmation or loading, the reply to give
   * instead of locating the report against the old building. Undefined otherwise.
   */
  holdReply?(): string | undefined;
  /** Told about each report that was held, so it can be located once the building is active. */
  onHeld?(report: Report): void;
}

export function createIngest(
  store: IncidentStore,
  getProcessor: () => ReportProcessor,
  live: { onReport(result: ProcessResult): void },
  options: IngestOptions = {},
): Ingest {
  return async (input) => {
    const holdBefore = options.holdReply?.();
    let result: ProcessResult = holdBefore ? {} : input.preprocessed ?? (await getProcessor()(input));
    // The processor itself may have started a lookup (the agent's find_building tool): its
    // location is on the old building, so hold this report too.
    const holdReply = holdBefore ?? options.holdReply?.();
    if (holdReply) result = { reply: holdReply, ...(result.trail && { trail: result.trail }) };
    const report: Report = {
      id: randomUUID(),
      caller: input.caller,
      text: input.text,
      roomId: result.roomId,
      confidence: result.confidence,
      time: Date.now(),
      ...(input.channel && { channel: input.channel }),
    };
    store.addReport(report);
    if (holdReply) options.onHeld?.(report);
    const where = holdReply ? "held until the building is confirmed" : report.roomId ? `${report.roomId} (${Math.round((report.confidence ?? 0) * 100)}%)` : "location unclear";
    store.log("report", `${report.channel === "voice" ? "Call" : "Report"} from ${report.caller}: ${where}`);
    if (result.trail?.length) store.patch({ trail: [...(store.get().trail ?? []), ...result.trail] });
    if (!holdReply) live.onReport(result);

    // Keep what Firewatch told the caller on the report itself, so clients can show a transcript.
    const reply = result.reply ?? store.get().recommendation?.callerReply;
    if (!reply) return { report, result, ...(holdReply && { held: true }) };
    const answered = { ...report, reply };
    store.patch({ reports: store.get().reports.map((r) => (r.id === report.id ? answered : r)) });
    // Logged as "report" (not a new kind) so existing clients that map every kind keep compiling.
    store.log("report", `Replied to ${report.caller}: ${reply}`);
    return { report: answered, result, reply, ...(holdReply && { held: true }) };
  };
}
