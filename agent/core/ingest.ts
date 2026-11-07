import type { Report } from "@firewatch/shared/types";

/**
 * Takes one inbound caller report (from Photon, the fallback form, or an
 * operator) and runs the agent on it.
 *
 * STUB: logs the report and does nothing else. When the shared contract
 * lands, this returns a LocatedReport and emits AgentTrail updates.
 */
export async function ingest(report: Report): Promise<void> {
  console.log(`[agent] ingest ${report.id} from ${report.caller}: ${JSON.stringify(report.text)}`);
}
