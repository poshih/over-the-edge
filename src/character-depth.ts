import { OBSTACLE_LINE } from './obstacle-line.ts';

// The pot collides, so it stands on the obstacle line; the body rides inside it, a little toward the camera.
const TORSO_DEPTH = OBSTACLE_LINE + 0.05;
const CHEST_FRONT_OFFSET = 0.23;

export const DEFAULT_ARM_FORWARD_DISTANCE = 0.25;
export const ARM_FORWARD_DISTANCE_LIMITS = { min: 0, max: 2, step: 0.01 } as const;

export const PLAYER_DEPTH = {
  pot: OBSTACLE_LINE,
  torso: TORSO_DEPTH,
  chestFront: TORSO_DEPTH + CHEST_FRONT_OFFSET,
} as const;

export function getToolDepth(armForwardDistance: number): number {
  return PLAYER_DEPTH.chestFront + armForwardDistance;
}
