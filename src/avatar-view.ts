import { Bone, Group, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Vector3 } from 'three';
import type { Quaternion } from 'three';
import { ARM_GEOMETRY, ARM_LENGTH } from './arm-ik';
import type { ArmPose } from './arm-ik';
import { AVATAR_BIND, AVATAR_JOINTS, createAvatarGeometry } from './avatar-geometry';
import { ARM_LAYER } from './arm-layer';
import { handFrame, limbFrame } from './avatar-rig-math';
import { ARM_SIDES } from './character';
import type { ArmSide } from './character';

interface AvatarArm {
  upper: Bone;
  forearm: Bone;
  hand: Bone;
}

function bone(name: string): Bone {
  const result = new Bone();
  result.name = name;
  result.matrixAutoUpdate = false;
  return result;
}

function armBones(side: ArmSide): AvatarArm {
  const upper = bone(`${side}-upper-arm`);
  const forearm = bone(`${side}-forearm`);
  const hand = bone(`${side}-hand`);
  const shoulder = ARM_GEOMETRY[side].shoulder;
  const axis = new Vector3(AVATAR_BIND.armDirection[side], 0, 0);
  const normal = new Vector3(...AVATAR_BIND.armNormal);
  const transverse = new Vector3().crossVectors(axis, normal);
  // Match the solver's ordinary -Z bend normal instead of introducing a bind-time half-roll.
  upper.matrix.makeBasis(transverse, axis, normal)
    .setPosition(shoulder[0], shoulder[1], shoulder[2]);
  forearm.matrix.makeTranslation(0, ARM_LENGTH.upper, 0);
  const forearmBind = new Matrix4().multiplyMatrices(upper.matrix, forearm.matrix);
  const grip = new Vector3(0, ARM_LENGTH.forearm, 0).applyMatrix4(forearmBind);
  const handAxis = new Vector3(...AVATAR_BIND.handAxis);
  const handForward = new Vector3(...AVATAR_BIND.handForward);
  transverse.crossVectors(handAxis, handForward);
  const handBind = new Matrix4().makeBasis(transverse, handAxis, handForward).setPosition(grip);
  // Both gloves have the same avatar-space shaft frame, not their parent's limb orientation.
  hand.matrix.copy(forearmBind).invert().multiply(handBind);
  upper.add(forearm);
  forearm.add(hand);
  return { upper, forearm, hand };
}

export class AvatarView {
  readonly root = new Group();
  private readonly material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  private readonly geometry = createAvatarGeometry();
  private readonly mesh = new SkinnedMesh(this.geometry.body, this.material);
  // The arms' surface, on the same skeleton, drawn over the body (see ARM_LAYER).
  private readonly armMesh = new SkinnedMesh(this.geometry.arms, this.material);
  private readonly skeleton: Skeleton;
  private readonly head = bone('avatar-head');
  private readonly arms: Record<ArmSide, AvatarArm> = { left: armBones('left'), right: armBones('right') };
  private readonly inverseBody = new Matrix4();
  private readonly inverseParent = new Matrix4();
  private readonly upperFrame = new Matrix4();
  private readonly forearmFrame = new Matrix4();
  private readonly handMatrix = new Matrix4();
  private readonly shoulder = new Vector3();
  private readonly elbow = new Vector3();
  private readonly hand = new Vector3();
  private readonly armNormal = new Vector3();
  private readonly shaft = new Vector3();
  private readonly handForward = new Vector3();

  constructor() {
    this.root.name = 'original-connected-avatar';
    this.root.matrixAutoUpdate = false;
    this.mesh.name = 'workwear-avatar-surface';
    this.mesh.frustumCulled = false;
    this.armMesh.name = 'workwear-avatar-arms';
    this.armMesh.frustumCulled = false;
    this.armMesh.layers.set(ARM_LAYER);
    const body = bone('avatar-body');
    this.head.matrix.makeTranslation(0, AVATAR_BIND.headY, 0);
    body.add(this.head);
    const bones: Bone[] = [];
    bones[AVATAR_JOINTS.body] = body;
    bones[AVATAR_JOINTS.head] = this.head;
    for (const side of ARM_SIDES) {
      const arm = this.arms[side];
      const indices = AVATAR_JOINTS[side];
      body.add(arm.upper);
      bones[indices.upper] = arm.upper;
      bones[indices.forearm] = arm.forearm;
      bones[indices.hand] = arm.hand;
    }
    this.mesh.add(body);
    this.root.add(this.mesh, this.armMesh);
    // Capture inverse bind transforms from the complete rest hierarchy, once.
    this.root.updateMatrixWorld(true);
    this.skeleton = new Skeleton(bones);
    this.mesh.bind(this.skeleton, this.mesh.matrixWorld);
    this.armMesh.bind(this.skeleton, this.mesh.bindMatrix);
  }

  // `turns` rotates each glove about its grip in world space, or is null for a glove that keeps the tool's frame.
  update(body: Matrix4, poses: readonly ArmPose[], headRotation: Quaternion,
    turns: Readonly<Record<ArmSide, Quaternion | null>>, headDelta: Matrix4 | null = null): void {
    this.root.matrix.copy(body);
    this.root.matrixWorldNeedsUpdate = true;
    if (headDelta === null) this.head.matrix.makeRotationFromQuaternion(headRotation).setPosition(0, AVATAR_BIND.headY, 0);
    else this.head.matrix.makeTranslation(0, AVATAR_BIND.headY, 0).premultiply(headDelta);
    this.head.matrixWorldNeedsUpdate = true;
    this.inverseBody.copy(body).invert();
    for (let index = 0; index < poses.length; index++) {
      const pose = poses[index];
      const arm = this.arms[pose.side];
      this.shoulder.copy(pose.shoulder).applyMatrix4(this.inverseBody);
      this.elbow.copy(pose.elbow).applyMatrix4(this.inverseBody);
      this.hand.copy(pose.hand).applyMatrix4(this.inverseBody);
      this.armNormal.copy(pose.normal).transformDirection(this.inverseBody);
      // The tool's shaft lies in the world's XY plane; the glove's front faces world +Z unless it is turned.
      this.shaft.copy(pose.shaftAxis);
      this.handForward.fromArray(AVATAR_BIND.handForward);
      const turn = turns[pose.side];
      if (turn !== null) {
        this.shaft.applyQuaternion(turn);
        this.handForward.applyQuaternion(turn);
      }
      this.shaft.transformDirection(this.inverseBody);
      this.handForward.transformDirection(this.inverseBody);
      limbFrame(this.upperFrame, this.shoulder, this.elbow, this.armNormal, ARM_LENGTH.upper);
      limbFrame(this.forearmFrame, this.elbow, this.hand, this.armNormal, ARM_LENGTH.forearm);
      handFrame(this.handMatrix, this.hand, this.shaft, this.handForward);

      // Desired avatar-space frames become exact hierarchical locals. Keeping matrices avoids
      // lossy TRS decomposition/shear and cancels inherited stretch at the elbow and grip.
      arm.upper.matrix.copy(this.upperFrame);
      this.inverseParent.copy(this.upperFrame).invert();
      arm.forearm.matrix.multiplyMatrices(this.inverseParent, this.forearmFrame);
      this.inverseParent.copy(this.forearmFrame).invert();
      arm.hand.matrix.multiplyMatrices(this.inverseParent, this.handMatrix);
      arm.upper.matrixWorldNeedsUpdate = true;
      arm.forearm.matrixWorldNeedsUpdate = true;
      arm.hand.matrixWorldNeedsUpdate = true;
    }
  }

  inspect(): {
    kind: 'skinned-upper-body'; meshes: number; triangles: number; armTriangles: number; vertices: number; bones: number; materials: number;
  } {
    const armTriangles = this.geometry.arms.index!.count / 3;
    return {
      kind: 'skinned-upper-body',
      meshes: 2,
      triangles: this.geometry.body.index!.count / 3 + armTriangles,
      armTriangles,
      vertices: this.geometry.body.getAttribute('position').count,
      bones: this.skeleton.bones.length,
      materials: 1,
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    // The parts share their vertex buffers; disposing both frees them and each part's index.
    this.geometry.body.dispose();
    this.geometry.arms.dispose();
    this.material.dispose();
    this.skeleton.dispose();
  }
}
