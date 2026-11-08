import type { IncomingMessage, ServerResponse } from "node:http";
import type { BuildingService } from "./service.ts";
import { BuildingApiError } from "./provider.ts";

const MAX_BODY_BYTES = 4096;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES)
      throw new BuildingApiError(413, "request_too_large", "Building lookup request is too large.");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new BuildingApiError(400, "invalid_json", "Request body must be valid JSON."); }
}

/** Returns false for unrelated paths so existing incident routes keep their behavior. */
export function createBuildingRoutes(service: BuildingService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawPath = (req.url ?? "").split("?")[0];
    if (rawPath !== "/buildings" && !rawPath.startsWith("/buildings/")) return false;
    try {
      let url: URL;
      let path: string;
      try {
        url = new URL(req.url ?? "", "http://localhost");
        path = decodeURIComponent(url.pathname);
      } catch { throw new BuildingApiError(400, "invalid_path", "Building lookup path is invalid."); }
      if (req.method === "GET" && path === "/buildings/search") {
        send(res, 200, await service.search(url.searchParams.get("q")));
      } else if (req.method === "POST" && path === "/buildings/resolve") {
        send(res, 200, await service.resolve(await readJson(req)));
      } else if (req.method === "GET" && path === "/buildings/providers") {
        send(res, 200, service.providers());
      } else if (req.method === "GET") {
        const match = /^\/buildings\/([^/]+)(\/rooms)?$/.exec(path);
        if (!match) throw new BuildingApiError(404, "route_not_found", "Building lookup route not found.");
        send(res, 200, match[2] ? service.rooms(match[1]) : service.get(match[1]));
      } else {
        throw new BuildingApiError(405, "method_not_allowed", "Method not allowed for this building lookup route.");
      }
    } catch (error) {
      if (error instanceof BuildingApiError)
        send(res, error.status, { ok: false, error: error.message, code: error.code, ...error.details });
      else
        send(res, 500, { ok: false, error: "Building lookup failed.", code: "building_lookup_failed" });
    }
    return true;
  };
}
