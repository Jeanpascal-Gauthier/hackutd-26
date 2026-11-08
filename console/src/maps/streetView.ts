export interface StreetPanorama {
  pano: string;
  heading: number;
  /** Interior includes unclassified tours; the SDK has no reliable indoor flag. */
  kind: "outdoor" | "interior";
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

type Service = Pick<google.maps.StreetViewService, "getPanorama">;
type PanoramaData = google.maps.StreetViewPanoramaData;

function queryPanorama(service: Service, request: google.maps.StreetViewLocationRequest): Promise<PanoramaData | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Street imagery lookup timed out.")), 15000);
    const failed = () => { clearTimeout(timer); reject(new Error("Street imagery lookup failed.")); };
    try {
      const pending = service.getPanorama(request, (data, status) => {
        clearTimeout(timer);
        if (status === "ZERO_RESULTS") resolve(null);
        else if (status === "OK" && data) resolve(data);
        else failed();
      });
      // The callback handles empty results; consume any corresponding SDK promise rejection.
      void pending?.catch(() => {});
    } catch { failed(); }
  });
}

function panoramaPosition(data: PanoramaData): google.maps.LatLngLiteral {
  const location = data.location;
  const lat = location?.latLng?.lat(), lng = location?.latLng?.lng();
  if (!location?.pano || typeof lat !== "number" || typeof lng !== "number" ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw new Error("Google returned invalid street imagery metadata.");
  return { lat, lng };
}

/** Outdoor-filtered requests can still return landmark interiors. Require street context too. */
function hasStreetContext(data: PanoramaData): boolean {
  const normalize = (text: string) => text.normalize("NFKC").trim().toLocaleLowerCase();
  const description = normalize(data.location?.description ?? "");
  return Boolean(description && data.links?.some(link => {
    const street = normalize(link.description ?? "");
    return street && description.includes(street);
  }));
}

const earthRadius = 6371000;
function distance(a: google.maps.LatLngLiteral, b: google.maps.LatLngLiteral): number {
  const radians = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2 +
    Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lng - a.lng) * radians / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, h)));
}

function surroundingLocations(position: google.maps.LatLngLiteral, metres: number): google.maps.LatLngLiteral[] {
  const radians = Math.PI / 180, lat = position.lat * radians, lng = position.lng * radians;
  const angle = metres / earthRadius;
  return [0, 90, 180, 270].map(degrees => {
    const heading = degrees * radians;
    const targetLat = Math.asin(Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(heading));
    const targetLng = lng + Math.atan2(Math.sin(heading) * Math.sin(angle) * Math.cos(lat), Math.cos(angle) - Math.sin(lat) * Math.sin(targetLat));
    return { lat: targetLat / radians, lng: ((targetLng / radians + 540) % 360) - 180 };
  });
}

/** Prefer street panoramas; keep nearby tours as a separately labelled fallback. */
export async function findPanorama(
  service: Service,
  position: google.maps.LatLngLiteral,
): Promise<StreetPanorama | null> {
  const searches: { radius: number; sources: google.maps.StreetViewSourceString[] }[] = [
    { radius: 150, sources: ["google", "outdoor"] },
    { radius: 500, sources: ["google", "outdoor"] },
    { radius: 500, sources: ["outdoor"] },
  ];
  let tour: PanoramaData | null = null;
  let ambiguousCoverage = false;
  const selected = (data: PanoramaData, kind: StreetPanorama["kind"]): StreetPanorama => ({
    pano: data.location!.pano, heading: kind === "outdoor" ? bearing(panoramaPosition(data), position) : 0, kind,
  });
  for (const { radius, sources } of searches) {
    const data = await queryPanorama(service, { location: position, radius, preference: "nearest", sources });
    if (!data) continue;
    const metres = distance(panoramaPosition(data), position);
    if (metres > 500) continue;
    if (hasStreetContext(data)) return selected(data, "outdoor");
    ambiguousCoverage = true;
    if (!tour && metres <= 50) tour = data;
  }

  // When a landmark tour wins every centre query, search around it to find actual streets.
  if (ambiguousCoverage) {
    for (const metres of [200, 350]) {
      const candidates = await Promise.all(surroundingLocations(position, metres).map(location =>
        queryPanorama(service, { location, radius: metres === 200 ? 100 : 150, preference: "nearest", sources: ["google", "outdoor"] })));
      const streets = candidates.filter((data): data is PanoramaData => {
        if (!data) return false;
        return distance(panoramaPosition(data), position) <= 500 && hasStreetContext(data);
      });
      streets.sort((a, b) => distance(panoramaPosition(a), position) - distance(panoramaPosition(b), position));
      if (streets[0]) return selected(streets[0], "outdoor");
    }
  }

  if (tour) return selected(tour, "interior");
  const fallback = await queryPanorama(service, { location: position, radius: 50, preference: "nearest", sources: ["default"] });
  if (!fallback || distance(panoramaPosition(fallback), position) > 50) return null;
  return selected(fallback, hasStreetContext(fallback) ? "outdoor" : "interior");
}
