import { ARM_SIDES } from './character';
import type { ArmSide } from './character';
import type { Point } from './config';
import { angleDifference } from './math';

export interface Transform2 extends Point { angle: number }
export interface Rotation3 { x: number; y: number; z: number; w: number }
export interface DeathArmPose {
  shoulder: Point;
  elbow: Point;
  hand: Transform2;
}
export interface DeathPose {
  torso: Transform2;
  head: Transform2;
  arms: Record<ArmSide, DeathArmPose>;
}
export interface ReadonlyDeathArmPose {
  readonly shoulder: Readonly<Point>;
  readonly elbow: Readonly<Point>;
  readonly hand: Readonly<Transform2>;
}
export interface ReadonlyDeathPose {
  readonly torso: Readonly<Transform2>;
  readonly head: Readonly<Transform2>;
  readonly arms: Readonly<Record<ArmSide, ReadonlyDeathArmPose>>;
}

// The resolved waist and neck, in the torso's local frame. Body construction and presentation
// share the captured layout; asset changes take effect only at the next placement.
export interface DeathLayout {
  waist: Point;
  neck: Point;
}
export interface ReadonlyDeathLayout {
  readonly waist: Readonly<Point>;
  readonly neck: Readonly<Point>;
}
export interface DeathSeed {
  placement: number;
  time: number;
  centre: Transform2;
  layout: DeathLayout;
  pose: DeathPose;
  headFacing: Rotation3;
  direction: -1 | 1;
}

interface PlayerCentre { readonly centre: Readonly<Transform2> }
export interface LivePlayerFrame extends PlayerCentre {
  readonly phase: 'alive';
  readonly shoulder: Readonly<Point>;
}
export interface DeathPlayerFrame extends PlayerCentre {
  readonly phase: 'dying-ragdoll' | 'dying-rigid';
  readonly pose: ReadonlyDeathPose;
  readonly layout: ReadonlyDeathLayout;
  readonly headFacing: Readonly<Rotation3>;
  readonly direction: -1 | 1;
}
export type PlayerFrameState = LivePlayerFrame | DeathPlayerFrame;
export interface MutableLivePlayerFrame extends LivePlayerFrame { centre: Transform2; shoulder: Point }
export interface MutableDeathPlayerFrame extends DeathPlayerFrame { centre: Transform2; pose: DeathPose }
export type MutablePlayerFrameState = MutableLivePlayerFrame | MutableDeathPlayerFrame;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finitePoint(value: unknown, transform = false): boolean {
  return object(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && (!transform || Number.isFinite(value.angle));
}
export function validDeathPose(value: unknown): value is ReadonlyDeathPose {
  if (!object(value) || !finitePoint(value.torso, true) || !finitePoint(value.head, true) || !object(value.arms)) return false;
  for (const side of ARM_SIDES) {
    const arm = value.arms[side];
    if (!object(arm) || !finitePoint(arm.shoulder) || !finitePoint(arm.elbow) || !finitePoint(arm.hand, true)) return false;
  }
  return true;
}
export function validHeadFacing(value: unknown): value is Readonly<Rotation3> {
  if (!object(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z) || !Number.isFinite(value.w)) return false;
  const q = value as unknown as Rotation3;
  return Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1) <= 1e-4;
}

export function createDeathPose(): DeathPose {
  const arm = (): DeathArmPose => ({ shoulder: { x: 0, y: 0 }, elbow: { x: 0, y: 0 }, hand: { x: 0, y: 0, angle: 0 } });
  return { torso: { x: 0, y: 0, angle: 0 }, head: { x: 0, y: 0, angle: 0 }, arms: { left: arm(), right: arm() } };
}
export function createDeathSeed(): DeathSeed {
  return {
    placement: 0, time: 0, centre: { x: 0, y: 0, angle: 0 },
    layout: { waist: { x: 0, y: 0 }, neck: { x: 0, y: 0 } },
    pose: createDeathPose(), headFacing: { x: 0, y: 0, z: 0, w: 1 }, direction: 1,
  };
}
export function copyPoint(out: Point, from: Readonly<Point>): void { out.x = from.x; out.y = from.y; }
export function copyTransform(out: Transform2, from: Readonly<Transform2>): void {
  copyPoint(out, from); out.angle = from.angle;
}
export function copyRotation(out: Rotation3, from: Readonly<Rotation3>): void {
  out.x = from.x; out.y = from.y; out.z = from.z; out.w = from.w;
}
export function copyDeathPose(out: DeathPose, from: ReadonlyDeathPose): void {
  copyTransform(out.torso, from.torso); copyTransform(out.head, from.head);
  copyPoint(out.arms.left.shoulder, from.arms.left.shoulder);
  copyPoint(out.arms.left.elbow, from.arms.left.elbow);
  copyTransform(out.arms.left.hand, from.arms.left.hand);
  copyPoint(out.arms.right.shoulder, from.arms.right.shoulder);
  copyPoint(out.arms.right.elbow, from.arms.right.elbow);
  copyTransform(out.arms.right.hand, from.arms.right.hand);
}
export function copyDeathSeed(from: DeathSeed): DeathSeed {
  const out = createDeathSeed();
  out.placement = from.placement; out.time = from.time; out.direction = from.direction;
  copyTransform(out.centre, from.centre);
  copyPoint(out.layout.waist, from.layout.waist); copyPoint(out.layout.neck, from.layout.neck);
  copyRotation(out.headFacing, from.headFacing); copyDeathPose(out.pose, from.pose);
  return out;
}
function interpolatePoint(out: Point, from: Readonly<Point>, to: Readonly<Point>, alpha: number): void {
  out.x = from.x + (to.x - from.x) * alpha; out.y = from.y + (to.y - from.y) * alpha;
}
export function interpolateTransform(out: Transform2, from: Readonly<Transform2>, to: Readonly<Transform2>, alpha: number): void {
  interpolatePoint(out, from, to, alpha);
  out.angle = from.angle + angleDifference(to.angle, from.angle) * alpha;
}
export function interpolateDeathPose(out: DeathPose, from: ReadonlyDeathPose, to: ReadonlyDeathPose, alpha: number): void {
  interpolateTransform(out.torso, from.torso, to.torso, alpha); interpolateTransform(out.head, from.head, to.head, alpha);
  interpolatePoint(out.arms.left.shoulder, from.arms.left.shoulder, to.arms.left.shoulder, alpha);
  interpolatePoint(out.arms.left.elbow, from.arms.left.elbow, to.arms.left.elbow, alpha);
  interpolateTransform(out.arms.left.hand, from.arms.left.hand, to.arms.left.hand, alpha);
  interpolatePoint(out.arms.right.shoulder, from.arms.right.shoulder, to.arms.right.shoulder, alpha);
  interpolatePoint(out.arms.right.elbow, from.arms.right.elbow, to.arms.right.elbow, alpha);
  interpolateTransform(out.arms.right.hand, from.arms.right.hand, to.arms.right.hand, alpha);
}
