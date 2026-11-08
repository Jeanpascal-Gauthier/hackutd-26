// Local ambient types for the parts of the Google Maps JavaScript API this folder uses.
// Written by hand so the console needs no @types/google.maps dependency.

interface Window {
  google?: typeof google;
  /** Google calls this when the key is rejected, possibly long after the script has loaded. */
  gm_authFailure?: () => void;
  /** The `callback` named in the script URL. */
  __firewatchMapsReady?: () => void;
}

declare namespace google.maps {
  interface LatLngLiteral { lat: number; lng: number }

  class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }

  class LatLngBounds {
    constructor();
    extend(point: LatLng | LatLngLiteral): LatLngBounds;
    getCenter(): LatLng;
    isEmpty(): boolean;
  }

  class Size { constructor(width: number, height: number) }
  class Point { constructor(x: number, y: number) }

  interface MapsEventListener { remove(): void }

  namespace event {
    function clearInstanceListeners(instance: object): void;
  }

  interface MapTypeStyle {
    featureType?: string;
    elementType?: string;
    stylers: Record<string, string | number>[];
  }

  interface MapOptions {
    center?: LatLngLiteral;
    zoom?: number;
    styles?: MapTypeStyle[];
    backgroundColor?: string;
    disableDefaultUI?: boolean;
    zoomControl?: boolean;
    clickableIcons?: boolean;
    keyboardShortcuts?: boolean;
  }

  class Map {
    constructor(element: HTMLElement, options?: MapOptions);
    setOptions(options: MapOptions): void;
    fitBounds(bounds: LatLngBounds, padding?: number): void;
    setCenter(center: LatLng | LatLngLiteral): void;
    setZoom(zoom: number): void;
  }

  enum SymbolPath { CIRCLE = 0 }

  interface Symbol {
    path: SymbolPath | string;
    scale?: number;
    fillColor?: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
  }

  interface Icon {
    url: string;
    size?: Size;
    scaledSize?: Size;
    anchor?: Point;
  }

  interface MarkerOptions {
    map?: Map | null;
    position: LatLngLiteral;
    icon?: Icon | Symbol;
    title?: string;
    zIndex?: number;
    opacity?: number;
    visible?: boolean;
    clickable?: boolean;
    cursor?: string;
  }

  class Marker {
    constructor(options: MarkerOptions);
    addListener(event: string, handler: () => void): MapsEventListener;
    setMap(map: Map | null): void;
    setPosition(position: LatLngLiteral): void;
    setIcon(icon: Icon | Symbol): void;
    setTitle(title: string): void;
    setZIndex(zIndex: number): void;
    setOpacity(opacity: number): void;
    setVisible(visible: boolean): void;
  }

  interface PolyStyle {
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    zIndex?: number;
    visible?: boolean;
    clickable?: boolean;
  }

  interface PolygonOptions extends PolyStyle {
    map?: Map | null;
    paths?: LatLngLiteral[];
    fillColor?: string;
    fillOpacity?: number;
  }

  class Polygon {
    constructor(options: PolygonOptions);
    setMap(map: Map | null): void;
    setOptions(options: PolygonOptions): void;
    setPaths(paths: LatLngLiteral[]): void;
    setVisible(visible: boolean): void;
  }

  interface PolylineOptions extends PolyStyle {
    map?: Map | null;
    path?: LatLngLiteral[];
  }

  class Polyline {
    constructor(options: PolylineOptions);
    setMap(map: Map | null): void;
    setOptions(options: PolylineOptions): void;
    setVisible(visible: boolean): void;
  }

  class TrafficLayer {
    constructor();
    setMap(map: Map | null): void;
  }

  interface StreetViewPov { heading: number; pitch: number }

  interface StreetViewPanoramaOptions {
    visible?: boolean;
    addressControl?: boolean;
    fullscreenControl?: boolean;
    motionTracking?: boolean;
    motionTrackingControl?: boolean;
    panControl?: boolean;
    zoomControl?: boolean;
    linksControl?: boolean;
    enableCloseButton?: boolean;
    showRoadLabels?: boolean;
    imageDateControl?: boolean;
  }

  class StreetViewPanorama {
    constructor(element: HTMLElement, options?: StreetViewPanoramaOptions);
    setPano(pano: string): void;
    setPov(pov: StreetViewPov): void;
    setVisible(visible: boolean): void;
  }

  enum StreetViewSource { OUTDOOR = "outdoor" }
  enum StreetViewPreference { NEAREST = "nearest" }

  interface StreetViewLocationRequest {
    location: LatLngLiteral;
    radius?: number;
    sources?: StreetViewSource[];
    preference?: StreetViewPreference;
  }

  interface StreetViewPanoramaData {
    imageDate?: string;
    location?: { pano?: string; latLng?: LatLng };
  }

  class StreetViewService {
    constructor();
    getPanorama(request: StreetViewLocationRequest): Promise<{ data: StreetViewPanoramaData }>;
  }
}
