// Inline SVG marker icons, drawn in the same 24px / 1.75-stroke language as console/src/Icons.tsx.
import type { MapIncidentKind } from "@firewatch/shared/types";
import type { MapTheme } from "./mapTheme";

const GLYPHS: Record<MapIncidentKind, string> = {
  fire: '<path d="M12 3c.5 3.2 4.5 5.4 4.5 10a4.5 4.5 0 0 1-9 0c0-2 1-3.4 2-4.5.3 1.6 1.1 2.6 2 3 0-2.8-.4-5.6.5-8.5Z"/>',
  crash: '<path d="M4 13.5 6 8.2A2 2 0 0 1 7.9 7h8.2A2 2 0 0 1 18 8.2l2 5.3V17H4v-3.5Z"/><path d="M4.5 13h15M6.5 17v2M17.5 17v2M7.5 15h.01M16.5 15h.01"/>',
  other: '<path d="M12 4 3.5 19h17L12 4Z"/><path d="M12 10v4M12 16.6h.01"/>',
};

// A rounded square like the brand mark, with a short tail that points at the exact location.
const PIN_WIDTH = 36;
const PIN_HEIGHT = 42;
const PIN_TIP_Y = 40.5;
const PIN_OUTLINE = "M9 1.5H27A7.5 7.5 0 0 1 34.5 9V27A7.5 7.5 0 0 1 27 34.5H22L18 40.5L14 34.5H9A7.5 7.5 0 0 1 1.5 27V9A7.5 7.5 0 0 1 9 1.5Z";
const ICON_STROKE = 1.75;
const SELECTED_SCALE = 1.2;

function svgIcon(svg: string, width: number, height: number, anchorX: number, anchorY: number): google.maps.Icon {
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(width, height),
    anchor: new google.maps.Point(anchorX, anchorY),
  };
}

export function pinIcon(kind: MapIncidentKind, selected: boolean, resolved: boolean, theme: MapTheme): google.maps.Icon {
  const kindColor = resolved ? theme.muted : kind === "fire" ? theme.fire : kind === "crash" ? theme.warn : theme.accent;
  const scale = selected ? SELECTED_SCALE : 1;
  const fill = selected ? kindColor : theme.surface;
  const glyph = selected ? theme.inkOn(fill) : kindColor;
  const outline = selected ? theme.accent : kindColor;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH * scale}" height="${PIN_HEIGHT * scale}" viewBox="0 0 ${PIN_WIDTH} ${PIN_HEIGHT}" fill="none">`
    + `<path d="${PIN_OUTLINE}" fill="${fill}" stroke="${outline}" stroke-width="${selected ? 2 / scale : 1.25}" stroke-linejoin="round"/>`
    + `<g transform="translate(6 6)" stroke="${glyph}" stroke-width="${ICON_STROKE / scale}" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[kind]}</g>`
    + "</svg>";
  return svgIcon(svg, PIN_WIDTH * scale, PIN_HEIGHT * scale, (PIN_WIDTH / 2) * scale, PIN_TIP_Y * scale);
}

/** A diamond holding the people glyph: a hospital, school, or similar site the forecast has reached. */
export function sensitiveSiteIcon(color: string, theme: MapTheme): google.maps.Icon {
  const size = 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">`
    + `<path d="M15 1.5 28.5 15 15 28.5 1.5 15Z" fill="${theme.surface}" stroke="${color}" stroke-width="1.75" stroke-linejoin="round"/>`
    + `<g transform="translate(8.1 8.1) scale(.575)" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">`
    + '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6M17.5 19.5a5.5 5.5 0 0 0-2-4.2"/>'
    + "</g></svg>";
  return svgIcon(svg, size, size, size / 2, size / 2);
}

/** A small flat dot for an exposed building that has no mapped footprint. */
export function exposureDot(color: string, theme: MapTheme): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 5,
    fillColor: color,
    fillOpacity: 0.85,
    strokeColor: theme.surface,
    strokeWeight: 1.25,
  };
}
