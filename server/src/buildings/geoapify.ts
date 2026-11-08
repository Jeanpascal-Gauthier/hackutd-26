import type { Coordinates } from "./types.ts";
import { BuildingApiError, isObject, providerJson, type RequestOptions } from "./provider.ts";

export interface AddressCandidate {
  placeId: string | null;
  address: string;
  name: string | null;
  location: Coordinates;
  resultType: string | null;
  confidence: number | null;
  matchType: string | null;
  source: { provider: "geoapify"; name: string | null; attribution: string | null; license: string | null };
}

const string = (value: unknown, max = 1000): string | null => typeof value === "string" && value.trim() ? value.slice(0, max) : null;

export function validateSearch(query: unknown): string {
  if (typeof query !== "string" || query.trim().length < 3 || query.trim().length > 500 || /[\u0000-\u001f]/.test(query))
    throw new BuildingApiError(400, "invalid_query", "`q` must be an address or place name between 3 and 500 characters.");
  return query.trim();
}

export async function searchAddresses(
  query: string,
  apiKey: string | undefined,
  options: RequestOptions = {},
): Promise<AddressCandidate[]> {
  const text = validateSearch(query);
  if (!apiKey?.trim())
    throw new BuildingApiError(503, "geoapify_not_configured", "Address search is unavailable. Configure GEOAPIFY_API_KEY on the server.");
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.search = new URLSearchParams({ text, format: "json", limit: "5", apiKey }).toString();
  const body = await providerJson(url, "Geoapify", { headers: { accept: "application/json" } }, { ...options, maxBytes: 512 * 1024 });
  if (!isObject(body) || !Array.isArray(body.results))
    throw new BuildingApiError(502, "provider_invalid_response", "Geoapify returned an invalid response.");
  return body.results.slice(0, 5).flatMap((item: unknown) => {
    if (!isObject(item) || typeof item.lat !== "number" || typeof item.lon !== "number" ||
        !Number.isFinite(item.lat) || !Number.isFinite(item.lon) || Math.abs(item.lat) > 90 || Math.abs(item.lon) > 180) return [];
    const address = string(item.formatted);
    if (!address) return [];
    const rank = isObject(item.rank) ? item.rank : {};
    const source = isObject(item.datasource) ? item.datasource : {};
    return [{
      placeId: string(item.place_id), address, name: string(item.name),
      location: { lat: item.lat, lon: item.lon }, resultType: string(item.result_type),
      confidence: typeof rank.confidence === "number" && rank.confidence >= 0 && rank.confidence <= 1 ? rank.confidence : null,
      matchType: string(rank.match_type),
      source: { provider: "geoapify" as const, name: string(source.sourcename), attribution: string(source.attribution), license: string(source.license) },
    }];
  });
}
