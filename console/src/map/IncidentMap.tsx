import { useEffect, useRef } from "react";
import type { MapIncident } from "@firewatch/shared/types";
import { useMapsStatus } from "./loader";
import { MapController, createMap } from "./mapController";
import { MapsMessage } from "./MapsMessage";
import "./map.css";

export interface IncidentMapProps {
  /** Only those with status "located" get pins. */
  incidents: MapIncident[];
  selectedId: string | null;
  showTraffic: boolean;
  onSelect(id: string): void;
}

export function IncidentMap({ incidents, selectedId, showTraffic, onSelect }: IncidentMapProps): JSX.Element {
  const status = useMapsStatus();
  const ready = status.state === "ready";
  const canvas = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const controller = useRef<MapController | null>(null);
  const latestSelect = useRef(onSelect);

  useEffect(() => { latestSelect.current = onSelect; }, [onSelect]);

  // The map lives as long as the canvas does. Only the controller's overlays are torn down.
  useEffect(() => {
    if (!ready || !canvas.current) return;
    map.current ??= createMap(canvas.current);
    const created = new MapController(map.current, canvas.current, (id) => latestSelect.current(id));
    controller.current = created;
    return () => {
      created.destroy();
      controller.current = null;
    };
  }, [ready]);

  useEffect(() => {
    controller.current?.update({ incidents, selectedId, showTraffic });
  }, [ready, incidents, selectedId, showTraffic]);

  return (
    <div className="fw-map" role="region" aria-label="Incident map">
      <div ref={canvas} className={`fw-map-canvas${ready ? "" : " is-hidden"}`} />
      {!ready && <MapsMessage status={status} />}
    </div>
  );
}
