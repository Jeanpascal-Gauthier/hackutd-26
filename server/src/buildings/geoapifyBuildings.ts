import type { AreaGeometry, BuildingRecord, Coordinates, OsmElement, Position } from "./types.ts";
import { normalizeOsmBuilding, osmId } from "./normalize.ts";
import { validateLocation } from "./overpass.ts";
import { BuildingApiError, isObject, providerJson, type RequestOptions } from "./provider.ts";

const invalid = () => new BuildingApiError(502, "provider_invalid_response", "Geoapify returned invalid building data.");

/** Validate every ring; never discard vertices, courtyard holes or polygon components. */
function footprint(value: unknown): AreaGeometry | null {
  if (!isObject(value) || !["Polygon", "MultiPolygon"].includes(String(value.type))) return null;
  if (!Array.isArray(value.coordinates)) throw invalid();
  let vertices = 0;
  const polygon = (value: unknown): Position[][] => {
    if (!Array.isArray(value) || !value.length) throw invalid();
    return value.map((ring: unknown): Position[] => {
      if (!Array.isArray(ring) || ring.length < 4) throw invalid();
      vertices += ring.length;
      if (vertices > 20000) throw invalid();
      const points = ring.map((point: unknown): Position => {
        if (!Array.isArray(point) || point.length < 2 ||
            typeof point[0] !== "number" || typeof point[1] !== "number" ||
            !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
            Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw invalid();
        return [point[0], point[1]];
      });
      const first = points[0], last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) throw invalid();
      const area = points.slice(1).reduce((sum, p, i) => sum + points[i][0] * p[1] - p[0] * points[i][1], 0);
      if (Math.abs(area) < 1e-14) throw invalid();
      return points;
    });
  };
  if (value.type === "Polygon") return { type: "Polygon", coordinates: polygon(value.coordinates) };
  if (!value.coordinates.length) throw invalid();
  return { type: "MultiPolygon", coordinates: value.coordinates.map(polygon) };
}

/** OSM building outlines through Geoapify's managed service; no public Overpass dependency. */
export async function getGeoapifyBuildings(
  input: Coordinates, apiKey: string | undefined, fetchedAt: string, options: RequestOptions = {},
): Promise<BuildingRecord[]> {
  const location = validateLocation(input);
  if (!apiKey?.trim())
    throw new BuildingApiError(503, "geoapify_not_configured", "Building lookup is unavailable. Configure GEOAPIFY_API_KEY on the server.");
  const url = new URL("https://api.geoapify.com/v2/place-details");
  url.search = new URLSearchParams({ lat: String(location.lat), lon: String(location.lon), features: "building", apiKey }).toString();
  const body = await providerJson(url, "Geoapify", { headers: { accept: "application/json" } }, options);
  if (!isObject(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features) || body.features.length > 50) throw invalid();
  return body.features.flatMap((feature: unknown): BuildingRecord[] => {
    if (!isObject(feature) || !isObject(feature.properties)) throw invalid();
    const p = feature.properties;
    if (p.feature_type !== "building") return [];
    const outline = footprint(feature.geometry);
    if (!outline) return [];
    const data = isObject(p.datasource) ? p.datasource : {};
    const raw = isObject(data.raw) ? data.raw : {};
    const id = typeof raw.osm_id === "number" ? raw.osm_id : typeof raw.osm_id === "string" && /^\d{1,16}$/.test(raw.osm_id) ? Number(raw.osm_id) : NaN;
    const type = raw.osm_type === "w" ? "way" : raw.osm_type === "r" ? "relation" : null;
    if (!type || !Number.isSafeInteger(id) || id <= 0) throw invalid();
    const tags: Record<string, string> = Object.fromEntries(Object.entries(raw)
      .filter(([key, value]) => !["osm_id", "osm_type"].includes(key) && ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, String(value)]));
    const building = isObject(p.building) ? p.building : {};
    const copy = (key: string, value: unknown) => {
      if (tags[key] === undefined && (typeof value === "string" || typeof value === "number")) tags[key] = String(value);
    };
    copy("building", building.type ?? "yes");
    copy("building:levels", building.levels);
    copy("building:use", building.use);
    copy("height", building.height);
    copy("name", p.name);
    copy("addr:full", p.formatted);
    const element: OsmElement = { type, id, tags };
    const record = normalizeOsmBuilding(osmId(element), [element], location, fetchedAt, outline);
    if (!record) throw invalid();
    record.source.attribution = "Geoapify | © OpenStreetMap contributors";
    record.warnings.push("Building outline retrieved through Geoapify. Mapped interiors were not requested; interior coverage is unknown.");
    return [record];
  });
}
