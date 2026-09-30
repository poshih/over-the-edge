import { Group, Matrix4, Mesh, SkinnedMesh, Vector3 } from 'three';
import type { Material, Object3D, Quaternion } from 'three';
import type { ArmChain, ArmChains } from './arm-ik';
import type { AvatarRigBinds, AvatarRigPose } from './avatar-rig';
import { ARM_SIDES } from './character';
import { AVATAR_JOINT_IDS, AVATAR_JOINT_PARENTS } from './character-profile';
import type { AvatarBoneMap, AvatarJointId } from './character-profile';
import type { ResolvedAvatarHair, ResolvedAvatarJoints, UnmappedAvatarJoint } from './character-model-inspect';
import type { LoadedCharacterModel } from './character-model-types';
import { SkinnedHair } from './skinned-hair';
import type { MappedJointFrames } from './skinned-hair';

interface DrivenJoint {
  readonly bone: Object3D;
  readonly predecessor: DrivenJoint | null;
  // The bone parent's bind transform relative to the predecessor (in avatar space for the body).
  readonly parentOffset: Matrix4;
  readonly bind: Matrix4;
  readonly current: Matrix4;
}

interface DrivenArm {
  readonly upper: DrivenJoint;
  readonly forearm: DrivenJoint;
  readonly hand: DrivenJoint;
}

/**
 * An imported skinned GLB driven like the built-in avatar. Mapped joints receive the prepared rig's
 * avatar-space matrices; unmapped joints keep their bind pose relative to their parents, so they
 * follow their nearest mapped ancestor, except the joints of the avatar's hair chains, which the shared
 * hair solver swings (SkinnedHair). Per frame it writes seven bone matrices plus the hair's and allocates nothing.
 *
 * This class is the engine's scene applicator: it owns the model's attachment, resets it to the
 * skin's inverse bind pose, and derives each mapped joint's real node-parent offset from the scene
 * hierarchy. Rig math and strategy code never see the scene.
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
  // Null for an avatar without hair chains, which then costs nothing.
  private readonly hair: SkinnedHair | null;
  private readonly mapped: MappedJointFrames;
  private readonly headPivot = new Vector3();
  private readonly scale: number;
  private readonly statistics: { meshes: number; skinnedMeshes: number; vertices: number; materials: number };
  private readonly frame = new Matrix4();
  private readonly parentNow = new Matrix4();
  private readonly rotated = new Vector3();
  private writes = 0;

  constructor(model: LoadedCharacterModel, resolved: ResolvedAvatarJoints, boneMap: AvatarBoneMap,
    bindings: AvatarRigBinds, hair: ResolvedAvatarHair) {
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
    const bindPose = new Map<Object3D, Matrix4>();
    for (const joint of model.report.joints) {
      bindPose.set(model.nodes.get(joint.node)!, new Matrix4().fromArray(joint.bind));
    }
    const modelSpace = new Map<Object3D, Matrix4>();
    const place = (object: Object3D, parent: Matrix4): void => {
      let world = bindPose.get(object);
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

    // The fitted frame and mapped bind matrices come from the shared fit; the scene supplies only
    // the real node-parent offsets, which non-joint parents cannot be derived without.
    this.scale = bindings.scale;
    this.fit.matrix.copy(bindings.fit);
    const avatarSpace = (object: Object3D): Matrix4 =>
      new Matrix4().multiplyMatrices(bindings.fit, modelSpace.get(object)!);

    const joints = {} as Record<AvatarJointId, DrivenJoint>;
    for (const id of AVATAR_JOINT_IDS) {
      const object = model.nodes.get(resolved.nodes[id])!;
      const bind = bindings.joints[id];
      const predecessorId = AVATAR_JOINT_PARENTS[id];
      const predecessor = predecessorId === null ? null : joints[predecessorId];
      const parentBind = avatarSpace(object.parent!);
      joints[id] = {
        bone: object, predecessor, bind,
        // The body is stationary in avatar space and is read as a predecessor; every other joint's
        // current matrix is written by apply() before the frame's bone pass reads it.
        current: predecessor === null ? bind.clone() : new Matrix4(),
        parentOffset: predecessor === null ? parentBind : predecessor.bind.clone().invert().multiply(parentBind),
      };
    }
    this.joints = joints;
    this.headPivot.setFromMatrixPosition(bindings.joints.head);
    const frames = (key: 'bind' | 'current') => Object.freeze(Object.fromEntries(AVATAR_JOINT_IDS.map(id => [id, joints[id][key]]))) as
      Readonly<Record<AvatarJointId, Matrix4>>;
    this.mapped = Object.freeze({ bind: frames('bind'), current: frames('current') });
    this.hair = hair.chains.length === 0 ? null : new SkinnedHair(hair, model.nodes, avatarSpace, this.mapped.bind, bindings.scale);

    const arms = {} as Record<'left' | 'right', DrivenArm>;
    const chains = {} as Record<'left' | 'right', ArmChain>;
    for (const side of ARM_SIDES) {
      const chain = bindings.arms[side].chain;
      arms[side] = {
        upper: joints[`${side}-upper-arm`], forearm: joints[`${side}-forearm`], hand: joints[`${side}-hand`],
      };
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

  // Applies the prepared rig's avatar-space pose, which the engine wrote this frame from the plan
  // and the arm solutions, then swings the hair for the frame at `time` (simulation seconds).
  apply(body: Matrix4, headRotation: Quaternion, pose: AvatarRigPose, time: number): void {
    this.root.matrix.copy(body);
    this.root.matrixWorldNeedsUpdate = true;

    const head = this.joints.head;
    this.frame.makeRotationFromQuaternion(headRotation);
    this.rotated.copy(this.headPivot).applyMatrix4(this.frame);
    this.frame.setPosition(this.headPivot.x - this.rotated.x, this.headPivot.y - this.rotated.y, this.headPivot.z - this.rotated.z);
    head.current.multiplyMatrices(this.frame, head.bind);

    for (const side of ARM_SIDES) {
      const arm = this.arms[side];
      const armPose = pose[side];
      arm.upper.current.copy(armPose.upper);
      arm.forearm.current.copy(armPose.forearm);
      arm.hand.current.copy(armPose.hand);
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
    this.hair?.apply(body, time, this.mapped);
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
      // False once another view took the model: this view then draws nothing.
      modelAttached: this.model.scene.parent === this.fit,
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    // A replacement view may already own the same model; leaving its scene alone keeps it rendering.
    if (this.model.scene.parent === this.fit) this.model.scene.removeFromParent();
  }
}
