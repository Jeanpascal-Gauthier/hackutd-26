// Shared fixtures for the portfolio tests: one data-center building and a located map incident.
import type { MapIncident } from "@firewatch/shared/types";
import type { PortfolioBuilding } from "../incidents/stepZero.ts";

export const BUILDING: PortfolioBuilding = {
  id: "dc-1",
  name: "Fairview Data Center",
  address: "1 Test Rd",
  use: "data_center",
  location: { lat: 32.97959, lon: -96.76572 },
  elevationM: 186,
  occupancy: { day: 40, night: 12 },
  systems: [{ id: "hvac", kind: "hvac", label: "Air handlers", dependsOn: [], level: "roof", restoreHours: 6, damageUsd: 1000 }],
  tenants: [{ name: "Cloud Co", slaPenaltyPerHour: 1000, rentPerMonth: 1000, dependsOn: ["hvac"] }],
  access: { roads: ["Coit Rd"] },
};

export function mapIncident(id: string, extra: Partial<MapIncident> = {}): MapIncident {
  return {
    id, kind: "fire", label: "Fire", severity: "critical", status: "located", location: { lat: 32.97659, lon: -96.77042 },
    reports: [{ caller: "a", text: "fire behind the strip mall", time: 1 }], time: 1, updated: 1, phase: "open", forecastStatus: "none",
    ...extra,
  };
}
