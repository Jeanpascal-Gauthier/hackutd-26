// Building information and evacuation analysis. Shown only for
// an incident that owns the active building, so a crash never sits next to someone else's stairwells.
import { useLayoutEffect, useRef, useState } from "react";
import type { ClientEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";
import type { ActiveBuilding, BuildingSync } from "./activeBuilding";
import { BuildingPanel } from "./BuildingPanel";
import { EvacuationPriorities, IncidentSummary, PriorityActions } from "./IncidentPriority";
import { buildingDecisions } from "./incidents";

/** Floor to show for a newly active building: the origin's floor, else the hottest room's, else the lowest. */
function fireFloor(state: IncidentState | null, active: ActiveBuilding): number {
  const origin = active.roomsById.get(state?.origin?.roomId ?? "");
  if (origin) return origin.floor;
  const hottest = [...(state?.rooms ?? [])].filter((room) => room.fire > 0.05 && active.roomsById.has(room.roomId)).sort((a, b) => b.fire - a.fire)[0];
  if (hottest) return active.roomsById.get(hottest.roomId)!.floor;
  return active.floors.includes(1) ? 1 : active.floors[0] ?? 1;
}

export function useBuildingTools({ state, active }: {
  state: IncidentState | null;
  active: ActiveBuilding;
}) {
  const { floors } = active;
  const [floor, setFloor] = useState(floors.includes(7) ? 7 : floors[floors.length - 1]!);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  // Another building became active: clear the selection and show the fire floor (else the lowest floor).
  const geometrySeen = useRef(active.geometryKey);
  useLayoutEffect(() => {
    if (geometrySeen.current === active.geometryKey) return;
    geometrySeen.current = active.geometryKey;
    setSelectedRoom(null);
    setFloor(fireFloor(state, active));
    // Later state updates keep the operator's selected floor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.geometryKey]);

  function focusRoom(id: string) {
    const room = active.roomsById.get(id);
    if (room) { setFloor(room.floor); setSelectedRoom(id); }
  }

  function selectFloor(value: number) {
    if (!floors.includes(value)) return;
    setFloor(value);
    setSelectedRoom((id) => active.roomsById.get(id ?? "")?.floor === value ? id : null);
  }

  return { floor, selectedRoom, focusRoom, selectFloor };
}

export type BuildingToolsState = ReturnType<typeof useBuildingTools>;

export function BuildingTools({ tools, state, active, connected, mode, sync, onSend, primary, showBuildingActions }: {
  tools: BuildingToolsState;
  state: IncidentState | null;
  active: ActiveBuilding;
  connected: boolean;
  mode: "mock" | "live" | "unknown";
  sync: BuildingSync;
  onSend: (event: ClientEvent) => boolean;
  /** Rendered with no map above it (the building-only path). */
  primary: boolean;
  /** Show the building's own recommendation here (a map incident owns the building). */
  showBuildingActions: boolean;
}) {
  const { floor, focusRoom, selectFloor } = tools;
  // A failed lookup leaves the demo building active. It must never pass for the caller's building.
  const noBuilding = state?.buildingLookup?.status === "failed" && active.isDemo;
  const buildingActions = buildingDecisions(state);

  return (
    <section id="building-tools" className={`building-tools${primary ? " is-primary" : ""}`} aria-labelledby="building-tools-heading">
      <div className="building-tools-heading">
        <h2 id="building-tools-heading">Building tools</h2>
        <span className="subtle">{noBuilding ? "No building confirmed" : active.isDemo ? "Demo building" : active.profile.name}</span>
      </div>

      <IncidentSummary state={state} onLocate={focusRoom} />

      {showBuildingActions && (buildingActions.recommendation || buildingActions.accepted) && <PriorityActions pending={buildingActions.recommendation} accepted={buildingActions.accepted} connected={connected} onAccept={() => onSend({ type: "acceptRecommendation" })} title="Building next actions" headingId="building-actions-heading" />}
      <EvacuationPriorities state={state} floor={floor} onFloor={selectFloor} />
      <BuildingPanel state={state} connected={connected} mode={mode} sync={sync} onSend={onSend} />
    </section>
  );
}
