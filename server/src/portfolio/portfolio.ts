// The building portfolio: what CBRE-style records join to an emergency. Eight buildings around
// Campbell Rd and Coit Rd in Richardson, TX, each with its systems and what they depend on, its
// leases (SLA penalty per hour of downtime, rent), the people inside by time of day, and the roads
// it is reached by. SYNTHETIC: names, tenants and dollar figures are invented for the demo.
//
// The dependency list is the dependency graph: utility power -> electrical room (basement) ->
// cooling -> servers. If a system's dependency fails and no backup covers it, it fails too.
import type { PortfolioBuilding, PortfolioSystem, PortfolioTenant } from "@firewatch/shared/types";

const system = (id: string, kind: PortfolioSystem["kind"], label: string, more: Partial<PortfolioSystem> = {}): PortfolioSystem => ({
  id,
  kind,
  label,
  dependsOn: [],
  level: "ground",
  restoreHours: 1,
  damageUsd: 0,
  ...more,
});

const tenant = (name: string, slaPenaltyPerHour: number, rentPerMonth: number, dependsOn: string[]): PortfolioTenant => ({ name, slaPenaltyPerHour, rentPerMonth, dependsOn });

/** Utility feed -> main switchgear in the basement, with a generator behind it when `generator` is set. */
const power = (opts: { generator?: { runtimeHours: number; fuel?: boolean }; basement?: boolean; damageUsd?: number; restoreHours?: number } = {}): PortfolioSystem[] => [
  system("utility", "utility_power", "Utility feed", { restoreHours: 2 }),
  system("elec", "electrical_room", "Main switchgear", {
    level: opts.basement === false ? "ground" : "basement",
    dependsOn: ["utility"],
    ...(opts.generator && { backups: ["generator"] }),
    restoreHours: opts.restoreHours ?? 12,
    damageUsd: opts.damageUsd ?? 150_000,
  }),
  ...(opts.generator
    ? [
        system("generator", "generator", "Backup generator", { dependsOn: opts.generator.fuel === false ? [] : ["fuel"], runtimeHours: opts.generator.runtimeHours, restoreHours: 4 }),
        ...(opts.generator.fuel === false ? [] : [system("fuel", "fuel_supply", "Diesel tank", { restoreHours: 1 })]),
      ]
    : []),
];

/** Rooftop intake -> air handlers. Smoke at the intake gets pulled inside. */
const air = (facingDegrees: number, damageUsd = 20_000): PortfolioSystem[] => [
  system("intake", "air_intake", "Rooftop air intake", { level: "roof", facingDegrees, restoreHours: 2 }),
  system("ahu", "hvac", "Air handlers", { level: "roof", dependsOn: ["intake"], restoreHours: 6, damageUsd }),
];

export const PORTFOLIO: PortfolioBuilding[] = [
  {
    id: "dc-coit",
    name: "Coit Road Data Center",
    address: "2400 N Coit Rd, Richardson, TX",
    use: "data_center",
    location: { lat: 32.9772, lon: -96.769 },
    elevationM: 186,
    occupancy: { day: 60, night: 18 },
    systems: [
      ...power({ generator: { runtimeHours: 4 }, damageUsd: 180_000 }),
      ...air(90, 25_000),
      system("cooling", "cooling", "CRAC cooling units", { dependsOn: ["elec", "ahu"], restoreHours: 4 }),
      system("ups", "ups", "UPS battery bank", { level: "basement", dependsOn: ["elec"], lagMinutes: 10, restoreHours: 1 }),
      system("servers", "servers", "Server halls", { dependsOn: ["cooling", "ups"], restoreHours: 8, damageUsd: 60_000 }),
    ],
    tenants: [
      tenant("Northwind Cloud", 25_000, 220_000, ["servers"]),
      tenant("Halcyon Payments", 12_000, 90_000, ["servers"]),
    ],
    // One road in and out: a crash on Coit Rd cuts the building off, and the diesel truck with it.
    access: { roads: ["Coit Road"], fuelRoute: "Coit Road" },
  },
  {
    id: "dc-edge",
    name: "Campbell Edge Colo",
    address: "1900 W Campbell Rd, Richardson, TX",
    use: "data_center",
    location: { lat: 32.9741, lon: -96.7731 },
    elevationM: 190,
    occupancy: { day: 25, night: 8 },
    systems: [
      ...power({ damageUsd: 90_000 }),
      ...air(180, 15_000),
      system("cooling", "cooling", "CRAC cooling units", { dependsOn: ["elec", "ahu"], restoreHours: 3 }),
      system("ups", "ups", "UPS battery bank", { level: "basement", dependsOn: ["elec"], lagMinutes: 12, restoreHours: 1 }),
      system("servers", "servers", "Server room", { dependsOn: ["cooling", "ups"], restoreHours: 6, damageUsd: 35_000 }),
    ],
    tenants: [tenant("Lone Star Telecom", 8_000, 70_000, ["servers"])],
    access: { roads: ["West Campbell Road", "Coit Road"] },
  },
  {
    id: "hosp-richardson",
    name: "Richardson Medical Pavilion",
    address: "2650 N Coit Rd, Richardson, TX",
    use: "hospital",
    location: { lat: 32.979, lon: -96.7735 },
    elevationM: 192,
    occupancy: { day: 450, night: 380 },
    systems: [
      ...power({ generator: { runtimeHours: 48 }, damageUsd: 220_000, restoreHours: 16 }),
      ...air(270, 30_000),
      system("life", "life_safety", "Fire alarm and emergency lighting", { dependsOn: ["elec"], backups: ["generator"], restoreHours: 2 }),
      system("o2", "medical_gas", "Oxygen manifold", { dependsOn: ["elec"], restoreHours: 6, damageUsd: 15_000 }),
      system("cold", "refrigeration", "Pharmacy cold storage", { dependsOn: ["elec"], restoreHours: 4, damageUsd: 40_000 }),
    ],
    tenants: [
      tenant("Emergency Department", 0, 300_000, ["life", "o2"]),
      tenant("Pharmacy", 0, 45_000, ["cold"]),
    ],
    access: { roads: ["Coit Road", "West Campbell Road"], fuelRoute: "Coit Road" },
  },
  {
    id: "office-campbell-tower",
    name: "Campbell Tower",
    address: "1700 E Campbell Rd, Richardson, TX",
    use: "office",
    location: { lat: 32.976, lon: -96.766 },
    elevationM: 191,
    occupancy: { day: 1200, night: 40 },
    systems: [
      ...power({ generator: { runtimeHours: 12 }, damageUsd: 120_000, restoreHours: 10 }),
      ...air(45, 35_000),
      system("elev", "elevators", "Elevator bank", { dependsOn: ["elec"], restoreHours: 4, damageUsd: 10_000 }),
      system("life", "life_safety", "Fire alarm and sprinklers", { dependsOn: ["elec"], backups: ["generator"], restoreHours: 2 }),
    ],
    tenants: [
      tenant("Redline Law Group", 3_000, 85_000, ["ahu", "elev"]),
      tenant("Summit Insurance", 2_000, 140_000, ["ahu", "elev"]),
    ],
    access: { roads: ["West Campbell Road", "Coit Road", "Greenville Avenue"] },
  },
  {
    id: "office-telecom-plaza",
    name: "Telecom Plaza",
    address: "1600 Plano Rd, Richardson, TX",
    use: "office",
    location: { lat: 32.9715, lon: -96.7705 },
    elevationM: 194,
    occupancy: { day: 600, night: 15 },
    systems: [...power({ basement: false, damageUsd: 80_000, restoreHours: 8 }), ...air(0, 20_000)],
    tenants: [tenant("Brightpath Software", 1_500, 110_000, ["elec", "ahu"])],
    access: { roads: ["Plano Road", "Arapaho Road"] },
  },
  {
    id: "retail-campbell-station",
    name: "Campbell Station Shopping Center",
    address: "1800 W Campbell Rd, Richardson, TX",
    use: "retail",
    location: { lat: 32.9768, lon: -96.7712 },
    elevationM: 188,
    occupancy: { day: 220, night: 6 },
    systems: [
      ...power({ basement: false, damageUsd: 40_000, restoreHours: 6 }),
      ...air(180, 15_000),
      system("fridge", "refrigeration", "Grocery refrigeration", { dependsOn: ["elec"], restoreHours: 6, damageUsd: 75_000 }),
    ],
    tenants: [
      tenant("Fresh Market Grocer", 0, 60_000, ["fridge", "ahu"]),
      tenant("Strip mall restaurants", 0, 35_000, ["ahu"]),
    ],
    access: { roads: ["West Campbell Road", "Coit Road"] },
  },
  {
    id: "retail-coit-commons",
    name: "Coit Commons",
    address: "2900 N Coit Rd, Richardson, TX",
    use: "retail",
    location: { lat: 32.9812, lon: -96.7692 },
    elevationM: 189,
    occupancy: { day: 180, night: 4 },
    systems: [...power({ basement: false, damageUsd: 30_000, restoreHours: 5 }), ...air(90, 12_000)],
    tenants: [tenant("Coit Commons shops", 0, 48_000, ["elec", "ahu"])],
    access: { roads: ["Coit Road", "Renner Road"] },
  },
  {
    id: "res-creekside",
    name: "Creekside Lofts",
    address: "1500 E Campbell Rd, Richardson, TX",
    use: "residential",
    location: { lat: 32.9798, lon: -96.766 },
    elevationM: 183,
    occupancy: { day: 260, night: 520 },
    systems: [
      ...power({ damageUsd: 70_000, restoreHours: 9 }),
      system("elev", "elevators", "Elevators", { dependsOn: ["elec"], restoreHours: 4, damageUsd: 8_000 }),
      system("pumps", "water", "Domestic water pumps", { level: "basement", dependsOn: ["elec"], restoreHours: 3, damageUsd: 12_000 }),
      system("life", "life_safety", "Fire alarm and sprinklers", { dependsOn: ["elec"], restoreHours: 2 }),
    ],
    tenants: [tenant("Residents (HOA)", 0, 190_000, ["elev", "pumps"])],
    access: { roads: ["East Campbell Road", "Greenville Avenue"] },
  },
];
