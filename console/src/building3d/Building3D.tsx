import { useEffect, useMemo, useRef, useState } from "react";
import building from "@firewatch/shared/building.json";
import type { IncidentState } from "@firewatch/shared/types";
import { ChevronDownIcon, ChevronUpIcon, FitIcon } from "../Icons";
import { BuildingScene } from "./scene";
import { readTheme, watchTheme } from "./theme";
import "./Building3D.css";

export interface Building3DProps {
  state: IncidentState | null;
  floor: number;
  selectedRoom: string | null;
  onSelectRoom(id: string): void;
  onSelectFloor(floor: number): void;
}

const floorNumbers = [...new Set(building.rooms.map((room) => room.floor))].sort((a, b) => a - b);
const minFloor = floorNumbers[0] ?? 1;
const maxFloor = floorNumbers[floorNumbers.length - 1] ?? 1;
const roomsById = new Map(building.rooms.map((room) => [room.id, room]));
const shortName = (name: string) => name.replace(/^Floor \d+ /, "");

let webglSupport: boolean | undefined;
function hasWebGL(): boolean {
  if (webglSupport === undefined) {
    try {
      const canvas = document.createElement("canvas");
      webglSupport = !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    } catch { webglSupport = false; }
  }
  return webglSupport;
}

export default function Building3D(props: Building3DProps) {
  const { state, floor, selectedRoom } = props;
  const supported = useMemo(hasWebGL, []);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BuildingScene | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!supported || !host) return;
    let scene: BuildingScene;
    try {
      const { state, floor, selectedRoom } = latest.current;
      scene = new BuildingScene(host, building, readTheme(), { state, floor, selectedRoom }, {
        onPick: (id) => {
          const room = roomsById.get(id);
          if (!room) return;
          latest.current.onSelectRoom(id);
          latest.current.onSelectFloor(room.floor);
        },
        onHover: (id, x, y) => setHover(id ? { name: roomsById.get(id)?.name ?? id, x, y } : null),
      });
    } catch {
      setFailed(true); // No usable WebGL context: the 2D floor plan stays the only view.
      return;
    }
    sceneRef.current = scene;
    const unwatch = watchTheme(() => scene.setTheme(readTheme()));
    return () => { unwatch(); scene.dispose(); sceneRef.current = null; setHover(null); };
  }, [supported]);

  useEffect(() => { sceneRef.current?.setState(state); }, [state]);
  useEffect(() => { sceneRef.current?.setFloor(floor); }, [floor]);
  useEffect(() => { sceneRef.current?.setSelectedRoom(selectedRoom); }, [selectedRoom]);

  const origin = state?.origin ? roomsById.get(state.origin.roomId) : undefined;
  const label = [
    `3D view of ${floorNumbers.length}-floor building`,
    origin ? `fire origin ${shortName(origin.name)} floor ${origin.floor}` : "no fire origin reported",
    `floor ${floor} highlighted`,
    state?.accepted ? "evacuation route lit in green" : "",
  ].filter(Boolean).join(", ");
  useEffect(() => {
    const canvas = sceneRef.current?.canvas;
    if (!canvas) return;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);
  }, [label]);

  if (!supported || failed) return null;
  return <section className="panel building3d-panel" aria-labelledby="building3d-heading">
    <div className="panel-heading building3d-heading">
      <div><span className="eyebrow">SPATIAL OVERVIEW / 3D</span><h2 id="building3d-heading">Building 3D</h2></div>
      <div className="building3d-tools">
        <div className="building3d-floor" role="group" aria-label="Change floor">
          <button type="button" className="building3d-icon" aria-label={`Show floor ${floor - 1}`} disabled={floor <= minFloor} onClick={() => props.onSelectFloor(floor - 1)}><ChevronDownIcon size={16} /></button>
          <span className="building3d-floor-value" aria-live="polite">Floor {floor}</span>
          <button type="button" className="building3d-icon" aria-label={`Show floor ${floor + 1}`} disabled={floor >= maxFloor} onClick={() => props.onSelectFloor(floor + 1)}><ChevronUpIcon size={16} /></button>
        </div>
        <button type="button" className="building3d-fit" aria-label="Reset 3D view" onClick={() => sceneRef.current?.fit()}><FitIcon size={15} />Fit</button>
      </div>
    </div>
    <div className="building3d-viewport">
      <div ref={hostRef} className="building3d-host" />
      {hover && <div className="building3d-tooltip" aria-hidden="true" style={{ transform: `translate(${Math.round(hover.x + 14)}px, ${Math.round(hover.y + 14)}px)` }}>{hover.name}</div>}
      <p className="building3d-hint" aria-hidden="true">Drag to orbit · Scroll to zoom · Select a room</p>
    </div>
  </section>;
}
