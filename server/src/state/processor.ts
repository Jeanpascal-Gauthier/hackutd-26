// Replaceable seam for Person C's agent. POST /ingest calls the active ReportProcessor.
// The server ships with the MOCK processor (mock/processor.ts); swap it with setReportProcessor().
import type { Recommendation } from "@firewatch/shared/types";

export interface IngestInput {
  text: string;
  caller: string;
}

export interface ProcessResult {
  roomId?: string; // which room the report is about
  confidence?: number; // 0..1
  recommendation?: Recommendation; // optional new recommendation for the operator
}

export type ReportProcessor = (input: IngestInput) => Promise<ProcessResult> | ProcessResult;
