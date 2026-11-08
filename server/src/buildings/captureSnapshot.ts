// Saves offline copies of live building lookups to server/snapshots/ (see snapshots.ts).
//
//   npm run snapshot -w server -- "800 W Campbell Rd, Richardson, TX"
//   npm run snapshot -w server -- "<address>" --building osm:way:123 --alias "UTD ECSW" "<another address>"
//
// Per address: one Geoapify search, one Overpass outline query around the top match, and one
// Overpass interior query per captured building (the nearest outline, or each --building given
// after that address). Requests run one at a time with a pause between them, to be gentle with the
// public Overpass instance. Loads GEOAPIFY_API_KEY from the root .env; the key is never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { searchAddresses } from "./geoapify.ts";
import { buildingInteriors, DEFAULT_OVERPASS_URL, nearbyBuildings } from "./overpass.ts";
import { getBuildingBounds, listOsmBuildingCandidates, normalizeOsmBuilding, osmId } from "./normalize.ts";
import { summarizeCandidate } from "./synthesize.ts";
import { BuildingApiError } from "./provider.ts";
import type { OsmElement } from "./types.ts";
import {
  DEFAULT_SNAPSHOT_DIR, parseSnapshot, SNAPSHOT_MATCH_METERS, SNAPSHOT_VERSION, snapshotFileName, writeSnapshot,
  type BuildingSnapshot,
} from "./snapshots.ts";

const USAGE = `Usage: npm run snapshot -w server -- "<address>" [--building osm:way:N]... [--alias "<text>"]... ["<address>" ...] [--dir <folder>]
  --building  capture this candidate (instead of the nearest outline) for the address before it; repeatable
  --alias     another spelling that should find the address before it, e.g. what a caller would say
  --dir       snapshot folder (default server/snapshots/, or BUILDINGS_SNAPSHOT_DIR)`;

interface Job { query: string; buildings: string[]; aliases: string[] }

function parseArgs(argv: string[]): { jobs: Job[]; dir: string } {
  const jobs: Job[] = [];
  let dir = process.env.BUILDINGS_SNAPSHOT_DIR || DEFAULT_SNAPSHOT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { console.log(USAGE); process.exit(0); }
    if (arg === "--building" || arg === "--alias" || arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--dir") { dir = value; continue; }
      const job = jobs.at(-1);
      if (!job) throw new Error(`${arg} must follow an address`);
      if (arg === "--building") {
        if (!/^osm:(way|relation):[1-9]\d{0,15}$/.test(value)) throw new Error(`--building must look like osm:way:123, not "${value}"`);
        job.buildings.push(value);
      } else job.aliases.push(value);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    jobs.push({ query: arg.trim().replace(/\s+/g, " "), buildings: [], aliases: [] });
  }
  if (!jobs.length) throw new Error("give at least one address");
  return { jobs, dir };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const apiKey = process.env.GEOAPIFY_API_KEY;
const overpassUrl = process.env.OVERPASS_API_URL || DEFAULT_OVERPASS_URL;
/** Error text without the API key, whatever produced it. */
const safe = (error: unknown) => {
  const text = error instanceof BuildingApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : String(error);
  return apiKey?.trim() ? text.split(apiKey.trim()).join("***") : text;
};
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), b.lat - a.lat) * 111195;

/** The existing file for this query, when it is a valid snapshot (keeps its aliases and other interiors). */
function previous(dir: string, query: string): BuildingSnapshot | undefined {
  const path = join(dir, snapshotFileName(query));
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseSnapshot(JSON.parse(readFileSync(path, "utf8")));
    return typeof parsed === "string" ? undefined : parsed;
  } catch { return undefined; }
}

async function capture(job: Job, dir: string): Promise<void> {
  const savedAt = new Date().toISOString();
  console.log(`\n${job.query}`);
  const search = await searchAddresses(job.query, apiKey, { timeoutMs: 20000 });
  const top = search[0];
  if (!top) throw new Error("Geoapify found no match for this address");
  console.log(`  match: ${top.address} (${top.location.lat}, ${top.location.lon}), ${top.resultType ?? "?"}, confidence ${top.confidence ?? "?"}`);

  await pause(1000);
  const nearby = await nearbyBuildings(top.location, overpassUrl, { timeoutMs: 30000 });
  const candidates = listOsmBuildingCandidates(nearby, top.location, savedAt)
    .map((candidate) => ({ candidate, distance: summarizeCandidate(candidate, top.location).distanceMeters }))
    .sort((a, b) => a.distance - b.distance);
  console.log(`  ${candidates.length} outline${candidates.length === 1 ? "" : "s"} nearby:`);
  for (const { candidate, distance } of candidates.slice(0, 8))
    console.log(`    ${candidate.id.padEnd(22)} ${String(Math.round(distance)).padStart(4)} m  ${candidate.name ?? candidate.address ?? "(unnamed)"}`);

  const unknown = job.buildings.filter((id) => !candidates.some(({ candidate }) => candidate.id === id));
  if (unknown.length) throw new Error(`not among this address's outlines: ${unknown.join(", ")}`);
  const chosen = job.buildings.length ? job.buildings : candidates.slice(0, 1).map(({ candidate }) => candidate.id);

  const old = previous(dir, job.query);
  const sameSpot = old && metres(old.location, top.location) <= SNAPSHOT_MATCH_METERS;
  const interiors: Record<string, OsmElement[]> = sameSpot ? { ...old.interiors } : {};
  let complete = true;
  for (const id of chosen) {
    const raw = nearby.find((element) => osmId(element) === id)!;
    const bounds = getBuildingBounds(raw, nearby);
    let inside: OsmElement[] = [];
    if (bounds) {
      await pause(1500);
      try {
        inside = await buildingInteriors(bounds, overpassUrl, { timeoutMs: 30000 });
      } catch (error) {
        complete = false;
        console.warn(`  ! interiors of ${id} unavailable: ${safe(error)}. Saved without them; run again later to add them.`);
        continue;
      }
    }
    interiors[id] = inside;
    const merged = new Map(nearby.map((element) => [osmId(element), element]));
    for (const element of inside) merged.set(osmId(element), element);
    const record = normalizeOsmBuilding(id, [...merged.values()], top.location, savedAt);
    if (!record) throw new Error(`${id} could not be normalized into a building record`);
    console.log(`  captured ${id}: ${record.name ?? "(unnamed)"}, ${record.floorsAboveGround ?? "?"} floors, ` +
      `${record.rooms.length} mapped rooms, ${record.connections.length} doors/stairs, ${inside.length} interior elements`);
  }

  const aliases = [...new Set([...(sameSpot ? old.aliases ?? [] : []), ...job.aliases])];
  const snapshot: BuildingSnapshot = {
    version: SNAPSHOT_VERSION, savedAt, query: job.query, ...(aliases.length && { aliases }),
    note: `Captured with npm run snapshot. Buildings with interiors: ${Object.keys(interiors).join(", ") || "none"}.`,
    location: top.location, search, nearby, interiors,
  };
  const path = writeSnapshot(dir, snapshot);
  console.log(`  saved ${path}${complete ? "" : " (incomplete)"}`);
}

async function main() {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(`snapshot: ${safe(error)}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!apiKey?.trim()) console.warn("GEOAPIFY_API_KEY is not set (root .env): address search will fail.");
  let failed = 0;
  for (const [i, job] of parsed.jobs.entries()) {
    if (i) await pause(3000);
    try { await capture(job, parsed.dir); } catch (error) {
      failed++;
      console.error(`  x ${job.query}: ${safe(error)}`);
    }
  }
  console.log(`\n${parsed.jobs.length - failed}/${parsed.jobs.length} address${parsed.jobs.length === 1 ? "" : "es"} saved.`);
  if (failed) process.exitCode = 1;
}

await main();
