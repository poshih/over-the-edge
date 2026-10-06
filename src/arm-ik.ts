import { MathUtils, Quaternion, Vector3 } from 'three';
import type { ArmSide } from './character';
import { clamp } from './math';

export const ARM_LENGTH = { upper: 0.82, forearm: 0.82 } as const;
const DIRECTION_EPSILON = 1e-8;
const POLE_SINGULARITY_SINE = 0.15;
const MAX_BEND_SPEED = 8;
export const ARM_GEOMETRY = {
  left: { shoulder: [-0.17, 0.74, -0.09], normalSign: -1 },
  right: { shoulder: [0.17, 0.74, 0.09], normalSign: 1 },
} as const;

// A two-bone arm: torso-local shoulder and bind-pose segment lengths.
export interface ArmChain {
  readonly shoulder: readonly [number, number, number];
  readonly upper: number;
  readonly forearm: number;
}
export type ArmChains = Readonly<Record<ArmSide, ArmChain>>;

export const DEFAULT_ARM_CHAINS: ArmChains = Object.freeze({
  left: Object.freeze({ shoulder: ARM_GEOMETRY.left.shoulder, upper: ARM_LENGTH.upper, forearm: ARM_LENGTH.forearm }),
  right: Object.freeze({ shoulder: ARM_GEOMETRY.right.shoulder, upper: ARM_LENGTH.upper, forearm: ARM_LENGTH.forearm }),
});

interface ArmTargets {
  shoulder: Vector3;
  hand: Vector3;
  hint: Vector3;
  shaftAxis: Vector3;
}

export interface ArmPose {
  side: ArmSide;
  shoulder: Vector3;
  hand: Vector3;
  hint: Vector3;
  elbow: Vector3;
  normal: Vector3;
  axis: Vector3;
  bendDirection: Vector3;
  shaftAxis: Vector3;
}

function initialBend(axis: Vector3, side: ArmSide, out: Vector3): Vector3 {
  if (Math.abs(axis.x) + DIRECTION_EPSILON < Math.abs(axis.z)) out.set(1, 0, 0);
  else out.set(0, 0, 1);
  return out.addScaledVector(axis, -out.dot(axis)).normalize()
    .multiplyScalar(ARM_GEOMETRY[side].normalSign);
}

// Synchronous numeric scratch, shared as placeLimb's is: no callbacks run inside the solver.
const axis = new Vector3();
const transportAxis = new Vector3();
const bendDirection = new Vector3();
const towardHint = new Vector3();
const projected = new Vector3();
const normal = new Vector3();
const rotation = new Quaternion();

function writeArmPose(side: ArmSide, targets: ArmTargets, previous: ArmPose | null, dt: number,
  lengths: Pick<ArmChain, 'upper' | 'forearm'>, out: ArmPose): ArmPose {
  const { upper, forearm } = lengths;
  const { shoulder, hand, hint, shaftAxis } = targets;
  axis.subVectors(hand, shoulder);
  const distance = axis.length();
  if (distance > DIRECTION_EPSILON) axis.divideScalar(distance);
  else if (previous !== null) axis.copy(previous.axis);
  else axis.copy(shaftAxis);

  // Opposite reach axes describe the same elbow circle plane, notably when a hand crosses its shoulder.
  transportAxis.copy(axis);
  if (previous !== null && previous.axis.dot(axis) < 0) transportAxis.negate();
  if (previous === null) initialBend(axis, side, bendDirection);
  else bendDirection.copy(previous.bendDirection).applyQuaternion(rotation.setFromUnitVectors(previous.axis, transportAxis));
  bendDirection.addScaledVector(axis, -bendDirection.dot(axis)).normalize();
  towardHint.subVectors(hint, shoulder);
  projected.copy(towardHint).addScaledVector(axis, -towardHint.dot(axis));
  if (projected.length() > DIRECTION_EPSILON) {
    const confidence = MathUtils.smoothstep(projected.length() / towardHint.length(), 0, POLE_SINGULARITY_SINE);
    projected.normalize();
    const sine = axis.dot(normal.crossVectors(bendDirection, projected));
    const cosine = bendDirection.dot(projected);
    // At an exact half-turn, roundoff must not choose a different route after a world-space translation.
    const angle = cosine < 0 && Math.abs(sine) < DIRECTION_EPSILON
      ? Math.PI * ARM_GEOMETRY[side].normalSign : Math.atan2(sine, cosine);
    // A collinear hint cannot define a bend plane. Transport the previous plane through that singularity.
    const turn = angle * confidence;
    const limit = previous === null ? Math.abs(turn) : MAX_BEND_SPEED * dt;
    bendDirection.applyAxisAngle(axis, clamp(turn, -limit, limit)).normalize();
  }

  const along = distance <= DIRECTION_EPSILON ? 0 : clamp(
    (upper ** 2 - forearm ** 2 + distance ** 2) / (2 * distance),
    -upper, upper,
  );
  const bend = Math.sqrt(Math.max(0, upper ** 2 - along ** 2));
  normal.crossVectors(axis, bendDirection).normalize()
    .multiplyScalar(ARM_GEOMETRY[side].normalSign);
  if (previous !== null && normal.dot(previous.normal) < -DIRECTION_EPSILON) normal.negate();
  // Calculate against the old history before writing: previous may be out, as in the pooled solver.
  out.shoulder.copy(shoulder);
  out.hand.copy(hand);
  out.hint.copy(hint);
  out.shaftAxis.copy(shaftAxis);
  out.elbow.copy(shoulder).addScaledVector(axis, along).addScaledVector(bendDirection, bend);
  out.normal.copy(normal);
  out.axis.copy(axis);
  out.bendDirection.copy(bendDirection);
  return out;
}

// One arm's pooled output and history. Phantom looks keep one per arm per figure, so neither targets nor the
// solver's intermediate vectors, quaternions or result allocate per frame. The same math also serves the player.
export class ArmPoseSolver {
  private readonly pose: ArmPose;
  private ready = false;

  constructor(side: ArmSide) {
    this.pose = {
      side, shoulder: new Vector3(), hand: new Vector3(), hint: new Vector3(), shaftAxis: new Vector3(),
      elbow: new Vector3(), normal: new Vector3(), axis: new Vector3(), bendDirection: new Vector3(),
    };
  }

  reset(): void { this.ready = false; }

  solve(targets: ArmTargets, dt: number, lengths: Pick<ArmChain, 'upper' | 'forearm'>): ArmPose {
    writeArmPose(this.pose.side, targets, this.ready ? this.pose : null, dt, lengths, this.pose);
    this.ready = true;
    return this.pose;
  }
}
