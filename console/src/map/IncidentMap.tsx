import { useEffect, useRef } from "react";
import type { MapIncident } from "@firewatch/shared/types";
import { useMapsStatus } from "./loader";
import { MapController, createMap } from "./mapController";
import { MapsMessage } from "./MapsMessage";
import { OfflineIncidentMap } from "./OfflineIncidentMap";
import type { ForecastScenario, ForecastScene } from "./forecastModel";
import "./map.css";

export interface IncidentMapProps {
  /** Only those with status "located" get pins. */
  incidents: MapIncident[];
  selectedId: string | null;
  showTraffic: boolean;
  onSelect(id: string): void;
  scene?: ForecastScene;
  scenario?: ForecastScenario;
  onSelectBuilding?(id: string): void;
  offline?: boolean;
}

export function IncidentMap(props: IncidentMapProps): JSX.Element {
  if (props.offline && props.scene && props.scenario) return <div className="fw-map"><OfflineIncidentMap {...props} scene={props.scene} scenario={props.scenario} onSelectBuilding={props.onSelectBuilding ?? (() => {})} /></div>;
  return <ConnectedIncidentMap {...props} />;
}

function ConnectedIncidentMap({ incidents, selectedId, showTraffic, onSelect, scene, scenario, onSelectBuilding }: IncidentMapProps): JSX.Element {
  const status = useMapsStatus();
  const ready = status.state === "ready";
  const canvas = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const controller = useRef<MapController | null>(null);
  const latestSelect = useRef(onSelect);
  const latestBuildingSelect = useRef(onSelectBuilding);

  useEffect(() => { latestSelect.current = onSelect; }, [onSelect]);
  useEffect(() => { latestBuildingSelect.current = onSelectBuilding; }, [onSelectBuilding]);

  // The map lives as long as the canvas does. Only the controller's overlays are torn down.
  useEffect(() => {
    if (!ready || !canvas.current) return;
    map.current ??= createMap(canvas.current);
    const created = new MapController(map.current, canvas.current, (id) => latestSelect.current(id), (id) => latestBuildingSelect.current?.(id));
    controller.current = created;
    return () => {
      created.destroy();
      controller.current = null;
    };
  }, [ready]);

  useEffect(() => {
    controller.current?.update({ incidents, selectedId, showTraffic, scene });
  }, [ready, incidents, selectedId, showTraffic, scene]);

  return (
    <div className="fw-map" role="region" aria-label="Incident map">
      <div ref={canvas} className={`fw-map-canvas${ready ? "" : " is-hidden"}`} />
      {!ready && (scenario && scene
        ? <OfflineIncidentMap incidents={incidents} selectedId={selectedId} scene={scene} scenario={scenario} onSelect={onSelect} onSelectBuilding={onSelectBuilding ?? (() => {})} />
        : <MapsMessage status={status} />)}
    </div>
  );
}
