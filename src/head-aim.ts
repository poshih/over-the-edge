import { Euler, MathUtils, Quaternion } from 'three';
import type { Point } from './config';

const HEAD_AIM = {
  responseTime: 0.12,
  forwardBias: 0.35,
  yawLimit: MathUtils.degToRad(75),
  pitchLimit: MathUtils.degToRad(55),
  aimEpsilon: 1e-6,
} as const;

export class HeadAim {
  readonly rotation = new Quaternion();
  private readonly target = new Quaternion();
  private readonly angles = new Euler(0, 0, 0, 'YXZ');
  private previousTime: number | null = null;

  update(aim: Readonly<Point>, time: number): void {
    if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y) || !Number.isFinite(time)) {
      throw new Error('Head aim and time must be finite.');
    }
    const reset = this.previousTime === null || time < this.previousTime;
    if (!reset && time === this.previousTime) return;
    const elapsed = reset ? 0 : time - this.previousTime!;
    const length = Math.hypot(aim.x, aim.y);
    if (length > HEAD_AIM.aimEpsilon) {
      const x = aim.x / length, y = aim.y / length;
      const yaw = MathUtils.clamp(Math.atan2(x, HEAD_AIM.forwardBias), -HEAD_AIM.yawLimit, HEAD_AIM.yawLimit);
      const pitch = MathUtils.clamp(-Math.atan2(y, Math.hypot(x, HEAD_AIM.forwardBias)),
        -HEAD_AIM.pitchLimit, HEAD_AIM.pitchLimit);
      this.angles.set(pitch, yaw, 0);
      this.target.setFromEuler(this.angles);
    } else if (reset) {
      this.target.identity();
    }
    if (reset) this.rotation.copy(this.target);
    else this.rotation.slerp(this.target, -Math.expm1(-elapsed / HEAD_AIM.responseTime));
    this.previousTime = time;
  }

  reset(): void {
    this.previousTime = null;
    this.target.identity();
    this.rotation.identity();
  }
}
