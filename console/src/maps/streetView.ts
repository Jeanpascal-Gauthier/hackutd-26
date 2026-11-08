export interface StreetPanorama {
  pano: string;
  heading: number;
}

let library: Promise<google.maps.StreetViewLibrary> | null = null;

/** Load only when Street View is selected; share the SDK across React mounts. */
export function loadStreetView(key: string): Promise<google.maps.StreetViewLibrary> {
  if (library) return library;
  library = new Promise<google.maps.StreetViewLibrary>((resolve, reject) => {
    const globals = window as Window & {
      __firewatchStreetViewReady?: () => void;
      gm_authFailure?: () => void;
    };
    const script = document.createElement("script");
    const previousAuthFailure = globals.gm_authFailure;
    const cleanup = () => {
      clearTimeout(timer);
      delete globals.__firewatchStreetViewReady;
      if (globals.gm_authFailure === authFailure) globals.gm_authFailure = previousAuthFailure;
    };
    const fail = () => {
      cleanup();
      script.remove();
      reject(new Error("Google street imagery could not be loaded. Check Maps JavaScript API configuration."));
    };
    const authFailure = () => { fail(); previousAuthFailure?.(); };
    const timer = setTimeout(fail, 12000);
    const ready = () => {
      google.maps.importLibrary("streetView")
        .then(result => { cleanup(); resolve(result as google.maps.StreetViewLibrary); })
        .catch(fail);
    };
    if (typeof google !== "undefined" && typeof google.maps?.importLibrary === "function") { ready(); return; }
    globals.__firewatchStreetViewReady = ready;
    globals.gm_authFailure = authFailure;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({
      key, v: "weekly", loading: "async", libraries: "streetView", callback: "__firewatchStreetViewReady",
    })}`;
    script.onerror = fail;
    document.head.append(script);
  }).catch(error => { library = null; throw error; });
  return library;
}

/** Initial bearing from the street camera towards the incident building. */
function bearing(from: google.maps.LatLngLiteral, to: google.maps.LatLngLiteral): number {
  const radians = Math.PI / 180;
  const lat1 = from.lat * radians, lat2 = to.lat * radians, delta = (to.lng - from.lng) * radians;
  return (Math.atan2(Math.sin(delta) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)) / radians + 360) % 360;
}

/** Select a specific outdoor Google panorama; never retry with unrestricted/indoor sources. */
export async function findOutdoorPanorama(
  service: Pick<google.maps.StreetViewService, "getPanorama">,
  position: google.maps.LatLngLiteral,
): Promise<StreetPanorama | null> {
  for (const radius of [150, 500]) {
    const data = await new Promise<google.maps.StreetViewPanoramaData | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Street imagery lookup timed out.")), 15000);
      const failed = () => { clearTimeout(timer); reject(new Error("Street imagery lookup failed.")); };
      try {
        const request = service.getPanorama({
          location: position, radius, preference: "nearest", sources: ["google", "outdoor"],
        }, (data, status) => {
          clearTimeout(timer);
          if (status === "ZERO_RESULTS") resolve(null);
          else if (status === "OK" && data) resolve(data);
          else failed();
        });
        // The callback handles empty results; consume any corresponding SDK promise rejection.
        void request?.catch(() => {});
      } catch { failed(); }
    });
    if (!data) continue;
    const location = data.location;
    const lat = location?.latLng?.lat(), lng = location?.latLng?.lng();
    if (!location?.pano || typeof lat !== "number" || typeof lng !== "number" ||
        !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      throw new Error("Google returned invalid street imagery metadata.");
    return { pano: location.pano, heading: bearing({ lat, lng }, position) };
  }
  return null;
}
