// The CBRE building portfolio (data/portfolio.json) the server assesses map incidents against.
// Read once and cached. A missing or unreadable file logs why and gives [], so the server keeps
// running with the portfolio feature off. Full checks live in data/portfolio.ts (npm test -w data).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PortfolioBuilding } from "../incidents/stepZero.ts";

export const PORTFOLIO_URL = new URL("../../../data/portfolio.json", import.meta.url);

const cache = new Map<string, PortfolioBuilding[]>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPoint = (v: unknown) => isObj(v) && Number.isFinite(v.lat) && Number.isFinite(v.lon);

/** Light check: the buildings the impact tools can use (id, location, systems, tenants, roads). Others are dropped. */
export function parsePortfolio(json: unknown): { buildings: PortfolioBuilding[]; dropped: number } {
  if (!Array.isArray(json)) return { buildings: [], dropped: 0 };
  const seen = new Set<string>();
  const buildings = json.filter((b): b is PortfolioBuilding => {
    const ok = isObj(b) && typeof b.id === "string" && !!b.id && !seen.has(b.id as string) && typeof b.name === "string" && isPoint(b.location)
      && Array.isArray(b.systems) && Array.isArray(b.tenants) && isObj(b.access) && Array.isArray(b.access.roads);
    if (ok) seen.add(b.id as string);
    return ok;
  });
  return { buildings, dropped: json.length - buildings.length };
}

/** The portfolio at `url` (default data/portfolio.json), cached per file. Never throws. */
export function loadPortfolio(url: URL = PORTFOLIO_URL): PortfolioBuilding[] {
  const cached = cache.get(url.href);
  if (cached) return cached;
  let buildings: PortfolioBuilding[] = [];
  try {
    const json: unknown = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    const parsed = parsePortfolio(json);
    if (!Array.isArray(json)) console.error(`[portfolio] ${fileURLToPath(url)} is not an array of buildings; portfolio impact is off`);
    else if (parsed.dropped) console.warn(`[portfolio] skipped ${parsed.dropped} malformed building(s) in ${fileURLToPath(url)}`);
    buildings = parsed.buildings;
  } catch (err) {
    console.error(`[portfolio] could not read ${fileURLToPath(url)}: ${(err as Error).message}; portfolio impact is off`);
  }
  cache.set(url.href, buildings);
  return buildings;
}
