// The one cost model. assess_property_impact prices a chain with it; plan_actions prices each
// action as (cost of the chain) - (cost with the steps it prevents stopped); the console's
// Execute button lowers the risk number by the same rule (residualCost).
import type { CostBreakdown, FailureStep, PlannedAction, PortfolioBuilding } from "./types.ts";

/** Hours a whole building stays shut after an evacuation step (systemId "building"). */
export const EVACUATION_HOURS = 3;
const HOURS_PER_MONTH = 730;

/** The chain with `prevented` steps removed, and every step that follows from them (causedBy, transitively). */
export function withoutPrevented(chain: FailureStep[], prevented: Iterable<string>): FailureStep[] {
  const gone = new Set(prevented);
  // Chains are short and time ordered, but causedBy may point forward after edits: loop to a fixpoint.
  let changed = gone.size > 0;
  while (changed) {
    changed = false;
    for (const s of chain) {
      if (!gone.has(s.id) && s.causedBy !== null && gone.has(s.causedBy)) {
        gone.add(s.id);
        changed = true;
      }
    }
  }
  return chain.filter((s) => !gone.has(s.id));
}

export interface CostResult extends CostBreakdown {
  downtimeHours: number;
}

/** What `chain` costs `building`, after stopping `prevented` steps. Whole dollars. */
export function estimateCost(building: PortfolioBuilding, chain: FailureStep[], prevented: Iterable<string> = []): CostResult {
  const steps = withoutPrevented(chain, prevented);
  const failed = new Set(steps.map((s) => s.systemId));
  const systems = new Map(building.systems.map((s) => [s.id, s]));
  const hoursDown = (id: string) => systems.get(id)?.restoreHours ?? 0;
  const evacuated = failed.has("building");

  let slaUsd = 0;
  let lostRentUsd = 0;
  let downtimeHours = evacuated ? EVACUATION_HOURS : 0;
  for (const t of building.tenants) {
    let hrs = evacuated ? EVACUATION_HOURS : 0;
    for (const dep of t.dependsOn) if (failed.has(dep)) hrs = Math.max(hrs, hoursDown(dep));
    slaUsd += t.slaPenaltyPerHour * hrs;
    lostRentUsd += (t.rentPerMonth / HOURS_PER_MONTH) * hrs;
    downtimeHours = Math.max(downtimeHours, hrs);
  }
  let damageUsd = 0;
  for (const id of failed) damageUsd += systems.get(id)?.damageUsd ?? 0;

  const r = (n: number) => Math.round(n);
  return {
    slaUsd: r(slaUsd),
    lostRentUsd: r(lostRentUsd),
    damageUsd: r(damageUsd),
    totalUsd: r(slaUsd) + r(lostRentUsd) + r(damageUsd),
    downtimeHours: Math.round(downtimeHours * 10) / 10,
  };
}

/** USD still at risk once the `done` actions are carried out. */
export function residualCost(building: PortfolioBuilding, chain: FailureStep[], actions: PlannedAction[]): CostResult {
  const prevented = actions.filter((a) => a.status === "done").flatMap((a) => a.prevents);
  return estimateCost(building, chain, prevented);
}
