// Loads the Google Maps script once for the whole console and reports how that went.
import { useSyncExternalStore } from "react";

export type MapsStatus =
  | { state: "missing-key" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; reason: "auth" | "network" };

const API_KEY = String(import.meta.env.GOOGLE_MAPS_API_KEY ?? "").trim();
const LOAD_TIMEOUT_MS = 20_000;

let status: MapsStatus = API_KEY ? { state: "loading" } : { state: "missing-key" };
let started = false;
const listeners = new Set<() => void>();

function publish(next: MapsStatus) {
  status = next;
  listeners.forEach((listener) => listener());
}

/** A rejected key is final: nothing that arrives later may turn it back into "ready". */
function publishUnlessRejected(next: MapsStatus) {
  if (status.state === "error" && status.reason === "auth") return;
  publish(next);
}

function start() {
  if (started || status.state === "missing-key") return;
  started = true;

  // Hot reload re-runs this module after the script has already loaded.
  if (window.google?.maps?.Map) { publish({ state: "ready" }); return; }

  window.gm_authFailure = () => publish({ state: "error", reason: "auth" });
  // A plain script `load` event can fire before the API is usable; this callback cannot.
  window.__firewatchMapsReady = () => publishUnlessRejected({ state: "ready" });

  // Keep the timeout even when hot reload finds a script whose request is still pending.
  window.setTimeout(() => {
    if (status.state === "loading") publish({ state: "error", reason: "network" });
  }, LOAD_TIMEOUT_MS);

  if (document.querySelector("script[data-firewatch-maps]")) return;
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(API_KEY)}&v=weekly&callback=__firewatchMapsReady`;
  script.async = true;
  script.dataset.firewatchMaps = "";
  script.onerror = () => publishUnlessRejected({ state: "error", reason: "network" });
  document.head.append(script);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getStatus = () => status;

/** Starts the load on first use. Safe to call from any number of components. */
export function useMapsStatus(): MapsStatus {
  return useSyncExternalStore(subscribe, getStatus);
}
