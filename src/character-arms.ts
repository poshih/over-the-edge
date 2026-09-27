// A character's own arm lengths. They replace each type's natural ones (the built-in arms, an
// imported avatar's bind pose, a 2D skeleton's arm bones), so every type draws the same arms.
export interface ArmLengths {
  readonly upper: number;
  readonly forearm: number;
}

export type CharacterArms = Readonly<Record<'left' | 'right', ArmLengths>>;

export const ARM_LENGTH_LIMITS = { min: 0.1, max: 2, step: 0.01 } as const;

export function sameArms(left: CharacterArms | null, right: CharacterArms | null): boolean {
  if (left === null || right === null) return left === right;
  return left.left.upper === right.left.upper && left.left.forearm === right.left.forearm &&
    left.right.upper === right.right.upper && left.right.forearm === right.right.forearm;
}
