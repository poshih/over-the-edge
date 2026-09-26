import { Group, Matrix4, Mesh, SkinnedMesh, Vector3 } from 'three';
import type { Material, Object3D, Quaternion } from 'three';
import { ARM_GEOMETRY } from './arm-ik';
import type { ArmChain, ArmChains, ArmPose } from './arm-ik';
import { AVATAR_BIND } from './avatar-geometry';
import { ARM_SIDES } from './character';
import { AVATAR_JOINT_IDS, AVATAR_JOINT_PARENTS } from './character-profile';
import type { AvatarBoneMap, AvatarJointId } from './character-profile';
import type { ResolvedAvatarJoints, UnmappedAvatarJoint } from './character-model-inspect';
import type { LoadedCharacterModel } from './character-model-types';

const SHOULDER_SPAN = ARM_GEOMETRY.right.shoulder[0] - ARM_GEOMETRY.left.shoulder[0];
const SHOULDER_CENTER = new Vector3(...ARM_GEOMETRY.left.shoulder).add(new Vector3(...ARM_GEOMETRY.right.shoulder)).multiplyScalar(0.5);
const BIND_ARM_NORMAL = new Vector3(...AVATAR_BIND.armNormal);
const FALLBACK_ARM_NORMAL = new Vector3(0, -1, 0);
const HAND_FORWARD = new Vector3(...AVATAR_BIND.handForward);
const PARALLEL_LIMIT = 0.99;

interface DrivenJoint {
  readonly id: AvatarJointId;
  readonly bone: Object3D;
  readonly predecessor: DrivenJoint | null;
  // The bone parent's bind transform relative to the predecessor (in avatar space for the body).
  readonly parentOffset: Matrix4;
  readonly bind: Matrix4;
  // The bone relative to its solver frame, captured in the bind pose.
  readonly offset: Matrix4;
  readonly current: Matrix4;
}

interface DrivenArm {
  readonly upper: DrivenJoint;
  readonly forearm: DrivenJoint;
  readonly hand: DrivenJoint;
  readonly chain: ArmChain;
}

/**
 * An imported skinned GLB driven like the built-in avatar. Mapped joints receive the same IK,
 * grip and head-gaze frames; unmapped joints keep their bind pose relative to their parents, so
 * they follow their nearest mapped ancestor. Per frame it writes seven bone matrices and allocates nothing.
 */
export class SkinnedAvatarView {
  readonly root = new Group();
  readonly chains: ArmChains;
  readonly model: LoadedCharacterModel;
  readonly boneMap: AvatarBoneMap;
  private readonly fit = new Group();
  private readonly joints: Readonly<Record<AvatarJointId, DrivenJoint>>;
  private readonly driven: readonly DrivenJoint[];
  private readonly arms: Readonly<Record<'left' | 'right', DrivenArm>>;
  private readonly unmapped: readonly UnmappedAvatarJoint[];
  private readonly headPivot = new Vector3();
  private readonly scale: number;
  private readonly statistics: { meshes: number; skinnedMeshes: number; vertices: number; materials: number };
  private readonly inverseBody = new Matrix4();
  private readonly frame = new Matrix4();
  private readonly parentNow = new Matrix4();
  private readonly shoulder = new Vector3();
  private readonly elbow = new Vector3();
  private readonly hand = new Vector3();
  private readonly armNormal = new Vector3();
  private readonly shaft = new Vector3();
  private readonly handForward = new Vector3();
  private readonly segment = new Vector3();
  private readonly frameSide = new Vector3();
  private readonly frameNormal = new Vector3();
  private readonly rotated = new Vector3();
  private writes = 0;

  constructor(model: LoadedCharacterModel, resolved: ResolvedAvatarJoints, boneMap: AvatarBoneMap) {
    this.model = model;
    this.boneMap = boneMap;
    this.unmapped = resolved.unmapped;
    this.root.name = 'imported-skinned-avatar';
    this.root.matrixAutoUpdate = false;
    this.fit.name = 'imported-avatar-fit';
    this.fit.matrixAutoUpdate = false;
    this.root.add(this.fit);
    const scene = model.scene;
    scene.removeFromParent();

    // Reset every joint to the skin's bind pose (inverse bind matrices), whatever pose the file stored.
    const binds = new Map<Object3D, Matrix4>();
    for (const joint of model.report.joints) binds.set(model.nodes.get(joint.node)!, new Matrix4().fromArray(joint.bind));
    const modelSpace = new Map<Object3D, Matrix4>();
    const place = (object: Object3D, parent: Matrix4): void => {
      let world = binds.get(object);
      if (world !== undefined) {
        object.matrix.copy(parent).invert().multiply(world);
        object.matrixAutoUpdate = false;
        object.matrixWorldNeedsUpdate = true;
      } else {
        if (object.matrixAutoUpdate) object.updateMatrix();
        world = new Matrix4().multiplyMatrices(parent, object.matrix);
      }
      modelSpace.set(object, world);
      for (const child of object.children) place(child, world);
    };
    place(scene, new Matrix4());
    this.fit.add(scene);

    // Match the built-in shoulders: span and midpoint, preserving the model's proportions.
    const bone = (id: AvatarJointId): Object3D => model.nodes.get(resolved.nodes[id])!;
    const bindPosition = (object: Object3D): Vector3 => new Vector3().setFromMatrixPosition(modelSpace.get(object)!);
    const left = bindPosition(bone('left-upper-arm'));
    const right = bindPosition(bone('right-upper-arm'));
    this.scale = SHOULDER_SPAN / (right.x - left.x);
    const center = left.add(right).multiplyScalar(0.5 * this.scale);
    this.fit.matrix.makeScale(this.scale, this.scale, this.scale).setPosition(SHOULDER_CENTER.clone().sub(center));
    const avatarSpace = (object: Object3D): Matrix4 => new Matrix4().multiplyMatrices(this.fit.matrix, modelSpace.get(object)!);

    const joints = {} as Record<AvatarJointId, DrivenJoint>;
    for (const id of AVATAR_JOINT_IDS) {
      const object = bone(id);
      const bind = avatarSpace(object);
      const predecessorId = AVATAR_JOINT_PARENTS[id];
      const predecessor = predecessorId === null ? null : joints[predecessorId];
      const parentBind = avatarSpace(object.parent!);
      joints[id] = {
        id, bone: object, predecessor, bind, offset: new Matrix4(), current: bind.clone(),
        parentOffset: predecessor === null ? parentBind : predecessor.bind.clone().invert().multiply(parentBind),
      };
    }
    this.joints = joints;
    this.headPivot.setFromMatrixPosition(joints.head.bind);

    const arms = {} as Record<'left' | 'right', DrivenArm>;
    const chains = {} as Record<'left' | 'right', ArmChain>;
    for (const side of ARM_SIDES) {
      const upper = joints[`${side}-upper-arm`];
      const forearm = joints[`${side}-forearm`];
      const hand = joints[`${side}-hand`];
      const shoulder = new Vector3().setFromMatrixPosition(upper.bind);
      const elbow = new Vector3().setFromMatrixPosition(forearm.bind);
      const wrist = new Vector3().setFromMatrixPosition(hand.bind);
      const chain: ArmChain = Object.freeze({
        shoulder: Object.freeze([shoulder.x, shoulder.y, shoulder.z] as [number, number, number]),
        upper: shoulder.distanceTo(elbow),
        forearm: elbow.distanceTo(wrist),
      });
      this.limbFrame(this.frame, shoulder, elbow, this.bindNormal(shoulder, elbow), chain.upper);
      upper.offset.copy(this.frame).invert().multiply(upper.bind);
      this.limbFrame(this.frame, elbow, wrist, this.bindNormal(elbow, wrist), chain.forearm);
      forearm.offset.copy(this.frame).invert().multiply(forearm.bind);
      // In the bind pose the virtual shaft runs along the forearm like the built-in avatar's gloves.
      this.shaft.subVectors(wrist, elbow).normalize().multiplyScalar(AVATAR_BIND.armDirection[side]);
      this.handFrame(this.frame, wrist, this.shaft, HAND_FORWARD);
      hand.offset.copy(this.frame).invert().multiply(hand.bind);
      arms[side] = { upper, forearm, hand, chain };
      chains[side] = chain;
    }
    this.arms = arms;
    this.chains = Object.freeze(chains);
    this.driven = Object.freeze(AVATAR_JOINT_IDS.filter(id => id !== 'body').map(id => joints[id]));

    let meshes = 0, skinnedMeshes = 0, vertices = 0;
    const materials = new Set<Material>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes++;
      vertices += object.geometry.getAttribute('position')?.count ?? 0;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      if (object instanceof SkinnedMesh) {
        skinnedMeshes++;
        // Bind-pose bounds no longer describe the retargeted surface.
        object.frustumCulled = false;
      }
    });
    this.statistics = { meshes, skinnedMeshes, vertices, materials: materials.size };
  }

  update(body: Matrix4, poses: readonly ArmPose[], headRotation: Quaternion): void {
    this.root.matrix.copy(body);
    this.root.matrixWorldNeedsUpdate = true;
    this.inverseBody.copy(body).invert();
    // The tool's shaft lies in the world's XY plane; keep each hand's front facing world +Z.
    this.handForward.copy(HAND_FORWARD).transformDirection(this.inverseBody);

    const head = this.joints.head;
    this.frame.makeRotationFromQuaternion(headRotation);
    this.rotated.copy(this.headPivot).applyMatrix4(this.frame);
    this.frame.setPosition(this.headPivot.x - this.rotated.x, this.headPivot.y - this.rotated.y, this.headPivot.z - this.rotated.z);
    head.current.multiplyMatrices(this.frame, head.bind);

    for (let index = 0; index < poses.length; index++) {
      const pose = poses[index];
      const arm = this.arms[pose.side];
      this.shoulder.copy(pose.shoulder).applyMatrix4(this.inverseBody);
      this.elbow.copy(pose.elbow).applyMatrix4(this.inverseBody);
      this.hand.copy(pose.hand).applyMatrix4(this.inverseBody);
      this.armNormal.copy(pose.normal).transformDirection(this.inverseBody);
      this.shaft.copy(pose.shaftAxis).transformDirection(this.inverseBody);
      this.limbFrame(this.frame, this.shoulder, this.elbow, this.armNormal, arm.chain.upper);
      arm.upper.current.multiplyMatrices(this.frame, arm.upper.offset);
      this.limbFrame(this.frame, this.elbow, this.hand, this.armNormal, arm.chain.forearm);
      arm.forearm.current.multiplyMatrices(this.frame, arm.forearm.offset);
      this.handFrame(this.frame, this.hand, this.shaft, this.handForward);
      arm.hand.current.multiplyMatrices(this.frame, arm.hand.offset);
    }

    // Desired avatar-space transforms become exact local matrices, parents first. Keeping
    // matrices avoids lossy decomposition and cancels the forearm's stretch at the wrist.
    for (let index = 0; index < this.driven.length; index++) {
      const joint = this.driven[index];
      this.parentNow.multiplyMatrices(joint.predecessor!.current, joint.parentOffset);
      joint.bone.matrix.copy(this.parentNow).invert().multiply(joint.current);
      joint.bone.matrixWorldNeedsUpdate = true;
    }
    this.writes += this.driven.length;
  }

  private bindNormal(start: Vector3, end: Vector3): Vector3 {
    this.segment.subVectors(end, start).normalize();
    return Math.abs(this.segment.dot(BIND_ARM_NORMAL)) < PARALLEL_LIMIT ? BIND_ARM_NORMAL : FALLBACK_ARM_NORMAL;
  }

  private limbFrame(target: Matrix4, start: Vector3, end: Vector3, normal: Vector3, restLength: number): void {
    this.segment.subVectors(end, start).divideScalar(restLength);
    this.frameSide.crossVectors(this.segment, normal).normalize();
    this.frameNormal.crossVectors(this.frameSide, this.segment).normalize();
    target.makeBasis(this.frameSide, this.segment, this.frameNormal).setPosition(start);
  }

  private handFrame(target: Matrix4, position: Vector3, shaft: Vector3, forward: Vector3): void {
    this.frameSide.crossVectors(shaft, forward).normalize();
    this.frameNormal.crossVectors(this.frameSide, shaft).normalize();
    target.makeBasis(this.frameSide, shaft, this.frameNormal).setPosition(position);
  }

  inspect() {
    const joints = {} as Record<AvatarJointId, [number, number, number]>;
    const position = new Vector3();
    for (const id of AVATAR_JOINT_IDS) {
      position.setFromMatrixPosition(this.joints[id].bone.matrixWorld);
      joints[id] = [position.x, position.y, position.z];
    }
    return {
      kind: 'imported-skinned' as const,
      name: this.model.name,
      ...this.statistics,
      triangles: this.model.triangles,
      bones: this.model.report.joints.length,
      fitScale: this.scale,
      boneMap: { ...this.boneMap },
      unmapped: this.unmapped.map(joint => ({ name: joint.name, follows: joint.follows })),
      chains: { left: { ...this.chains.left }, right: { ...this.chains.right } },
      joints,
      boneWrites: this.writes,
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.model.scene.removeFromParent();
  }
}
