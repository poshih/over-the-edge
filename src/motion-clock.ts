// The fixed-step clock secondary motion runs on: sprite and imported-avatar hair, and the motions games register for
// imported avatars. Each frame it turns simulation time into a reset or a number of fixed steps, so motion freezes while
// time stands still, catches up at most MOTION_MAX_STEPS steps, and restarts from rest on a rewind (a restart rewinds
// to 0), after a gap longer than that catch-up, the first time it runs, and after interrupt(). No imports, so the
// profile format loads anywhere.

export const MOTION_STEP_SECONDS = 1 / 60;
export const MOTION_MAX_STEPS = 15;
const MAX_CATCHUP_SECONDS = MOTION_STEP_SECONDS * MOTION_MAX_STEPS;
const TIME_EPSILON = 1e-9;

export class MotionClock {
  // This frame's advance: a reset starts from rest and takes no steps; otherwise `steps` fixed steps, 0 while time
  // stands still.
  reset = true;
  steps = 0;
  private remainder = 0;
  private lastTime: number | null = null;
  private running = false;

  // The motion was not simulated for a while: the next advance resets.
  interrupt(): void {
    this.running = false;
  }

  advance(time: number): void {
    const lastTime = this.lastTime;
    if (!this.running || lastTime === null || time < lastTime || time - lastTime > MAX_CATCHUP_SECONDS) {
      this.reset = true;
      this.steps = 0;
      this.remainder = 0;
    } else {
      this.reset = false;
      this.remainder += time - lastTime;
      this.steps = Math.min(MOTION_MAX_STEPS, Math.floor((this.remainder + TIME_EPSILON) / MOTION_STEP_SECONDS));
      this.remainder = Math.max(0, this.remainder - this.steps * MOTION_STEP_SECONDS);
    }
    this.running = true;
    this.lastTime = time;
  }

  // Continues exactly where `source` left off.
  copyFrom(source: MotionClock): void {
    this.reset = source.reset;
    this.steps = source.steps;
    this.remainder = source.remainder;
    this.lastTime = source.lastTime;
    this.running = source.running;
  }
}
