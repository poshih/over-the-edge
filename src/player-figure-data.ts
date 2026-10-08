// Metres in the character's frame; shared by artwork and the passive death bodies.
import type { ArmSide } from './character';

export const PLAYER_FIGURE = {
  chest: { radius: 0.28, y: 0.56, scale: [0.82, 1.25, 0.77] },
  neck: { top: 0.07, bottom: 0.09, height: 0.16, y: 0.89 },
  helmet: { radius: 0.225, y: 1.095, scaleY: 1.06 },
  upperArm: { top: 0.065, bottom: 0.073 },
  forearm: { top: 0.055, bottom: 0.07 },
  elbow: 0.077,
  hand: 0.083,
  hammerHead: { depth: 0.22, bevel: 0.012 },
} as const;

export const ARM_LENGTH = { upper: 0.82, forearm: 0.82 } as const;
export const ARM_GEOMETRY = {
  left: { shoulder: [-0.17, 0.74, -0.09], normalSign: -1 },
  right: { shoulder: [0.17, 0.74, 0.09], normalSign: 1 },
} as const;

// A two-bone arm: torso-local shoulder and bind-pose segment lengths.
export interface ArmChain {
  readonly shoulder: readonly [number, number, number];
  readonly upper: number;
  readonly forearm: number;
}
export type ArmChains = Readonly<Record<ArmSide, ArmChain>>;

export const DEFAULT_ARM_CHAINS: ArmChains = Object.freeze({
  left: Object.freeze({ shoulder: ARM_GEOMETRY.left.shoulder, upper: ARM_LENGTH.upper, forearm: ARM_LENGTH.forearm }),
  right: Object.freeze({ shoulder: ARM_GEOMETRY.right.shoulder, upper: ARM_LENGTH.upper, forearm: ARM_LENGTH.forearm }),
});
