// Replaceable seam for Person C's agent. POST /ingest calls the active ReportProcessor.
// The server ships with the MOCK processor (mock/processor.ts); swap it with setReportProcessor().
import type { Recommendation, TrailStep } from "@firewatch/shared/types";

export interface IngestInput {
  text: string;
  caller: string;
}

export interface ProcessResult {
  roomId?: string; // which room the report is about
  confidence?: number; // 0..1
  recommendation?: Recommendation; // optional new recommendation for the operator
  trail?: TrailStep[]; // agent tool calls for this report; appended to state.trail
  reply?: string; // text to send back to the caller (follow-up question or advice)
}

export type ReportProcessor = (input: IngestInput) => Promise<ProcessResult> | ProcessResult;
