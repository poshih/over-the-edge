import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { HairSolver } from './hair-solver';
import type { HairChainState } from './hair-solver';
import type { AvatarHairCollider, AvatarJointId } from './character-profile';
import type { ResolvedAvatarHair } from './character-model-inspect';

// The mapped joints' avatar-space matrices at bind and this frame, as the rig wrote them.
export interface MappedJointFrames {
  readonly bind: Readonly<Record<AvatarJointId, Matrix4>>;
  readonly current: Readonly<Record<AvatarJointId, Matrix4>>;
}

// A chain joint: its node and avatar-space bind, and this frame's rigid and simulated avatar-space poses.
interface HairJoint {
  readonly bone: Object3D;
  readonly bind: Matrix4;
  readonly rigid: Matrix4;
  readonly current: Matrix4;
  readonly rigidPosition: Vector3;
  readonly position: Vector3;
  readonly turn: Quaternion;
}

interface SkinnedChain {
  readonly follows: AvatarJointId;
  // The avatar-space bind of the node the root hangs from, and that node's matrix this frame.
  readonly parentBind: Matrix4;
  readonly parentNow: Matrix4;
  readonly joints: readonly HairJoint[];
  readonly state: HairChainState;
  // The world depth of each joint's rigid pose, which the simulated joint keeps.
  readonly depth: Float64Array;
}

const DIRECTION_EPSILON = 1e-9;

/**
 * An imported avatar's spring-bone hair (docs/characters.md, Hair on an imported avatar). A chain's joints follow
 * their mapped joint rigidly, which gives the shared hair solver its targets and segment lengths; the solver moves
 * them in the world's X-Y plane, the game's view. Each joint keeps the world depth of its rigid pose and turns by
 * the least rotation that carries its rigid segment onto the simulated one, so the skin bends along the chain; the
 * tip joint turns with the last segment. Colliders ride on mapped joints. Runs after the rig has written the mapped
 * joints; allocation-free per frame, its cost bounded by the chains' joints and the colliders.
 */
export class SkinnedHair {
  private readonly solver: HairSolver;
  private readonly chains: readonly SkinnedChain[];
  private readonly colliders: readonly AvatarHairCollider[];
  // The fit's scale: collider offsets are fitted metres, and a mapped joint's avatar-space frame carries the scale.
  private readonly scale: number;
  private readonly bindInverse: Readonly<Record<AvatarJointId, Matrix4>>;
  private readonly follow = new Matrix4();
  private readonly bodyInverse = new Matrix4();
  private readonly frame = new Matrix4();
  private readonly point = new Vector3();
  private readonly rigidDirection = new Vector3();
  private readonly direction = new Vector3();

  constructor(hair: ResolvedAvatarHair, nodes: ReadonlyMap<number, Object3D>, avatarBind: (object: Object3D) => Matrix4,
    mappedBind: Readonly<Record<AvatarJointId, Matrix4>>, scale: number) {
    this.solver = new HairSolver(hair.chains.map(resolved => ({ parameters: resolved.chain, segments: resolved.nodes.length - 1 })),
      hair.colliders.map(collider => collider.radius));
    this.chains = Object.freeze(hair.chains.map((resolved, index): SkinnedChain => {
      const bones = resolved.nodes.map(node => nodes.get(node)!);
      return {
        follows: resolved.follows,
        parentBind: avatarBind(bones[0]!.parent!),
        parentNow: new Matrix4(),
        joints: Object.freeze(bones.map(bone => ({
          bone, bind: avatarBind(bone), rigid: new Matrix4(), current: new Matrix4(),
          rigidPosition: new Vector3(), position: new Vector3(), turn: new Quaternion(),
        }))),
        state: this.solver.chains[index]!,
        depth: new Float64Array(bones.length),
      };
    }));
    this.colliders = hair.colliders;
    this.bindInverse = Object.freeze(Object.fromEntries(Object.entries(mappedBind).map(([id, bind]) => [id, bind.clone().invert()])) as
      Record<AvatarJointId, Matrix4>);
    this.scale = scale;
  }

  // Simulates the hair for the frame at `time` and writes its joints' local matrices. `body` places avatar space in
  // the world, as the view's root does.
  apply(body: Matrix4, time: number, mapped: MappedJointFrames): void {
    this.bodyInverse.copy(body).invert();
    for (const chain of this.chains) this.target(chain, body, mapped);
    for (const [index, collider] of this.colliders.entries()) {
      this.point.set(collider.x / this.scale, collider.y / this.scale, 0).applyMatrix4(mapped.current[collider.joint]).applyMatrix4(body);
      this.solver.colliderX[index] = this.point.x;
      this.solver.colliderY[index] = this.point.y;
    }
    this.solver.solve(time);
    for (const chain of this.chains) this.write(chain);
  }

  // The chain's rigid pose, riding on its mapped joint, becomes the solver's targets and segment lengths.
  private target(chain: SkinnedChain, body: Matrix4, mapped: MappedJointFrames): void {
    this.follow.multiplyMatrices(mapped.current[chain.follows], this.bindInverse[chain.follows]);
    chain.parentNow.multiplyMatrices(this.follow, chain.parentBind);
    const { state } = chain;
    for (const [index, joint] of chain.joints.entries()) {
      joint.rigid.multiplyMatrices(this.follow, joint.bind);
      joint.rigidPosition.setFromMatrixPosition(joint.rigid);
      this.point.copy(joint.rigidPosition).applyMatrix4(body);
      state.targetX[index] = this.point.x;
      state.targetY[index] = this.point.y;
      chain.depth[index] = this.point.z;
      if (index > 0) state.lengths[index - 1] = Math.hypot(this.point.x - state.targetX[index - 1], this.point.y - state.targetY[index - 1]);
    }
  }

  // Each joint moves to its particle at its rigid depth and turns its rigid segment onto the simulated one.
  private write(chain: SkinnedChain): void {
    const { joints, state } = chain;
    for (const [index, joint] of joints.entries()) {
      joint.position.set(state.currentX[index], state.currentY[index], chain.depth[index]).applyMatrix4(this.bodyInverse);
    }
    for (let index = 0; index < joints.length - 1; index += 1) {
      const joint = joints[index]!, next = joints[index + 1]!;
      this.rigidDirection.subVectors(next.rigidPosition, joint.rigidPosition);
      this.direction.subVectors(next.position, joint.position);
      if (this.rigidDirection.lengthSq() <= DIRECTION_EPSILON || this.direction.lengthSq() <= DIRECTION_EPSILON) joint.turn.identity();
      else joint.turn.setFromUnitVectors(this.rigidDirection.normalize(), this.direction.normalize());
    }
    joints[joints.length - 1]!.turn.copy(joints[joints.length - 2]!.turn);
    let parent = chain.parentNow;
    for (const joint of joints) {
      // The rigid frame turned about its own origin, then placed on the particle.
      this.frame.copy(joint.rigid).setPosition(0, 0, 0);
      joint.current.makeRotationFromQuaternion(joint.turn).multiply(this.frame).setPosition(joint.position);
      joint.bone.matrix.copy(parent).invert().multiply(joint.current);
      joint.bone.matrixWorldNeedsUpdate = true;
      parent = joint.current;
    }
  }
}
