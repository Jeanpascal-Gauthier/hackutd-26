// Plugs Person C's agent (agent/index.ts) into the server as the ReportProcessor, in-process.
// The agent exports:
//   export async function processReport(input: { text, caller }): Promise<{ roomId?, confidence?,
//     recommendation?, trail?, reply? }>
//   export function resetConversations(): void   // forget callers' earlier texts (new demo run)
// Loaded by relative path (no package dependency). Every call is guarded: if the agent throws,
// times out or returns something unusable, that report falls back to the rule-based locator.
import type { ProcessResult, ReportProcessor } from "../state/processor.ts";

export const AGENT_EXPORT = "processReport";
export const RESET_EXPORT = "resetConversations";
const AGENT_URL = new URL("../../../agent/index.ts", import.meta.url);

const isResult = (v: unknown): v is ProcessResult => typeof v === "object" && v !== null && !Array.isArray(v);

/** Wraps the agent so a failure on one report never fails the ingest. */
export function guardAgent(agent: ReportProcessor, fallback: ReportProcessor, timeoutMs: number): ReportProcessor {
  return async (input) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`agent timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve(agent(input)), timeout]);
      if (!isResult(result)) throw new Error(`agent returned ${JSON.stringify(result)}, expected an object`);
      return result;
    } catch (err) {
      console.error(`[agent] ${(err as Error).message}; using the rule-based locator for this report`);
      return fallback(input);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function importAgent(url: URL): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(url.href)) as Record<string, unknown>;
  } catch (err) {
    console.error(`[agent] could not load ${url.pathname}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Loads the agent's processReport. Returns undefined (and logs why) when the agent can't be
 * loaded or doesn't export it yet, so the server keeps running on the rule-based locator.
 */
export async function loadAgentProcessor(url: URL = AGENT_URL): Promise<ReportProcessor | undefined> {
  const mod = await importAgent(url);
  if (!mod) return undefined;
  const fn = mod[AGENT_EXPORT];
  if (typeof fn !== "function") {
    console.warn(`[agent] agent/index.ts does not export ${AGENT_EXPORT}() yet; using the rule-based locator`);
    return undefined;
  }
  return fn as ReportProcessor;
}

/**
 * Loads the agent's resetConversations, wrapped so it never throws. Returns undefined when the
 * agent doesn't export it; resets then only clear the server's state.
 */
export async function loadAgentReset(url: URL = AGENT_URL): Promise<(() => void) | undefined> {
  const fn = (await importAgent(url))?.[RESET_EXPORT];
  if (typeof fn !== "function") return undefined;
  return () => {
    try {
      fn();
    } catch (err) {
      console.error(`[agent] ${RESET_EXPORT}() failed: ${(err as Error).message}`);
    }
  };
}
