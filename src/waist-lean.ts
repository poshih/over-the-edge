// A character leans its upper body toward the hammer, turning at the waist. A profile's `waistLean` is the most it
// leans, in degrees; 0 keeps it upright. Presentation only: physics, grips and aim never see it. No imports, so the
// profile format loads anywhere.
export const DEFAULT_WAIST_LEAN = 0;
export const WAIST_LEAN_LIMITS = { min: 0, max: 45, step: 1 } as const;

const RESPONSE_TIME = 0.15;
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * The upper body's lean: it turns about the waist toward the side the hammer's shaft points, the most when the shaft
 * is level and not at all when it points straight up or down, easing toward that angle. Its angle is counterclockwise
 * in the view's plane, radians. Allocation-free.
 */
export class WaistLean {
  angle = 0;
  // The waist's height above the torso's origin (the player root).
  private readonly pivotY: number;
  private previousTime: number | null = null;

  constructor(pivotY: number) {
    this.pivotY = pivotY;
  }

  // `shaftAngle` is the shaft's direction from its butt to its head (radians, counterclockwise from +X); `maxLean` is
  // the profile's waistLean in degrees; `time` is simulation seconds, and a rewind restarts at the target.
  update(shaftAngle: number, maxLean: number, time: number): void {
    if (!Number.isFinite(shaftAngle) || !Number.isFinite(maxLean) || !Number.isFinite(time)) {
      throw new Error('The waist lean needs a finite shaft angle, lean and time.');
    }
    // Leaning toward +X, the side a level shaft points to when its angle is 0, turns the upper body clockwise.
    const target = -maxLean * RADIANS_PER_DEGREE * Math.cos(shaftAngle);
    const previous = this.previousTime;
    this.previousTime = time;
    if (previous === null || time < previous) {
      this.angle = target;
      return;
    }
    this.angle += (target - this.angle) * -Math.expm1(-(time - previous) / RESPONSE_TIME);
  }

  reset(): void {
    this.previousTime = null;
    this.angle = 0;
  }

  // Where the torso's origin, the player root at `x`, `y` when upright, sits once the upper body turns about the waist.
  torsoOrigin(x: number, y: number, out: { x: number; y: number }): { x: number; y: number } {
    out.x = x + this.pivotY * Math.sin(this.angle);
    out.y = y + this.pivotY * (1 - Math.cos(this.angle));
    return out;
  }
}
