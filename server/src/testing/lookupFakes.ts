// Fakes for the building-lookup tests: Geoapify + Overpass behind one fake fetch, a small
// synthesized two-floor building, a candidate summarizer and an occupancy estimator.
import type { Building, BuildingCandidateSummary } from "@firewatch/shared/types";
import { createApp, type AppOptions } from "../app.ts";
import { createBuildingService } from "../buildings/service.ts";
import type { BuildingCandidate, BuildingRecord, Coordinates } from "../buildings/types.ts";
import type { SynthesizedBuilding, SynthesizeOptions } from "../buildings/synthesize.ts";
import type { OccupancyEstimator } from "../agent/bridge.ts";

export const ADDRESS = "800 W Campbell Rd, Richardson, TX";
export const LOCATION = { lat: 32.0005, lon: -95.9995 };

const rectangle = (south: number, west: number, north: number, east: number) => [
  { lat: south, lon: west }, { lat: south, lon: east }, { lat: north, lon: east },
  { lat: north, lon: west }, { lat: south, lon: west },
];
/** Two outlines near LOCATION: way 100 (the point is inside it) and way 200 (just east). */
export const ELEMENTS = [
  { type: "way", id: 100, tags: { building: "office", name: "Science Hall", "building:levels": "2" }, geometry: rectangle(32, -96, 32.001, -95.999) },
  { type: "way", id: 200, tags: { building: "yes", name: "Annex" }, geometry: rectangle(32, -95.9985, 32.001, -95.998) },
];

export interface FakeWorld {
  /** Geoapify results per query (lower case); default: one match at LOCATION. */
  geocode: Map<string, unknown[]>;
  /** Overpass elements per "lat,lon"; default ELEMENTS. */
  outlines: Map<string, unknown[]>;
  /** A query (lower case) whose geocode waits for this promise. */
  gates: Map<string, Promise<void>>;
  /** Hold every Overpass response until this resolves. */
  overpassGate?: Promise<void>;
  /** Make Geoapify answer HTTP 500. */
  geoapifyDown?: boolean;
  calls: { geoapify: number; overpass: number };
}

export function fakeWorld(): FakeWorld {
  return { geocode: new Map(), outlines: new Map(), gates: new Map(), calls: { geoapify: 0, overpass: 0 } };
}

export const match = (lat = LOCATION.lat, lon = LOCATION.lon, formatted = "800 West Campbell Road, Richardson, TX 75080, United States") => ({
  formatted, lat, lon, result_type: "building", place_id: `p-${lat}-${lon}`,
  rank: { confidence: 1, match_type: "full_match" }, timezone: { name: "America/Chicago" },
});

export function fakeFetch(world: FakeWorld): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.geoapify.com") {
      world.calls.geoapify++;
      const text = (url.searchParams.get("text") ?? "").toLowerCase();
      await world.gates.get(text);
      if (world.geoapifyDown) return new Response("down", { status: 500 });
      return Response.json({ results: world.geocode.get(text) ?? [match()] });
    }
    world.calls.overpass++;
    await world.overpassGate;
    // The Overpass query names the point: "around:R,lat,lon".
    const body = String(init?.body ?? "");
    const at = /around:\d+(?:\.\d+)?,(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(body.replace(/\+/g, " ")));
    const key = at ? `${Number(at[1])},${Number(at[2])}` : "";
    return Response.json({ elements: world.outlines.get(key) ?? ELEMENTS });
  };
}

/** A small building in the demo's conventions: floors 1-2, a hall, break room, office, stair A. */
export function smallBuilding(): Building {
  const rooms = [1, 2].flatMap((f) =>
    ["hall", "break", "office", "stair-a"].map((k, i) => ({ id: `${f}-${k}`, floor: f, name: `Floor ${f} ${k}`, x: i * 6, z: 0, w: 5, d: 5 })),
  );
  const links = [1, 2].flatMap((f) =>
    ["break", "office", "stair-a"].map((k) => ({ a: `${f}-hall`, b: `${f}-${k}`, kind: "door" as const, fireRated: k !== "break", closed: k === "stair-a" })),
  );
  return { rooms, links, verticals: [{ id: "stair-a", kind: "stair", floors: [1, 2], doorsClosed: true }] };
}

export interface Fakes {
  synthCalls: { record: BuildingRecord; options?: SynthesizeOptions }[];
  synthesize(record: BuildingRecord, options?: SynthesizeOptions): SynthesizedBuilding;
  summarize(candidate: BuildingCandidate, origin: Coordinates): BuildingCandidateSummary;
  estimateOccupancy: OccupancyEstimator;
  estimateCalls: number;
}

/** Distances the fake summarizer reports (way 200 is "nearer", to check the sort). */
export const DISTANCES: Record<string, number> = { "osm:way:100": 40, "osm:way:200": 5 };

export function fakes(): Fakes {
  const f: Fakes = {
    synthCalls: [],
    estimateCalls: 0,
    synthesize(record, options) {
      f.synthCalls.push({ record, options });
      const b = smallBuilding();
      return {
        building: {
          ...b,
          profile: {
            id: record.id, name: record.name ?? "Unnamed building", address: options?.address, source: "osm", use: "office",
            floors: 2, location: record.location, timezone: options?.timezone, layoutEstimated: true, assumptions: ["test layout"],
          },
        },
        sprinklers: Object.fromEntries(b.rooms.map((r) => [r.id, "none" as const])),
        doors: b.links.map((l) => ({ a: l.a, b: l.b, ratingMinutes: l.fireRated ? 60 : 0 })),
      };
    },
    summarize(candidate) {
      return {
        id: candidate.id, name: candidate.name, address: candidate.address, floors: candidate.floorsAboveGround,
        heightMeters: candidate.heightMeters, use: null, distanceMeters: DISTANCES[candidate.id] ?? 0, outline: [[0, 0], [10, 0], [10, 10]],
      };
    },
    estimateOccupancy(building) {
      f.estimateCalls++;
      void building;
      return {
        occupants: [{ room: "1-office", count: 8, flags: [], estimated: true }, { room: "2-office", count: 12, flags: [], estimated: true }],
        total: 20,
        byFloor: { "1": 8, "2": 12 },
        localTime: "Sun 14:05",
        basis: ["office", "weekend afternoon: 15% of design occupancy"],
      };
    },
  };
  return f;
}

/** A live-mode app on fakes. */
export function fakeApp(options: Partial<AppOptions> = {}) {
  const world = fakeWorld();
  const f = fakes();
  const app = createApp({
    mock: false,
    buildings: createBuildingService({ fetch: fakeFetch(world), geoapifyApiKey: "test-key", overpassApiUrl: "https://overpass.test/api/interpreter" }),
    synthesize: f.synthesize,
    summarize: f.summarize,
    estimateOccupancy: f.estimateOccupancy,
    ...options,
  });
  return { app, world, fakes: f };
}

/** A promise and its resolve function. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
