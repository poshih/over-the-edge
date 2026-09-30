import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { HairSolver } from './hair-solver';
import type { HairChainState } from './hair-solver';
import type { AvatarJointId } from './character-profile';
import type { ResolvedAvatarHair } from './character-model-inspect';

// The mapped joints' avatar-space matrices at bind and this frame, as the rig wrote them.
export interface MappedJointFrames {
  readonly bind: Readonly<Record<AvatarJointId, Matrix4>>;
  readonly current: Readonly<Record<AvatarJointId, Matrix4>>;
}

// A chain joint: its node, avatar-space bind and the bind offset of the next joint (or the tip's, repeated), and
// this frame's rest frame and position, simulated position and turn.
interface HairJoint {
  readonly bone: Object3D;
  readonly bind: Matrix4;
  readonly bindPosition: Vector3;
  readonly segment: Vector3;
  readonly rest: Matrix4;
  readonly restPosition: Vector3;
  readonly restDirection: Vector3;
  readonly current: Matrix4;
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
  // The world depth of each joint's rest position, which the simulated joint keeps.
  readonly depth: Float64Array;
}

// A collider's centre in avatar space at bind, and the mapped joint whose motion carries it.
interface SkinnedCollider {
  readonly joint: AvatarJointId;
  readonly centre: Vector3;
}

const DIRECTION_EPSILON = 1e-9;

/**
 * An imported avatar's spring-bone hair (docs/characters.md, Hair on an imported avatar). A chain's root follows its
 * mapped joint rigidly; the joints after it rest at their bind offsets from the root in the body's frame, so hair
 * keeps hanging as authored while a head turns, and those rest positions give the shared hair solver its targets and
 * segment lengths. The solver moves the joints in the world's X-Y plane, the game's view. Each joint keeps the world
 * depth of its rest position and turns by the least rotation that carries its rest segment onto the simulated one,
 * so the skin bends along the chain; the tip joint turns with the last segment. Colliders are carried by their
 * mapped joints. Runs after the rig has written the mapped joints; allocation-free per frame, its cost bounded by the
 * chains' joints and the colliders.
 */
export class SkinnedHair {
  private readonly solver: HairSolver;
  private readonly chains: readonly SkinnedChain[];
  private readonly colliders: readonly SkinnedCollider[];
  private readonly bindInverse: Readonly<Record<AvatarJointId, Matrix4>>;
  private readonly follow = new Matrix4();
  private readonly bodyInverse = new Matrix4();
  private readonly frame = new Matrix4();
  private readonly point = new Vector3();
  private readonly direction = new Vector3();

  constructor(hair: ResolvedAvatarHair, nodes: ReadonlyMap<number, Object3D>, avatarBind: (object: Object3D) => Matrix4,
    mappedBind: Readonly<Record<AvatarJointId, Matrix4>>) {
    this.solver = new HairSolver(hair.chains.map(resolved => ({ parameters: resolved.chain, segments: resolved.nodes.length - 1 })),
      hair.colliders.map(collider => collider.radius));
    this.chains = Object.freeze(hair.chains.map((resolved, index): SkinnedChain => {
      const bones = resolved.nodes.map(node => nodes.get(node)!);
      const binds = bones.map(bone => avatarBind(bone));
      const positions = binds.map(bind => new Vector3().setFromMatrixPosition(bind));
      return {
        follows: resolved.follows,
        parentBind: avatarBind(bones[0]!.parent!),
        parentNow: new Matrix4(),
        joints: Object.freeze(bones.map((bone, at) => ({
          bone, bind: binds[at]!, bindPosition: positions[at]!,
          // The tip joint has no next joint; its segment repeats the last one.
          segment: at + 1 < positions.length ? positions[at + 1]!.clone().sub(positions[at]!) : positions[at]!.clone().sub(positions[at - 1]!),
          rest: new Matrix4(), restPosition: new Vector3(), restDirection: new Vector3(),
          current: new Matrix4(), position: new Vector3(), turn: new Quaternion(),
        }))),
        state: this.solver.chains[index]!,
        depth: new Float64Array(bones.length),
      };
    }));
    this.colliders = Object.freeze(hair.colliders.map(collider => ({
      joint: collider.joint,
      // In the plane of the joint it rides on.
      centre: new Vector3(collider.x, collider.y, new Vector3().setFromMatrixPosition(mappedBind[collider.joint]).z),
    })));
    this.bindInverse = Object.freeze(Object.fromEntries(Object.entries(mappedBind).map(([id, bind]) => [id, bind.clone().invert()])) as
      Record<AvatarJointId, Matrix4>);
  }

  // Simulates the hair for the frame at `time` and writes its joints' local matrices. `body` places avatar space in
  // the world, as the view's root does.
  apply(body: Matrix4, time: number, mapped: MappedJointFrames): void {
    this.bodyInverse.copy(body).invert();
    for (const chain of this.chains) this.target(chain, body, mapped);
    for (const [index, collider] of this.colliders.entries()) {
      this.follow.multiplyMatrices(mapped.current[collider.joint], this.bindInverse[collider.joint]);
      this.point.copy(collider.centre).applyMatrix4(this.follow).applyMatrix4(body);
      this.solver.colliderX[index] = this.point.x;
      this.solver.colliderY[index] = this.point.y;
    }
    this.solver.solve(time);
    for (const chain of this.chains) this.write(chain);
  }

  // The chain's rest pose: the root rides rigidly on its mapped joint, every later joint rests at its bind offset from
  // the root. Its positions are the solver's targets, and their spacing its segment lengths.
  private target(chain: SkinnedChain, body: Matrix4, mapped: MappedJointFrames): void {
    this.follow.multiplyMatrices(mapped.current[chain.follows], this.bindInverse[chain.follows]);
    chain.parentNow.multiplyMatrices(this.follow, chain.parentBind);
    const { joints, state } = chain;
    const root = joints[0]!;
    root.rest.multiplyMatrices(this.follow, root.bind);
    root.restPosition.setFromMatrixPosition(root.rest);
    root.restDirection.copy(root.segment).transformDirection(this.follow);
    for (let index = 1; index < joints.length; index += 1) {
      const joint = joints[index]!;
      joint.restPosition.copy(joint.bindPosition).sub(root.bindPosition).add(root.restPosition);
      joint.rest.copy(joint.bind).setPosition(joint.restPosition);
      joint.restDirection.copy(joint.segment).normalize();
    }
    for (const [index, joint] of joints.entries()) {
      this.point.copy(joint.restPosition).applyMatrix4(body);
      state.targetX[index] = this.point.x;
      state.targetY[index] = this.point.y;
      chain.depth[index] = this.point.z;
      if (index > 0) state.lengths[index - 1] = Math.hypot(this.point.x - state.targetX[index - 1], this.point.y - state.targetY[index - 1]);
    }
  }

  // Each joint moves to its particle at its rest depth and turns its rest segment onto the simulated one.
  private write(chain: SkinnedChain): void {
    const { joints, state } = chain;
    for (const [index, joint] of joints.entries()) {
      joint.position.set(state.currentX[index], state.currentY[index], chain.depth[index]).applyMatrix4(this.bodyInverse);
    }
    for (let index = 0; index < joints.length - 1; index += 1) {
      const joint = joints[index]!;
      this.direction.subVectors(joints[index + 1]!.position, joint.position);
      if (joint.restDirection.lengthSq() <= DIRECTION_EPSILON || this.direction.lengthSq() <= DIRECTION_EPSILON) joint.turn.identity();
      else joint.turn.setFromUnitVectors(joint.restDirection, this.direction.normalize());
    }
    joints[joints.length - 1]!.turn.copy(joints[joints.length - 2]!.turn);
    let parent = chain.parentNow;
    for (const joint of joints) {
      // The rest frame turned about its own origin, then placed on the particle.
      this.frame.copy(joint.rest).setPosition(0, 0, 0);
      joint.current.makeRotationFromQuaternion(joint.turn).multiply(this.frame).setPosition(joint.position);
      joint.bone.matrix.copy(parent).invert().multiply(joint.current);
      joint.bone.matrixWorldNeedsUpdate = true;
      parent = joint.current;
    }
  }
}
