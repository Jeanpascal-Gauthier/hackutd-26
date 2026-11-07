// Tunable coefficients for the illustrative spread model.
// All rates are "fraction of the difference between two rooms moved per minute".
// These are made-up numbers for a demo, not calibrated fire science.

export const COEFFICIENTS = {
  /** Smoke transfer rate per link type (per minute). */
  smoke: {
    openDoor: 0.7,
    closedDoor: 0.1, // closed, not fire-rated
    closedFireRatedDoor: 0.03,
    wall: 0.02, // leakage only
  },
  /** Fire spreads at this fraction of the matching smoke rate (smoke is faster). */
  fireRateRatio: 0.1,
  /** Upward smoke via stairs/elevators = this x the baseline rate (see below). */
  verticalUpMultiplier: 3,
  /** Downward smoke via vertical links = baseline x this. */
  verticalDownMultiplier: 1,
  /** Baseline vertical rate by door state, before the multiplier. */
  verticalBaseline: { open: 0.3, closed: 0.1 },

  /** Fire intensity at minute 0 in the origin room. */
  originInitialFire: 0.2,
  /** A room only self-sustains/grows once fire reaches this; below it fire just accumulates from neighbours. */
  ignitionThreshold: 0.2,
  /** Fraction of remaining headroom a burning room gains each minute. */
  fireGrowth: 0.25,
  /** Smoke produced per minute = this x room fire (a fire overfills its room; excess pushes out). */
  smokeProduction: 1.0,

  /** Smoke transfer is split into this many substeps per minute (numerical stability only). */
  smokeSubsteps: 6,
  /** A stairwell is "clear" on a floor while its smoke stays below this. */
  clearThreshold: 0.3,

  /** Working sprinklers: growth multiplier, hard cap, and decay per minute. */
  sprinkler: { growthMultiplier: 0.2, fireCap: 0.35, decay: 0.05 },
} as const;
