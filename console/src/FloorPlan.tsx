import { lazy, Suspense, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import building from "@firewatch/shared/building.json";
import type { IncidentState } from "@firewatch/shared/types";
import { hasHeat, heatSources, type HeatRect } from "./heat/sources";

// WebGL heat layer (three.js) loads in its own chunk, only once a floor has fire or smoke.
const HeatOverlay = lazy(() => import("./heat/HeatOverlay"));

interface FloorPlanProps {
  floor: number;
  state: IncidentState | null;
  selectedRoom: string | null;
  onSelect: (id: string) => void;
  /** Set (to the acceptance time) while the route should draw itself on once; null otherwise. */
  drawRoute?: number | null;
}

/** On-screen text sizes (CSS px). SVG font sizes are derived from the measured map scale so text never renders smaller. */
const LABEL_PX = 12;
const READING_PX = 12;
const LINE_GAP_PX = 4;
const PAD_PX = 6;
/** Rough average glyph width as a fraction of the font size (slightly generous so text never clips). */
const CHAR_EM = 0.6;
/** Labels are upper-case, letter-spaced drafting lettering, so they run wider. */
const LABEL_EM = 0.76;

/** Drawing conventions, in metres (building.json units). */
const EXTERIOR_WALL = 0.3;
const INTERIOR_WALL = 0.14;
const DOOR_WIDTH = 0.9;
const TREAD = 0.3;
/** Rooms smaller than this (stairs, lifts) don't define structural grid lines. */
const CORE_AREA = 12;
/** Margin (SVG units) around the building for grid bubbles and dimension strings. */
const MARGIN = { top: 34, left: 34, right: 40, bottom: 44 };

type Room = (typeof building.rooms)[number];
type Line = { orient: "h" | "v"; at: number; lo: number; hi: number };
type Opening = Line & { into: Room; kind: "swing" | "slide" };

/**
 * Rooms on this floor that are part of an evacuation route (hall + clear stairwell), mapped to their
 * draw order: rank of the earliest position they take in any exit.route (hall first, then stair).
 */
function routeRooms(state: IncidentState | null, floor: number): Map<string, number> {
  const position = new Map<string, number>();
  for (const exit of state?.exits ?? []) (exit.route ?? []).forEach((id, index) => {
    if (id.startsWith(`${floor}-`)) position.set(id, Math.min(index, position.get(id) ?? Infinity));
  });
  const ranks = [...new Set(position.values())].sort((a, b) => a - b);
  return new Map([...position].map(([id, index]) => [id, ranks.indexOf(index)]));
}

const shortName = (label: string) => label.replace(/^Stairwell /, "Stair ").replace(/ (Office|Room)$/, "").replace(/^Conference$/, "Conf.").replace(/^Elevator$/, "Elev.");

/** Room fill: a mix of the empty-room colour toward fire or smoke by intensity, so both themes work. */
function roomFill(fire: number, smoke: number) {
  if (fire > 0.01) return `color-mix(in oklab, var(--fire) ${Math.round(22 + fire * 40)}%, var(--room-empty))`;
  if (smoke > 0.01) return `color-mix(in oklab, var(--smoke) ${Math.round(14 + smoke * 40)}%, var(--room-empty))`;
  return "var(--room-empty)";
}

const EPS = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

/** The four edges of a room, each with the rooms on its far side that touch it. */
function edges(room: Room, rooms: Room[]) {
  const right = room.x + room.w, bottom = room.z + room.d;
  return [
    { side: "top", line: { orient: "h", at: room.z, lo: room.x, hi: right }, across: rooms.filter((o) => same(o.z + o.d, room.z)) },
    { side: "bottom", line: { orient: "h", at: bottom, lo: room.x, hi: right }, across: rooms.filter((o) => same(o.z, bottom)) },
    { side: "left", line: { orient: "v", at: room.x, lo: room.z, hi: bottom }, across: rooms.filter((o) => same(o.x + o.w, room.x)) },
    { side: "right", line: { orient: "v", at: right, lo: room.z, hi: bottom }, across: rooms.filter((o) => same(o.x, right)) },
  ] as const satisfies readonly { side: string; line: Line; across: Room[] }[];
}

/** Span of a neighbour along an edge's direction. */
const span = (line: Line, other: Room): [number, number] => line.orient === "h" ? [other.x, other.x + other.w] : [other.z, other.z + other.d];

/** [lo, hi] minus a set of intervals. */
function subtract(lo: number, hi: number, cuts: [number, number][]): [number, number][] {
  let pieces: [number, number][] = [[lo, hi]];
  for (const [a, b] of cuts) pieces = pieces.flatMap(([p, q]) => b <= p || a >= q ? [[p, q]] : [[p, Math.min(a, q)], [Math.max(b, p), q]].filter(([s, e]) => e - s > EPS) as [number, number][]);
  return pieces;
}

/** [lo, hi] intersected with a set of intervals. */
function intersect(lo: number, hi: number, spans: [number, number][]): [number, number][] {
  return spans.map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)] as [number, number]).filter(([a, b]) => b - a > EPS);
}

/**
 * Wall centre-lines for one floor, split into exterior (no room across) and interior pieces, with door
 * openings cut out. Interior walls come only from bottom/right edges so shared walls are drawn once.
 */
function floorWalls(rooms: Room[], floor: number) {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const openings: Opening[] = [];
  for (const link of building.links) {
    if (link.kind !== "door") continue;
    const a = byId.get(link.a), b = byId.get(link.b);
    if (!a || !b || a.floor !== floor) continue;
    const shared = edges(a, rooms).find((edge) => edge.across.includes(b));
    if (!shared) continue;
    const [lo, hi] = intersect(shared.line.lo, shared.line.hi, [span(shared.line, b)])[0] ?? [];
    if (lo === undefined || hi === undefined) continue;
    const width = Math.min(DOOR_WIDTH, (hi - lo) * 0.6);
    // Doors into wide rooms sit near a corner, as drawn on real plans; narrow cores get a centred door.
    const start = hi - lo > 3 ? lo + 0.45 : (lo + hi - width) / 2;
    openings.push({ ...shared.line, lo: start, hi: start + width, into: b, kind: /elev/.test(b.id) ? "slide" : "swing" });
  }
  const cut = (line: Line, pieces: [number, number][], thickness: number) => pieces.flatMap(([lo, hi]) =>
    // Openings are widened by half a wall so square line caps land exactly on the jambs.
    subtract(lo, hi, openings.filter((o) => o.orient === line.orient && same(o.at, line.at)).map((o) => [o.lo - thickness / 2, o.hi + thickness / 2])),
  ).map(([lo, hi]) => ({ ...line, lo, hi }));

  const exterior: Line[] = [];
  const interior: Line[] = [];
  for (const room of rooms) for (const { side, line, across } of edges(room, rooms)) {
    const covered = across.map((other) => span(line, other));
    exterior.push(...cut(line, subtract(line.lo, line.hi, covered), EXTERIOR_WALL));
    if (side === "bottom" || side === "right") interior.push(...cut(line, intersect(line.lo, line.hi, covered), INTERIOR_WALL));
  }
  return { exterior, interior, openings };
}

/** Structural grid: distinct edge coordinates of the main (non-core) rooms. */
function gridLines(rooms: Room[]) {
  const main = rooms.filter((room) => room.w * room.d >= CORE_AREA);
  const unique = (values: number[]) => [...new Set(values.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  return { xs: unique(main.flatMap((room) => [room.x, room.x + room.w])), zs: unique(main.flatMap((room) => [room.z, room.z + room.d])) };
}

const metres = (value: number) => `${value.toFixed(value % 1 ? 1 : 0)} m`;

export function FloorPlan({ floor, state, selectedRoom, onSelect, drawRoute = null }: FloorPlanProps) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const rooms = building.rooms.filter((room) => room.floor === floor);
  const minX = Math.min(...rooms.map((room) => room.x));
  const minZ = Math.min(...rooms.map((room) => room.z));
  const maxX = Math.max(...rooms.map((room) => room.x + room.w));
  const maxZ = Math.max(...rooms.map((room) => room.z + room.d));
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const scale = Math.min(640 / Math.max(width, 1), 360 / Math.max(depth, 1));
  const viewW = width * scale + MARGIN.left + MARGIN.right;
  const viewH = depth * scale + MARGIN.top + MARGIN.bottom;
  // Rendered CSS px per SVG unit. Text sizes divide by this so labels stay legible at any width.
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const box = svg.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setK(Math.min(box.width / viewW, box.height / viewH));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [viewW, viewH]);

  if (!rooms.length) return <p className="empty-state">No geometry available for this floor.</p>;
  const route = routeRooms(state, floor);
  const routeActive = !!state?.accepted;
  const drawing = routeActive && drawRoute !== null;
  const origin = state?.origin;
  const originRoom = origin ? rooms.find((room) => room.id === origin.roomId) : undefined;
  const labelSize = LABEL_PX / k;
  const readingSize = READING_PX / k;
  const gap = LINE_GAP_PX / k;
  const inset = PAD_PX / k;

  const px = (x: number) => MARGIN.left + (x - minX) * scale;
  const py = (z: number) => MARGIN.top + (z - minZ) * scale;
  const { exterior, interior, openings } = floorWalls(rooms, floor);
  const grid = gridLines(rooms);
  // Annotation text is decorative: fixed to the margin so the viewBox never depends on the measured scale.
  const annot = Math.min(11, Math.max(8, 9.5 / k));
  const bubble = Math.min(10, Math.max(7.5, 8 / k));
  const toSeg = (line: Line) => line.orient === "h"
    ? { x1: px(line.lo), y1: py(line.at), x2: px(line.hi), y2: py(line.at) }
    : { x1: px(line.at), y1: py(line.lo), x2: px(line.at), y2: py(line.hi) };
  const dimY = py(maxZ) + 16;
  const dimX = px(maxX) + 16;

  // Per-room geometry, state and label layout, shared by the stacked layers below.
  const layout = rooms.map((room) => {
    const current = state?.rooms.find((value) => value.roomId === room.id);
    const fire = Math.min(1, Math.max(0, current?.fire ?? 0));
    const smoke = Math.min(1, Math.max(0, current?.smoke ?? 0));
    const selected = selectedRoom === room.id;
    const stroke = selected ? "var(--accent)" : "transparent";
    const count = state?.occupants.filter((item) => item.room === room.id).reduce((sum, item) => sum + item.count, 0) ?? 0;
    const x = px(room.x);
    const y = py(room.z);
    const w = room.w * scale;
    const d = room.d * scale;
    // Retain forecast/acceptance animation, without marking hazardous or unknown segments green.
    const onRoute = route.has(room.id) && current !== undefined && fire <= 0.01 && smoke < 0.3;
    const isOrigin = origin?.roomId === room.id;
    const isStair = /stair/.test(room.id);
    const isLift = /elev/.test(room.id);
    const label = room.name.replace(/^Floor \d+ /, "");
    const status = current ? `fire ${Math.round(fire * 100)} percent, smoke ${Math.round(smoke * 100)} percent` : "awaiting incident data";
    const wallInset = (INTERIOR_WALL * scale) / 2 + 1.5;

    // Text layout: stack label + readings if they fit, else one joined line, else label only, else nothing.
    const readings = [fire > 0.01 && `Fire ${Math.round(fire * 100)}%`, smoke > 0.01 && `Smoke ${Math.round(smoke * 100)}%`].filter(Boolean) as string[];
    if (count > 0) readings.push(`${count} people`);
    const innerW = w - inset * 2 - 4;
    const innerH = d - inset * 2 - 4;
    const fits = (text: string, size: number, em = CHAR_EM) => text.length * em * size <= innerW;
    const name = fits(label, labelSize, LABEL_EM) ? label : fits(shortName(label), labelSize, LABEL_EM) ? shortName(label) : null;
    let lines: { text: string; size: number; cls: string }[] = [];
    if (name) {
      const stacked = [{ text: name.toUpperCase(), size: labelSize, cls: "room-label" }];
      for (const text of readings) if (fits(text, readingSize)) stacked.push({ text, size: readingSize, cls: text.endsWith("people") ? "room-occupants" : "room-reading" });
      const stackH = (n: number) => stacked.slice(0, n).reduce((sum, line) => sum + line.size, 0) + gap * (n - 1);
      let n = stacked.length;
      while (n > 1 && stackH(n) > innerH) n--;
      lines = stacked.slice(0, n);
      const hazard = readings.filter((text) => !text.endsWith("people")).join(" · ");
      if (lines.length === 1 && hazard && innerH >= labelSize && fits(`${name} · ${hazard}`, labelSize, LABEL_EM)) lines = [{ text: `${name.toUpperCase()} · ${hazard}`, size: labelSize, cls: "room-label" }];
      if (lines.length === 1 && innerH < labelSize) lines = [];
    }
    const totalH = lines.reduce((sum, line) => sum + line.size, 0) + gap * Math.max(0, lines.length - 1);
    let cursor = y + d / 2 - totalH / 2;
    const placed = lines.map((line) => { const top = cursor; cursor += line.size + gap; return { ...line, y: top + line.size * 0.8 }; });

    // Stair treads run across the flight's short side; the arrow points up the flight.
    const along = w >= d ? "x" : "z";
    const flight = along === "x" ? w : d;
    const treads = Array.from({ length: Math.max(0, Math.floor((flight - 2 * wallInset) / (TREAD * scale))) }, (_, i) => wallInset + (i + 0.5) * TREAD * scale);
    return { room, current, fire, smoke, selected, stroke, count, x, y, w, d, onRoute, isOrigin, isStair, isLift, status, wallInset, placed, along, treads };
  });
  const heat = heatSources(rooms, state);
  const heatBounds: HeatRect = [minX - MARGIN.left / scale, minZ - MARGIN.top / scale, maxX + MARGIN.right / scale, maxZ + MARGIN.bottom / scale];

  return <div className="floor-plan">
    <p className="map-caption"><span>Floor {floor} plan · select a room to inspect</span>{originRoom && origin && <span>Likely origin: <strong>{originRoom.name.replace(/^Floor \d+ /, "")}</strong> ({Math.round(origin.confidence * 100)}%)</span>}</p>
    <svg ref={svgRef} className="map blueprint" viewBox={`0 0 ${viewW} ${viewH}`} role="group" aria-label={`Floor ${floor} interactive room map`}>
      <defs>
        <pattern id={`${uid}-minor`} width={scale} height={scale} x={MARGIN.left} y={MARGIN.top} patternUnits="userSpaceOnUse">
          <path d={`M ${scale} 0 H 0 V ${scale}`} className="bp-grid-minor" />
        </pattern>
        <pattern id={`${uid}-major`} width={scale * 5} height={scale * 5} x={MARGIN.left} y={MARGIN.top} patternUnits="userSpaceOnUse">
          <rect width={scale * 5} height={scale * 5} fill={`url(#${uid}-minor)`} />
          <path d={`M ${scale * 5} 0 H 0 V ${scale * 5}`} className="bp-grid-major" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${uid}-major)`} />

      {/* Structural grid: dash-dot centre lines with lettered/numbered bubbles, as on a GA plan. */}
      <g className="bp-annotation" aria-hidden="true">
        {grid.xs.map((x, index) => <g key={`gx${x}`}>
          <line className="bp-gridline" x1={px(x)} y1={bubble * 2 + 4} x2={px(x)} y2={py(maxZ) + 4} />
          <circle className="bp-bubble" cx={px(x)} cy={bubble + 3} r={bubble} />
          <text className="bp-bubble-text" x={px(x)} y={bubble + 3} fontSize={bubble * 1.05}>{index + 1}</text>
        </g>)}
        {grid.zs.map((z, index) => <g key={`gz${z}`}>
          <line className="bp-gridline" x1={bubble * 2 + 4} y1={py(z)} x2={px(maxX) + 4} y2={py(z)} />
          <circle className="bp-bubble" cx={bubble + 3} cy={py(z)} r={bubble} />
          <text className="bp-bubble-text" x={bubble + 3} y={py(z)} fontSize={bubble * 1.05}>{String.fromCharCode(65 + index)}</text>
        </g>)}
      </g>

      {layout.map(({ room, current, fire, smoke, selected, stroke, count, x, y, w, d, onRoute, isOrigin, isStair, isLift, status, wallInset, along, treads }) =>
        <g key={room.id} role="button" tabIndex={0} data-room-id={room.id} data-origin={isOrigin || undefined} data-route={onRoute && routeActive || undefined} aria-pressed={selected} aria-label={`${room.name}, ${status}, ${count} recorded occupants${isOrigin ? ", suspected fire origin" : ""}${onRoute ? routeActive ? ", accepted route segment" : ", forecast route segment" : ""}`} className={`map-room ${selected ? "is-selected" : ""}`} onClick={() => onSelect(room.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(room.id); } }}>
          <title>{room.name} · {room.id}{current ? ` · fire ${Math.round(fire * 100)}% · smoke ${Math.round(smoke * 100)}%` : " · No incident data"}{count ? ` · ${count} people` : ""}{onRoute ? " · evacuation route" : ""}</title>
          {/* Fill and stroke as styles so scrubbing the timeline cross-fades them; :hover / :focus-visible override the stroke. Walls are drawn over this separately. */}
          <rect className="room-shape" x={x + wallInset} y={y + wallInset} width={Math.max(1, w - wallInset * 2)} height={Math.max(1, d - wallInset * 2)} strokeWidth={selected ? 2.5 : 1} style={{ fill: roomFill(fire, smoke), stroke }} />
          {isStair && <g className="bp-fixture" aria-hidden="true">
            {treads.map((t) => along === "x"
              ? <line key={t} x1={x + t} y1={y + wallInset} x2={x + t} y2={y + d - wallInset} />
              : <line key={t} x1={x + wallInset} y1={y + t} x2={x + w - wallInset} y2={y + t} />)}
            {along === "x"
              // Kept off-centre so it doesn't run through the room label.
              ? <path className="bp-flight" d={`M ${x + wallInset + 3} ${y + d * 0.8} H ${x + w - wallInset - 6} m -4 -3 l 4 3 l -4 3`} />
              : <path className="bp-flight" d={`M ${x + w * 0.8} ${y + d - wallInset - 3} V ${y + wallInset + 6} m -3 4 l 3 -4 l 3 4`} />}
          </g>}
          {isLift && <g className="bp-fixture" aria-hidden="true">
            <rect x={x + wallInset + 3} y={y + wallInset + 3} width={Math.max(1, w - wallInset * 2 - 6)} height={Math.max(1, d - wallInset * 2 - 6)} />
            <path d={`M ${x + wallInset + 3} ${y + wallInset + 3} L ${x + w - wallInset - 3} ${y + d - wallInset - 3} M ${x + w - wallInset - 3} ${y + wallInset + 3} L ${x + wallInset + 3} ${y + d - wallInset - 3}`} />
          </g>}
        </g>)}

      {/* Radar-style heat field, floating over the rooms; pointer events pass through to them. */}
      {hasHeat(heat) && <foreignObject x={0} y={0} width={viewW} height={viewH} pointerEvents="none" aria-hidden="true">
        <Suspense fallback={null}><HeatOverlay sources={heat} bounds={heatBounds} clip={[minX, minZ, maxX, maxZ]} width={viewW * k} height={viewH * k} /></Suspense>
      </foreignObject>}

      {/* Walls (solid poché, heavier on the envelope) and doors with swing arcs, drawn over the rooms. */}
      <g className="bp-walls" aria-hidden="true">
        {interior.map((line, index) => <line key={`i${index}`} className="bp-wall" {...toSeg(line)} strokeWidth={INTERIOR_WALL * scale} />)}
        {exterior.map((line, index) => <line key={`e${index}`} className="bp-wall" {...toSeg(line)} strokeWidth={EXTERIOR_WALL * scale} />)}
        {openings.map((door, index) => {
          const into = door.into;
          // Unit normal pointing into the room the door opens into.
          const sign = door.orient === "h" ? (into.z + into.d / 2 > door.at ? 1 : -1) : (into.x + into.w / 2 > door.at ? 1 : -1);
          const size = (door.hi - door.lo) * scale;
          const hinge = door.orient === "h" ? { x: px(door.lo), y: py(door.at) } : { x: px(door.at), y: py(door.lo) };
          const jamb = door.orient === "h" ? { x: px(door.hi), y: py(door.at) } : { x: px(door.at), y: py(door.hi) };
          const tip = door.orient === "h" ? { x: hinge.x, y: hinge.y + sign * size } : { x: hinge.x + sign * size, y: hinge.y };
          if (door.kind === "slide") {
            const off = 2 * sign;
            return door.orient === "h"
              ? <g key={`d${index}`} className="bp-door"><line x1={hinge.x} y1={hinge.y + off} x2={(hinge.x + jamb.x) / 2 + 1} y2={hinge.y + off} /><line x1={(hinge.x + jamb.x) / 2 - 1} y1={hinge.y - off} x2={jamb.x} y2={hinge.y - off} /></g>
              : <g key={`d${index}`} className="bp-door"><line x1={hinge.x + off} y1={hinge.y} x2={hinge.x + off} y2={(hinge.y + jamb.y) / 2 + 1} /><line x1={hinge.x - off} y1={(hinge.y + jamb.y) / 2 - 1} x2={hinge.x - off} y2={jamb.y} /></g>;
          }
          // SVG sweep flag: 1 when turning from tip to jamb is clockwise on screen (y points down).
          const cross = (tip.x - hinge.x) * (jamb.y - hinge.y) - (tip.y - hinge.y) * (jamb.x - hinge.x);
          return <g key={`d${index}`} className="bp-door">
            <line className="bp-door-leaf" x1={hinge.x} y1={hinge.y} x2={tip.x} y2={tip.y} />
            <path className="bp-door-swing" d={`M ${tip.x} ${tip.y} A ${size} ${size} 0 0 ${cross > 0 ? 1 : 0} ${jamb.x} ${jamb.y}`} />
          </g>;
        })}
      </g>

      {/* Route, selection and labels sit above the heat field so they stay readable. */}
      <g className="map-overlays" aria-hidden="true">
        {/* A dark casing under each route outline keeps the green route distinct from green radar smoke. */}
        {layout.map(({ room, x, y, w, d, onRoute }) => onRoute && (drawing
          ? <rect key={`draw-casing-${room.id}-${drawRoute}`} className="room-route active draw casing" pathLength={1} style={{ "--order": route.get(room.id) ?? 0 } as CSSProperties} x={x + 6} y={y + 6} width={Math.max(1, w - 12)} height={Math.max(1, d - 12)} rx={1} />
          : <rect key={`casing-${room.id}`} className={`room-route casing ${routeActive ? "active" : ""}`} x={x + 6} y={y + 6} width={Math.max(1, w - 12)} height={Math.max(1, d - 12)} rx={1} />))}
        {layout.map(({ room, x, y, w, d, onRoute }) => onRoute && (drawing
          // Forecast: static dashed outline. Accepted: solid. Just accepted: draws on once via a normalised dash (pathLength 1).
          ? <rect key={`draw-${room.id}-${drawRoute}`} className="room-route active draw" pathLength={1} style={{ "--order": route.get(room.id) ?? 0 } as CSSProperties} x={x + 6} y={y + 6} width={Math.max(1, w - 12)} height={Math.max(1, d - 12)} rx={1} />
          : <rect key={`route-${room.id}`} className={`room-route ${routeActive ? "active" : ""}`} x={x + 6} y={y + 6} width={Math.max(1, w - 12)} height={Math.max(1, d - 12)} rx={1} />))}
        {layout.filter((entry) => entry.selected).map(({ room, x, y, w, d, wallInset }) =>
          <rect key={`sel-${room.id}`} className="room-selection" x={x + wallInset} y={y + wallInset} width={Math.max(1, w - wallInset * 2)} height={Math.max(1, d - wallInset * 2)} />)}
        {layout.flatMap(({ room, x, w, placed }) => placed.map((line, index) =>
          <text key={`${room.id}-${index}`} x={x + w / 2} y={line.y} textAnchor="middle" className={line.cls} fontSize={line.size}>{line.text}</text>))}
      </g>

      {/* Chain dimensions along the bottom (bays + overall) and right side, with architectural tick marks. */}
      <g className="bp-annotation bp-dimensions" aria-hidden="true">
        <line x1={px(grid.xs[0] ?? minX)} y1={dimY} x2={px(grid.xs.at(-1) ?? maxX)} y2={dimY} />
        <line x1={px(minX)} y1={dimY + 16} x2={px(maxX)} y2={dimY + 16} />
        {grid.xs.map((x) => <path key={`tx${x}`} className="bp-tick" d={`M ${px(x) - 3} ${dimY + 3} l 6 -6 M ${px(x)} ${py(maxZ) + 3} V ${dimY + 5}`} />)}
        {[minX, maxX].map((x) => <path key={`to${x}`} className="bp-tick" d={`M ${px(x) - 3} ${dimY + 19} l 6 -6 M ${px(x)} ${dimY + 10} V ${dimY + 21}`} />)}
        {grid.xs.slice(1).map((x, index) => <text key={`lx${x}`} x={(px(x) + px(grid.xs[index]!)) / 2} y={dimY - 3} fontSize={annot}>{metres(x - grid.xs[index]!)}</text>)}
        <text x={(px(minX) + px(maxX)) / 2} y={dimY + 13} fontSize={annot}>{metres(width)} overall</text>
        <line x1={dimX} y1={py(grid.zs[0] ?? minZ)} x2={dimX} y2={py(grid.zs.at(-1) ?? maxZ)} />
        {grid.zs.map((z) => <path key={`tz${z}`} className="bp-tick" d={`M ${dimX - 3} ${py(z) + 3} l 6 -6 M ${px(maxX) + 3} ${py(z)} H ${dimX + 5}`} />)}
        {grid.zs.slice(1).map((z, index) => {
          const cy = (py(z) + py(grid.zs[index]!)) / 2;
          return <text key={`lz${z}`} x={dimX + 4} y={cy} fontSize={annot} transform={`rotate(-90 ${dimX + 4} ${cy})`} dy={annot * 0.9}>{metres(z - grid.zs[index]!)}</text>;
        })}
      </g>

      {originRoom && (() => {
        // Static pin in the origin room's top-left corner; its label is in the caption above the map.
        const r = 10 / Math.max(k, 0.6);
        const cx = px(originRoom.x) + 6 + r;
        const cy = py(originRoom.z) + 6 + r;
        return <g key={originRoom.id} transform={`translate(${cx} ${cy}) scale(${r / 9})`} aria-hidden="true">
          <g className="origin-pin">
            <circle r={9} />
            <path d="M0 -5.2c.32 1.9 2.7 3.2 2.7 6a2.7 2.7 0 0 1-5.4 0c0-1.2.6-2 1.2-2.7.18.96.66 1.56 1.2 1.8 0-1.7-.24-3.4.3-5.1Z" />
          </g>
        </g>;
      })()}
    </svg>
  </div>;
}
