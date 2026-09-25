import { normalizeDegrees, signedDegrees } from './directional-data.ts';
import type { SpriteFlipbook } from './sprite-data.ts';

const FULL_TURN = 360;

// Angles are degrees (right 0, up 90, counterclockwise). Frame i faces startAngle + i * 360 / N.
// An exact midpoint between two frames selects the counterclockwise one.
export function nearestFlipbookFrame(flipbook: SpriteFlipbook, aimAngle: number): number {
  const count = flipbook.images.length;
  return Math.round(normalizeDegrees(aimAngle - flipbook.startAngle) / (FULL_TURN / count)) % count;
}

// Keeps the current frame throughout its sector widened by hysteresis on both sides, including
// the band edges. Beyond that band, or without a current frame, it selects the nearest frame
// directly, so a large aim jump never steps through intermediate frames.
export function selectFlipbookFrame(flipbook: SpriteFlipbook, aimAngle: number, current: number | null): number {
  if (current !== null && flipbook.hysteresis > 0) {
    const spacing = FULL_TURN / flipbook.images.length;
    const distance = Math.abs(signedDegrees(aimAngle - flipbook.startAngle - current * spacing));
    if (distance <= spacing / 2 + flipbook.hysteresis) return current;
  }
  return nearestFlipbookFrame(flipbook, aimAngle);
}
