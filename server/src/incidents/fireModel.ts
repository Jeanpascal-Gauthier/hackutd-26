// Outdoor fire and smoke forecast: a wind-stretched fire front, a downwind smoke plume, and when
// each reaches the buildings nearby. Deliberately simple; the assumptions travel with the result.
import type { FireExposure, FireForecast, GeoPoint, WindReading } from "@firewatch/shared/types";
import { distanceToRing, pointInRing } from "../buildings/geometry.ts";
import { FORECAST_MINUTES, HORIZON_MINUTES, bearingOf, compass, localFrame, offset, radians, roundPoint, type Metres } from "./geo.ts";

export interface NearbyBuilding {
  id: string;
  name: string | null;
  /** Footprint ring, or empty when only `location` is known. */
  outline: GeoPoint[];
  /** Required when `outline` is empty. */
  location?: GeoPoint;
  /** Set on hospitals, schools and similar: "hospital", "school", "nursing home", ... */
  use?: string;
}

/** `sensitiveSitesUnavailable` means the wider lookup failed, so a missing hospital proves nothing. */
export type NearbyBuildings = NearbyBuilding[] & { sensitiveSitesUnavailable?: boolean };

export const EXPOSURE_RADIUS_METERS = 250; // ordinary buildings are looked up this far out
export const SENSITIVE_RADIUS_METERS = 3000; // hospitals, schools and care homes, this far out

const START_RADIUS = 15; // metres already burning at minute 0
const CALM_RATE = 1; // m/min in every direction when the wind is unknown
const BACKING_RATE = 0.3; // m/min against the wind
const RATE_PER_MPS = 0.6; // extra m/min with the wind, per m/s of wind
const SMOKE_TRANSPORT = 0.6; // share of wind speed the plume's leading edge travels at
const MAX_SMOKE = 6000; // metres
const UNKNOWN_WIND_SMOKE = 30; // m/min, even circle
const MAX_FIRE_ETA = 60; // minutes; buildings further off are left out
const MAX_EXPOSURES = 40;
const RING_POINTS = 36;
const SAME_SPOT = 25; // metres; a point-only building this close is the one that is burning
const MAX_SITES_IN_SUMMARY = 3;

const downwind = (wind: WindReading) => radians(wind.fromDegrees + 180);
const plumeHalfAngle = (speed: number) => radians(speed < 2 ? 45 : speed < 5 ? 25 : 15);
const smokeSpeed = (wind: WindReading) => Math.max(wind.speedMps, 0.7) * 60 * SMOKE_TRANSPORT;

/** Fire front speed (m/min) on a compass bearing. */
function fireRate(wind: WindReading | null, bearing: number): number {
  if (!wind) return CALM_RATE;
  const forward = BACKING_RATE + 0.2 + RATE_PER_MPS * wind.speedMps;
  const alignment = (1 + Math.cos(bearing - downwind(wind))) / 2;
  return BACKING_RATE + (forward - BACKING_RATE) * alignment * alignment;
}

function fireRing(wind: WindReading | null, minute: number): Metres[] {
  return Array.from({ length: RING_POINTS }, (_, i) => {
    const bearing = (i / RING_POINTS) * 2 * Math.PI;
    return offset(bearing, START_RADIUS + fireRate(wind, bearing) * minute);
  });
}

function smokeRing(wind: WindReading | null, minute: number): Metres[] {
  if (!wind) {
    const range = Math.min(MAX_SMOKE, UNKNOWN_WIND_SMOKE * minute);
    return Array.from({ length: RING_POINTS }, (_, i) => offset((i / RING_POINTS) * 2 * Math.PI, range));
  }
  const range = Math.min(MAX_SMOKE, smokeSpeed(wind) * minute);
  const half = plumeHalfAngle(wind.speedMps);
  const centre = downwind(wind);
  const arc = Array.from({ length: 13 }, (_, i) => offset(centre - half + (i / 12) * 2 * half, range));
  return [[0, 0], ...arc];
}

function smokeEta(wind: WindReading | null, bearing: number, range: number): number | null {
  let eta: number;
  if (!wind) eta = range / UNKNOWN_WIND_SMOKE;
  else {
    const off = Math.abs(Math.atan2(Math.sin(bearing - downwind(wind)), Math.cos(bearing - downwind(wind))));
    if (off > plumeHalfAngle(wind.speedMps)) return null;
    eta = range / smokeSpeed(wind);
  }
  return eta <= HORIZON_MINUTES && range <= MAX_SMOKE ? Math.round(eta) : null;
}

/** Whether the forecast has smoke or fire arriving here within its 30 minutes. */
const reached = (b: FireExposure) => b.smokeEtaMinutes !== null || b.fireEtaMinutes <= HORIZON_MINUTES;

function exposures(origin: GeoPoint, wind: WindReading | null, buildings: NearbyBuilding[]): FireExposure[] {
  const frame = localFrame(origin);
  const out: FireExposure[] = [];
  for (const building of buildings) {
    const hasRing = building.outline.length >= 3;
    if (!hasRing && !building.location) continue;
    const ring = hasRing ? building.outline.map(frame.toMetres) : [frame.toMetres(building.location!)];
    const middle: Metres = [ring.reduce((sum, p) => sum + p[0], 0) / ring.length, ring.reduce((sum, p) => sum + p[1], 0) / ring.length];
    const inside = hasRing ? pointInRing([0, 0], ring) : Math.hypot(...middle) <= SAME_SPOT;
    const range = inside ? 0 : hasRing ? distanceToRing([0, 0], ring) : Math.hypot(...middle);
    const bearing = bearingOf(middle);
    const fireEta = Math.max(0, (range - START_RADIUS) / fireRate(wind, bearing));
    const smoke = smokeEta(wind, bearing, range);
    // Past the ordinary lookup radius only sensitive sites exist, and only the plume makes them relevant.
    if (range > EXPOSURE_RADIUS_METERS ? smoke === null : fireEta > MAX_FIRE_ETA && smoke === null) continue;
    out.push({
      id: building.id,
      name: building.name,
      location: building.location ? roundPoint(building.location) : frame.toPoint(middle),
      outline: hasRing ? building.outline.map(roundPoint) : [],
      distanceMeters: Math.round(range),
      origin: inside,
      fireEtaMinutes: Math.round(fireEta),
      smokeEtaMinutes: smoke,
      risk: fireEta <= 15 ? "high" : fireEta <= HORIZON_MINUTES ? "moderate" : "low",
      ...(building.use ? { use: building.use } : {}),
    });
  }
  out.sort((a, b) => a.fireEtaMinutes - b.fireEtaMinutes || Number(Boolean(b.use)) - Number(Boolean(a.use)));
  // The cap only trims ordinary buildings: a reached hospital or school is never cut for space.
  const protectedSite = (b: FireExposure) => b.origin || (Boolean(b.use) && reached(b));
  let room = Math.max(0, MAX_EXPOSURES - out.filter(protectedSite).length);
  return out.filter((b) => protectedSite(b) || room-- > 0);
}

/** Plain sentences naming the sensitive sites the forecast reaches, soonest first. */
function sensitiveSentences(wind: WindReading | null, exposed: FireExposure[]): string[] {
  const label = (b: FireExposure) => (!b.name ? `a ${b.use}` : b.name.toLowerCase().includes(b.use!) ? b.name : `${b.name} (${b.use})`);
  const when = (minutes: number) => (minutes < 1 ? "within a minute" : `in about ${minutes} minute${minutes === 1 ? "" : "s"}`);
  const sentences = exposed.filter((b) => b.use && b.origin).map((b) => `The fire is at ${label(b)}.`);
  const threats = exposed.filter((b) => b.use && !b.origin && reached(b)).map((b) => {
    const fireFirst = b.fireEtaMinutes <= HORIZON_MINUTES && (b.smokeEtaMinutes === null || b.fireEtaMinutes < b.smokeEtaMinutes);
    return { b, fireFirst, eta: fireFirst ? b.fireEtaMinutes : b.smokeEtaMinutes! };
  }).sort((x, y) => x.eta - y.eta);
  const shown = threats.slice(0, MAX_SITES_IN_SUMMARY);
  const more = threats.length - shown.length;
  const list = (fire: boolean) => shown.filter((t) => t.fireFirst === fire).map((t) => `${label(t.b)} ${when(t.eta)}`).join(", ");
  if (list(true)) sentences.push(`Fire could reach ${list(true)}.`);
  if (list(false)) sentences.push(`${wind ? "Smoke" : "With wind unknown, smoke"} could reach ${list(false)}.`);
  if (more) sentences.push(`${more} more sensitive site${more === 1 ? " is" : "s are"} also reached within 30 minutes.`);
  return sentences;
}

function summary(wind: WindReading | null, steps: FireForecast["steps"], exposed: FireExposure[], buildingsKnown: boolean): string {
  const nearby = exposed.filter((b) => !b.origin && b.distanceMeters <= EXPOSURE_RADIUS_METERS);
  const threatened = nearby.filter((b) => b.fireEtaMinutes <= HORIZON_MINUTES).length;
  const smoked = nearby.filter((b) => b.smokeEtaMinutes !== null).length;
  const parts = [
    wind
      ? `Wind from the ${compass(wind.fromDegrees)} at ${Math.round(wind.speedMps)} m/s. Smoke moves ${compass(wind.fromDegrees + 180)}, up to ${(Math.min(MAX_SMOKE, smokeSpeed(wind) * HORIZON_MINUTES) / 1000).toFixed(1)} km by 30 minutes.`
      : "Wind is unknown, so smoke direction is not forecast.",
  ];
  if (buildingsKnown) parts.push(`Fire could reach ${threatened} nearby building${threatened === 1 ? "" : "s"} and smoke ${smoked} within 30 minutes.`, ...sensitiveSentences(wind, exposed));
  return steps.length ? parts.join(" ") : "";
}

/** `buildings` is null when the map data could not be loaded; the fire and smoke areas still come back. */
export function forecastFire(origin: GeoPoint, wind: WindReading | null, buildings: NearbyBuildings | null): FireForecast {
  const frame = localFrame(origin);
  const steps = FORECAST_MINUTES.map((minute) => ({
    minute,
    fire: fireRing(wind, minute).map(frame.toPoint),
    smoke: smokeRing(wind, minute).map(frame.toPoint),
  }));
  const exposed = exposures(origin, wind, buildings ?? []);
  return {
    wind,
    steps,
    exposures: exposed,
    summary: summary(wind, steps, exposed, buildings !== null),
    assumptions: [
      "Illustrative model, not a measured fire or a calibrated fire-behavior simulation.",
      "Fire speed depends on wind only. Fuel, terrain, construction and suppression are not modeled.",
      wind ? "Wind is the current surface reading at this location and is held constant for 30 minutes." : "Weather was unavailable, so smoke is shown as an even circle.",
      buildings ? "Nearby buildings come from OpenStreetMap and may be incomplete." : "Nearby buildings and sensitive sites could not be loaded, so none are listed.",
      ...(!buildings ? [] : [buildings.sensitiveSitesUnavailable
        ? "Hospitals, schools and other sensitive sites could not be checked, so ones beyond the nearby buildings are not listed. Do not read that as none being in the smoke's path."
        : `Hospitals, schools, nursing homes and other sensitive sites come from OpenStreetMap within about ${SENSITIVE_RADIUS_METERS / 1000} km of the fire and may be incomplete. Any further out are not checked, even if smoke reaches that far.`]),
    ],
  };
}
