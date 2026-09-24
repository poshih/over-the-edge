import { MathUtils, Quaternion, Vector3 } from 'three';
import type { ArmSide } from './character';
import { clamp } from './math';

export const ARM_LENGTH = { upper: 0.82, forearm: 0.82 } as const;
const DIRECTION_EPSILON = 1e-8;
const POLE_SINGULARITY_SINE = 0.15;
const MAX_BEND_SPEED = 8;
export const ARM_GEOMETRY = {
  left: { shoulder: [-0.17, 0.74, -0.09], gripX: 0.04, normalSign: -1 },
  right: { shoulder: [0.17, 0.74, 0.09], gripX: 0.22, normalSign: 1 },
} as const;

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

function initialBend(axis: Vector3, side: ArmSide): Vector3 {
  const reference = Math.abs(axis.x) + DIRECTION_EPSILON < Math.abs(axis.z)
    ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
  return reference.addScaledVector(axis, -reference.dot(axis)).normalize()
    .multiplyScalar(ARM_GEOMETRY[side].normalSign);
}

export function solveArmPose(side: ArmSide, targets: ArmTargets, options: { previous: ArmPose | null; dt: number }): ArmPose {
  const { previous, dt } = options;
  const { shoulder, hand, hint, shaftAxis } = targets;
  const axis = new Vector3().subVectors(hand, shoulder);
  const distance = axis.length();
  if (distance > DIRECTION_EPSILON) axis.divideScalar(distance);
  else if (previous !== null) axis.copy(previous.axis);
  else axis.copy(shaftAxis);

  // Opposite reach axes describe the same elbow circle plane, notably when a hand crosses its shoulder.
  const transportAxis = previous !== null && previous.axis.dot(axis) < 0 ? axis.clone().negate() : axis;
  const bendDirection = previous === null ? initialBend(axis, side) :
    previous.bendDirection.clone().applyQuaternion(new Quaternion().setFromUnitVectors(previous.axis, transportAxis));
  bendDirection.addScaledVector(axis, -bendDirection.dot(axis)).normalize();
  const towardHint = new Vector3().subVectors(hint, shoulder);
  const projected = towardHint.clone().addScaledVector(axis, -towardHint.dot(axis));
  if (projected.length() > DIRECTION_EPSILON) {
    const confidence = MathUtils.smoothstep(projected.length() / towardHint.length(), 0, POLE_SINGULARITY_SINE);
    projected.normalize();
    const sine = axis.dot(new Vector3().crossVectors(bendDirection, projected));
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
    (ARM_LENGTH.upper ** 2 - ARM_LENGTH.forearm ** 2 + distance ** 2) / (2 * distance),
    -ARM_LENGTH.upper, ARM_LENGTH.upper,
  );
  const bend = Math.sqrt(Math.max(0, ARM_LENGTH.upper ** 2 - along ** 2));
  const elbow = shoulder.clone().addScaledVector(axis, along).addScaledVector(bendDirection, bend);
  const normal = new Vector3().crossVectors(axis, bendDirection).normalize()
    .multiplyScalar(ARM_GEOMETRY[side].normalSign);
  if (previous !== null && normal.dot(previous.normal) < -DIRECTION_EPSILON) normal.negate();
  return { side, shoulder, elbow, hand, hint, normal, axis, bendDirection, shaftAxis };
}
