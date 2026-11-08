// Console design tokens, resolved to the #rrggbb values the Maps API needs, plus the base map style.
import { readTheme } from "../building3d/theme";

export interface MapTheme {
  /** Changes only when a colour changes, so theme events that alter nothing can be ignored. */
  key: string;
  isLight: boolean;
  mapBg: string;
  surface: string;
  surface2: string;
  line: string;
  muted: string;
  accent: string;
  fire: string;
  smoke: string;
  warn: string;
  blocked: string;
  heavy: string;
  moderate: string;
  /** The stronger of the dark and light ink colours, for glyphs on a filled pin. */
  inkOn(fill: string): string;
}

let paint: CanvasRenderingContext2D | null | undefined;

/** Turns any CSS colour the browser computed (oklab, color(), rgb) into #rrggbb. */
function toHex(computed: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(computed)) return computed.toLowerCase();
  if (paint === undefined) paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!paint) return fallback;
  paint.fillStyle = "#000000";
  paint.fillStyle = computed;
  if (paint.fillStyle === "#000000" && computed !== "rgb(0, 0, 0)") return fallback; // not parseable here
  paint.clearRect(0, 0, 1, 1);
  paint.fillRect(0, 0, 1, 1);
  const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Reads a token through the CSS engine, so color-mix() tokens come back as a real colour. */
function token(name: string, fallback: string): string {
  if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim()) return fallback;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${name})`;
  document.documentElement.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return toHex(computed, fallback);
}

function brightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

export function readMapTheme(): MapTheme {
  const base = readTheme();
  const fire = toHex(base.fire, "#f26b3f");
  const warn = toHex(base.warn, "#e8b04e");
  const colors = {
    mapBg: token("--map-bg", toHex(base.surface2, "#0c1318")),
    surface: toHex(base.surface, "#10171d"),
    surface2: toHex(base.surface2, "#172129"),
    line: toHex(base.line, "#25313b"),
    muted: toHex(base.muted, "#95a5b0"),
    accent: toHex(base.accent, "#5fd4bd"),
    fire,
    smoke: toHex(base.smoke, "#b9a27a"),
    warn,
    blocked: token("--congestion-blocked", fire),
    heavy: token("--congestion-heavy", fire),
    moderate: token("--congestion-moderate", warn),
  };
  return {
    ...colors,
    isLight: base.isLight,
    key: [base.isLight, ...Object.values(colors)].join(),
    inkOn: (fill) => (brightness(fill) > 0.55 ? "#10171c" : "#ffffff"),
  };
}

/** Muted, low-detail base map built from the console tokens, so overlays carry the emphasis. */
export function mapStyles(theme: MapTheme): google.maps.MapTypeStyle[] {
  const { mapBg, surface, surface2, line, muted, isLight } = theme;
  return [
    { elementType: "geometry", stylers: [{ color: mapBg }] },
    { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { elementType: "labels.text.fill", stylers: [{ color: muted }] },
    { elementType: "labels.text.stroke", stylers: [{ color: mapBg }, { weight: 3 }] },
    { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: line }] },
    { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.neighborhood", elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "landscape.man_made", elementType: "geometry.stroke", stylers: [{ color: line }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "poi.park", elementType: "geometry.fill", stylers: [{ visibility: "on" }, { color: surface2 }] },
    { featureType: "road", elementType: "geometry.fill", stylers: [{ color: surface }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: line }] },
    { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: surface2 }] },
    { featureType: "road.local", elementType: "labels", stylers: [{ visibility: "simplified" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: isLight ? line : surface2 }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: muted }] },
  ];
}
