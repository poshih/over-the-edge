import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { ARM_SIDES } from './character';
import type { ArmSide } from './character';
import { ArmPoseSolver } from './arm-ik';
import type { ArmPose } from './arm-ik';
import { createArmSolutions, createFramePlan, createPose } from './avatar-rig';
import type { AvatarRig, AvatarRigBinds, AvatarRigFrameContext, AvatarRigFramePlan, AvatarRigPoseContext } from './avatar-rig';
import { attachCharacterRoot, characterStance, GripTurn } from './character-presenter';
import type { CharacterPresenter, CharacterStance, PresentedFrame } from './character-presenter';
import type { SkinnedAvatarView } from './skinned-avatar-view';
import type { CharacterPresentation } from './sprite-data';

// The fitted avatar owns both strategy phases and its solver history; no pose leaks between models.
export class ImportedAvatarPresenter implements CharacterPresenter {
  readonly kind = 'imported-avatar';
  readonly view: SkinnedAvatarView;
  private readonly actors: Object3D;
  private readonly stance: () => CharacterStance;
  private readonly binds: AvatarRigBinds;
  private readonly rig: AvatarRig;
  private readonly plan = createFramePlan();
  // A prepared rig's frame plan as the grip rotations turn it: the presenter's own copy, so a strategy's plan,
  // which may carry its state between frames, is never rewritten.
  private readonly turnedPlan = createFramePlan();
  private activePlan: Readonly<AvatarRigFramePlan> = this.plan;
  private readonly pose = createPose();
  private readonly solvers = { left: new ArmPoseSolver('left'), right: new ArmPoseSolver('right') };
  private readonly headPivot: Readonly<Vector3>;
  private readonly inverseBody = new Matrix4();
  private readonly solutions = createArmSolutions();
  private readonly gripTurn = new GripTurn();
  private readonly turn = new Quaternion();
  private readonly context: { -readonly [K in keyof AvatarRigPoseContext]: AvatarRigPoseContext[K] } = {
    body: new Matrix4(), inverseBody: this.inverseBody, plan: this.plan, arms: this.solutions, dt: 0, attachment: 'gripped',
  };
  private disposed = false;

  constructor(view: SkinnedAvatarView, binds: AvatarRigBinds, rig: AvatarRig, actors: Object3D, stance: () => CharacterStance) {
    this.view = view; this.binds = binds; this.rig = rig; this.actors = actors; this.stance = stance;
    this.headPivot = Object.freeze(new Vector3().setFromMatrixPosition(binds.joints.head));
  }

  stanceFor(presentation: Readonly<CharacterPresentation>): CharacterStance {
    return characterStance(presentation, 'props', this.binds.chains, this.headPivot);
  }

  show(shown: boolean): void { attachCharacterRoot(this.view.root, this.actors, shown); }

  // Phase 1 inputs for a prepared rig: the tool frame and the standard hand directions, in avatar space.
  // Returns the plan the arms follow: the rig's own, or the presenter's copy turned about each rotated hand's grip.
  planHands(context: Readonly<AvatarRigFrameContext>): Readonly<AvatarRigFramePlan> {
    this.inverseBody.copy(context.inverseBody);
    this.rig.writeFramePlan(context, this.plan);
    const rotations = this.stance().gripRotations;
    if (rotations.left === null && rotations.right === null) return this.activePlan = this.plan;
    for (const side of ARM_SIDES) {
      const track = this.plan[side], turned = this.turnedPlan[side];
      turned.offset.copy(track.offset);
      turned.shaft.copy(track.shaft);
      turned.forward.copy(track.forward);
      const rotation = rotations[side];
      if (rotation === null) continue;
      // The wrist swings about the grip with the hand, so a rig's wrist offset turns too.
      const turn = this.gripTurn.write(rotation, context.shaftAxis, context.forward, this.turn);
      turned.offset.applyQuaternion(turn);
      turned.shaft.applyQuaternion(turn);
      turned.forward.applyQuaternion(turn);
    }
    return this.activePlan = this.turnedPlan;
  }

  armSolver(side: ArmSide): ArmPoseSolver { return this.solvers[side]; }

  present(frame: Readonly<PresentedFrame>): void {
    if (frame.phase === 'dying') this.inverseBody.copy(frame.body).invert();
    for (const pose of frame.arms) {
      this.captureSolution(pose);
      if (frame.phase === 'dying') {
        const track = this.turnedPlan[pose.side];
        track.offset.set(0, 0, 0);
        track.shaft.copy(pose.shaftAxis).transformDirection(this.inverseBody);
        track.forward.set(0, 0, 1).transformDirection(this.inverseBody);
      }
    }
    const context = this.context;
    context.body = frame.body;
    context.plan = frame.phase === 'alive' ? this.activePlan : this.turnedPlan;
    context.dt = frame.dt;
    context.attachment = frame.phase === 'alive' ? 'gripped' : 'released';
    // Phase 2: the prepared rig composes its mapped-joint matrices from the turned plan and these solutions.
    this.rig.writePose(context, this.pose);
    this.view.apply(frame.body, frame.pot, frame.jarBottom, frame.headRotation, this.pose, frame.time,
      frame.phase === 'alive' ? null : frame.headDelta);
  }

  setDying(_dying: boolean): void {}

  reset(scope: 'history' | 'placement'): void {
    this.solvers.left.reset(); this.solvers.right.reset();
    if (scope === 'placement') this.view.interrupt();
  }

  inspect() {
    const inspected = this.view.inspect();
    return { ...inspected, visible: this.view.root.visible && this.view.root.parent !== null && inspected.modelAttached };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view.dispose();
  }

  // Phase 2 inputs: the solved arm in avatar space, with `wrist` the actual IK target.
  private captureSolution(pose: ArmPose): void {
    const solution = this.solutions[pose.side];
    solution.shoulder.copy(pose.shoulder).applyMatrix4(this.inverseBody);
    solution.elbow.copy(pose.elbow).applyMatrix4(this.inverseBody);
    solution.wrist.copy(pose.hand).applyMatrix4(this.inverseBody);
    solution.normal.copy(pose.normal).transformDirection(this.inverseBody);
  }
}
