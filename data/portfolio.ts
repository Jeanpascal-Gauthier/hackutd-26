// Checks data/portfolio.json, the CBRE building portfolio the server assesses incidents against
// (same PortfolioBuilding[] shape as agent/fixtures/portfolio.json).
//   npx tsx portfolio.ts [path]   -> "ok: N buildings" or the problems, one per line
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { PortfolioBuilding } from "../agent/core/impact/types.ts";

export const PORTFOLIO_PATH = fileURLToPath(new URL("./portfolio.json", import.meta.url));

const USES = ["data_center", "hospital", "office", "retail", "residential", "industrial"];
const LEVELS = ["basement", "ground", "roof"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((s) => typeof s === "string") ? v : undefined);

/** First dependency cycle among `systems` (dependsOn and backups edges), as "a -> b -> a", or undefined. */
function findCycle(edges: Map<string, string[]>): string | undefined {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id].join(" -> ");
    state.set(id, "open");
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of edges.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

/** Every problem with a portfolio, as readable lines. [] when it is valid. */
export function validatePortfolio(json: unknown): string[] {
  if (!Array.isArray(json)) return ["portfolio must be an array of buildings"];
  const errors: string[] = [];
  const buildingIds = new Set<string>();
  json.forEach((b: unknown, i) => {
    const at = isObj(b) && typeof b.id === "string" ? `building ${b.id}` : `building #${i}`;
    if (!isObj(b)) return void errors.push(`${at}: must be an object`);
    if (typeof b.id !== "string" || !b.id) errors.push(`${at}: id must be a non-empty string`);
    else if (buildingIds.has(b.id)) errors.push(`${at}: duplicate building id`);
    else buildingIds.add(b.id);
    for (const k of ["name", "address"]) if (typeof b[k] !== "string" || !b[k]) errors.push(`${at}: ${k} must be a non-empty string`);
    if (!USES.includes(b.use as string)) errors.push(`${at}: use must be one of ${USES.join(", ")}`);

    const loc = b.location;
    if (!isObj(loc) || !isNum(loc.lat) || !isNum(loc.lon) || Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180 || (loc.lat === 0 && loc.lon === 0))
      errors.push(`${at}: location must be { lat, lon } with sane coordinates`);
    if (!isNum(b.elevationM) || b.elevationM < -500 || b.elevationM > 9000) errors.push(`${at}: elevationM must be metres above sea level`);
    const occ = b.occupancy;
    if (!isObj(occ) || !isNum(occ.day) || !isNum(occ.night) || occ.day < 0 || occ.night < 0)
      errors.push(`${at}: occupancy must be { day, night } numbers >= 0`);

    // Systems: unique ids, sane numbers; edges collected for the reference and cycle checks.
    const systems = Array.isArray(b.systems) ? b.systems : [];
    if (!Array.isArray(b.systems) || systems.length === 0) errors.push(`${at}: systems must be a non-empty array`);
    const systemIds = new Set<string>();
    for (const s of systems) {
      if (isObj(s) && typeof s.id === "string" && s.id) {
        if (systemIds.has(s.id)) errors.push(`${at}: duplicate system id ${s.id}`);
        systemIds.add(s.id);
      } else errors.push(`${at}: every system needs a string id`);
    }
    const edges = new Map<string, string[]>();
    for (const s of systems) {
      if (!isObj(s) || typeof s.id !== "string") continue;
      const sat = `${at} system ${s.id}`;
      if (typeof s.kind !== "string" || !s.kind) errors.push(`${sat}: kind must be a string`);
      if (typeof s.label !== "string" || !s.label) errors.push(`${sat}: label must be a string`);
      if (!LEVELS.includes(s.level as string)) errors.push(`${sat}: level must be one of ${LEVELS.join(", ")}`);
      const deps = strings(s.dependsOn);
      if (!deps) errors.push(`${sat}: dependsOn must be an array of system ids`);
      const backups = s.backups === undefined ? [] : strings(s.backups);
      if (!backups) errors.push(`${sat}: backups must be an array of system ids`);
      for (const ref of [...(deps ?? []), ...(backups ?? [])]) {
        if (!systemIds.has(ref)) errors.push(`${sat}: references unknown system ${ref}`);
        if (ref === s.id) errors.push(`${sat}: depends on itself`);
      }
      edges.set(s.id, [...(deps ?? []), ...(backups ?? [])].filter((ref) => systemIds.has(ref) && ref !== s.id));
      for (const k of ["restoreHours", "damageUsd"]) if (!isNum(s[k]) || (s[k] as number) < 0) errors.push(`${sat}: ${k} must be a number >= 0`);
      for (const k of ["lagMinutes", "runtimeHours"])
        if (s[k] !== undefined && (!isNum(s[k]) || (s[k] as number) < 0)) errors.push(`${sat}: ${k} must be a number >= 0`);
      if (s.facingDegrees !== undefined && (!isNum(s.facingDegrees) || s.facingDegrees < 0 || s.facingDegrees >= 360))
        errors.push(`${sat}: facingDegrees must be 0..359`);
    }
    const cycle = findCycle(edges);
    if (cycle) errors.push(`${at}: dependency cycle ${cycle}`);

    const tenants = Array.isArray(b.tenants) ? b.tenants : undefined;
    if (!tenants) errors.push(`${at}: tenants must be an array`);
    for (const t of tenants ?? []) {
      const tat = `${at} tenant ${isObj(t) && typeof t.name === "string" ? t.name : "?"}`;
      if (!isObj(t) || typeof t.name !== "string" || !t.name) {
        errors.push(`${tat}: name must be a non-empty string`);
        continue;
      }
      for (const k of ["slaPenaltyPerHour", "rentPerMonth"]) if (!isNum(t[k]) || (t[k] as number) < 0) errors.push(`${tat}: ${k} must be a number >= 0`);
      const deps = strings(t.dependsOn);
      if (!deps) errors.push(`${tat}: dependsOn must be an array of system ids`);
      for (const ref of deps ?? []) if (!systemIds.has(ref)) errors.push(`${tat}: references unknown system ${ref}`);
    }

    const access = b.access;
    const roads = isObj(access) ? strings(access.roads) : undefined;
    if (!roads || roads.length === 0) errors.push(`${at}: access.roads must be a non-empty array of road names`);
    else if (isObj(access) && access.fuelRoute !== undefined) {
      if (typeof access.fuelRoute !== "string" || !roads.includes(access.fuelRoute))
        errors.push(`${at}: access.fuelRoute ${String(access.fuelRoute)} must be one of access.roads`);
    }
  });
  return errors;
}

/** Reads and checks a portfolio file. Throws with every problem listed. */
export function readPortfolio(path: string = PORTFOLIO_PATH): PortfolioBuilding[] {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  const errors = validatePortfolio(json);
  if (errors.length) throw new Error(`${path}:\n${errors.join("\n")}`);
  return json as PortfolioBuilding[];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ? resolve(process.argv[2]) : PORTFOLIO_PATH;
  try {
    console.log(`ok: ${readPortfolio(path).length} buildings`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
