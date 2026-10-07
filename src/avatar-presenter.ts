import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { ARM_SIDES } from './character';
import type { ArmSide } from './character';
import type { ArmPoseSolver } from './arm-ik';
import type { AvatarRigFrameContext } from './avatar-rig';
import { AvatarView } from './avatar-view';
import { attachCharacterRoot, characterStance, GripTurn } from './character-presenter';
import type { CharacterPresenter, CharacterStance, PresentedFrame } from './character-presenter';
import type { FigureRig } from './figure-rig';
import type { CharacterPresentation } from './sprite-data';

// Toward the camera: the grip frame's Z in world space.
const WORLD_FORWARD = Object.freeze(new Vector3(0, 0, 1));

export class BuiltInAvatarPresenter implements CharacterPresenter {
  readonly kind = 'built-in-avatar';
  private readonly figure: FigureRig;
  private readonly actors: Object3D;
  private readonly stance: () => CharacterStance;
  private avatar: AvatarView | null = null;
  // Scratch for turning a grip rotation into another space, and each glove's world-space turn this frame.
  private readonly gripTurn = new GripTurn();
  private readonly shaftAxis = new Vector3();
  private readonly gloveTurns: Record<ArmSide, Quaternion | null> = { left: null, right: null };
  private readonly gloveTurnScratch: Record<ArmSide, Quaternion> = { left: new Quaternion(), right: new Quaternion() };

  constructor(figure: FigureRig, actors: Object3D, stance: () => CharacterStance) {
    this.figure = figure; this.actors = actors; this.stance = stance;
  }

  stanceFor(presentation: Readonly<CharacterPresentation>): CharacterStance {
    return characterStance(presentation, 'props');
  }

  show(shown: boolean): void {
    if (shown && this.avatar === null) this.avatar = new AvatarView();
    if (this.avatar !== null) attachCharacterRoot(this.avatar.root, this.actors, shown);
  }

  planHands(_context: Readonly<AvatarRigFrameContext>): null { return null; }
  armSolver(side: ArmSide): ArmPoseSolver { return this.figure.armSolver(side); }

  present(frame: Readonly<PresentedFrame>): void {
    if (this.avatar === null) throw new Error('The built-in avatar must be shown before it is posed.');
    if (frame.phase === 'dying') this.gloveTurns.left = this.gloveTurns.right = null;
    else {
      // Each rotated glove's turn about its grip in world space, where the grip frame follows the tool's shaft
      // axis this frame, for the built-in avatar.
      this.shaftAxis.set(Math.cos(frame.shaft.angle), Math.sin(frame.shaft.angle), 0);
      const rotations = this.stance().gripRotations;
      for (const side of ARM_SIDES) {
        const rotation = rotations[side];
        this.gloveTurns[side] = rotation === null ? null
          : this.gripTurn.write(rotation, this.shaftAxis, WORLD_FORWARD, this.gloveTurnScratch[side]);
      }
    }
    this.avatar.update(frame.body, frame.arms, frame.headRotation, this.gloveTurns, frame.phase === 'alive' ? null : frame.headDelta);
  }

  setDying(_dying: boolean): void {}
  reset(_scope: 'history' | 'placement'): void { this.figure.resetPoseHistory(); }

  inspect() {
    return this.avatar === null ? null : { ...this.avatar.inspect(), visible: this.avatar.root.visible };
  }

  dispose(): void {
    const avatar = this.avatar;
    this.avatar = null;
    avatar?.dispose();
  }
}
