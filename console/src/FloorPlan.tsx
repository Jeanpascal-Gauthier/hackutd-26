import { useLayoutEffect, useRef, useState } from "react";
import building from "@firewatch/shared/building.json";
import type { IncidentState } from "@firewatch/shared/types";

interface FloorPlanProps {
  floor: number;
  state: IncidentState | null;
  selectedRoom: string | null;
  onSelect: (id: string) => void;
}

/** On-screen text sizes (CSS px). SVG font sizes are derived from the measured map scale so text never renders smaller. */
const LABEL_PX = 13;
const READING_PX = 12;
const LINE_GAP_PX = 4;
const PAD_PX = 6;
/** Rough average glyph width for DM Sans, as a fraction of the font size (slightly generous so text never clips). */
const CHAR_EM = 0.6;

/** Rooms on this floor that are part of an evacuation route (hall + clear stairwell). */
function routeRooms(state: IncidentState | null, floor: number): Set<string> {
  const ids = new Set<string>();
  for (const exit of state?.exits ?? []) for (const id of exit.route ?? []) if (id.startsWith(`${floor}-`)) ids.add(id);
  return ids;
}

const shortName = (label: string) => label.replace(/^Stairwell /, "Stair ").replace(/ (Office|Room)$/, "").replace(/^Conference$/, "Conf.").replace(/^Elevator$/, "Elev.");

/** Room fill: a mix of the empty-room colour toward fire or smoke by intensity, so both themes work. */
function roomFill(fire: number, smoke: number) {
  if (fire > 0.01) return `color-mix(in oklab, var(--fire) ${Math.round(22 + fire * 40)}%, var(--room-empty))`;
  if (smoke > 0.01) return `color-mix(in oklab, var(--smoke) ${Math.round(14 + smoke * 40)}%, var(--room-empty))`;
  return "var(--room-empty)";
}

export function FloorPlan({ floor, state, selectedRoom, onSelect }: FloorPlanProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rooms = building.rooms.filter((room) => room.floor === floor);
  const minX = Math.min(...rooms.map((room) => room.x));
  const minZ = Math.min(...rooms.map((room) => room.z));
  const width = Math.max(...rooms.map((room) => room.x + room.w)) - minX;
  const depth = Math.max(...rooms.map((room) => room.z + room.d)) - minZ;
  const scale = Math.min(640 / Math.max(width, 1), 360 / Math.max(depth, 1));
  const pad = 12;
  const viewW = width * scale + pad * 2;
  const viewH = depth * scale + pad * 2;
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
  const origin = state?.origin;
  const originRoom = origin ? rooms.find((room) => room.id === origin.roomId) : undefined;
  const labelSize = LABEL_PX / k;
  const readingSize = READING_PX / k;
  const gap = LINE_GAP_PX / k;
  const inset = PAD_PX / k;

  return <div className="floor-plan">
    <p className="map-caption"><span>Floor {floor} · select a room to inspect</span>{originRoom && origin && <span>Likely origin: <strong>{originRoom.name.replace(/^Floor \d+ /, "")}</strong> ({Math.round(origin.confidence * 100)}%)</span>}</p>
    <svg ref={svgRef} className="map" viewBox={`0 0 ${viewW} ${viewH}`} role="group" aria-label={`Floor ${floor} interactive room map`}>
      <defs><pattern id="map-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.9" style={{ fill: "var(--grid-dot)" }} /></pattern></defs>
      <rect width="100%" height="100%" fill="url(#map-grid)" />
      {rooms.map((room) => {
        const current = state?.rooms.find((value) => value.roomId === room.id);
        const fire = Math.min(1, Math.max(0, current?.fire ?? 0));
        const smoke = Math.min(1, Math.max(0, current?.smoke ?? 0));
        const selected = selectedRoom === room.id;
        const stroke = selected ? "var(--accent)" : fire > 0.01 ? "var(--fire)" : smoke > 0.01 ? "var(--smoke)" : "var(--line-strong)";
        const count = state?.occupants.filter((item) => item.room === room.id).reduce((sum, item) => sum + item.count, 0) ?? 0;
        const x = pad + (room.x - minX) * scale;
        const y = pad + (room.z - minZ) * scale;
        const w = room.w * scale;
        const d = room.d * scale;
        const onRoute = route.has(room.id);
        const label = room.name.replace(/^Floor \d+ /, "");
        const status = current ? `fire ${Math.round(fire * 100)} percent, smoke ${Math.round(smoke * 100)} percent` : "awaiting incident data";

        // Text layout: stack label + readings if they fit, else one joined line, else label only, else nothing.
        const readings = [fire > 0.01 && `Fire ${Math.round(fire * 100)}%`, smoke > 0.01 && `Smoke ${Math.round(smoke * 100)}%`].filter(Boolean) as string[];
        if (count > 0) readings.push(`${count} people`);
        const innerW = w - inset * 2 - 4;
        const innerH = d - inset * 2 - 4;
        const fits = (text: string, size: number) => text.length * CHAR_EM * size <= innerW;
        const name = fits(label, labelSize) ? label : fits(shortName(label), labelSize) ? shortName(label) : null;
        let lines: { text: string; size: number; cls: string }[] = [];
        if (name) {
          const stacked = [{ text: name, size: labelSize, cls: "room-label" }];
          for (const text of readings) if (fits(text, readingSize)) stacked.push({ text, size: readingSize, cls: text.endsWith("people") ? "room-occupants" : "room-reading" });
          const stackH = (n: number) => stacked.slice(0, n).reduce((sum, line) => sum + line.size, 0) + gap * (n - 1);
          let n = stacked.length;
          while (n > 1 && stackH(n) > innerH) n--;
          lines = stacked.slice(0, n);
          const hazard = readings.filter((text) => !text.endsWith("people")).join(" · ");
          if (lines.length === 1 && hazard && innerH >= labelSize && fits(`${name} · ${hazard}`, labelSize)) lines = [{ text: `${name} · ${hazard}`, size: labelSize, cls: "room-label" }];
          if (lines.length === 1 && innerH < labelSize) lines = [];
        }
        const totalH = lines.reduce((sum, line) => sum + line.size, 0) + gap * Math.max(0, lines.length - 1);
        let cursor = y + d / 2 - totalH / 2;

        return <g key={room.id} role="button" tabIndex={0} aria-pressed={selected} aria-label={`${room.name}, ${status}, ${count} recorded occupants${onRoute ? ", on the evacuation route" : ""}`} className={`map-room ${selected ? "is-selected" : ""}`} onClick={() => onSelect(room.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(room.id); } }}>
          <title>{room.name} · {room.id}{current ? ` · fire ${Math.round(fire * 100)}% · smoke ${Math.round(smoke * 100)}%` : " · No incident data"}{count ? ` · ${count} people` : ""}{onRoute ? " · evacuation route" : ""}</title>
          {/* Fill and stroke as styles so scrubbing the timeline cross-fades them; :hover / :focus-visible override the stroke. */}
          <rect className="room-shape" x={x + 2} y={y + 2} width={Math.max(1, w - 4)} height={Math.max(1, d - 4)} rx={4} strokeWidth={selected ? 2.5 : 1} style={{ fill: roomFill(fire, smoke), stroke }} />
          {onRoute && <rect className={`room-route ${routeActive ? "active" : ""}`} x={x + 6} y={y + 6} width={Math.max(1, w - 12)} height={Math.max(1, d - 12)} rx={3} />}
          {lines.map((line, index) => {
            const top = cursor;
            cursor += line.size + gap;
            return <text key={index} x={x + w / 2} y={top + line.size * 0.8} textAnchor="middle" className={line.cls} fontSize={line.size} aria-hidden="true">{line.text}</text>;
          })}
        </g>;
      })}
      {originRoom && (() => {
        // Static pin in the origin room's top-left corner; its label is in the caption above the map.
        const r = 10 / Math.max(k, 0.6);
        const cx = pad + (originRoom.x - minX) * scale + 6 + r;
        const cy = pad + (originRoom.z - minZ) * scale + 6 + r;
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
