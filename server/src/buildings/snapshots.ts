// Offline copies of building lookups (server/snapshots/*.json), served when Geoapify or Overpass
// fails, or always with BUILDINGS_OFFLINE=1. One plain JSON file per captured address holds the
// provider results the live flow needs: the geocoder candidates, the OSM outlines near the top
// match, and the interior elements of the captured building(s). The normal service code turns
// them into candidates and records, so normalization changes still apply to old snapshots.
// Capture with `npm run snapshot -w server -- "<address>"` (src/buildings/captureSnapshot.ts).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressCandidate } from "./geoapify.ts";
import type { Coordinates, OsmElement } from "./types.ts";
import { isObject } from "./provider.ts";

export const SNAPSHOT_VERSION = 1;
/** server/snapshots/, next to this package's src/. */
export const DEFAULT_SNAPSHOT_DIR = fileURLToPath(new URL("../../snapshots/", import.meta.url));
/** A geocoded point this close to a snapshot's point reuses its outlines. */
export const SNAPSHOT_MATCH_METERS = 50;

export interface BuildingSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** ISO time the live lookup was captured. */
  savedAt: string;
  /** The address as captured. */
  query: string;
  /** Other spellings that should find this snapshot (hand-editable), e.g. "UTD ECSW". */
  aliases?: string[];
  /** Geoapify candidates for the query, best first (GET /buildings/search). */
  search: AddressCandidate[];
  /** The point the outlines were fetched around: the top candidate's location. */
  location: Coordinates;
  /** Overpass building outlines around `location` (resolve's candidate list). */
  nearby: OsmElement[];
  /** Overpass interior elements per captured building id ("osm:way:123"). */
  interiors: Record<string, OsmElement[]>;
  /** Free text: who captured it and which building was confirmed. */
  note?: string;
}

export interface SnapshotHit<T> { value: T; savedAt: string; file: string }

const ABBREVIATIONS: Record<string, string> = {
  west: "w", east: "e", north: "n", south: "s", road: "rd", street: "st", avenue: "ave", drive: "dr",
  boulevard: "blvd", parkway: "pkwy", lane: "ln", court: "ct", place: "pl", highway: "hwy", suite: "ste",
  texas: "tx",
};
/** "800 West Campbell Road, Richardson, TX 75080, United States" -> "800 w campbell rd richardson tx 75080" */
export function addressKey(text: string): string {
  return text.toLocaleLowerCase()
    .replace(/\b(united states( of america)?|usa)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().split(" ").filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(" ");
}

/** "800 W Campbell Rd, Richardson, TX" -> "800-w-campbell-rd-richardson-tx" */
export function snapshotFileName(query: string): string {
  return `${addressKey(query).replace(/ /g, "-").slice(0, 80) || "snapshot"}.json`;
}

function distanceMeters(a: Coordinates, b: Coordinates): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371000;
}

const coordinates = (value: unknown): value is Coordinates => isObject(value) &&
  typeof value.lat === "number" && typeof value.lon === "number" && Number.isFinite(value.lat) && Number.isFinite(value.lon);
const osmElements = (value: unknown): value is OsmElement[] => Array.isArray(value) &&
  value.every((e) => isObject(e) && (e.type === "node" || e.type === "way" || e.type === "relation") && typeof e.id === "number");

/** A parsed snapshot file, or a reason it is unusable. */
export function parseSnapshot(raw: unknown): BuildingSnapshot | string {
  if (!isObject(raw)) return "not a JSON object";
  if (raw.version !== SNAPSHOT_VERSION) return `version must be ${SNAPSHOT_VERSION}`;
  if (typeof raw.savedAt !== "string" || !Number.isFinite(Date.parse(raw.savedAt))) return "savedAt must be an ISO date";
  if (typeof raw.query !== "string" || !raw.query.trim()) return "query is missing";
  if (raw.aliases !== undefined && !(Array.isArray(raw.aliases) && raw.aliases.every((a) => typeof a === "string"))) return "aliases must be strings";
  if (!Array.isArray(raw.search) || !raw.search.every((c) => isObject(c) && typeof c.address === "string" && coordinates(c.location)))
    return "search must be a list of address candidates";
  if (!coordinates(raw.location)) return "location must be { lat, lon }";
  if (!osmElements(raw.nearby)) return "nearby must be a list of OSM elements";
  if (!isObject(raw.interiors) || !Object.values(raw.interiors).every(osmElements)) return "interiors must map building ids to OSM elements";
  return raw as unknown as BuildingSnapshot;
}

interface Loaded { file: string; snapshot: BuildingSnapshot; keys: string[] }

/** Reads `dir` lazily and again whenever its files change; `false` disables snapshots. */
export function createSnapshotStore(dir: string | false) {
  let signature: string | undefined;
  let loaded: Loaded[] = [];

  function load(): Loaded[] {
    if (!dir) return [];
    let names: string[];
    try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch { names = []; }
    const next = names.map((name) => {
      try { const s = statSync(join(dir, name)); return `${name}:${s.mtimeMs}:${s.size}`; } catch { return name; }
    }).join("|");
    if (next === signature) return loaded;
    signature = next;
    loaded = names.flatMap((file): Loaded[] => {
      let parsed: BuildingSnapshot | string;
      try { parsed = parseSnapshot(JSON.parse(readFileSync(join(dir, file), "utf8"))); } catch { parsed = "invalid JSON"; }
      if (typeof parsed === "string") {
        console.warn(`[snapshots] skipping ${file}: ${parsed}`);
        return [];
      }
      const keys = [parsed.query, ...(parsed.aliases ?? []), ...parsed.search.map((c) => c.address)].map(addressKey).filter(Boolean);
      return [{ file, snapshot: parsed, keys: [...new Set(keys)] }];
    });
    return loaded;
  }

  const hit = <T>(entry: Loaded, value: T): SnapshotHit<T> => ({ value, savedAt: entry.snapshot.savedAt, file: entry.file });

  /**
   * Geocoder candidates for a query. Exact key first; otherwise a key that starts with the query
   * (or the reverse) at a word boundary, when the shorter one has a house number and 3+ words:
   * "800 w campbell rd" finds "800 w campbell rd richardson tx".
   */
  function search(query: string): SnapshotHit<AddressCandidate[]> | undefined {
    const key = addressKey(query);
    if (!key) return undefined;
    const all = load();
    const exact = all.find((entry) => entry.keys.includes(key));
    if (exact) return hit(exact, exact.snapshot.search);
    const prefix = (short: string, long: string) => short.split(" ").length >= 3 && /\d/.test(short) && long.startsWith(`${short} `);
    const partial = all.find((entry) => entry.keys.some((k) => prefix(key, k) || prefix(k, key)));
    return partial && hit(partial, partial.snapshot.search);
  }

  /** The outlines of the snapshot nearest `location` (within SNAPSHOT_MATCH_METERS). */
  function nearby(location: Coordinates): SnapshotHit<OsmElement[]> | undefined {
    let best: Loaded | undefined, bestDistance = SNAPSHOT_MATCH_METERS;
    for (const entry of load()) {
      const d = distanceMeters(location, entry.snapshot.location);
      if (d <= bestDistance) { best = entry; bestDistance = d; }
    }
    return best && hit(best, best.snapshot.nearby);
  }

  /** Interior elements captured for a building, preferring the snapshot nearest `location`. */
  function interiors(buildingId: string, location?: Coordinates): SnapshotHit<OsmElement[]> | undefined {
    const withBuilding = load().filter((entry) => Object.hasOwn(entry.snapshot.interiors, buildingId));
    if (location) withBuilding.sort((a, b) => distanceMeters(location, a.snapshot.location) - distanceMeters(location, b.snapshot.location));
    const entry = withBuilding[0];
    return entry && hit(entry, entry.snapshot.interiors[buildingId]);
  }

  return { search, nearby, interiors, count: () => load().length };
}

export type SnapshotStore = ReturnType<typeof createSnapshotStore>;

/** Top-level fields one per line, and one candidate or OSM element per line: readable, diffable. */
export function formatSnapshot(snapshot: BuildingSnapshot): string {
  const list = (items: unknown[], indent: string) =>
    items.length ? `[\n${items.map((item) => `${indent}  ${JSON.stringify(item)}`).join(",\n")}\n${indent}]` : "[]";
  const { search, nearby, interiors, ...head } = snapshot;
  const fields = Object.entries(head).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  fields.push(`  "search": ${list(search, "  ")}`, `  "nearby": ${list(nearby, "  ")}`);
  const ids = Object.keys(interiors);
  fields.push(`  "interiors": ${ids.length
    ? `{\n${ids.map((id) => `    ${JSON.stringify(id)}: ${list(interiors[id], "    ")}`).join(",\n")}\n  }`
    : "{}"}`);
  return `{\n${fields.join(",\n")}\n}\n`;
}

/** Writes (or replaces) one snapshot file. Returns its path. */
export function writeSnapshot(dir: string, snapshot: BuildingSnapshot): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, snapshotFileName(snapshot.query));
  writeFileSync(path, formatSnapshot(snapshot));
  return path;
}
