// Colours for the 3D view, read from the page's CSS custom properties so the
// scene follows the console theme. Each token falls back to a legacy name and
// then to today's dark palette, so the view works before the tokens land.

export interface Theme3D {
  isLight: boolean;
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  fire: string;
  smoke: string;
  safe: string;
  warn: string;
}

const TOKENS: Record<Exclude<keyof Theme3D, "isLight">, [string[], string]> = {
  bg: [["--bg"], "#0b1116"],
  surface: [["--surface"], "#101920"],
  surface2: [["--surface-2"], "#17232c"],
  line: [["--line"], "#25323c"],
  text: [["--text"], "#dce5e9"],
  muted: [["--text-muted", "--muted"], "#8b9ba6"],
  accent: [["--accent", "--mint"], "#6ad9c3"],
  fire: [["--fire"], "#e8643a"],
  smoke: [["--smoke"], "#a69472"],
  safe: [["--safe"], "#5fd08a"],
  warn: [["--warn", "--orange"], "#ee9b72"],
};

/** Relative luminance of a #rrggbb colour (0..1); unknown formats count as dark. */
function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;
  const n = parseInt(match[1], 16);
  const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function readTheme(): Theme3D {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Theme3D;
  for (const [key, [names, fallback]] of Object.entries(TOKENS) as [keyof typeof TOKENS, [string[], string]][]) {
    let value = "";
    for (const name of names) { value = style.getPropertyValue(name).trim(); if (value) break; }
    out[key] = value || fallback;
  }
  const declared = document.documentElement.dataset.theme;
  out.isLight = declared === "light" ? true : declared === "dark" ? false : luminance(out.surface) > 0.5;
  return out;
}

/** Calls `onChange` when the resolved theme may have changed. Returns an unsubscribe. */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // The CSS may resolve tokens from the media query, so let the cascade settle first.
  const onMedia = () => requestAnimationFrame(onChange);
  media.addEventListener("change", onMedia);
  return () => { observer.disconnect(); media.removeEventListener("change", onMedia); };
}
