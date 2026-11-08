// The primary incident map, with live traffic and Street View.
import { useMemo, useState } from "react";
import type { MapIncident } from "@firewatch/shared/types";
import { IncidentMap } from "./map/IncidentMap";
import { StreetScene } from "./map/StreetScene";
import { locationIssue, placeOf } from "./incidents";

export function MapPanel({ incidents, selected, onSelect }: {
  incidents: MapIncident[];
  selected: MapIncident | null;
  onSelect: (id: string) => void;
}) {
  const [view, setView] = useState<"map" | "street">("map");
  const [showTraffic, setShowTraffic] = useState(false);
  const location = selected?.location;
  const street = view === "street" && !!location;
  const selectedId = selected?.id ?? null;
  // Resolved incidents leave the map unless the operator is looking at one.
  const shown = useMemo(() => incidents.filter((incident) => incident.phase !== "resolved" || incident.id === selectedId), [incidents, selectedId]);
  const issue = selected ? locationIssue(selected) : null;

  return (
    <section className="panel primary-map map-panel" aria-labelledby="map-heading">
      <div className="panel-heading map-heading">
        <h2 id="map-heading">{selected ? selected.label : "Incident map"}{selected && placeOf(selected) && <small className="map-place">{placeOf(selected)}</small>}</h2>
        <div className="map-controls">
          {!street && <div className="view-switch" role="group" aria-label="Map layers"><button aria-pressed={showTraffic} onClick={() => setShowTraffic(!showTraffic)}>Live traffic</button></div>}
          <div className="view-switch" role="group" aria-label="Scene view">
            <button aria-pressed={!street} onClick={() => setView("map")}>Map</button>
            <button aria-pressed={street} disabled={!location} onClick={() => setView("street")}>Street view</button>
          </div>
        </div>
      </div>
      {issue && <p className="map-hint">{issue}. This incident is not on the map yet.</p>}
      {street && selected && location
        ? <StreetScene location={location} label={placeOf(selected) ?? selected.label} />
        : <IncidentMap incidents={shown} selectedId={selectedId} showTraffic={showTraffic} onSelect={onSelect} />}
    </section>
  );
}
