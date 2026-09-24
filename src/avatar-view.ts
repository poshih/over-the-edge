import { Bone, Group, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Vector3 } from 'three';
import type { Quaternion } from 'three';
import { ARM_GEOMETRY, ARM_LENGTH } from './arm-ik';
import type { ArmPose } from './arm-ik';
import { AVATAR_BIND, AVATAR_JOINTS, createAvatarGeometry } from './avatar-geometry';
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
  private readonly mesh = new SkinnedMesh(createAvatarGeometry(), this.material);
  private readonly skeleton: Skeleton;
  private readonly head = bone('avatar-head');
  private readonly arms: Record<ArmSide, AvatarArm> = { left: armBones('left'), right: armBones('right') };
  private readonly inverseBody = new Matrix4();
  private readonly inverseParent = new Matrix4();
  private readonly upperFrame = new Matrix4();
  private readonly forearmFrame = new Matrix4();
  private readonly handFrame = new Matrix4();
  private readonly shoulder = new Vector3();
  private readonly elbow = new Vector3();
  private readonly hand = new Vector3();
  private readonly armNormal = new Vector3();
  private readonly shaft = new Vector3();
  private readonly handForward = new Vector3();
  private readonly segment = new Vector3();
  private readonly frameSide = new Vector3();
  private readonly frameNormal = new Vector3();

  constructor() {
    this.root.name = 'original-connected-avatar';
    this.root.matrixAutoUpdate = false;
    this.mesh.name = 'workwear-avatar-surface';
    this.mesh.frustumCulled = false;
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
    this.root.add(this.mesh);
    // Capture inverse bind transforms from the complete rest hierarchy, once.
    this.root.updateMatrixWorld(true);
    this.skeleton = new Skeleton(bones);
    this.mesh.bind(this.skeleton, this.mesh.matrixWorld);
  }

  update(body: Matrix4, poses: readonly ArmPose[], headRotation: Quaternion): void {
    this.root.matrix.copy(body);
    this.root.matrixWorldNeedsUpdate = true;
    this.head.matrix.makeRotationFromQuaternion(headRotation).setPosition(0, AVATAR_BIND.headY, 0);
    this.head.matrixWorldNeedsUpdate = true;
    this.inverseBody.copy(body).invert();
    // The tool's shaft lies in the world's XY plane; keep the glove's front facing world +Z.
    this.handForward.fromArray(AVATAR_BIND.handForward).transformDirection(this.inverseBody);
    for (let index = 0; index < poses.length; index++) {
      const pose = poses[index];
      const arm = this.arms[pose.side];
      this.shoulder.copy(pose.shoulder).applyMatrix4(this.inverseBody);
      this.elbow.copy(pose.elbow).applyMatrix4(this.inverseBody);
      this.hand.copy(pose.hand).applyMatrix4(this.inverseBody);
      this.armNormal.copy(pose.normal).transformDirection(this.inverseBody);
      this.shaft.copy(pose.shaftAxis).transformDirection(this.inverseBody);
      this.limbFrame(this.upperFrame, this.shoulder, this.elbow, this.armNormal, ARM_LENGTH.upper);
      this.limbFrame(this.forearmFrame, this.elbow, this.hand, this.armNormal, ARM_LENGTH.forearm);
      this.frameSide.crossVectors(this.shaft, this.handForward).normalize();
      this.frameNormal.crossVectors(this.frameSide, this.shaft).normalize();
      this.handFrame.makeBasis(this.frameSide, this.shaft, this.frameNormal).setPosition(this.hand);

      // Desired avatar-space frames become exact hierarchical locals. Keeping matrices avoids
      // lossy TRS decomposition/shear and cancels inherited stretch at the elbow and grip.
      arm.upper.matrix.copy(this.upperFrame);
      this.inverseParent.copy(this.upperFrame).invert();
      arm.forearm.matrix.multiplyMatrices(this.inverseParent, this.forearmFrame);
      this.inverseParent.copy(this.forearmFrame).invert();
      arm.hand.matrix.multiplyMatrices(this.inverseParent, this.handFrame);
      arm.upper.matrixWorldNeedsUpdate = true;
      arm.forearm.matrixWorldNeedsUpdate = true;
      arm.hand.matrixWorldNeedsUpdate = true;
    }
  }

  private limbFrame(target: Matrix4, start: Vector3, end: Vector3, normal: Vector3, restLength: number): void {
    this.segment.subVectors(end, start).divideScalar(restLength);
    this.frameSide.crossVectors(this.segment, normal).normalize();
    this.frameNormal.crossVectors(this.frameSide, this.segment).normalize();
    target.makeBasis(this.frameSide, this.segment, this.frameNormal).setPosition(start);
  }

  inspect(): { kind: 'skinned-upper-body'; meshes: number; triangles: number; vertices: number; bones: number; materials: number } {
    return {
      kind: 'skinned-upper-body',
      meshes: 1,
      triangles: this.mesh.geometry.index!.count / 3,
      vertices: this.mesh.geometry.getAttribute('position').count,
      bones: this.skeleton.bones.length,
      materials: 1,
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.skeleton.dispose();
  }
}
