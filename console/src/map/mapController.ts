// Drives one google.maps.Map imperatively from React props. Everything here diffs against what is
// already drawn, because state broadcasts arrive often and usually change nothing on the map.
import type { GeoPoint, MapIncident } from "@firewatch/shared/types";
import { watchTheme } from "../building3d/theme";
import { pinIcon } from "./mapIcons";
import { mapStyles, readMapTheme, type MapTheme } from "./mapTheme";
import type { ForecastScene, SceneShape } from "./forecastModel";

export interface MapViewInput {
  incidents: MapIncident[];
  selectedId: string | null;
  showTraffic: boolean;
  scene?: ForecastScene;
}

export const DEFAULT_CENTER: google.maps.LatLngLiteral = { lat: 32.985, lng: -96.75 }; // Richardson, TX
export const DEFAULT_ZOOM = 11;

const FIT_PADDING = 56;
/** Degrees added around the fit, so one pin does not zoom in to street furniture. */
const MIN_FIT_SPAN = 0.002;

const Z_PIN_RESOLVED = 80;
const Z_PIN = 100;
const Z_PIN_SELECTED = 1000;
const RESOLVED_OPACITY = 0.65;

interface Located extends MapIncident { location: GeoPoint }
const isLocated = (incident: MapIncident): incident is Located => incident.status === "located" && !!incident.location;

interface Pin {
  marker: google.maps.Marker;
  position: string;
  look: string;
  title: string;
  calls: number;
}

function pinTitle(incident: Located) {
  const place = incident.formatted ?? incident.query;
  const base = place ? `${incident.label}: ${place}` : incident.label;
  const calls = incident.reports.length > 1 ? ` · ${incident.reports.length} calls merged` : "";
  return incident.phase === "resolved" ? `${base}${calls} (resolved)` : `${base}${calls}`;
}

export function createMap(element: HTMLElement): google.maps.Map {
  const theme = readMapTheme();
  return new google.maps.Map(element, {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    styles: mapStyles(theme),
    backgroundColor: theme.mapBg,
    disableDefaultUI: true,
    zoomControl: true,
    clickableIcons: false,
    keyboardShortcuts: true,
  });
}

export class MapController {
  private readonly pins = new Map<string, Pin>();
  private readonly traffic = new google.maps.TrafficLayer();
  private readonly disposers: (() => void)[] = [];
  private readonly overlays = new Map<string, { overlay: google.maps.Polygon | google.maps.Polyline; key: string }>();
  private theme: MapTheme = readMapTheme();
  private input: MapViewInput | null = null;

  private trafficOn = false;

  private viewedSelection: string | null | undefined = undefined;
  private fitKey: string | null = null;
  /** A selection asked for a fit that has not happened yet (its incident had no location). */
  private fitOwed = false;
  private operatorMoved = false;

  constructor(
    private readonly map: google.maps.Map,
    element: HTMLElement,
    private readonly select: (id: string) => void,
    private readonly selectBuilding: (id: string) => void = () => {},
  ) {
    this.disposers.push(watchTheme(() => this.applyTheme()));
    const moved = () => { this.operatorMoved = true; };
    for (const type of ["pointerdown", "wheel", "keydown"]) {
      element.addEventListener(type, moved, { capture: true, passive: true });
      this.disposers.push(() => element.removeEventListener(type, moved, { capture: true }));
    }
    this.applyTheme(true);
  }

  update(input: MapViewInput) {
    this.input = input;
    const located = input.incidents.filter(isLocated);
    const selected = located.find((incident) => incident.id === input.selectedId) ?? null;
    this.syncPins(located, input.selectedId);
    this.syncTraffic(input.showTraffic);
    this.syncForecast(input.scene);
    this.syncView(located, selected, input.selectedId);
  }

  destroy() {
    this.disposers.forEach((dispose) => dispose());
    for (const pin of this.pins.values()) this.removePin(pin);
    this.pins.clear();
    this.clearForecast();
    this.traffic.setMap(null);
  }

  private applyTheme(force = false) {
    const next = readMapTheme();
    if (!force && next.key === this.theme.key) return; // watchTheme also fires for unrelated class changes
    this.theme = next;
    this.map.setOptions({ styles: mapStyles(next) });
    if (this.input) this.syncPins(this.input.incidents.filter(isLocated), this.input.selectedId);
  }

  private syncPins(located: Located[], selectedId: string | null) {
    const seen = new Set<string>();
    for (const incident of located) {
      seen.add(incident.id);
      const selected = incident.id === selectedId;
      const resolved = incident.phase === "resolved";
      const position = { lat: incident.location.lat, lng: incident.location.lon };
      const positionKey = `${position.lat},${position.lng}`;
      const look = `${incident.kind}|${selected}|${resolved}|${this.theme.key}`;
      const title = pinTitle(incident);

      let pin = this.pins.get(incident.id);
      if (!pin) {
        const marker = new google.maps.Marker({ map: this.map, position, title });
        const id = incident.id;
        marker.addListener("click", () => this.select(id));
        pin = { marker, position: positionKey, look: "", title, calls: -1 };
        this.pins.set(id, pin);
      }
      if (pin.position !== positionKey) { pin.marker.setPosition(position); pin.position = positionKey; }
      if (pin.title !== title) { pin.marker.setTitle(title); pin.title = title; }
      if (pin.calls !== incident.reports.length) {
        pin.marker.setLabel(incident.reports.length > 1 ? { text: `${incident.reports.length} calls`, className: "fw-call-count", color: "#ffffff", fontSize: "11px", fontWeight: "700" } : null);
        pin.calls = incident.reports.length;
      }
      if (pin.look !== look) {
        pin.marker.setIcon(pinIcon(incident.kind, selected, resolved, this.theme));
        pin.marker.setZIndex(selected ? Z_PIN_SELECTED : resolved ? Z_PIN_RESOLVED : Z_PIN);
        pin.marker.setOpacity(resolved && !selected ? RESOLVED_OPACITY : 1);
        pin.look = look;
      }
    }
    for (const [id, pin] of this.pins) {
      if (seen.has(id)) continue;
      this.removePin(pin);
      this.pins.delete(id);
    }
  }

  private removePin(pin: Pin) {
    google.maps.event.clearInstanceListeners(pin.marker);
    pin.marker.setMap(null);
  }

  private syncTraffic(on: boolean) {
    if (on === this.trafficOn) return;
    this.trafficOn = on;
    this.traffic.setMap(on ? this.map : null);
  }

  private clearForecast() {
    for (const { overlay } of this.overlays.values()) {
      google.maps.event.clearInstanceListeners(overlay);
      overlay.setMap(null);
    }
    this.overlays.clear();
  }

  private syncForecast(scene?: ForecastScene) {
    const seen = new Set<string>();
    for (const shape of scene?.shapes ?? []) {
      seen.add(shape.id);
      const key = JSON.stringify(shape);
      const previous = this.overlays.get(shape.id);
      if (previous?.key === key) continue;
      if (previous) {
        google.maps.event.clearInstanceListeners(previous.overlay);
        previous.overlay.setMap(null);
      }
      const path = shape.path.map((point) => ({ lat: point.lat, lng: point.lon }));
      const overlay = this.createForecastOverlay(shape, path);
      if (shape.buildingId) overlay.addListener("click", () => this.selectBuilding(shape.buildingId!));
      this.overlays.set(shape.id, { overlay, key });
    }
    for (const [id, { overlay }] of this.overlays) if (!seen.has(id)) {
      google.maps.event.clearInstanceListeners(overlay);
      overlay.setMap(null);
      this.overlays.delete(id);
    }
  }

  private createForecastOverlay(shape: SceneShape, path: google.maps.LatLngLiteral[]) {
    const common = { map: this.map, strokeColor: shape.color, strokeWeight: shape.weight, strokeOpacity: shape.opacity, zIndex: shape.zIndex, clickable: !!shape.buildingId };
    return shape.kind === "polygon"
      ? new google.maps.Polygon({ ...common, paths: path, fillColor: shape.color, fillOpacity: shape.opacity, strokeOpacity: shape.weight ? 1 : 0 })
      : new google.maps.Polyline({ ...common, path, strokeOpacity: shape.dashed ? 0 : shape.opacity, icons: shape.dashed ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 2 }, offset: "0", repeat: "12px" }] : undefined });
  }

  /**
   * Moves the camera only when what should be in view changes. A new selection always moves it.
   * Background changes (a location update, a new pin) move it only if the operator has not
   * moved the map themselves.
   */
  private syncView(located: Located[], selected: Located | null, selectedId: string | null) {
    if (selectedId !== this.viewedSelection) {
      this.viewedSelection = selectedId;
      this.fitOwed = true;
    }
    if (selectedId && !selected) return; // Nothing to show until this incident has a location.

    const scenario = this.input?.scene?.scenarioId;
    const key = scenario ? `scenario|${scenario}` : selected
      ? `selected|${selected.location.lat},${selected.location.lon}|${selected.id}`
      : `all|${located.map((incident) => `${incident.id}:${incident.location.lat},${incident.location.lon}`).sort().join()}`;
    if (key === this.fitKey) return;
    this.fitKey = key;
    if (this.operatorMoved && !this.fitOwed) return;
    this.fitOwed = false;
    this.operatorMoved = false;

    if (!selected && located.length === 0) {
      this.map.setCenter(DEFAULT_CENTER);
      this.map.setZoom(DEFAULT_ZOOM);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const incident of scenario ? located : selected ? [selected] : located) {
      bounds.extend({ lat: incident.location.lat, lng: incident.location.lon });
    }
    if (scenario) for (const point of this.input?.scene?.extent ?? []) bounds.extend({ lat: point.lat, lng: point.lon });
    const center = bounds.getCenter();
    bounds.extend({ lat: center.lat() + MIN_FIT_SPAN, lng: center.lng() + MIN_FIT_SPAN });
    bounds.extend({ lat: center.lat() - MIN_FIT_SPAN, lng: center.lng() - MIN_FIT_SPAN });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) this.map.setCenter(center);
    this.map.fitBounds(bounds, FIT_PADDING);
  }
}
