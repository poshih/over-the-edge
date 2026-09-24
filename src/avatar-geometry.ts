import { BufferGeometry, Color, Float32BufferAttribute, MathUtils, Uint16BufferAttribute } from 'three';
import { ARM_GEOMETRY, ARM_LENGTH } from './arm-ik';
import { ARM_SIDES, HEAD_GEOMETRY } from './character';
import type { ArmSide } from './character';

export const AVATAR_JOINTS = {
  body: 0,
  head: 1,
  left: { upper: 2, forearm: 3, hand: 4 },
  right: { upper: 5, forearm: 6, hand: 7 },
} as const;

export const AVATAR_BIND = {
  headY: HEAD_GEOMETRY.neck[1],
  armDirection: { left: -1, right: 1 },
  armNormal: [0, 0, -1],
  handAxis: [1, 0, 0],
  handForward: [0, 0, 1],
} as const;

const BODY_SEGMENTS = 32;
const SHOULDER_PATCH_WIDTH = 4;
const SHOULDER_COLUMNS: Readonly<Record<ArmSide, number>> = { left: BODY_SEGMENTS / 2 + 1, right: 1 };
const SHOULDER_HALF_HEIGHT = 0.09;
const SHOULDER_Y = ARM_GEOMETRY.left.shoulder[1];
const FRONT_COLUMN = BODY_SEGMENTS / 4;
const EYE_COLUMN_OFFSET = 2;
const HEAD = { top: 1.305, sideHairStart: 1.025, noseSharpness: 32, earSharpness: 12 } as const;
const SKINNING = {
  shoulderStart: -0.08,
  shoulderEnd: 0.26,
  shoulderInnerHeight: SHOULDER_HALF_HEIGHT,
  shoulderOuterHeight: 0.24,
  elbowBlend: 0.13,
  wristBlend: 0.16,
  palmStart: 0.025,
  neckLength: 0.06,
} as const;

const COLORS = {
  shirt: new Color(0x3d6d72),
  placket: new Color(0x244852),
  collar: new Color(0xc89956),
  skin: new Color(0xbd8560),
  eyes: new Color(0x243037),
  hair: new Color(0x343338),
  mouth: new Color(0x824e43),
  glove: new Color(0x39444e),
} as const;

type BodySurface = 'shirt' | 'collar' | 'neck' | 'face' | 'mouth' | 'eyes' | 'brows' | 'hair';
type BodyRing = readonly [
  y: number, width: number, depth: number, surface: BodySurface, nose: number, ears: number,
];

// Original workwear silhouette, sculpted as one loft rather than assembled primitive meshes.
const LOWER_BODY: readonly BodyRing[] = [
  [0.28, 0.19, 0.135, 'shirt', 0, 0],
  [0.35, 0.217, 0.15, 'shirt', 0, 0],
  [0.49, 0.248, 0.162, 'shirt', 0, 0],
  [0.61, 0.262, 0.169, 'shirt', 0, 0],
];
const SHOULDERS: readonly BodyRing[] = [
  [SHOULDER_Y - SHOULDER_HALF_HEIGHT, 0.268, 0.175, 'shirt', 0, 0],
  [SHOULDER_Y, 0.274, 0.178, 'shirt', 0, 0],
  [SHOULDER_Y + SHOULDER_HALF_HEIGHT, 0.252, 0.159, 'shirt', 0, 0],
];
const NECK_AND_HEAD: readonly BodyRing[] = [
  [0.865, 0.154, 0.11, 'collar', 0, 0],
  [AVATAR_BIND.headY, 0.082, 0.078, 'collar', 0, 0],
  [0.925, 0.076, 0.072, 'neck', 0, 0],
  [0.947, 0.111, 0.086, 'face', 0, 0],
  [0.97, 0.145, 0.11, 'face', 0, 0],
  [1, 0.174, 0.136, 'mouth', 0.005, 0],
  [1.025, 0.185, 0.148, 'face', 0.033, 0.012],
  [1.055, 0.19, 0.151, 'face', 0.048, 0.022],
  [1.083, 0.193, 0.152, 'eyes', 0.024, 0.022],
  [1.106, 0.192, 0.151, 'brows', 0.01, 0.01],
  [1.139, 0.187, 0.15, 'face', 0, 0],
  [1.17, 0.177, 0.145, 'hair', 0, 0],
  [1.208, 0.158, 0.133, 'hair', 0, 0],
  [1.248, 0.121, 0.105, 'hair', 0, 0],
  [1.282, 0.07, 0.064, 'hair', 0, 0],
];
const BODY_PROFILE = [...LOWER_BODY, ...SHOULDERS, ...NECK_AND_HEAD];
const SHOULDER_BOTTOM = LOWER_BODY.length;
const SHOULDER_TOP = SHOULDER_BOTTOM + SHOULDERS.length - 1;
const ARM_REACH = ARM_LENGTH.upper + ARM_LENGTH.forearm;
const HAND_TIP = ARM_REACH + 0.128;

type ArmRing = readonly [distance: number, height: number, depth: number, surface: 'shirt' | 'collar' | 'glove'];
const ARM_PROFILE: readonly ArmRing[] = [
  [0.15, 0.104, 0.086, 'shirt'],
  [0.28, 0.095, 0.08, 'shirt'],
  [ARM_LENGTH.upper * 0.56, 0.084, 0.074, 'shirt'],
  [ARM_LENGTH.upper * 0.83, 0.076, 0.069, 'shirt'],
  [ARM_LENGTH.upper * 0.94, 0.074, 0.068, 'shirt'],
  [ARM_LENGTH.upper, 0.074, 0.068, 'shirt'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.06, 0.072, 0.065, 'shirt'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.2, 0.071, 0.064, 'shirt'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.48, 0.063, 0.059, 'shirt'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.72, 0.058, 0.056, 'shirt'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.83, 0.06, 0.056, 'collar'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.89, 0.059, 0.055, 'collar'],
  [ARM_LENGTH.upper + ARM_LENGTH.forearm * 0.96, 0.076, 0.07, 'glove'],
  [ARM_REACH, 0.082, 0.073, 'glove'],
  [ARM_REACH + 0.055, 0.071, 0.062, 'glove'],
  [ARM_REACH + 0.103, 0.041, 0.04, 'glove'],
];

function bodyColor(surface: BodySurface, column: number, y: number, sine: number): Color {
  if (surface === 'shirt') return column === FRONT_COLUMN ? COLORS.placket : COLORS.shirt;
  if (surface === 'collar') return COLORS.collar;
  if (surface === 'neck') return COLORS.skin;
  if (surface === 'hair' || (sine < 0 && y >= HEAD.sideHairStart)) return COLORS.hair;
  const fromCenter = Math.abs(column - FRONT_COLUMN);
  if (surface === 'eyes' && fromCenter === EYE_COLUMN_OFFSET) return COLORS.eyes;
  if (surface === 'brows' && fromCenter === EYE_COLUMN_OFFSET) return COLORS.hair;
  if (surface === 'mouth' && fromCenter <= 1) return COLORS.mouth;
  return COLORS.skin;
}

function shoulderWeight(side: ArmSide, x: number, y: number): number {
  const shoulder = ARM_GEOMETRY[side].shoulder;
  const outward = AVATAR_BIND.armDirection[side] * (x - shoulder[0]);
  return MathUtils.smoothstep(outward, SKINNING.shoulderStart, SKINNING.shoulderEnd)
    * (1 - MathUtils.smoothstep(Math.abs(y - shoulder[1]), SKINNING.shoulderInnerHeight, SKINNING.shoulderOuterHeight));
}

export function createAvatarGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];
  const bodyRings: number[][] = [];

  function vertex(x: number, y: number, z: number, color: Color, first: number, second: number, blend: number): number {
    const index = positions.length / 3;
    positions.push(x, y, z);
    colors.push(color.r, color.g, color.b);
    skinIndices.push(first, second, 0, 0);
    skinWeights.push(1 - blend, blend, 0, 0);
    return index;
  }

  function quad(a: number, b: number, c: number, d: number): void {
    indices.push(a, b, d, d, b, c);
  }

  function capEnd(ring: readonly number[], tip: number): void {
    for (let index = 0; index < ring.length; index++) {
      indices.push(ring[index], tip, ring[(index + 1) % ring.length]);
    }
  }

  for (let row = 0; row < BODY_PROFILE.length; row++) {
    const [y, width, depth, surface, nose, ears] = BODY_PROFILE[row];
    const ring: number[] = [];
    for (let column = 0; column < BODY_SEGMENTS; column++) {
      const patchInterior = row > SHOULDER_BOTTOM && row < SHOULDER_TOP && ARM_SIDES.some((side) =>
        column > SHOULDER_COLUMNS[side] && column < SHOULDER_COLUMNS[side] + SHOULDER_PATCH_WIDTH);
      if (patchInterior) {
        ring.push(-1);
        continue;
      }
      const angle = column * Math.PI * 2 / BODY_SEGMENTS;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const x = width * cosine + ears * Math.sign(cosine) * Math.abs(cosine) ** HEAD.earSharpness;
      const z = depth * sine + nose * Math.max(0, sine) ** HEAD.noseSharpness;
      const side = x < 0 ? 'left' : 'right';
      const head = y >= AVATAR_BIND.headY;
      const blend = head
        ? MathUtils.smoothstep(y, AVATAR_BIND.headY, AVATAR_BIND.headY + SKINNING.neckLength)
        : surface === 'shirt' ? shoulderWeight(side, x, y) : 0;
      ring.push(vertex(x, y, z, bodyColor(surface, column, y, sine),
        AVATAR_JOINTS.body, head ? AVATAR_JOINTS.head : AVATAR_JOINTS[side].upper, blend));
    }
    bodyRings.push(ring);
  }

  for (let row = 0; row < bodyRings.length - 1; row++) {
    for (let column = 0; column < BODY_SEGMENTS; column++) {
      const patchCell = row >= SHOULDER_BOTTOM && row < SHOULDER_TOP && ARM_SIDES.some((side) =>
        column >= SHOULDER_COLUMNS[side] && column < SHOULDER_COLUMNS[side] + SHOULDER_PATCH_WIDTH);
      if (patchCell) continue;
      const next = (column + 1) % BODY_SEGMENTS;
      quad(bodyRings[row][column], bodyRings[row + 1][column], bodyRings[row + 1][next], bodyRings[row][next]);
    }
  }

  const bottom = vertex(0, BODY_PROFILE[0][0], 0, COLORS.shirt, AVATAR_JOINTS.body, AVATAR_JOINTS.body, 0);
  for (let column = 0; column < BODY_SEGMENTS; column++) {
    indices.push(bottom, bodyRings[0][column], bodyRings[0][(column + 1) % BODY_SEGMENTS]);
  }
  capEnd(bodyRings[bodyRings.length - 1], vertex(0, HEAD.top, 0, COLORS.hair, AVATAR_JOINTS.head, AVATAR_JOINTS.head, 0));

  for (const side of ARM_SIDES) {
    const start = SHOULDER_COLUMNS[side];
    const end = start + SHOULDER_PATCH_WIDTH;
    const shoulder = ARM_GEOMETRY[side].shoulder;
    const direction = AVATAR_BIND.armDirection[side];
    const joints = AVATAR_JOINTS[side];
    const boundary: number[] = [];
    // Reuse the hole's twelve boundary indices. There is no shoulder cap, overlap, or duplicate seam.
    for (let column = start; column <= end; column++) boundary.push(bodyRings[SHOULDER_BOTTOM][column]);
    for (let row = SHOULDER_BOTTOM + 1; row <= SHOULDER_TOP; row++) boundary.push(bodyRings[row][end]);
    for (let column = end - 1; column >= start; column--) boundary.push(bodyRings[SHOULDER_TOP][column]);
    for (let row = SHOULDER_TOP - 1; row > SHOULDER_BOTTOM; row--) boundary.push(bodyRings[row][start]);
    const angles = boundary.map((index) =>
      Math.atan2(positions[index * 3 + 2] - shoulder[2], -direction * (positions[index * 3 + 1] - shoulder[1])));
    let previous = boundary;

    for (const [distance, height, depth, surface] of ARM_PROFILE) {
      const ring: number[] = [];
      for (const angle of angles) {
        const x = shoulder[0] + direction * distance;
        const y = shoulder[1] - direction * height * Math.cos(angle);
        const z = shoulder[2] + depth * Math.sin(angle);
        let first: number;
        let second: number;
        let blend: number;
        if (distance < ARM_LENGTH.upper - SKINNING.elbowBlend) {
          first = AVATAR_JOINTS.body;
          second = joints.upper;
          blend = shoulderWeight(side, x, y);
        } else if (distance < ARM_LENGTH.upper + SKINNING.elbowBlend) {
          first = joints.upper;
          second = joints.forearm;
          blend = MathUtils.smoothstep(distance, ARM_LENGTH.upper - SKINNING.elbowBlend, ARM_LENGTH.upper + SKINNING.elbowBlend);
        } else {
          first = joints.forearm;
          second = joints.hand;
          blend = MathUtils.smoothstep(distance, ARM_REACH - SKINNING.wristBlend, ARM_REACH - SKINNING.palmStart);
        }
        ring.push(vertex(x, y, z, COLORS[surface], first, second, blend));
      }
      for (let index = 0; index < ring.length; index++) {
        const next = (index + 1) % ring.length;
        quad(previous[index], ring[index], ring[next], previous[next]);
      }
      previous = ring;
    }
    capEnd(previous, vertex(shoulder[0] + direction * HAND_TIP, shoulder[1], shoulder[2],
      COLORS.glove, joints.hand, joints.hand, 0));
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
