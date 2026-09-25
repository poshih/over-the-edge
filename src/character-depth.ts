const TORSO_DEPTH = 0.27;
const CHEST_FRONT_OFFSET = 0.23;

export const DEFAULT_ARM_FORWARD_DISTANCE = 0.25;
export const ARM_FORWARD_DISTANCE_LIMITS = { min: 0, max: 2, step: 0.01 } as const;

export const PLAYER_DEPTH = {
  pot: 0.22,
  torso: TORSO_DEPTH,
  chestFront: TORSO_DEPTH + CHEST_FRONT_OFFSET,
} as const;

export function getToolDepth(armForwardDistance: number): number {
  return PLAYER_DEPTH.chestFront + armForwardDistance;
}
