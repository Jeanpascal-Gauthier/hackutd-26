export type Fetch = typeof globalThis.fetch;

export class BuildingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BuildingApiError";
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface RequestOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Only fixed, sanitized messages leave this boundary: fetch errors can contain API keys. */
export async function providerJson(
  url: URL | string,
  provider: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BuildingApiError(504, "provider_timeout", `${provider} lookup timed out. Please retry.`));
    }, options.timeoutMs ?? 10000);
  });
  const request = async () => {
    const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429)
        throw new BuildingApiError(503, "provider_rate_limited", `${provider} is temporarily rate limited. Please retry later.`);
      if (response.status === 401 || response.status === 403)
        throw new BuildingApiError(502, "provider_auth_failed", `${provider} rejected the server credentials or access settings.`);
      throw new BuildingApiError(502, "provider_unavailable", `${provider} lookup is temporarily unavailable.`);
    }
    const maxBytes = options.maxBytes ?? 6 * 1024 * 1024;
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new BuildingApiError(502, "provider_response_too_large", `${provider} returned too much data for this lookup.`);
    }
    if (!response.body)
      throw new BuildingApiError(502, "provider_invalid_response", `${provider} returned an invalid response.`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new BuildingApiError(502, "provider_response_too_large", `${provider} returned too much data for this lookup.`);
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
    } catch {
      throw new BuildingApiError(502, "provider_invalid_response", `${provider} returned an invalid response.`);
    }
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (error instanceof BuildingApiError) throw error;
    throw new BuildingApiError(502, "provider_unavailable", `${provider} lookup is temporarily unavailable.`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
