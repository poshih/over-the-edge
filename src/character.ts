import type { Box3, Group, Object3D } from 'three';
import type { VisualVisibility } from './visual-visibility';
import { PLAYER_FIGURE } from './player-figure-data';

export const VISUAL_PART_IDS = [
  'pot', 'torso', 'character-head', 'left-upper-arm', 'right-upper-arm', 'left-forearm', 'right-forearm',
  'left-elbow', 'right-elbow', 'left-hand', 'right-hand', 'hammer-shaft', 'hammer-head',
] as const;
export type VisualPartId = (typeof VISUAL_PART_IDS)[number];
export const SPRITE_TARGET_IDS = [...VISUAL_PART_IDS, 'left-grip', 'right-grip', 'hammer-base', 'aim'] as const;
export const ARM_SIDES = ['left', 'right'] as const;
export type ArmSide = (typeof ARM_SIDES)[number];
export const HEAD_GEOMETRY = { neck: [0, PLAYER_FIGURE.neck.y, 0] } as const;
// Hammer-shaft artwork spans this length along local X and is stretched to the physical shaft.
export const SHAFT_ARTWORK_LENGTH = 1.5;

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
}

export interface VisualBinding {
  readonly anchor: Group;
  readonly modelAnchor: Group;
  readonly defaults: readonly Object3D[];
  readonly bounds: Readonly<Box3>;
  readonly visibility: VisualVisibility;
  // Asset owners retain pending models until placement, or release them if the view closes.
  readonly deferChange?: (apply: () => void, cancel?: () => void) => boolean;
}
