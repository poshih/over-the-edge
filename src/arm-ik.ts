import { MathUtils, Vector3 } from 'three';
import type { ArmSide } from './appearance-types';
import type { Point } from './config';
import { clamp, transformPoint } from './math';

const ARM_LENGTH = { upper: 0.82, forearm: 0.82 } as const;
const SHOULDER_HEIGHT = 0.74;
const ARM_GEOMETRY = {
  left: { shoulderX: -0.17, gripX: 0.04, depth: 0.18, bendSign: -1 },
  right: { shoulderX: 0.17, gripX: 0.22, depth: 0.63, bendSign: 1 },
} as const;

export function solveArmPose(side: ArmSide, root: Point, slider: Point & { angle: number }, elbowAngle: number) {
  const geometry = ARM_GEOMETRY[side];
  const shoulder = new Vector3(root.x + geometry.shoulderX, root.y + SHOULDER_HEIGHT, geometry.depth);
  const grip = transformPoint({ x: geometry.gripX, y: 0 }, slider, slider.angle);
  const hand = new Vector3(grip.x, grip.y, geometry.depth);
  const dx = hand.x - shoulder.x;
  const dy = hand.y - shoulder.y;
  const distance = Math.hypot(dx, dy);
  // At a coincident grip, the shaft axis defines the fully folded arm's plane.
  const axis = distance === 0
    ? new Vector3(Math.cos(slider.angle), Math.sin(slider.angle), 0)
    : new Vector3(dx / distance, dy / distance, 0);
  const along = distance === 0 ? 0 : clamp(
    (ARM_LENGTH.upper ** 2 - ARM_LENGTH.forearm ** 2 + distance ** 2) / (2 * distance),
    -ARM_LENGTH.upper, ARM_LENGTH.upper,
  );
  const bend = Math.sqrt(Math.max(0, ARM_LENGTH.upper ** 2 - along ** 2)) * geometry.bendSign;
  const angle = MathUtils.degToRad(elbowAngle);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const elbow = new Vector3(
    shoulder.x + axis.x * along - axis.y * bend * cosine,
    shoulder.y + axis.y * along + axis.x * bend * cosine,
    shoulder.z + bend * sine,
  );
  const normal = new Vector3(axis.y * sine, -axis.x * sine, cosine);
  return { shoulder, elbow, hand, normal };
}
