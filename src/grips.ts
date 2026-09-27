import { RIG } from './config.ts';

// Where a character's hands hold the handle. Grips are presentation: physics never reads them.
export const GRIP_STRATEGIES = ['fixed', 'sliding'] as const;
export type GripStrategy = (typeof GRIP_STRATEGIES)[number];
export const DEFAULT_GRIP_STRATEGY: GripStrategy = 'fixed';

// Distances from the butt. Fixed grips stay here; sliding grips keep this order and spacing.
export const BUTT_GRIPS = Object.freeze({ left: 0.04, right: 0.22 });
// Space kept between the leading hand and the head's collision block.
export const HEAD_GRIP_CLEARANCE = 0.1;

const BUTT_CENTRE = (BUTT_GRIPS.left + BUTT_GRIPS.right) / 2;
const HEAD_HALF_LENGTH = Math.max(...RIG.headVertices.map((point) => point.x));

export interface GripDistances {
  left: number;
  right: number;
}

/**
 * Places both hands along the handle, as distances from its butt, into `out`. `centre` is where
 * the shoulders' midpoint projects onto the handle; `shaftLength` is the butt-to-head distance.
 * Sliding grips centre there, clamped between the butt grips and the head, so the handle slides
 * through the hands and they hold the butt once it passes the body. Both are continuous in aim
 * and extension.
 */
export function placeGrips(strategy: GripStrategy, centre: number, shaftLength: number, out: GripDistances): GripDistances {
  if (strategy === 'fixed') {
    out.left = Math.min(BUTT_GRIPS.left, shaftLength);
    out.right = Math.min(BUTT_GRIPS.right, shaftLength);
    return out;
  }
  // How far the hands have slid from the butt grips, stopping short of the head.
  const travel = Math.max(0, shaftLength - HEAD_HALF_LENGTH - HEAD_GRIP_CLEARANCE - BUTT_GRIPS.right);
  const offset = Math.min(Math.max(centre - BUTT_CENTRE, 0), travel);
  out.left = BUTT_GRIPS.left + offset;
  out.right = BUTT_GRIPS.right + offset;
  return out;
}
