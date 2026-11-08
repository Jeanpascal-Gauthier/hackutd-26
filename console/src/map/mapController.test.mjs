// No Google key or browser needed: exercise incident pins and camera behavior with Maps doubles.
// Run: node --import tsx --test console/src/map/mapController.test.mjs
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { MapController } from "./mapController.ts";

const objects = [];
class Overlay {
  constructor(options = {}) {
    Object.assign(this, options);
    this.options = options;
    objects.push(this);
  }
  setMap(value) { this.map = value; }
  setOptions(value) { Object.assign(this.options, value); }
  setVisible(value) { this.visible = value; }
  setPaths(value) { this.paths = value; }
  setPosition(value) { this.position = value; }
  setTitle(value) { this.title = value; }
  setIcon(value) { this.icon = value; }
  setZIndex(value) { this.zIndex = value; }
  setOpacity(value) { this.opacity = value; }
  addListener(name, callback) { this[name] = callback; }
}
class Marker extends Overlay {}
class Polygon extends Overlay {}
class Polyline extends Overlay {}
class TrafficLayer extends Overlay {}
class Bounds {
  points = [];
  extend(point) { this.points.push(point); return this; }
  getCenter() {
    const lat = this.points.reduce((sum, p) => sum + p.lat, 0) / this.points.length;
    const lng = this.points.reduce((sum, p) => sum + p.lng, 0) / this.points.length;
    return { lat: () => lat, lng: () => lng };
  }
}
let observers;
beforeEach(() => {
  objects.length = 0;
  observers = [];
  globalThis.google = { maps: {
    Marker, Polygon, Polyline, TrafficLayer, LatLngBounds: Bounds,
    Size: class {}, Point: class {}, SymbolPath: { CIRCLE: 0 },
    event: { clearInstanceListeners(instance) { instance.listenersCleared = true; } },
  } };
  globalThis.document = { documentElement: { dataset: { theme: "dark" } } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
});

const point = (lat = 33, lon = -97) => ({ lat, lon });
const area = [point(), point(33.001), point(33.001, -97.001)];
function incident(id = "one", kind = "fire") {
  const value = { id, kind, label: kind, severity: "serious", status: "located", location: point(), reports: [], time: 1, updated: 1, phase: "open", forecastStatus: "ready" };
  if (kind === "fire") value.fire = {
    wind: null, steps: [{ minute: 5, fire: area, smoke: area }], exposures: [], summary: "Fire model", assumptions: [],
  };
  if (kind === "crash") value.crash = {
    road: "Main", segments: [{ path: [point(), point(33.001)], road: "Main", queueMinute: 5, level: "heavy" }],
    steps: [], summary: "Crash model", assumptions: [],
  };
  return value;
}
function harness() {
  const handlers = new Map();
  const element = {
    addEventListener(name, callback) { handlers.set(name, callback); },
    removeEventListener(name) { handlers.delete(name); },
  };
  const map = {
    fits: 0,
    setOptions() {}, fitBounds() { this.fits++; }, setCenter() {}, setZoom() {},
  };
  const selections = [];
  const controller = new MapController(map, element, (id) => selections.push(id));
  return { controller, map, selections, handlers };
}
function update(controller, incidents, selectedId = incidents[0]?.id ?? null, extra = {}) {
  controller.update({ incidents, selectedId, showTraffic: false, ...extra });
}

test("forecast payloads never draw overlays or change the incident camera", () => {
  const { controller, map } = harness();
  const original = incident();
  update(controller, [original]);
  const count = objects.length;
  const refreshed = structuredClone(original);
  refreshed.forecastAt = 2;
  refreshed.fire.steps[0].fire[1].lat += 1;
  update(controller, [refreshed]);
  update(controller, [incident("crash", "crash")]);
  assert.equal(objects.filter((item) => item instanceof Polygon || item instanceof Polyline).length, 0);
  assert.equal(count, 2); // Traffic layer plus incident pin.
  assert.equal(map.fits, 2); // One fit per selected incident, none for forecast refresh.
  controller.destroy();
});

test("unchanged broadcasts reuse incident pins and preserve the camera", () => {
  const { controller, map } = harness();
  const original = incident();
  update(controller, [original]);
  const count = objects.length;
  update(controller, [structuredClone(original)]);
  assert.equal(objects.length, count);
  assert.equal(map.fits, 1);
  controller.destroy();
});

test("unlocated calls get no pins and a late location fits once", () => {
  const { controller, map } = harness();
  const value = incident();
  value.status = "locating";
  delete value.location;
  update(controller, [value]);
  assert.equal(objects.filter((item) => item instanceof Marker).length, 0);
  assert.equal(map.fits, 0);
  value.status = "located";
  value.location = point();
  update(controller, [value]);
  update(controller, [structuredClone(value)]);
  assert.equal(map.fits, 1);
  controller.destroy();
});

test("pins select incidents, traffic toggles, and cleanup removes objects and subscriptions", () => {
  const { controller, map, selections, handlers } = harness();
  update(controller, [incident()], "one", { showTraffic: true });
  const marker = objects.find((item) => item instanceof Marker);
  marker.click();
  assert.deepEqual(selections, ["one"]);
  const traffic = objects.find((item) => item instanceof TrafficLayer);
  assert.equal(traffic.map, map);
  update(controller, [incident()]);
  assert.equal(traffic.map, null);
  controller.destroy();
  assert.ok(objects.every((item) => item.map === null));
  assert.ok(marker.listenersCleared);
  assert.ok(observers.every((observer) => observer.disconnected));
  assert.equal(handlers.size, 0);
});

