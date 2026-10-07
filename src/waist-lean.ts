// A character leans its upper body toward the hammer, turning at the waist. A profile's `waistLean` is the most it
// leans, in degrees; 0 keeps it upright. Live presentation eases toward the target; physics uses that same target
// once at corpse entry, never the view's filter or preview. No imports, so the profile format loads anywhere.
export const DEFAULT_WAIST_LEAN = 0;
export const WAIST_LEAN_LIMITS = { min: 0, max: 45, step: 1 } as const;

const RESPONSE_TIME = 0.15;
const RADIANS_PER_DEGREE = Math.PI / 180;

export function waistLeanTarget(shaftAngle: number, maxLean: number): number {
  return -maxLean * RADIANS_PER_DEGREE * Math.cos(shaftAngle);
}

// A Workshop preview that moves the upper body so secondary motion can be judged without playing: a sway rocks it
// about the waist a few times, a jolt kicks it once.
export type LeanPreview = 'sway' | 'jolt';
const SWAY = { amplitude: 14 * RADIANS_PER_DEGREE, frequency: 1.4, duration: 2.5 } as const;
const JOLT = { amplitude: 18 * RADIANS_PER_DEGREE, rise: 0.05, duration: 0.6 } as const;

/**
 * The upper body's lean: it turns about the waist toward the side the hammer's shaft points, the most when the shaft
 * is level and not at all when it points straight up or down, easing toward that angle, plus any preview. Its angle is
 * counterclockwise in the view's plane, radians. Allocation-free.
 */
export class WaistLean {
  angle = 0;
  // The waist's height above the torso's origin (the player root).
  private readonly pivotY: number;
  private eased = 0;
  private previousTime: number | null = null;
  private previewing: LeanPreview | null = null;
  // When the preview began, in simulation seconds; null until its first frame.
  private previewStart: number | null = null;

  constructor(pivotY: number) {
    this.pivotY = pivotY;
  }

  // `shaftAngle` is the shaft's direction from its butt to its head (radians, counterclockwise from +X); `maxLean` is
  // the profile's waistLean in degrees; `time` is simulation seconds. Pauses and tab hiding settle interpolation; only
  // explicit placements rewind presentation time, and placements also restart lean, with elapsed time clamped at zero.
  update(shaftAngle: number, maxLean: number, time: number): void {
    if (!Number.isFinite(shaftAngle) || !Number.isFinite(maxLean) || !Number.isFinite(time)) {
      throw new Error('The waist lean needs a finite shaft angle, lean and time.');
    }
    // Leaning toward +X, the side a level shaft points to when its angle is 0, turns the upper body clockwise.
    const target = waistLeanTarget(shaftAngle, maxLean);
    const previous = this.previousTime;
    this.previousTime = time;
    if (previous === null) this.eased = target;
    else this.eased += (target - this.eased) * -Math.expm1(-Math.max(0, time - previous) / RESPONSE_TIME);
    this.angle = this.eased + this.previewAngle(time);
  }

  // Rocks or kicks the upper body from the next frame on, over the lean, timed by simulation time like the motion it
  // shows. Placement ends it explicitly; the preview and filter are presentation only.
  preview(kind: LeanPreview): void {
    this.previewing = kind;
    this.previewStart = null;
  }

  reset(): void {
    this.previousTime = null;
    this.eased = 0;
    this.angle = 0;
    this.previewing = null;
  }

  // Ends a running preview at once.
  endPreview(): void {
    this.previewing = null;
  }

  private previewAngle(time: number): number {
    if (this.previewing === null) return 0;
    if (this.previewStart === null) this.previewStart = time;
    const elapsed = Math.max(0, time - this.previewStart);
    const duration = this.previewing === 'sway' ? SWAY.duration : JOLT.duration;
    if (elapsed >= duration) {
      this.previewing = null;
      return 0;
    }
    if (this.previewing === 'sway') {
      return SWAY.amplitude * Math.sin(Math.PI * elapsed / SWAY.duration) * Math.sin(2 * Math.PI * SWAY.frequency * elapsed);
    }
    // Peaks at the rise time, then settles.
    const rise = elapsed / JOLT.rise;
    return JOLT.amplitude * rise * Math.exp(1 - rise);
  }

  // Where the torso's origin, the player root at `x`, `y` when upright, sits once the upper body turns about the waist.
  torsoOrigin(x: number, y: number, out: { x: number; y: number }, angle = this.angle): { x: number; y: number } {
    out.x = x + this.pivotY * Math.sin(angle);
    out.y = y + this.pivotY * (1 - Math.cos(angle));
    return out;
  }
}
