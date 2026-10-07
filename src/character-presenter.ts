import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { HEAD_GEOMETRY } from './character';
import type { ArmSide } from './character';
import type { ArmPose, ArmPoseSolver } from './arm-ik';
import type { AvatarRigFrameContext, AvatarRigFramePlan } from './avatar-rig';
import type { ArmLengths, CharacterArms } from './character-arms';
import { DEFAULT_ARM_FORWARD_DISTANCE, getToolDepth } from './character-depth';
import type { Point } from './config';
import type { ReadonlyDeathAppearance } from './death-pose';
import type { FigureRig } from './figure-rig';
import { NO_GRIP_ROTATION, sameGripRotation } from './grips';
import type { GripDistances, GripRotation, Grips } from './grips';
import { DEFAULT_ARM_CHAINS } from './player-figure-data';
import type { ArmChains } from './player-figure-data';
import type { Transform2 } from './player-pose';
import { UPPER_BODY_3D } from './sprite-data';
import type { CharacterPresentation } from './sprite-data';

export type PresenterKind = 'mesh-parts' | 'built-in-avatar' | 'imported-avatar' | 'sprite';

// Replaced on a presentation change; no frame rewrites its proportions or grip rotations.
export interface CharacterStance {
  readonly upperBody3d: boolean;
  readonly bodyVisuals: 'figure' | 'props';
  readonly toolDepth: number;
  readonly waistLean: number;
  readonly grips: Grips;
  // Each hand's grip rotation in its grip frame, or null for none.
  readonly gripRotations: Readonly<Record<ArmSide, Quaternion | null>>;
  readonly chains: ArmChains;
  readonly reach: Readonly<Record<ArmSide, ArmLengths | null>>;
  readonly headPivot: Readonly<Vector3>;
}

export interface ShaftFrame {
  readonly base: Readonly<Transform2>;
  readonly centre: Readonly<Point>;
  readonly tip: Readonly<Transform2>;
  readonly length: number;
  readonly angle: number;
}

interface FrameBase {
  readonly time: number;
  readonly dt: number;
  readonly body: Matrix4;
  readonly pot: Matrix4;
  readonly tool: Matrix4;
  readonly shaft: Readonly<ShaftFrame>;
  readonly headRotation: Quaternion;
  readonly arms: readonly ArmPose[];
  readonly cursor: Readonly<Point>;
  readonly aim: Readonly<Point>;
  // The preview turn carried by aim. Death keeps the last live aim and its turn.
  readonly turn: number;
}

export interface LivePresented extends FrameBase {
  readonly phase: 'alive';
  readonly grips: Readonly<GripDistances>;
}
export interface DeathPresented extends FrameBase {
  readonly phase: 'dying';
  readonly headDelta: Matrix4;
  readonly appearance: ReadonlyDeathAppearance;
}
export type PresentedFrame = LivePresented | DeathPresented;

// Renderer-specific hooks over the shared character posing stage.
export interface CharacterPresenter {
  readonly kind: PresenterKind;
  stanceFor(presentation: Readonly<CharacterPresentation>): CharacterStance;
  show(shown: boolean): void;
  planHands(context: Readonly<AvatarRigFrameContext>): Readonly<AvatarRigFramePlan> | null;
  armSolver(side: ArmSide): ArmPoseSolver;
  present(frame: Readonly<PresentedFrame>): void;
  setDying(dying: boolean): void;
  reset(scope: 'history' | 'placement'): void;
  dispose(): void;
}

export const DEFAULT_HEAD_PIVOT: Readonly<Vector3> = Object.freeze(new Vector3(...HEAD_GEOMETRY.neck));
export const NO_NATURAL_ARMS = Object.freeze({ left: null, right: null });

// A character's arm lengths replace the natural chains' segment lengths; shoulders stay.
function withArmLengths(chains: ArmChains, arms: CharacterArms | null): ArmChains {
  if (arms === null) return chains;
  return Object.freeze({
    left: Object.freeze({ ...chains.left, upper: arms.left.upper, forearm: arms.left.forearm }),
    right: Object.freeze({ ...chains.right, upper: arms.right.upper, forearm: arms.right.forearm }),
  });
}

// A hand's grip rotation as a quaternion in its grip frame, or null for none, so unrotated hands do no
// per-frame work. Three.js's 'ZYX' order composes Rz · Ry · Rx: X first, then Y, then Z, about fixed axes.
function gripQuaternion(rotation: GripRotation): Quaternion | null {
  if (sameGripRotation(rotation, NO_GRIP_ROTATION)) return null;
  return new Quaternion().setFromEuler(new Euler(
    MathUtils.degToRad(rotation.x), MathUtils.degToRad(rotation.y), MathUtils.degToRad(rotation.z), 'ZYX'));
}

export function characterStance(presentation: Readonly<CharacterPresentation>, bodyVisuals: CharacterStance['bodyVisuals'],
  chains: ArmChains = DEFAULT_ARM_CHAINS, headPivot: Readonly<Vector3> = DEFAULT_HEAD_PIVOT,
  reach: CharacterStance['reach'] = NO_NATURAL_ARMS): CharacterStance {
  const upperBody3d = UPPER_BODY_3D[presentation.characterRiggingType];
  // 2D characters keep the wrist rotation authored on their IK chains, and their art hangs from these
  // hand anchors, so only 3D hands turn on their grips.
  const rotation = upperBody3d ? presentation.grips.rotation : null;
  return Object.freeze({
    upperBody3d, bodyVisuals,
    toolDepth: getToolDepth(upperBody3d ? presentation.armForwardDistance : DEFAULT_ARM_FORWARD_DISTANCE),
    waistLean: upperBody3d ? presentation.waistLean : 0,
    grips: presentation.grips,
    gripRotations: Object.freeze(rotation === null ? { left: null, right: null }
      : { left: gripQuaternion(rotation.left), right: gripQuaternion(rotation.right) }),
    chains: withArmLengths(chains, presentation.arms),
    reach, headPivot,
  });
}

export function attachCharacterRoot(object: Object3D, parent: Object3D, attached: boolean): void {
  object.visible = attached;
  if (!attached) object.removeFromParent();
  else if (object.parent !== parent) parent.add(object);
}

// Shared numeric scratch; allocated once per presenter, never per hand or frame.
export class GripTurn {
  private readonly basis = new Matrix4();
  private readonly frame = new Quaternion();
  private readonly across = new Vector3();

  // `rotation`, given in a hand's grip frame, as a turn in the space where that frame's X (the handle,
  // toward the head) is `shaft` and its Z (toward the camera) is `forward`.
  write(rotation: Quaternion, shaft: Vector3, forward: Vector3, out: Quaternion): Quaternion {
    this.across.crossVectors(forward, shaft);
    this.frame.setFromRotationMatrix(this.basis.makeBasis(shaft, this.across, forward));
    return out.copy(this.frame).multiply(rotation).multiply(this.frame.invert());
  }
}

export class MeshPartsPresenter implements CharacterPresenter {
  readonly kind = 'mesh-parts';
  private readonly figure: FigureRig;

  constructor(figure: FigureRig) { this.figure = figure; }

  stanceFor(presentation: Readonly<CharacterPresentation>): CharacterStance {
    return characterStance(presentation, 'figure');
  }

  show(_shown: boolean): void {}
  planHands(_context: Readonly<AvatarRigFrameContext>): null { return null; }
  armSolver(side: ArmSide): ArmPoseSolver { return this.figure.armSolver(side); }
  present(_frame: Readonly<PresentedFrame>): void {}
  setDying(_dying: boolean): void {}
  reset(_scope: 'history' | 'placement'): void { this.figure.resetPoseHistory(); }
  dispose(): void {}
}
