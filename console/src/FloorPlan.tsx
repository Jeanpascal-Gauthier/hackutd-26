import building from "@firewatch/shared/building.json";
import type { IncidentState } from "@firewatch/shared/types";

interface FloorPlanProps {
  floor: number;
  state: IncidentState | null;
  selectedRoom: string | null;
  onSelect: (id: string) => void;
}

/** Rooms on this floor that are part of an evacuation route (hall + clear stairwell). */
function routeRooms(state: IncidentState | null, floor: number): Set<string> {
  const ids = new Set<string>();
  for (const exit of state?.exits ?? []) for (const id of exit.route ?? []) if (id.startsWith(`${floor}-`)) ids.add(id);
  return ids;
}

export function FloorPlan({ floor, state, selectedRoom, onSelect }: FloorPlanProps) {
  const rooms = building.rooms.filter((room) => room.floor === floor);
  if (!rooms.length) return <p className="empty-state">No geometry available for this floor.</p>;
  const minX = Math.min(...rooms.map((room) => room.x));
  const minZ = Math.min(...rooms.map((room) => room.z));
  const width = Math.max(...rooms.map((room) => room.x + room.w)) - minX;
  const depth = Math.max(...rooms.map((room) => room.z + room.d)) - minZ;
  const scale = Math.min(640 / Math.max(width, 1), 360 / Math.max(depth, 1));
  const top = 48;
  const left = 32;
  const route = routeRooms(state, floor);
  const routeActive = !!state?.accepted;
  const origin = state?.origin;
  const originRoom = origin ? rooms.find((room) => room.id === origin.roomId) : undefined;

  return <div className="floor-plan"><svg viewBox={`0 0 ${width * scale + left * 2} ${depth * scale + top + 44}`} role="group" aria-label={`Floor ${floor} interactive room map`}>
    <defs><pattern id="map-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.75" fill="#263440" /></pattern></defs>
    <rect width="100%" height="100%" fill="url(#map-grid)" />
    <text x={left} y={25} className="map-caption">FLOOR {floor.toString().padStart(2, "0")} / SELECT A ROOM TO INSPECT{originRoom && origin && <tspan className="map-caption-origin"> · LIKELY ORIGIN: {originRoom.name.replace(/^Floor \d+ /, "").toUpperCase()} ({Math.round(origin.confidence * 100)}%)</tspan>}</text>
    {rooms.map((room) => {
      const current = state?.rooms.find((value) => value.roomId === room.id);
      const fire = Math.min(1, Math.max(0, current?.fire ?? 0));
      const smoke = Math.min(1, Math.max(0, current?.smoke ?? 0));
      const color = fire > 0.01 ? `hsl(14 66% ${20 + fire * 18}%)` : smoke > 0.01 ? `hsl(35 ${15 + smoke * 25}% ${16 + smoke * 13}%)` : "#17242c";
      const stroke = selectedRoom === room.id ? "#6ad9c3" : fire > 0.01 ? "#d87550" : smoke > 0.01 ? "#a69472" : "#344954";
      const count = state?.occupants.filter((item) => item.room === room.id).reduce((sum, item) => sum + item.count, 0) ?? 0;
      const x = left + (room.x - minX) * scale;
      const y = top + (room.z - minZ) * scale;
      const w = room.w * scale;
      const d = room.d * scale;
      const selected = selectedRoom === room.id;
      const onRoute = route.has(room.id);
      const label = room.name.replace(/^Floor \d+ /, "");
      const status = current ? `fire ${Math.round(fire * 100)} percent, smoke ${Math.round(smoke * 100)} percent` : "awaiting incident data";
      return <g key={room.id} role="button" tabIndex={0} aria-pressed={selected} aria-label={`${room.name}, ${status}, ${count} recorded occupants${onRoute ? ", on the evacuation route" : ""}`} className={`map-room ${selected ? "is-selected" : ""}`} onClick={() => onSelect(room.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(room.id); } }}>
        <title>{room.name} · {room.id}{current ? ` · fire ${Math.round(fire * 100)}% · smoke ${Math.round(smoke * 100)}%` : " · No incident data"}{onRoute ? " · evacuation route" : ""}</title>
        {/* Fill as a style so scrubbing the timeline cross-fades colours; stroke stays an attribute so :hover can override it. */}
        <rect className="room-shape" x={x + 2} y={y + 2} width={Math.max(1, w - 4)} height={Math.max(1, d - 4)} rx={4} stroke={stroke} strokeWidth={selected ? 2.5 : 1} style={{ fill: color }} />
        {fire >= 0.3 && <rect className="room-ember" x={x + 2} y={y + 2} width={Math.max(1, w - 4)} height={Math.max(1, d - 4)} rx={4} />}
        {onRoute && <rect className={`room-route ${routeActive ? "active" : ""}`} x={x + 5} y={y + 5} width={Math.max(1, w - 10)} height={Math.max(1, d - 10)} rx={3} />}
        <svg x={x + 8} y={y + 5} width={Math.max(w - 16, 1)} height={Math.max(d - 10, 1)} viewBox={`0 0 ${Math.max(w - 16, 1)} ${Math.max(d - 10, 1)}`} overflow="hidden" aria-hidden="true">
          <text x="50%" y={d > 90 ? "38%" : "42%"} textAnchor="middle" dominantBaseline="middle" className="room-label" fontSize={Math.min(14, Math.max(7, (w - 20) / (label.length * 0.58)))}>{label}</text>
          {d > 46 && <text x="50%" y={d > 90 ? "59%" : "73%"} textAnchor="middle" className="room-reading" fontSize={Math.min(10, Math.max(6, w / 22))}>{current ? fire > 0.01 ? `FIRE ${Math.round(fire * 100)}% · SMOKE ${Math.round(smoke * 100)}%` : smoke > 0.01 ? `SMOKE ${Math.round(smoke * 100)}%` : "NO FIRE / SMOKE" : "AWAITING DATA"}</text>}
          {count > 0 && d > 90 && <text x="50%" y="82%" textAnchor="middle" className="room-occupants" fontSize={10}>{count} occupants</text>}
        </svg>
      </g>;
    })}
    {originRoom && origin && (() => {
      // The demo's "red marker": a pin inside the origin room's top-left corner, with a ping ring
      // to draw the eye. Its label lives in the map caption so it never collides with room text.
      const cx = left + (originRoom.x - minX) * scale + 16;
      const cy = top + (originRoom.z - minZ) * scale + 16;
      return <g key={origin.roomId} className="origin-marker" transform={`translate(${cx} ${cy})`} aria-hidden="true">
        <circle className="origin-ping" r={9} />
        <g className="origin-pin">
          <circle r={9} />
          <path d="M0 -5.2c.32 1.9 2.7 3.2 2.7 6a2.7 2.7 0 0 1-5.4 0c0-1.2.6-2 1.2-2.7.18.96.66 1.56 1.2 1.8 0-1.7-.24-3.4.3-5.1Z" />
        </g>
      </g>;
    })()}
  </svg></div>;
}
