import { RIG } from './config.ts';
import { RIG_LIMITS } from './rig.ts';

// Where a character's hands hold the handle. Grips are presentation: physics never reads them.
export const GRIP_PLACEMENTS = ['fixed', 'sliding'] as const;
export type GripPlacement = (typeof GRIP_PLACEMENTS)[number];

// Each hand's distance from the butt. Fixed grips hold there; sliding grips start there and slide together.
export interface Grips {
  readonly placement: GripPlacement;
  readonly left: number;
  readonly right: number;
}

export const DEFAULT_GRIPS: Grips = Object.freeze({ placement: 'fixed', left: 0.04, right: 0.22 });
export const GRIP_LIMITS = { min: 0, max: RIG_LIMITS.handleLength.max, step: 0.01 } as const;
// Space kept between the leading hand and the head's collision block.
export const HEAD_GRIP_CLEARANCE = 0.1;
// No hand holds nearer the head's centre than this, so none enters its collision block.
export const HEAD_GRIP_MARGIN = Math.max(...RIG.headVertices.map((point) => point.x)) + HEAD_GRIP_CLEARANCE;

export interface GripDistances {
  left: number;
  right: number;
}

/**
 * Places both hands along the handle, as distances from its butt, into `out`. `centre` is where
 * the shoulders' midpoint projects onto the handle; `shaftLength` is the butt-to-head distance.
 * Sliding grips centre there, between their authored grips and the head, so the handle slides
 * through the hands and they return to their grips once the butt passes the body. Both are
 * continuous in aim and extension.
 */
export function placeGrips(grips: Grips, centre: number, shaftLength: number, out: GripDistances): GripDistances {
  const farthest = Math.max(0, shaftLength - HEAD_GRIP_MARGIN);
  const left = Math.min(grips.left, farthest);
  const right = Math.min(grips.right, farthest);
  if (grips.placement === 'fixed') {
    out.left = left;
    out.right = right;
    return out;
  }
  // Both hands slide by the same amount, from their grips toward the head.
  const travel = farthest - Math.max(left, right);
  const offset = Math.min(Math.max(centre - (left + right) / 2, 0), travel);
  out.left = left + offset;
  out.right = right + offset;
  return out;
}

export function sameGrips(left: Grips, right: Grips): boolean {
  return left.placement === right.placement && left.left === right.left && left.right === right.right;
}
