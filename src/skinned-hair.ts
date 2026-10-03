import { Matrix4, Quaternion, Vector3 } from 'three';
import { HairSolver } from './hair-solver';
import type { HairChainState } from './hair-solver';
import type { AvatarJointId } from './character-profile';
import { RIG } from './config';
import type { ResolvedAvatarHair } from './character-model-inspect';
import type { AvatarMotion, AvatarMotionFrame, AvatarMotionModel, AvatarMotionSkeleton } from './avatar-motion';

// A chain joint: its avatar-space bind and the bind offset of the next joint (or the tip's, repeated), and this
// frame's rest frame and position, simulated position and turn.
interface HairJoint {
  readonly bind: Matrix4;
  readonly bindPosition: Vector3;
  readonly segment: Vector3;
  readonly rest: Matrix4;
  readonly restPosition: Vector3;
  readonly restDirection: Vector3;
  readonly position: Vector3;
  readonly turn: Quaternion;
}

interface SkinnedChain {
  readonly follows: AvatarJointId;
  // Where the chain's joints start among the motion's claims.
  readonly offset: number;
  readonly joints: readonly HairJoint[];
  readonly state: HairChainState;
  // The world depth of each joint's rest position, which the simulated joint keeps.
  readonly depth: Float64Array;
}

// A collider's centre, carried by a mapped joint's motion from its avatar-space place at bind, or held in the jar's
// frame (origin at its bottom-centre), which stays with the physical pot as the body leans.
type SkinnedCollider =
  | { readonly frame: 'joint'; readonly joint: AvatarJointId; readonly centre: Vector3 }
  | { readonly frame: 'pot'; readonly centre: Vector3 };

const DIRECTION_EPSILON = 1e-9;

/**
 * An imported avatar's spring-bone hair (docs/characters.md, Hair on an imported avatar), the first built-in motion:
 * it claims its chains' joints and runs through the same interface as the motions games register. A chain's root
 * follows its mapped joint rigidly, its rest frame; the joints after it rest at their bind offsets from the root in
 * the body's frame, so hair keeps hanging as authored while a head turns, and those rest positions give the shared
 * hair solver its targets and segment lengths. The solver moves the joints in the world's X-Y plane, the game's view,
 * on the steps of the avatar's motion clock. Each joint keeps the world depth of its rest position and turns by the
 * least rotation that carries its rest segment onto the simulated one, so the skin bends along the chain; the tip
 * joint turns with the last segment. Colliders are carried by their mapped joints, or held by the jar. Pure, built
 * from the model's facts; its per-frame cost is bounded by the chains' joints and the colliders.
 */
export class HairMotion implements AvatarMotion {
  readonly claims: readonly number[];
  private readonly solver: HairSolver;
  private readonly chains: readonly SkinnedChain[];
  private readonly colliders: readonly SkinnedCollider[];
  private readonly bindInverse: Readonly<Record<AvatarJointId, Matrix4>>;
  private readonly follow = new Matrix4();
  private readonly bodyInverse = new Matrix4();
  private readonly frame = new Matrix4();
  private readonly point = new Vector3();
  private readonly direction = new Vector3();

  // `joints` gives each chain joint's index among the model's skin joints.
  constructor(hair: ResolvedAvatarHair, model: AvatarMotionModel, joints: readonly (readonly number[])[]) {
    this.solver = new HairSolver(hair.chains.map(resolved => ({ parameters: resolved.chain, segments: resolved.nodes.length - 1 })),
      hair.colliders.map(collider => collider.radius));
    let offset = 0;
    this.chains = Object.freeze(hair.chains.map((resolved, index): SkinnedChain => {
      const binds = joints[index]!.map(joint => new Matrix4().copy(model.joints[joint]!.bind));
      const positions = binds.map(bind => new Vector3().setFromMatrixPosition(bind));
      const chain: SkinnedChain = {
        follows: resolved.follows,
        offset,
        joints: Object.freeze(binds.map((bind, at) => ({
          bind, bindPosition: positions[at]!,
          // The tip joint has no next joint; its segment repeats the last one.
          segment: at + 1 < positions.length ? positions[at + 1]!.clone().sub(positions[at]!) : positions[at]!.clone().sub(positions[at - 1]!),
          rest: new Matrix4(), restPosition: new Vector3(), restDirection: new Vector3(),
          position: new Vector3(), turn: new Quaternion(),
        }))),
        state: this.solver.chains[index]!,
        depth: new Float64Array(binds.length),
      };
      offset += binds.length;
      return chain;
    }));
    this.claims = Object.freeze(joints.flat());
    const mappedBind = (id: AvatarJointId): Readonly<Matrix4> => model.joints[model.mapped[id]]!.bind;
    this.colliders = Object.freeze(hair.colliders.map((collider): SkinnedCollider => collider.joint === 'pot'
      // The jar's bottom-centre is at the player root's pot bottom at bind.
      ? { frame: 'pot', centre: new Vector3(collider.x, collider.y - RIG.potBottom, 0) }
      // In the plane of the joint it rides on.
      : {
        frame: 'joint', joint: collider.joint,
        centre: new Vector3(collider.x, collider.y, new Vector3().setFromMatrixPosition(mappedBind(collider.joint)).z),
      }));
    this.bindInverse = Object.freeze(Object.fromEntries(Object.keys(model.mapped).map(id =>
      [id, new Matrix4().copy(mappedBind(id as AvatarJointId)).invert()])) as Record<AvatarJointId, Matrix4>);
  }

  update(frame: AvatarMotionFrame): void {
    this.bodyInverse.copy(frame.body).invert();
    for (const chain of this.chains) this.target(chain, frame.body, frame.mapped, frame.rest);
    for (let index = 0; index < this.colliders.length; index += 1) {
      const collider = this.colliders[index]!;
      if (collider.frame === 'pot') this.point.copy(collider.centre).applyMatrix4(frame.pot);
      else {
        this.follow.multiplyMatrices(frame.mapped.current[collider.joint], this.bindInverse[collider.joint]);
        this.point.copy(collider.centre).applyMatrix4(this.follow).applyMatrix4(frame.body);
      }
      this.solver.colliderX[index] = this.point.x;
      this.solver.colliderY[index] = this.point.y;
    }
    this.solver.advance(frame.reset, frame.steps);
    for (const chain of this.chains) this.write(chain, frame.out);
  }

  // The chain's rest pose: the root rides rigidly on its mapped joint, every later joint rests at its bind offset from
  // the root. Its positions are the solver's targets, and their spacing its segment lengths.
  private target(chain: SkinnedChain, body: Readonly<Matrix4>, mapped: AvatarMotionSkeleton, rest: readonly Readonly<Matrix4>[]): void {
    this.follow.multiplyMatrices(mapped.current[chain.follows], this.bindInverse[chain.follows]);
    const { joints, state } = chain;
    const root = joints[0]!;
    root.rest.copy(rest[chain.offset]!);
    root.restPosition.setFromMatrixPosition(root.rest);
    root.restDirection.copy(root.segment).transformDirection(this.follow);
    for (let index = 1; index < joints.length; index += 1) {
      const joint = joints[index]!;
      joint.restPosition.copy(joint.bindPosition).sub(root.bindPosition).add(root.restPosition);
      joint.rest.copy(joint.bind).setPosition(joint.restPosition);
      joint.restDirection.copy(joint.segment).normalize();
    }
    for (let index = 0; index < joints.length; index += 1) {
      this.point.copy(joints[index]!.restPosition).applyMatrix4(body);
      state.targetX[index] = this.point.x;
      state.targetY[index] = this.point.y;
      chain.depth[index] = this.point.z;
      if (index > 0) state.lengths[index - 1] = Math.hypot(this.point.x - state.targetX[index - 1], this.point.y - state.targetY[index - 1]);
    }
  }

  // Each joint moves to its particle at its rest depth and turns its rest segment onto the simulated one.
  private write(chain: SkinnedChain, out: readonly Matrix4[]): void {
    const { joints, state } = chain;
    for (let index = 0; index < joints.length; index += 1) {
      joints[index]!.position.set(state.currentX[index], state.currentY[index], chain.depth[index]).applyMatrix4(this.bodyInverse);
    }
    for (let index = 0; index < joints.length - 1; index += 1) {
      const joint = joints[index]!;
      this.direction.subVectors(joints[index + 1]!.position, joint.position);
      if (joint.restDirection.lengthSq() <= DIRECTION_EPSILON || this.direction.lengthSq() <= DIRECTION_EPSILON) joint.turn.identity();
      else joint.turn.setFromUnitVectors(joint.restDirection, this.direction.normalize());
    }
    joints[joints.length - 1]!.turn.copy(joints[joints.length - 2]!.turn);
    for (let index = 0; index < joints.length; index += 1) {
      const joint = joints[index]!;
      // The rest frame turned about its own origin, then placed on the particle.
      this.frame.copy(joint.rest).setPosition(0, 0, 0);
      out[chain.offset + index]!.makeRotationFromQuaternion(joint.turn).multiply(this.frame).setPosition(joint.position);
    }
  }
}
