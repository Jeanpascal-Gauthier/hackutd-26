// Crash congestion forecast. A queue grows backward from the crash along the street graph, at
// the shock-wave speed for each road class, and thins out where it splits across junctions.
import type { CongestionSegment, CrashForecast, GeoPoint, LanesBlocked } from "@firewatch/shared/types";
import { FORECAST_MINUTES, HORIZON_MINUTES, distance, localFrame, type Metres } from "./geo.ts";

export interface RoadWay {
  id: number;
  name: string | null;
  highway: string;
  /** Direction of travel relative to the order of `nodes`. */
  oneway: "forward" | "reverse" | "both";
  lanes: number | null;
  nodes: number[];
  geometry: GeoPoint[];
}

/** Assumed typical demand (vehicles/hour/lane), free-flow speed (km/h) and lanes per direction. */
const CLASSES: Record<string, { demand: number; speed: number; lanes: number }> = {
  motorway: { demand: 1500, speed: 100, lanes: 3 },
  trunk: { demand: 1200, speed: 80, lanes: 2 },
  primary: { demand: 900, speed: 60, lanes: 2 },
  secondary: { demand: 700, speed: 50, lanes: 2 },
  tertiary: { demand: 450, speed: 45, lanes: 1 },
  unclassified: { demand: 200, speed: 40, lanes: 1 },
  residential: { demand: 80, speed: 35, lanes: 1 },
};
const JAM_DENSITY = 130; // vehicles/km/lane
const MAX_SNAP = 150; // metres from the crash to the nearest road
const MIN_PRESSURE = 0.1; // a queue thinner than this has dissolved into the network
const CHUNK = 75; // metres; the longest stretch drawn as one step
const MAX_SEGMENTS = 500;
/** Assumed minute the road reopens. Illustrative: real clearance depends on the response. */
const REOPEN_MINUTES: Record<LanesBlocked, number> = { all: 30, some: 20, unknown: 20 };
const SATURATION_FLOW = 1800; // vehicles/hour/lane a queue discharges at once the road reopens
const MAX_CLEARANCE_MINUTES = 120; // constant typical demand stops being a fair guess past this
const MAX_ALTERNATES = 5;
const ALTERNATE_RADIUS = 1000; // metres from the crash, for a road that does not touch the queue
const JUNCTION_BONUS = 2; // class ranks a road gains by meeting a junction the queue reaches
/** Worst to best, for ranking alternates. */
const CLASS_RANK = ["residential", "unclassified", "tertiary", "secondary", "primary", "trunk", "motorway"];
export const ROAD_RADIUS_METERS = 1500;

const classOf = (highway: string) => CLASSES[highway.replace(/_link$/, "")] ?? CLASSES.unclassified!;
const lanesOf = (way: RoadWay) => Math.max(1, way.oneway === "both" && way.lanes ? Math.ceil(way.lanes / 2) : way.lanes ?? classOf(way.highway).lanes);
/** Backward shock-wave speed, m/min: q / (k_jam - q / v_free). */
function waveSpeed(highway: string): number {
  const { demand, speed } = classOf(highway);
  return ((demand / (JAM_DENSITY - demand / speed)) * 1000) / 60;
}

interface Edge { from: number; to: number; length: number; way: RoadWay; path: Metres[] }

function graph(ways: RoadWay[], toMetres: (p: GeoPoint) => Metres) {
  const edges: Edge[] = [];
  const inbound = new Map<number, Edge[]>();
  const add = (edge: Edge) => {
    edges.push(edge);
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge]);
  };
  for (const way of ways) {
    if (way.nodes.length !== way.geometry.length) continue;
    const points = way.geometry.map(toMetres);
    for (let i = 1; i < points.length; i++) {
      const a = way.nodes[i - 1]!, b = way.nodes[i]!;
      const pa = points[i - 1]!, pb = points[i]!;
      const length = distance(pa, pb);
      if (way.oneway !== "reverse") add({ from: a, to: b, length, way, path: [pa, pb] });
      if (way.oneway !== "forward") add({ from: b, to: a, length, way, path: [pb, pa] });
    }
  }
  return { edges, inbound };
}

function project(p: Metres, a: Metres, b: Metres): Metres {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / span));
  return [a[0] + t * dx, a[1] + t * dy];
}

function nearestEdge(edges: Edge[]) {
  let best: { edge: Edge; at: Metres; off: number } | undefined;
  for (const edge of edges) {
    const at = project([0, 0], edge.path[0]!, edge.path[1]!);
    const off = distance(at, [0, 0]);
    if (!best || off < best.off) best = { edge, at, off };
  }
  return best;
}

const startPressureOf = (lanes: LanesBlocked) => (lanes === "all" ? 1 : 0.6);

/** Point queue at the crash: vehicles held until the reopening, then discharged against continuing demand. */
function clearanceOf(way: RoadWay, lanes: LanesBlocked): NonNullable<CrashForecast["clearance"]> {
  const reopenMinute = REOPEN_MINUTES[lanes];
  const { demand } = classOf(way.highway);
  const queued = (demand / 60) * reopenMinute * startPressureOf(lanes);
  const discharge = (SATURATION_FLOW - demand) / 60;
  const cleared = discharge > 0 ? Math.round(reopenMinute + queued / discharge) : Infinity;
  return { reopenMinute, clearedMinute: cleared <= MAX_CLEARANCE_MINUTES ? cleared : null };
}

/** Named roads the queue does not use, best first. `queueNodes` are the junctions the queue reaches. */
function alternatesOf(ways: RoadWay[], toMetres: (p: GeoPoint) => Metres, queueNodes: Set<number>, queuedNames: Set<string>): string[] {
  const best = new Map<string, { score: number; connected: boolean; off: number }>();
  for (const way of ways) {
    // Ramps are not through routes, and a way the graph skipped has unreliable node positions.
    if (!way.name || queuedNames.has(way.name) || way.highway.endsWith("_link") || way.nodes.length !== way.geometry.length) continue;
    const points = way.geometry.map(toMetres);
    const off = Math.min(...points.slice(1).map((p, i) => distance(project([0, 0], points[i]!, p), [0, 0])));
    const connected = way.nodes.some((node) => queueNodes.has(node));
    if (!connected && (way.highway === "residential" || off > ALTERNATE_RADIUS)) continue;
    const score = Math.max(0, CLASS_RANK.indexOf(way.highway)) + (connected ? JUNCTION_BONUS : 0);
    const known = best.get(way.name);
    if (!known || score > known.score || (score === known.score && off < known.off)) best.set(way.name, { score, connected, off });
  }
  return [...best.entries()]
    .sort(([, a], [, b]) => b.score - a.score || Number(b.connected) - Number(a.connected) || a.off - b.off)
    .slice(0, MAX_ALTERNATES)
    .map(([name]) => name);
}

function assumptions(lanes: LanesBlocked): string[] {
  const reopen = REOPEN_MINUTES[lanes];
  return [
    "Illustrative queue model, not live traffic. Compare it with the map's live traffic layer.",
    "Traffic demand is a typical value per road class. Time of day and local counts are not used.",
    lanes === "all" ? "All lanes are treated as blocked." : "Part of the road is treated as blocked, because the caller did not say all lanes were.",
    "Both directions of a two-way road are treated as affected. Drivers diverting around the crash are not modeled.",
    `Roads come from OpenStreetMap data within about ${ROAD_RADIUS_METERS / 1000} km of the crash and may leave out minor streets, so a queue stops at that edge.`,
    `Clearance assumes the road reopens at minute ${reopen}, which is a planning assumption and not a report from the scene. The queue then discharges at about ${SATURATION_FLOW} vehicles per hour per lane while typical demand keeps arriving.`,
    ...(reopen < HORIZON_MINUTES ? [`Queue lengths shown up to 30 minutes do not shrink after the assumed reopening at minute ${reopen}.`] : []),
    "Alternate roads come from the map's road network and do not account for their live traffic.",
  ];
}

export function forecastCrash(origin: GeoPoint, ways: RoadWay[], lanesBlocked: LanesBlocked): CrashForecast {
  const frame = localFrame(origin);
  const { edges, inbound } = graph(ways, frame.toMetres);

  // A street address geocodes onto a building, where the closest line is often an unnamed driveway.
  const named = nearestEdge(edges.filter((e) => e.way.name !== null));
  const crash = named && named.off <= MAX_SNAP ? named : nearestEdge(edges);
  if (!crash || crash.off > MAX_SNAP)
    return { road: null, segments: [], steps: FORECAST_MINUTES.map((minute) => ({ minute, queueMeters: 0, roads: [] })), alternateRoads: [], summary: "No mapped road near this location, so congestion is not forecast.", assumptions: assumptions(lanesBlocked) };

  const startPressure = startPressureOf(lanesBlocked);
  const segments: (CongestionSegment & { length: number })[] = [];
  const levelOf = (pressure: number, crashRoad: boolean): CongestionSegment["level"] =>
    crashRoad && lanesBlocked === "all" ? "blocked" : pressure >= 0.45 ? "heavy" : "moderate";

  /** Records `head` -> `tail` in short steps. Returns the minute the queue reaches `tail`. */
  function emit(head: Metres, tail: Metres, way: RoadWay, startMinute: number, pressure: number, crashRoad: boolean): number {
    const length = distance(head, tail);
    const pieces = Math.max(1, Math.ceil(length / CHUNK));
    const pace = waveSpeed(way.highway) * pressure;
    const at = (i: number): Metres => [head[0] + ((tail[0] - head[0]) * i) / pieces, head[1] + ((tail[1] - head[1]) * i) / pieces];
    for (let i = 0; i < pieces; i++) {
      const minute = startMinute + ((length / pieces) * (i + 1)) / pace;
      if (minute > HORIZON_MINUTES) break;
      segments.push({ path: [at(i), at(i + 1)].map(frame.toPoint), road: way.name, queueMinute: Math.round(minute * 10) / 10, level: levelOf(pressure, crashRoad), length: length / pieces });
    }
    return startMinute + length / pace;
  }

  // Earliest-arrival search outward from the crash, against the direction of travel.
  interface Front { node: number; came: number; minute: number; pressure: number; way: RoadWay }
  const open: Front[] = [];
  const crashWay = crash.edge.way;
  const onCrashRoad = (way: RoadWay) => way === crashWay || (way.name !== null && way.name === crashWay.name);
  const { edge: hit, at: crashAt } = crash;
  const seen = new Set<number>();
  // At a junction every approach backs up. Mid-road, both directions of that stretch, where allowed.
  const junction = distance(crashAt, hit.path[1]!) < 1 ? hit.to : distance(crashAt, hit.path[0]!) < 1 ? hit.from : undefined;
  if (junction !== undefined) seen.add(junction);
  const seeds = junction !== undefined
    ? inbound.get(junction) ?? []
    : edges.filter((e) => (e.from === hit.from && e.to === hit.to) || (e.from === hit.to && e.to === hit.from));
  for (const seed of seeds) {
    const minute = emit(crashAt, seed.path[0]!, seed.way, 0, startPressure, onCrashRoad(seed.way));
    open.push({ node: seed.from, came: seed.to, minute, pressure: startPressure, way: seed.way });
  }

  while (open.length) {
    open.sort((a, b) => a.minute - b.minute);
    const front = open.shift()!;
    if (front.minute > HORIZON_MINUTES) break;
    if (seen.has(front.node)) continue;
    seen.add(front.node);
    const approaches = (inbound.get(front.node) ?? []).filter((e) => e.from !== front.came);
    const weight = (e: Edge) => lanesOf(e.way) * classOf(e.way.highway).demand * (e.way.name && e.way.name === front.way.name ? 2 : 1);
    const total = approaches.reduce((sum, e) => sum + weight(e), 0);
    for (const edge of approaches) {
      const pressure = (front.pressure * weight(edge)) / total;
      if (pressure < MIN_PRESSURE || seen.has(edge.from)) continue;
      const minute = emit(edge.path[1]!, edge.path[0]!, edge.way, front.minute, pressure, onCrashRoad(edge.way));
      open.push({ node: edge.from, came: front.node, minute, pressure, way: edge.way });
    }
  }

  segments.sort((a, b) => a.queueMinute - b.queueMinute);
  const kept = segments.slice(0, MAX_SEGMENTS);
  const steps = FORECAST_MINUTES.map((minute) => {
    const reached = kept.filter((s) => s.queueMinute <= minute);
    return { minute, queueMeters: Math.round(reached.reduce((sum, s) => sum + s.length, 0)), roads: [...new Set(reached.flatMap((s) => s.road ?? []))] };
  });
  const last = steps[steps.length - 1]!;
  const ten = steps.find((s) => s.minute === 10)!;
  const place = crashWay.name ?? "The road";
  const others = last.roads.filter((road) => road !== crashWay.name);
  const clearance = clearanceOf(crashWay, lanesBlocked);
  const queuedNames = new Set(segments.flatMap((s) => s.road ?? []));
  if (crashWay.name) queuedNames.add(crashWay.name);
  const clears = clearance.clearedMinute === null
    ? `If the road reopens around minute ${clearance.reopenMinute}, the queue may take more than ${MAX_CLEARANCE_MINUTES / 60} hours from the start to clear.`
    : `If the road reopens around minute ${clearance.reopenMinute}, the queue could clear by about minute ${clearance.clearedMinute}.`;
  return {
    road: crashWay.name,
    segments: kept.map(({ length: _length, ...segment }) => segment),
    steps,
    clearance,
    alternateRoads: alternatesOf(ways, frame.toMetres, seen, queuedNames),
    summary: `${place} is ${lanesBlocked === "all" ? "blocked" : "partly blocked"}. Queues total about ${(ten.queueMeters / 1000).toFixed(1)} km by 10 minutes and ${(last.queueMeters / 1000).toFixed(1)} km by 30 minutes${others.length ? `, reaching ${others.slice(0, 4).join(", ")}` : ""}. ${clears}`,
    assumptions: assumptions(lanesBlocked),
  };
}
