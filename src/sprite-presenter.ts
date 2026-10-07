import { Vector3 } from 'three';
import type { ArmSide } from './character';
import type { ArmPoseSolver } from './arm-ik';
import type { AvatarRigFrameContext } from './avatar-rig';
import { characterStance, DEFAULT_HEAD_PIVOT, NO_NATURAL_ARMS } from './character-presenter';
import type { CharacterPresenter, CharacterStance, PresentedFrame } from './character-presenter';
import type { FigureRig } from './figure-rig';
import { DEFAULT_ARM_CHAINS } from './player-figure-data';
import type { RigTarget } from './skeleton-pose';
import type { CharacterPresentation } from './sprite-data';
import type { SpriteArmSlots, SpriteRig } from './sprite-rig';

// Each arm's grip target and segment slots, so a character's arm lengths also stretch its 2D arms.
export const SPRITE_ARM_SLOTS: Readonly<Record<ArmSide, SpriteArmSlots>> = Object.freeze({
  left: Object.freeze({ target: 'left-grip', upper: 'left-upper-arm', forearm: 'left-forearm' }),
  right: Object.freeze({ target: 'right-grip', upper: 'right-upper-arm', forearm: 'right-forearm' }),
});

type MutableTarget = { -readonly [K in keyof RigTarget]: RigTarget[K] };

export class SpritePresenter implements CharacterPresenter {
  readonly kind = 'sprite';
  readonly rig: SpriteRig;
  private readonly figure: FigureRig;
  private readonly contact = new Vector3();
  private readonly targets = new Map<string, MutableTarget>(
    ['left-grip', 'right-grip', 'hammer-base', 'hammer-shaft', 'hammer-head', 'aim']
      .map((id): [string, MutableTarget] => [id, { x: 0, y: 0, angle: 0 }]));
  // The aim a sprite character turns its head and faces by: before a presentation preview's turn, which its anchors
  // already carry.
  private readonly spriteFrame = { time: 0, dt: 0, aim: { x: 0, y: 0 }, targets: this.targets };
  private disposed = false;

  constructor(rig: SpriteRig, figure: FigureRig) {
    this.rig = rig; this.figure = figure;
  }

  stanceFor(presentation: Readonly<CharacterPresentation>): CharacterStance {
    const reach = presentation.arms === null ? this.rig.naturalArmLengths() : NO_NATURAL_ARMS;
    return characterStance(presentation, 'figure', DEFAULT_ARM_CHAINS, DEFAULT_HEAD_PIVOT, reach);
  }

  show(shown: boolean): void {
    // Profile selection owns the mounts; hiding only stops this presenter's frame feed.
    if (!shown) this.rig.forgetLiveFrame();
  }

  planHands(_context: Readonly<AvatarRigFrameContext>): null { return null; }
  armSolver(side: ArmSide): ArmPoseSolver { return this.figure.armSolver(side); }

  present(frame: Readonly<PresentedFrame>): void {
    for (const pose of frame.arms) {
      if (frame.phase === 'dying') this.contact.copy(pose.hand);
      else this.contact.set(frame.grips[pose.side], 0, 0).applyMatrix4(frame.tool);
      const target = this.targets.get(SPRITE_ARM_SLOTS[pose.side].target)!;
      target.x = this.contact.x;
      target.y = this.contact.y;
      target.angle = Math.atan2(pose.shaftAxis.y, pose.shaftAxis.x);
    }
    const { base, centre, tip, angle } = frame.shaft;
    const baseTarget = this.targets.get('hammer-base')!;
    baseTarget.x = base.x; baseTarget.y = base.y; baseTarget.angle = angle;
    const shaftTarget = this.targets.get('hammer-shaft')!;
    shaftTarget.x = centre.x; shaftTarget.y = centre.y; shaftTarget.angle = angle;
    const headTarget = this.targets.get('hammer-head')!;
    headTarget.x = tip.x; headTarget.y = tip.y; headTarget.angle = tip.angle;
    const turnCos = Math.cos(frame.turn), turnSin = Math.sin(frame.turn), aim = this.spriteFrame.aim;
    aim.x = frame.aim.x * turnCos + frame.aim.y * turnSin;
    aim.y = frame.aim.y * turnCos - frame.aim.x * turnSin;
    const aimTarget = this.targets.get('aim')!;
    aimTarget.x = frame.cursor.x; aimTarget.y = frame.cursor.y;
    aimTarget.angle = Math.atan2(frame.phase === 'alive' ? frame.aim.y : aim.y, frame.phase === 'alive' ? frame.aim.x : aim.x);
    this.spriteFrame.time = frame.time;
    this.spriteFrame.dt = frame.dt;
    this.rig.setDeathBrightness(frame.phase === 'dying' ? frame.appearance.spriteBrightness : 1);
    this.rig.update(this.spriteFrame);
  }

  setDying(dying: boolean): void {
    this.rig.setDying(dying);
    if (!dying) this.rig.setDeathBrightness(1);
  }

  reset(scope: 'history' | 'placement'): void {
    this.figure.resetPoseHistory();
    if (scope === 'placement') this.rig.resetPresentation();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rig.dispose();
  }
}
