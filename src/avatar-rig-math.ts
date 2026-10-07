// Shared avatar-rig math: fitting a model's joints into the avatar's frame and composing the
// arm-joint matrices an arm solution produces. Pure numeric (Three.js math only) with no scene,
// material or renderer access, so the engine views, offline authoring tools and rig strategies all
// run the one implementation. The per-frame frame builders use scalar arithmetic and write their
// output matrix directly, so they allocate nothing and share no state between calls.
import { Matrix4, Vector3 } from 'three';
import { ARM_GEOMETRY } from './player-figure-data';
import type { ArmChain, ArmChains } from './player-figure-data';
import { AVATAR_BIND } from './avatar-geometry';
import { ARM_SIDES } from './character';
import type { ArmSide } from './character';
import { AVATAR_JOINT_IDS, CharacterModelError } from './character-profile';
import type { AvatarBoneMap, AvatarJointId } from './character-profile';
import type { CharacterModelJoint, CharacterModelReport } from './character-model-inspect';
import type { GripShoulder } from './grips';

// The built-in avatar's shoulder span and midpoint; imported rigs are scaled to match them. Scalar
// components keep the fit free of shared mutable vectors.
export const SHOULDER_SPAN = ARM_GEOMETRY.right.shoulder[0] - ARM_GEOMETRY.left.shoulder[0];
const SHOULDER_CENTER_X = (ARM_GEOMETRY.left.shoulder[0] + ARM_GEOMETRY.right.shoulder[0]) * 0.5;
const SHOULDER_CENTER_Y = (ARM_GEOMETRY.left.shoulder[1] + ARM_GEOMETRY.right.shoulder[1]) * 0.5;
const SHOULDER_CENTER_Z = (ARM_GEOMETRY.left.shoulder[2] + ARM_GEOMETRY.right.shoulder[2]) * 0.5;
export const SHOULDER_CENTER = Object.freeze([SHOULDER_CENTER_X, SHOULDER_CENTER_Y, SHOULDER_CENTER_Z] as const);
// A bone nearly parallel to the bind arm normal cannot define a bend plane.
const PARALLEL_LIMIT = 0.99;

/**
 * Builds the column-basis frame the arm solver's IK uses for a limb: +Y along the segment divided
 * by its bind length (so a solved stretch is carried through), +X along the bend plane, +Z its normal.
 */
export function limbFrame(target: Matrix4, start: Vector3, end: Vector3, bendNormal: Vector3, restLength: number): void {
  const sx = (end.x - start.x) / restLength;
  const sy = (end.y - start.y) / restLength;
  const sz = (end.z - start.z) / restLength;
  let cx = sy * bendNormal.z - sz * bendNormal.y;
  let cy = sz * bendNormal.x - sx * bendNormal.z;
  let cz = sx * bendNormal.y - sy * bendNormal.x;
  const sideLength = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
  cx /= sideLength; cy /= sideLength; cz /= sideLength;
  let nx = cy * sz - cz * sy;
  let ny = cz * sx - cx * sz;
  let nz = cx * sy - cy * sx;
  const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= normalLength; ny /= normalLength; nz /= normalLength;
  const elements = target.elements;
  elements[0] = cx; elements[1] = cy; elements[2] = cz; elements[3] = 0;
  elements[4] = sx; elements[5] = sy; elements[6] = sz; elements[7] = 0;
  elements[8] = nx; elements[9] = ny; elements[10] = nz; elements[11] = 0;
  elements[12] = start.x; elements[13] = start.y; elements[14] = start.z; elements[15] = 1;
}

/** Builds a hand frame: +Y along the hand's shaft, +X across it, +Z in front of the palm. */
export function handFrame(target: Matrix4, position: Vector3, shaft: Vector3, forward: Vector3): void {
  let cx = shaft.y * forward.z - shaft.z * forward.y;
  let cy = shaft.z * forward.x - shaft.x * forward.z;
  let cz = shaft.x * forward.y - shaft.y * forward.x;
  const sideLength = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
  cx /= sideLength; cy /= sideLength; cz /= sideLength;
  let nx = cy * shaft.z - cz * shaft.y;
  let ny = cz * shaft.x - cx * shaft.z;
  let nz = cx * shaft.y - cy * shaft.x;
  const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= normalLength; ny /= normalLength; nz /= normalLength;
  const elements = target.elements;
  elements[0] = cx; elements[1] = cy; elements[2] = cz; elements[3] = 0;
  elements[4] = shaft.x; elements[5] = shaft.y; elements[6] = shaft.z; elements[7] = 0;
  elements[8] = nx; elements[9] = ny; elements[10] = nz; elements[11] = 0;
  elements[12] = position.x; elements[13] = position.y; elements[14] = position.z; elements[15] = 1;
}

/**
 * The arm normal to build a bind-pose frame around. A bone nearly parallel to the avatar's arm
 * normal cannot define a bend plane, so the fallback normal stands in, exactly as it did before.
 */
export function bindArmNormal(start: Vector3, end: Vector3): Vector3 {
  const direction = new Vector3(end.x - start.x, end.y - start.y, end.z - start.z).normalize();
  const dot = direction.x * AVATAR_BIND.armNormal[0] + direction.y * AVATAR_BIND.armNormal[1]
    + direction.z * AVATAR_BIND.armNormal[2];
  return Math.abs(dot) < PARALLEL_LIMIT
    ? direction.set(AVATAR_BIND.armNormal[0], AVATAR_BIND.armNormal[1], AVATAR_BIND.armNormal[2])
    : direction.set(0, -1, 0);
}

// One arm's fitted solver-frame offsets: each mapped bone relative to the frame its solution builds.
export interface AvatarRigArmBind {
  readonly chain: ArmChain;
  readonly upperOffset: Matrix4;
  readonly forearmOffset: Matrix4;
  readonly handOffset: Matrix4;
}

/**
 * A model's mapped joints fitted into avatar space. Immutable after fitting: strategies and views
 * read it, never rewrite it. `fit` maps model space to avatar space; `joints` are the mapped joints'
 * fitted global bind matrices; `arms` carry the per-side chain and solver-frame offsets.
 */
export interface AvatarRigBinds {
  readonly sha256: string;
  readonly boneMap: AvatarBoneMap;
  readonly scale: number;
  readonly fit: Matrix4;
  readonly chains: ArmChains;
  readonly joints: Readonly<Record<AvatarJointId, Matrix4>>;
  readonly arms: Readonly<Record<ArmSide, AvatarRigArmBind>>;
}

function fittedJoint(report: CharacterModelReport, boneMap: AvatarBoneMap, id: AvatarJointId): CharacterModelJoint {
  const name = boneMap[id];
  const found = report.joints.find((joint) => joint.name === name);
  if (found === undefined) {
    throw new CharacterModelError('unknown-joint', `The model has no skin joint named "${name}".`, { joints: [name] });
  }
  return found;
}

function jointPosition(joint: CharacterModelJoint): Vector3 {
  return new Vector3(joint.bind[12]!, joint.bind[13]!, joint.bind[14]!);
}

/**
 * Fits a model's mapped bind pose into the built-in avatar's frame: scales the shoulder span to
 * match, centres the shoulders, and captures each arm's solver-frame offsets. Reads the report's
 * global bind matrices directly, so it needs no scene, nodes or renderer.
 */
export function fitAvatarRig(report: CharacterModelReport, boneMap: AvatarBoneMap): AvatarRigBinds {
  const records = {} as Record<AvatarJointId, CharacterModelJoint>;
  for (const id of AVATAR_JOINT_IDS) records[id] = fittedJoint(report, boneMap, id);

  const left = jointPosition(records['left-upper-arm']);
  const right = jointPosition(records['right-upper-arm']);
  const scale = SHOULDER_SPAN / (right.x - left.x);
  const centerX = (left.x + right.x) * 0.5 * scale;
  const centerY = (left.y + right.y) * 0.5 * scale;
  const centerZ = (left.z + right.z) * 0.5 * scale;
  const fit = new Matrix4().makeScale(scale, scale, scale).setPosition(
    SHOULDER_CENTER_X - centerX, SHOULDER_CENTER_Y - centerY, SHOULDER_CENTER_Z - centerZ);

  const joints = {} as Record<AvatarJointId, Matrix4>;
  for (const id of AVATAR_JOINT_IDS) {
    joints[id] = new Matrix4().multiplyMatrices(fit, new Matrix4().fromArray(records[id].bind));
  }

  const frame = new Matrix4();
  const handForward = new Vector3(...AVATAR_BIND.handForward);
  const arms = {} as Record<ArmSide, AvatarRigArmBind>;
  for (const side of ARM_SIDES) {
    const upper = joints[`${side}-upper-arm`];
    const forearm = joints[`${side}-forearm`];
    const hand = joints[`${side}-hand`];
    const shoulder = new Vector3().setFromMatrixPosition(upper);
    const elbow = new Vector3().setFromMatrixPosition(forearm);
    const wrist = new Vector3().setFromMatrixPosition(hand);
    const chain: ArmChain = Object.freeze({
      shoulder: Object.freeze([shoulder.x, shoulder.y, shoulder.z] as [number, number, number]),
      upper: shoulder.distanceTo(elbow),
      forearm: elbow.distanceTo(wrist),
    });
    limbFrame(frame, shoulder, elbow, bindArmNormal(shoulder, elbow), chain.upper);
    const upperOffset = new Matrix4().copy(frame).invert().multiply(upper);
    limbFrame(frame, elbow, wrist, bindArmNormal(elbow, wrist), chain.forearm);
    const forearmOffset = new Matrix4().copy(frame).invert().multiply(forearm);
    // In the bind pose the virtual shaft runs along the forearm like the built-in avatar's gloves.
    const shaft = new Vector3().subVectors(wrist, elbow).normalize().multiplyScalar(AVATAR_BIND.armDirection[side]);
    handFrame(frame, wrist, shaft, handForward);
    const handOffset = new Matrix4().copy(frame).invert().multiply(hand);
    arms[side] = Object.freeze({ chain, upperOffset, forearmOffset, handOffset });
  }

  const chains: ArmChains = Object.freeze({ left: arms.left.chain, right: arms.right.chain });
  // No strategy can accidentally corrupt another consumer of the prepared binding.
  const freezeMatrix = (matrix: Matrix4): void => { Object.freeze(matrix.elements); Object.freeze(matrix); };
  freezeMatrix(fit);
  for (const id of AVATAR_JOINT_IDS) freezeMatrix(joints[id]);
  for (const side of ARM_SIDES) {
    freezeMatrix(arms[side].upperOffset);
    freezeMatrix(arms[side].forearmOffset);
    freezeMatrix(arms[side].handOffset);
  }
  return Object.freeze({
    sha256: report.sha256, boneMap: Object.freeze({ ...boneMap }), scale, fit, chains,
    joints: Object.freeze(joints), arms: Object.freeze(arms),
  });
}

/**
 * Composes an arm's avatar-space desired matrices from an explicit arm solution and the fitted
 * bindings. The forearm's stretch is cancelled at the wrist by keeping matrices, never decomposing.
 * This is the one implementation the standard strategy and custom rig strategies build on.
 */
export function composeLimbJoints(bind: AvatarRigArmBind, shoulder: Vector3, elbow: Vector3, wrist: Vector3,
  bendNormal: Vector3, out: Pick<AvatarRigArmPose, 'upper' | 'forearm'>): void {
  limbFrame(out.upper, shoulder, elbow, bendNormal, bind.chain.upper);
  out.upper.multiply(bind.upperOffset);
  limbFrame(out.forearm, elbow, wrist, bendNormal, bind.chain.forearm);
  out.forearm.multiply(bind.forearmOffset);
}

export function composeArmJoints(bind: AvatarRigArmBind, shoulder: Vector3, elbow: Vector3, wrist: Vector3,
  bendNormal: Vector3, shaft: Vector3, forward: Vector3, out: AvatarRigArmPose): void {
  composeLimbJoints(bind, shoulder, elbow, wrist, bendNormal, out);
  handFrame(out.hand, wrist, shaft, forward);
  out.hand.multiply(bind.handOffset);
}

// A shoulder against a unit shaft in the course plane, as the camera sees them: the depth between the body and
// the tool never counts against a hand's reach. Callers provide the effective shoulder (actual shoulder minus
// the wrist offset) in the same frame as the butt.
export function projectGripShoulder(shoulder: Vector3, butt: Vector3, shaftAxis: Vector3,
  arm: number, out: GripShoulder): void {
  const dx = shoulder.x - butt.x, dy = shoulder.y - butt.y;
  const along = dx * shaftAxis.x + dy * shaftAxis.y;
  out.along = along;
  out.aside2 = Math.max(0, dx * dx + dy * dy - along * along);
  out.arm = arm;
}

// One side's wrist target track: the wrist sits at the handle contact plus `offset`, reoriented by
// `shaft` and `forward`. The standard strategy leaves `offset` zero and copies the tool's directions.
export interface AvatarRigHandTrack {
  readonly offset: Vector3;
  readonly shaft: Vector3;
  readonly forward: Vector3;
}

export interface AvatarRigFramePlan {
  readonly left: AvatarRigHandTrack;
  readonly right: AvatarRigHandTrack;
}

export interface AvatarRigArmPose {
  readonly upper: Matrix4;
  readonly forearm: Matrix4;
  readonly hand: Matrix4;
}

export interface AvatarRigPose {
  readonly left: AvatarRigArmPose;
  readonly right: AvatarRigArmPose;
}

// One side's solved arm, expressed in avatar space, with the wrist being the actual IK target.
export interface AvatarRigArmSolution {
  readonly shoulder: Vector3;
  readonly elbow: Vector3;
  readonly wrist: Vector3;
  readonly normal: Vector3;
}

// Phase 1 inputs. `tool` and the directions are already in avatar space, matching the fitted binds.
export interface AvatarRigFrameContext {
  readonly body: Matrix4;
  readonly inverseBody: Matrix4;
  readonly tool: Matrix4;
  readonly shaftAxis: Vector3;
  readonly forward: Vector3;
  readonly shaftLength: number;
  readonly dt: number;
}

// Released poses bypass phase 1. Their plan has zero offsets and forearm-aligned hand directions.
export interface AvatarRigPoseContext {
  readonly body: Matrix4;
  readonly inverseBody: Matrix4;
  readonly plan: AvatarRigFramePlan;
  readonly arms: Readonly<Record<ArmSide, AvatarRigArmSolution>>;
  readonly dt: number;
  readonly attachment: 'gripped' | 'released';
}

export function createFramePlan(): AvatarRigFramePlan {
  const track = (): AvatarRigHandTrack => ({ offset: new Vector3(), shaft: new Vector3(), forward: new Vector3() });
  return { left: track(), right: track() };
}

export function createPose(): AvatarRigPose {
  const arm = (): AvatarRigArmPose => ({ upper: new Matrix4(), forearm: new Matrix4(), hand: new Matrix4() });
  return { left: arm(), right: arm() };
}

export function createArmSolutions(): Record<ArmSide, AvatarRigArmSolution> {
  const solution = (): AvatarRigArmSolution =>
    ({ shoulder: new Vector3(), elbow: new Vector3(), wrist: new Vector3(), normal: new Vector3() });
  return { left: solution(), right: solution() };
}
