import building from "@firewatch/shared/building.json";
import type { IncidentState } from "@firewatch/shared/types";

export function FloorPlan({ floor, state, selectedRoom, onSelect }: { floor: number; state: IncidentState | null; selectedRoom: string | null; onSelect: (id: string) => void }) {
  const rooms = building.rooms.filter((room) => room.floor === floor);
  const routeRooms = new Set(state?.accepted ? (state.exits ?? []).flatMap((exit) => exit.route ?? []) : []);
  if (!rooms.length) return <p className="empty-state">No geometry available for this floor.</p>;
  const minX = Math.min(...rooms.map((room) => room.x));
  const minZ = Math.min(...rooms.map((room) => room.z));
  const width = Math.max(...rooms.map((room) => room.x + room.w)) - minX;
  const depth = Math.max(...rooms.map((room) => room.z + room.d)) - minZ;
  const scale = Math.min(640 / Math.max(width, 1), 360 / Math.max(depth, 1));
  const top = 48;
  const left = 32;
  return <div className="floor-plan"><svg viewBox={`0 0 ${width * scale + left * 2} ${depth * scale + top + 44}`} role="group" aria-label={`Floor ${floor} interactive room map`}>
    <defs><pattern id="map-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.75" fill="#263440" /></pattern></defs>
    <rect width="100%" height="100%" fill="url(#map-grid)" />
    <text x={left} y={25} className="map-caption">FLOOR {floor.toString().padStart(2, "0")} / SELECT A ROOM TO INSPECT</text>
    {rooms.map((room) => {
      const current = state?.rooms.find((value) => value.roomId === room.id);
      const fire = Math.min(1, Math.max(0, current?.fire ?? 0));
      const smoke = Math.min(1, Math.max(0, current?.smoke ?? 0));
      const color = fire > 0.01 ? `hsl(14 66% ${20 + fire * 18}%)` : smoke > 0.01 ? `hsl(35 ${15 + smoke * 25}% ${16 + smoke * 13}%)` : "#17242c";
      const count = state?.occupants.filter((item) => item.room === room.id).reduce((sum, item) => sum + item.count, 0) ?? 0;
      const x = left + (room.x - minX) * scale;
      const y = top + (room.z - minZ) * scale;
      const w = room.w * scale;
      const d = room.d * scale;
      const selected = selectedRoom === room.id;
      const origin = state?.origin?.roomId === room.id;
      // Keep hazard colors visible. Only mark segments with known conditions below
      // the model's smoke threshold, and no visible fire, at the selected minute.
      const onRoute = routeRooms.has(room.id) && current !== undefined && fire <= 0.01 && smoke < 0.3;
      const label = room.name.replace(/^Floor \d+ /, "");
      return <g key={room.id} role="button" tabIndex={0} data-room-id={room.id} data-origin={origin || undefined} data-route={onRoute || undefined} aria-pressed={selected} aria-label={`${room.name}, ${current ? `fire ${Math.round(fire * 100)} percent, smoke ${Math.round(smoke * 100)} percent` : "awaiting incident data"}, ${count} recorded occupants${origin ? ", suspected fire origin" : ""}${onRoute ? ", accepted route segment" : ""}`} className={`map-room ${selected ? "is-selected" : ""}`} onClick={() => onSelect(room.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(room.id); } }}>
        <title>{room.name} · {room.id}{current ? ` · fire ${Math.round(fire * 100)}% · smoke ${Math.round(smoke * 100)}%` : " · No incident data"}</title>
        <rect x={x + 2} y={y + 2} width={Math.max(1, w - 4)} height={Math.max(1, d - 4)} rx={4} fill={color} stroke={selected ? "#6ad9c3" : fire > 0.01 ? "#d87550" : smoke > 0.01 ? "#a69472" : "#344954"} strokeWidth={selected ? 2.5 : 1} />
        {onRoute && <rect className="route-highlight" x={x + 5} y={y + 5} width={Math.max(1, w - 10)} height={Math.max(1, d - 10)} rx={3} fill="none" stroke="#7eea93" strokeWidth={2} strokeDasharray="5 3" pointerEvents="none" aria-hidden="true" />}
        {origin && <circle cx={x + w - 10} cy={y + 10} r={4} fill="#ee9b72" stroke="#0b1116" strokeWidth={1.5} pointerEvents="none" aria-hidden="true" />}
        <svg x={x + 8} y={y + 5} width={Math.max(w - 16, 1)} height={Math.max(d - 10, 1)} viewBox={`0 0 ${Math.max(w - 16, 1)} ${Math.max(d - 10, 1)}`} overflow="hidden" aria-hidden="true">
          <text x="50%" y={d > 90 ? "38%" : "42%"} textAnchor="middle" dominantBaseline="middle" className="room-label" fontSize={Math.min(14, Math.max(7, (w - 20) / (label.length * 0.58)))}>{label}</text>
          {d > 46 && <text x="50%" y={d > 90 ? "59%" : "73%"} textAnchor="middle" className="room-reading" fontSize={Math.min(10, Math.max(6, w / 22))}>{current ? fire > 0.01 ? `FIRE ${Math.round(fire * 100)}% · SMOKE ${Math.round(smoke * 100)}%` : smoke > 0.01 ? `SMOKE ${Math.round(smoke * 100)}%` : "NO FIRE / SMOKE" : "AWAITING DATA"}</text>}
          {count > 0 && d > 90 && <text x="50%" y="82%" textAnchor="middle" className="room-occupants" fontSize={10}>{count} occupants</text>}
        </svg>
      </g>;
    })}
  </svg></div>;
}
