/**
 * "Pinch and pull" detector: the user pinches (or holds the trigger) while pointing at
 * the city, then draws the hand back toward their body as if pulling themselves into
 * the map. Only horizontal travel along the original pointing direction counts, so a
 * downward-pointing ray still reads a natural pull back toward the chest.
 * Dependency-free so it can be tested in Node.
 */
export interface Vec3Like { x: number; y: number; z: number }

/** Metres of hand travel back toward the body that commit the dive. */
export const PULL_DISTANCE = 0.15;
/** Pushing forward this far first is read as a change of mind. */
const PUSH_CANCEL = 0.08;

export type PullResult = 'idle' | 'pulling' | 'commit' | 'cancel';

export class PullGesture {
  private start: Vec3Like | null = null;
  private backX = 0;
  private backZ = 0;
  /** 0..1 progress toward commit, for feedback visuals. */
  progress = 0;

  get active(): boolean { return this.start !== null; }

  /** Begin at the pinch. `pointing` is the ray direction at that moment. */
  begin(hand: Vec3Like, pointing: Vec3Like): void {
    const length = Math.hypot(pointing.x, pointing.z);
    // A ray straight up or down has no "toward me" direction; fall back to -Z forward.
    const fx = length > 1e-3 ? pointing.x / length : 0;
    const fz = length > 1e-3 ? pointing.z / length : -1;
    this.backX = -fx; this.backZ = -fz;
    this.start = { x: hand.x, y: hand.y, z: hand.z };
    this.progress = 0;
  }

  update(hand: Vec3Like, selecting: boolean): PullResult {
    if (!this.start) return 'idle';
    const pulled = (hand.x - this.start.x) * this.backX + (hand.z - this.start.z) * this.backZ;
    this.progress = Math.min(1, Math.max(0, pulled / PULL_DISTANCE));
    if (pulled >= PULL_DISTANCE) { this.reset(); return 'commit'; }
    if (!selecting || pulled <= -PUSH_CANCEL) { this.reset(); return 'cancel'; }
    return 'pulling';
  }

  reset(): void { this.start = null; this.progress = 0; }
}
