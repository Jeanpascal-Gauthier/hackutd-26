// Theme resolution. index.html sets data-theme before first paint; this module keeps it in sync.
// Contract for other views (e.g. the 3D panel): <html data-theme="light" | "dark"> always holds the
// resolved theme, and the colour tokens (--bg, --surface, --fire, …) live on :root.
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "firesight-theme";
const META_COLOR: Record<Theme, string> = { light: "#f6f7f8", dark: "#0a0f13" };

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function current(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : stored() ?? systemTheme();
}

/** Swap the theme without every transition on the page animating to the new colours. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLOR[theme]);
  void root.offsetHeight; // force a reflow so the new colours apply with transitions off
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) applyTheme(theme);
    // Follow the OS setting until the operator picks a theme.
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return;
    const onChange = () => { if (!stored()) { const next = systemTheme(); applyTheme(next); setTheme(next); } };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    setTheme((previous) => {
      const next: Theme = previous === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* storage unavailable: still switch for this session */ }
      applyTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
