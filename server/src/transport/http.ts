// HTTP: POST /ingest (validated, handed to the ReportProcessor), GET /health, mock controls.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { IncidentStore } from "../state/store.ts";
import type { IngestInput, ProcessResult, ReportProcessor } from "../state/processor.ts";

const MAX_BODY = 16 * 1024;
const MAX_TEXT = 2000;
const MAX_CALLER = 100;

export interface HttpDeps {
  store: IncidentStore;
  getProcessor: () => ReportProcessor;
  /** Present only in mock mode: POST /mock/reset and /mock/replay. */
  mock?: { reset(): void; replay(): void };
  /** Present only in live mode: POST /live/reset, and told about every ingested report. */
  live?: { reset(): void; onReport(result: ProcessResult): void };
}

/** Returns validated input or a list of problems. */
export function validateIngest(body: unknown): IngestInput | string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ["body must be a JSON object"];
  const { text, caller } = body as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof text !== "string" || text.trim() === "") errors.push("`text` must be a non-empty string");
  else if (text.length > MAX_TEXT) errors.push(`\`text\` must be at most ${MAX_TEXT} characters`);
  if (typeof caller !== "string" || caller.trim() === "") errors.push("`caller` must be a non-empty string");
  else if (caller.length > MAX_CALLER) errors.push(`\`caller\` must be at most ${MAX_CALLER} characters`);
  return errors.length ? errors : { text: (text as string).trim(), caller: (caller as string).trim() };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*", // dev: console/headset run on other ports
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function createHttpServer({ store, getProcessor, mock, live }: HttpDeps) {
  return createServer(async (req, res) => {
    const { method, url } = req;
    if (method === "OPTIONS") return json(res, 204, null);
    if (method === "GET" && url === "/health") return json(res, 200, { ok: true, mock: !!mock });

    if (method === "POST" && url === "/live/reset") {
      if (!live) return json(res, 404, { ok: false, error: "live mode is off (start with MOCK=0)" });
      live.reset();
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && (url === "/mock/reset" || url === "/mock/replay")) {
      if (!mock) return json(res, 404, { ok: false, error: "mock mode is off" });
      url === "/mock/reset" ? mock.reset() : mock.replay();
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/ingest") {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 413, { ok: false, error: "body too large" });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, error: "invalid JSON" });
      }
      const input = validateIngest(parsed);
      if (Array.isArray(input)) return json(res, 400, { ok: false, errors: input });

      try {
        const result = await getProcessor()(input);
        const report = {
          id: randomUUID(),
          caller: input.caller,
          text: input.text,
          roomId: result.roomId,
          confidence: result.confidence,
          time: Date.now(),
        };
        store.addReport(report);
        if (result.trail?.length) store.patch({ trail: [...(store.get().trail ?? []), ...result.trail] });
        if (live) live.onReport(result);
        else if (result.recommendation) store.setRecommendation(result.recommendation);
        const reply = result.reply ?? store.get().recommendation?.callerReply;
        return json(res, 200, { ok: true, report, reply });
      } catch (err) {
        console.error("[ingest] processor failed", err);
        return json(res, 502, { ok: false, error: "processing failed" });
      }
    }

    json(res, 404, { ok: false, error: "not found" });
  });
}
