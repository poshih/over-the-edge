import { Matrix4, Vector3 } from 'three';
import { ARM_SIDES } from './character';
import type { ArmIkSettings, ArmSide } from './character';
import { createArmPose } from './arm-ik';
import type { ArmPose } from './arm-ik';
import { projectGripShoulder } from './avatar-rig';
import type { AvatarRigFrameContext, AvatarRigFramePlan } from './avatar-rig';
import type { CharacterPresenter, CharacterStance } from './character-presenter';
import type { ReadonlyDeathPose } from './death-pose';
import type { FigureRig } from './figure-rig';
import { DEFAULT_GRIPS, GripHold, headGripMargin } from './grips';
import type { GripDistances, Grips, GripShoulder } from './grips';
import { DEFAULT_HAMMER_HEAD } from './hammer-head';
import type { HammerHead } from './hammer-head';
import { OBSTACLE_LINE } from './obstacle-line';
import { ARM_GEOMETRY } from './player-figure-data';

// Grip placement and IK are shared by every presenter. Imported plans run before either hand is placed.
export class GripArms {
  readonly distances: GripDistances = { left: 0, right: 0 };
  private readonly figure: FigureRig;
  // Where sliding hands have slid to, kept from frame to frame.
  private readonly hold = new GripHold();
  private grips: Grips = DEFAULT_GRIPS;
  private headOutline: HammerHead = DEFAULT_HAMMER_HEAD;
  private headMargin = headGripMargin(DEFAULT_HAMMER_HEAD);
  // Each shoulder against the handle, refreshed every frame for the grip placement.
  private readonly shoulders: Record<ArmSide, GripShoulder> = {
    left: { along: 0, aside2: 0, arm: 0 }, right: { along: 0, aside2: 0, arm: 0 },
  };
  private readonly shoulder = new Vector3();
  private readonly butt = new Vector3();
  private readonly shaftAxis = new Vector3();
  private readonly inverseBody = new Matrix4();
  private readonly avatarTool = new Matrix4();
  private readonly avatarButt = new Vector3();
  private readonly avatarShaft = new Vector3();
  private readonly avatarForward = new Vector3();
  private readonly wristAvatar = new Vector3();
  private readonly handAvatar = new Vector3();
  private readonly targets = { shoulder: new Vector3(), hand: new Vector3(), hint: new Vector3(), shaftAxis: new Vector3() };
  private readonly physicalArms = { left: createArmPose('left'), right: createArmPose('right') };
  private readonly context: { -readonly [K in keyof AvatarRigFrameContext]: AvatarRigFrameContext[K] } = {
    body: new Matrix4(), inverseBody: this.inverseBody, tool: this.avatarTool,
    shaftAxis: this.avatarShaft, forward: this.avatarForward, shaftLength: 0, dt: 0,
  };

  constructor(figure: FigureRig) { this.figure = figure; }

  setStance(stance: Readonly<CharacterStance>): void {
    const grips = stance.grips;
    // New grips put the hands back on them; a new slide point or hand turn leaves them where they hold.
    if (grips.placement !== this.grips.placement || grips.left !== this.grips.left || grips.right !== this.grips.right) {
      this.hold.reset();
    }
    this.grips = grips;
  }

  syncHead(outline: HammerHead): void {
    if (outline === this.headOutline) return;
    this.headOutline = outline;
    this.headMargin = headGripMargin(outline);
  }

  reset(): void { this.hold.reset(); }

  // Every character type takes its hands from the same grip placement on the physical tool frame.
  solve(stance: Readonly<CharacterStance>, settings: Readonly<ArmIkSettings>, presenter: CharacterPresenter, dt: number): readonly ArmPose[] {
    const body = this.figure.torso.matrixWorld, tool = this.figure.toolFrame;
    const { length: shaftLength, angle: shaftAngle } = this.figure.shaft;
    const chains = stance.chains, cos = Math.cos(shaftAngle), sin = Math.sin(shaftAngle);
    const butt = this.butt.setFromMatrixPosition(tool);
    const shaftAxis = this.shaftAxis.set(cos, sin, 0);
    let plan: Readonly<AvatarRigFramePlan> | null = null;
    // Phase 1: the prepared rig writes each side's wrist target track before grips are placed; the arms
    // then follow that plan as the grip rotations turn it.
    if (presenter.kind === 'imported-avatar') {
      this.inverseBody.copy(body).invert();
      this.avatarTool.copy(this.inverseBody).multiply(tool);
      this.avatarButt.setFromMatrixPosition(this.avatarTool);
      this.avatarShaft.set(cos, sin, 0).transformDirection(this.inverseBody);
      this.avatarForward.set(0, 0, 1).transformDirection(this.inverseBody);
      this.context.body = body;
      this.context.shaftLength = shaftLength;
      this.context.dt = dt;
      plan = presenter.planHands(this.context);
    }
    // Every arm reaches from the body's shoulders with the lengths it is drawn at, measured in the course plane as
    // the camera sees it. A 2D arm chain that targets a hand's grip has its authored lengths unless the profile has
    // its own.
    for (const side of ARM_SIDES) {
      const local = chains[side].shoulder;
      const shoulder = this.shoulder.set(local[0], local[1], local[2]);
      // Reach is measured to the wrist, which a rig may hold off the handle's contact point.
      if (plan !== null) shoulder.sub(plan[side].offset);
      shoulder.applyMatrix4(body);
      const lengths = stance.reach[side] ?? chains[side];
      projectGripShoulder(shoulder, butt, shaftAxis, lengths.upper + lengths.forearm, this.shoulders[side]);
    }
    this.hold.place(this.grips, this.shoulders, shaftLength, this.headMargin, this.distances);
    const poses = this.figure.posedArms;
    poses.length = 0;
    for (const side of ARM_SIDES) {
      // An imported avatar supplies its own shoulders and bind-pose bone lengths; grips are shared.
      const chain = chains[side], grip = this.distances[side], targets = this.targets;
      const hand = targets.hand.set(grip, 0, 0).applyMatrix4(tool);
      if (plan !== null) {
        // The IK reaches the wrist, not the contact point, so the palm and its grip can differ.
        this.wristAvatar.copy(this.avatarButt).addScaledVector(this.avatarShaft, grip);
        this.handAvatar.copy(this.wristAvatar).add(plan[side].offset).applyMatrix4(body);
        hand.copy(this.handAvatar);
      }
      targets.shoulder.set(chain.shoulder[0], chain.shoulder[1], chain.shoulder[2]).applyMatrix4(body);
      if (side === 'left') targets.hint.set(settings.leftHintX, settings.leftHintY, settings.leftHintZ);
      else targets.hint.set(settings.rightHintX, settings.rightHintY, settings.rightHintZ);
      targets.hint.applyMatrix4(body);
      targets.shaftAxis.set(cos, sin, 0);
      const pose = presenter.armSolver(side).solve(targets, dt, chain);
      this.figure.placeArm(pose, shaftAngle, stance.gripRotations[side]);
      poses.push(pose);
    }
    return poses;
  }

  // Released poses never visit live grip placement or IK.
  placePhysical(presented: ReadonlyDeathPose): readonly ArmPose[] {
    const poses = this.figure.posedArms;
    for (let index = 0; index < ARM_SIDES.length; index++) {
      const side = ARM_SIDES[index]!, source = presented.arms[side], pose = this.physicalArms[side];
      const previousNormalZ = poses[index]?.normal.z ?? 0;
      pose.shoulder.set(source.shoulder.x, source.shoulder.y, OBSTACLE_LINE);
      pose.elbow.set(source.elbow.x, source.elbow.y, OBSTACLE_LINE);
      pose.hand.set(source.hand.x, source.hand.y, OBSTACLE_LINE);
      pose.normal.set(0, 0, Math.abs(previousNormalZ) > 1e-8
        ? Math.sign(previousNormalZ) : ARM_GEOMETRY[side].normalSign);
      pose.shaftAxis.set(Math.cos(source.hand.angle), Math.sin(source.hand.angle), 0);
      pose.axis.subVectors(pose.hand, pose.shoulder).normalize();
      pose.bendDirection.subVectors(pose.elbow, pose.shoulder).normalize();
      pose.hint.copy(pose.elbow);
      this.figure.placeArm(pose, source.hand.angle, null);
    }
    poses.length = 0;
    poses.push(this.physicalArms.left, this.physicalArms.right);
    return poses;
  }
}
