// The one path every report takes, whether it comes from POST /ingest or the scripted demo:
// processor (agent or rule-based locator) -> report in the store -> trail -> live incident update.
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
    const result = await getProcessor()(input);
    const report: Report = {
      id: randomUUID(),
      caller: input.caller,
      text: input.text,
      roomId: result.roomId,
      confidence: result.confidence,
      time: Date.now(),
    };
    store.addReport(report);
    if (result.trail?.length) store.patch({ trail: [...(store.get().trail ?? []), ...result.trail] });
    live.onReport(result);
    return { report, result, reply: result.reply ?? store.get().recommendation?.callerReply };
  };
}
