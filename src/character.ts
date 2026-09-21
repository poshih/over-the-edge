import type { Box3, Group, Object3D } from 'three';
import type { VisualVisibility } from './visual-visibility';

export const VISUAL_PART_IDS = [
  'pot', 'torso', 'character-head', 'left-upper-arm', 'right-upper-arm', 'left-forearm', 'right-forearm',
  'left-elbow', 'right-elbow', 'left-hand', 'right-hand', 'hammer-shaft', 'hammer-head',
] as const;
export type VisualPartId = (typeof VISUAL_PART_IDS)[number];
export const SPRITE_TARGET_IDS = [...VISUAL_PART_IDS, 'left-grip', 'right-grip', 'hammer-base', 'aim'] as const;
export const ARM_SIDES = ['left', 'right'] as const;
export type ArmSide = (typeof ARM_SIDES)[number];

export interface ArmIkSettings {
  leftHintX: number;
  leftHintY: number;
  leftHintZ: number;
  rightHintX: number;
  rightHintY: number;
  rightHintZ: number;
}

export const DEFAULT_ARM_IK: Readonly<ArmIkSettings> = Object.freeze({
  leftHintX: -0.55, leftHintY: 0.15, leftHintZ: -0.35,
  rightHintX: 0.55, rightHintY: 0.15, rightHintZ: 0.45,
});

export interface CharacterState {
  armIk: Readonly<ArmIkSettings>;
  shaft: 'segmented' | 'straight';
}

export interface VisualBinding {
  readonly anchor: Group;
  readonly defaults: readonly Object3D[];
  readonly bounds: Readonly<Box3>;
  readonly visibility: VisualVisibility;
}
