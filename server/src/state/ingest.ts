// The one path every report takes, whether it comes from POST /ingest or the scripted demo:
// processor (or the agent's own result, if it sent one) -> report in the store -> trail -> live incident update.
import { randomUUID } from "node:crypto";
import type { Report } from "@firewatch/shared/types";
import type { IncidentStore } from "./store.ts";
import type { IngestInput, ProcessResult, ReportProcessor } from "./processor.ts";

export interface IngestOutcome {
  report: Report;
  result: ProcessResult;
  /** Text to send back to the caller: the processor's reply, else the recommendation's. */
  reply?: string;
}

export type Ingest = (input: IngestInput) => Promise<IngestOutcome>;

export function createIngest(
  store: IncidentStore,
  getProcessor: () => ReportProcessor,
  live: { onReport(result: ProcessResult): void },
): Ingest {
  return async (input) => {
    const result = input.preprocessed ?? (await getProcessor()(input));
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
    const where = report.roomId ? `${report.roomId} (${Math.round((report.confidence ?? 0) * 100)}%)` : "location unclear";
    store.log("report", `${report.channel === "voice" ? "Call" : "Report"} from ${report.caller}: ${where}`);
    if (result.trail?.length) store.patch({ trail: [...(store.get().trail ?? []), ...result.trail] });
    live.onReport(result);

    // Keep what FireSight told the caller on the report itself, so clients can show a transcript.
    const reply = result.reply ?? store.get().recommendation?.callerReply;
    if (!reply) return { report, result };
    const answered = { ...report, reply };
    store.patch({ reports: store.get().reports.map((r) => (r.id === report.id ? answered : r)) });
    // Logged as "report" (not a new kind) so existing clients that map every kind keep compiling.
    store.log("report", `Replied to ${report.caller}: ${reply}`);
    return { report: answered, result, reply };
  };
}
