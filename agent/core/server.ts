// ServerApi over HTTP (server/API.md). Works both in-process (the server loads the agent with
// AGENT=1 and the agent calls back to the same port) and from a separate process.
import type { BuildingLookup, IncidentState } from "@firewatch/shared/types";
import type { BuildingInfo, Forecast, ServerApi } from "./tools/types.ts";

const TIMEOUT_MS = 5000;

export function serverUrl(): string {
  return process.env.FIRESIGHT_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${serverUrl()}${path}`;
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!res.ok || !body || body.ok === false) {
    const why = (body?.errors as string[] | undefined)?.join("; ") ?? body?.error ?? res.statusText;
    throw new Error(`${init?.method ?? "GET"} ${path} failed: HTTP ${res.status} ${String(why)}`);
  }
  return body as T;
}

export function httpServerApi(): ServerApi {
  return {
    getState: () => call<IncidentState>("/state"),
    getBuilding: () => call<BuildingInfo>("/building"),
    forecast: async (origin, minutes) => {
      const { ok: _ok, ...f } = await call<Forecast & { ok: true }>("/forecast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(minutes === undefined ? { origin } : { origin, minutes }),
      });
      return f;
    },
    lookupAddress: async (address, caller) => {
      const { lookup } = await call<{ ok: true; lookup: BuildingLookup }>("/incident/address", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(caller === undefined ? { address } : { address, caller }),
      });
      return lookup;
    },
  };
}
