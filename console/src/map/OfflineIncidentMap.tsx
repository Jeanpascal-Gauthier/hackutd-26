import type { GeoPoint, MapIncident } from "@firewatch/shared/types";
import type { ForecastScene, ForecastScenario } from "./forecastModel";

/** Uses the same geographic shapes as Google Maps. No key, tiles, or network needed for the demo. */
export function OfflineIncidentMap({ incidents, selectedId, scene, scenario, onSelect, onSelectBuilding }: {
  incidents: MapIncident[];
  selectedId: string | null;
  scene: ForecastScene;
  scenario: ForecastScenario;
  onSelect(id: string): void;
  onSelectBuilding(id: string): void;
}) {
  const located = incidents.filter((incident) => incident.location && incident.status === "located");
  const points = [...scene.extent, ...located.map((incident) => incident.location!)];
  const minLat = Math.min(...points.map((point) => point.lat));
  const maxLat = Math.max(...points.map((point) => point.lat));
  const minLon = Math.min(...points.map((point) => point.lon));
  const maxLon = Math.max(...points.map((point) => point.lon));
  const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const longitudeScale = Math.cos(center.lat * Math.PI / 180);
  const scale = Math.min(760 / Math.max(0.001, (maxLon - minLon) * longitudeScale), 310 / Math.max(0.001, maxLat - minLat));
  const project = (point: GeoPoint) => ({ x: 450 + (point.lon - center.lon) * longitudeScale * scale, y: 215 - (point.lat - center.lat) * scale });
  const path = (ring: GeoPoint[]) => ring.map((point) => { const p = project(point); return `${p.x},${p.y}`; }).join(" ");
  const activate = (event: React.KeyboardEvent, callback: () => void) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); callback(); }
  };
  return <div className="offline-incident-map">
    <svg viewBox="0 0 900 430" aria-label="Downtown Dallas incident forecast, schematic map" role="group">
      <defs><pattern id="demo-city-grid" width="80" height="66" patternUnits="userSpaceOnUse" patternTransform="rotate(-14 450 215)">
        <rect x="7" y="7" width="66" height="52" rx="3" className="demo-block" />
      </pattern></defs>
      <rect width="900" height="430" className="demo-ground" />
      <rect width="900" height="430" fill="url(#demo-city-grid)" />
      <g className="demo-road-names" aria-hidden="true"><text x="50" y="100" transform="rotate(-14 50 100)">ELM STREET</text><text x="610" y="315" transform="rotate(-14 610 315)">COMMERCE STREET</text><text x="360" y="230" transform="rotate(-14 360 230)">MAIN STREET</text></g>
      {[...scene.shapes].sort((a, b) => a.zIndex - b.zIndex).map((shape) => shape.kind === "polygon"
        ? <polygon key={shape.id} points={path(shape.path)} fill={shape.color} fillOpacity={shape.opacity} stroke={shape.color} strokeWidth={shape.weight} strokeOpacity={shape.weight ? 1 : 0}
          className={shape.buildingId ? "demo-building" : undefined} role={shape.buildingId ? "button" : undefined} tabIndex={shape.buildingId ? 0 : undefined} aria-label={shape.buildingId ? shape.title : undefined}
          onClick={shape.buildingId ? () => onSelectBuilding(shape.buildingId!) : undefined} onKeyDown={shape.buildingId ? (event) => activate(event, () => onSelectBuilding(shape.buildingId!)) : undefined}>
          <title>{shape.title}</title>
        </polygon>
        : <polyline key={shape.id} points={path(shape.path)} fill="none" stroke={shape.color} strokeOpacity={shape.opacity} strokeWidth={shape.weight} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={shape.dashed ? "6 7" : undefined}><title>{shape.title}</title></polyline>)}
      {scenario.buildings.map((building, index) => {
        const p = project(building.location);
        return <text key={building.id} x={p.x} y={p.y + 4} textAnchor="middle" className="demo-building-number" aria-hidden="true">{index + 1}</text>;
      })}
      {located.map((incident) => {
        const p = project(incident.location!);
        const selected = incident.id === selectedId;
        // Lift incident pins off the footprint so buildings can be clicked directly.
        return <g key={incident.id} transform={`translate(${p.x + 15},${p.y - 25})`} role="button" tabIndex={0} aria-label={`${incident.label}${incident.reports.length > 1 ? ` · ${incident.reports.length} calls merged` : ""}`} className={`demo-incident-pin${selected ? " selected" : ""}`} onClick={() => onSelect(incident.id)} onKeyDown={(event) => activate(event, () => onSelect(incident.id))}>
          <path d="M0 13 0 25" className="demo-pin-stem" />
          <rect x="-12" y="-12" width="24" height="25" rx="5" />
          <text y="5" textAnchor="middle" className="demo-pin-glyph">{incident.kind === "fire" ? "F" : incident.kind === "crash" ? "C" : incident.label.includes("flood") ? "W" : "!"}</text>
          <text x="19" y="4" className="demo-pin-label">{incident.label}</text>
          {incident.reports.length > 1 && <g transform="translate(-17 -35)"><rect width="61" height="20" rx="10" className="demo-calls-bg" /><text x="30" y="14" textAnchor="middle" className="demo-calls-label">{incident.reports.length} calls</text></g>}
        </g>;
      })}
      <g transform="translate(852 35)" className="demo-north" aria-hidden="true"><path d="m0 14 0-23m-5 6 5-6 5 6" /><text y="29" textAnchor="middle">N</text></g>
      <g transform="translate(28 395)" className="demo-scale" aria-hidden="true"><path d={`M0 -4 V0 H${100 / 111_320 * scale} V-4`} /><text y="17">100 m</text></g>
    </svg>
    <span className="offline-map-caption">Downtown Dallas · schematic street layout</span>
  </div>;
}
