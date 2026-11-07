// MOCK ReportProcessor so /ingest works without Person C's agent or API keys.
// Keyword match only; replace with the real agent via setReportProcessor().
import type { ReportProcessor } from "../state/processor.ts";

export const mockProcessor: ReportProcessor = ({ text }) => {
  const t = text.toLowerCase();
  const roomId = t.includes("8") || t.includes("eighth") ? "8-hall" : "7-break";
  return { roomId, confidence: 0.5 };
};
