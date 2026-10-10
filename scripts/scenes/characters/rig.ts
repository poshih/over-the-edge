// A skinned, animated GLB from a rig: joints at their bind positions, box parts each skinned whole to one joint and
// coloured per vertex, and clips sampled from pose functions. Like the built-in course's rocks it has no normals, so it
// draws flat-shaded. The first joint is the top joint, whose translation along +Z is the root motion the engine bakes.
import { encodeGlb } from '../../glb.ts';

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface Joint {
  readonly name: string;
  // Null for the top joint, under the armature.
  readonly parent: string | null;
  // Where it is in the bind pose, in the model's space: +Y up, facing +Z, +X the model's left.
  readonly at: Vec3;
}

// A convex hexahedron skinned whole to one joint: its eight corners in the bind pose, indexed x | y << 1 | z << 2 as a
// box's corners are, each bit choosing the low or high side along a right-handed frame.
export interface Part {
  readonly joint: string;
  readonly color: number;
  readonly corners: readonly Vec3[];
}

// A joint's pose: its rotation from the bind pose and its offset from its bind position, both in its parent's space.
export interface JointPose {
  readonly rotation?: Quat;
  readonly offset?: Vec3;
}
export type Pose = Readonly<Record<string, JointPose>>;

export interface Clip {
  readonly name: string;
  readonly duration: number;
  // The pose `time` seconds in. A looping clip's last pose is its first, but for the top joint's travel.
  readonly pose: (time: number) => Pose;
}

export interface Rig {
  readonly name: string;
  readonly joints: readonly Joint[];
  readonly parts: readonly Part[];
  readonly clips: readonly Clip[];
  readonly metallic: number;
  readonly roughness: number;
}

// Clips are sampled this many times a second and played back linearly between samples.
const SAMPLE_RATE = 30;
// Each box face as two outward, counterclockwise triangles of its corners.
const BOX_TRIANGLES = [0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6];
const IDENTITY: Quat = [0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];

export const DEGREE = Math.PI / 180;

// Rotation by `angle` radians about a unit axis.
export function axisAngle(axis: Vec3, angle: number): Quat {
  const half = angle / 2;
  const sine = Math.sin(half);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)];
}

// `a` after `b`: the rotation that applies `b`, then `a`.
export function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * A joint rotation in degrees: `pitch` about X first (a hanging limb swings back for positive angles, an upright one
 * leans forward), then `yaw` about Y (the model's left side turns back), then `roll` about Z (a limb on the model's left
 * swings out, and one on its right swings in).
 */
export function rotation(pitch: number, yaw = 0, roll = 0): Quat {
  return multiply(axisAngle([0, 0, 1], roll * DEGREE), multiply(axisAngle([0, 1, 0], yaw * DEGREE), axisAngle([1, 0, 0], pitch * DEGREE)));
}

// An axis-aligned box from its low corner to its high one.
export function box(joint: string, color: number, low: Vec3, high: Vec3): Part {
  return {
    joint, color,
    corners: Array.from({ length: 8 }, (_, corner): Vec3 => [
      corner & 1 ? high[0] : low[0], corner & 2 ? high[1] : low[1], corner & 4 ? high[2] : low[2],
    ]),
  };
}

// A box whose top face is scaled by `top`, across X and Z, about its middle, as a head, torso or limb narrows.
export function taper(joint: string, color: number, low: Vec3, high: Vec3, top: readonly [number, number]): Part {
  const middle = [(low[0] + high[0]) / 2, (low[2] + high[2]) / 2] as const;
  return {
    joint, color,
    corners: Array.from({ length: 8 }, (_, corner): Vec3 => {
      const x = corner & 1 ? high[0] : low[0];
      const z = corner & 4 ? high[2] : low[2];
      if (!(corner & 2)) return [x, low[1], z];
      return [middle[0] + (x - middle[0]) * top[0], high[1], middle[1] + (z - middle[1]) * top[1]];
    }),
  };
}

/**
 * A slab from `start`, `length` long along `direction` (in the XY plane), `thickness` thick across it, spanning `chord`
 * along Z, which narrows by `tip` about its middle toward the far end: a wing's feathers, or a bow's limb.
 */
export function strut(joint: string, color: number, start: Vec3, direction: readonly [number, number], length: number,
  chord: readonly [number, number], thickness: number, tip = 1): Part {
  const norm = Math.hypot(direction[0], direction[1]);
  const along = [direction[0] / norm, direction[1] / norm] as const;
  // Along, across and Z make a right-handed frame, so the box's faces keep their outward winding.
  const across = [-along[1], along[0]] as const;
  const middle = (chord[0] + chord[1]) / 2;
  return {
    joint, color,
    corners: Array.from({ length: 8 }, (_, corner): Vec3 => {
      const end = corner & 1 ? length : 0;
      const side = (corner & 2 ? 0.5 : -0.5) * thickness;
      const z = corner & 4 ? chord[1] : chord[0];
      return [
        start[0] + along[0] * end + across[0] * side,
        start[1] + along[1] * end + across[1] * side,
        start[2] + (corner & 1 ? middle + (z - middle) * tip : z),
      ];
    }),
  };
}

// The same part mirrored across the model's middle (X = 0), for the other side, with its corners reordered so its faces
// stay outward.
export function mirror(part: Part, joint: string): Part {
  return {
    joint, color: part.color,
    corners: Array.from({ length: 8 }, (_, corner): Vec3 => {
      const [x, y, z] = part.corners[corner ^ 1]!;
      return [-x, y, z];
    }),
  };
}

// Eases from 0 to 1 with zero slope at both ends.
export function smooth(value: number): number {
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * (3 - 2 * t);
}

/** A value that eases between keys `[time, value]`, holding the first before them and the last after them. */
export function keys(points: readonly (readonly [number, number])[]): (time: number) => number {
  return (time) => {
    if (time <= points[0]![0]) return points[0]![1];
    for (let at = 1; at < points.length; at++) {
      const [t1, v1] = points[at]!;
      if (time > t1) continue;
      const [t0, v0] = points[at - 1]!;
      return v0 + (v1 - v0) * smooth((time - t0) / (t1 - t0));
    }
    return points[points.length - 1]![1];
  };
}

function aligned(length: number): number {
  return (length + 3) & ~3;
}

/** Builds the rig's GLB: one skinned mesh, its skeleton and every clip. */
export function skinnedGlb(rig: Rig): Uint8Array<ArrayBuffer> {
  const jointIndex = new Map(rig.joints.map((joint, at) => [joint.name, at]));
  const jointOf = (name: string): number => {
    const at = jointIndex.get(name);
    if (at === undefined) throw new Error(`${rig.name}: no joint "${name}".`);
    return at;
  };
  if (rig.joints[0]?.parent !== null || rig.joints.slice(1).some((joint) => joint.parent === null)) {
    throw new Error(`${rig.name}: the first joint, and only it, is the top joint.`);
  }
  rig.joints.forEach((joint, at) => {
    if (joint.parent !== null && jointOf(joint.parent) >= at) throw new Error(`${rig.name}: "${joint.name}" comes before its parent.`);
  });

  // The mesh: eight vertices and twelve triangles per part.
  const positions: number[] = [];
  const colors: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  for (const part of rig.parts) {
    if (part.corners.length !== 8) throw new Error(`${rig.name}: a part needs eight corners.`);
    const base = positions.length / 3;
    const joint = jointOf(part.joint);
    for (const corner of part.corners) {
      positions.push(...corner);
      colors.push((part.color >> 16) & 255, (part.color >> 8) & 255, part.color & 255, 255);
      joints.push(joint, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    for (const index of BOX_TRIANGLES) indices.push(base + index);
  }
  const count = positions.length / 3;
  if (count > 65535) throw new Error(`${rig.name}: too many vertices.`);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < positions.length; at++) {
    min[at % 3] = Math.min(min[at % 3]!, Math.fround(positions[at]!));
    max[at % 3] = Math.max(max[at % 3]!, Math.fround(positions[at]!));
  }

  // Each joint's inverse bind matrix undoes its bind position: the bind pose turns no joint.
  const inverseBind = rig.joints.flatMap((joint) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -joint.at[0], -joint.at[1], -joint.at[2], 1]);

  // The binary: one buffer view per array, each four-byte aligned.
  const chunks: { readonly bytes: Uint8Array; readonly target?: number }[] = [];
  const view = (array: Float32Array | Uint8Array | Uint16Array, target?: number): number => {
    chunks.push({ bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength), target });
    return chunks.length - 1;
  };
  const accessors: Record<string, unknown>[] = [];
  const accessor = (fields: Record<string, unknown>): number => {
    accessors.push(fields);
    return accessors.length - 1;
  };
  const position = accessor({ bufferView: view(new Float32Array(positions), 34962), componentType: 5126, count, type: 'VEC3', min, max });
  const color = accessor({ bufferView: view(Uint8Array.from(colors), 34962), componentType: 5121, normalized: true, count, type: 'VEC4' });
  const skinJoints = accessor({ bufferView: view(Uint8Array.from(joints), 34962), componentType: 5121, count, type: 'VEC4' });
  const skinWeights = accessor({ bufferView: view(new Float32Array(weights), 34962), componentType: 5126, count, type: 'VEC4' });
  const index = accessor({ bufferView: view(Uint16Array.from(indices), 34963), componentType: 5123, count: indices.length, type: 'SCALAR' });
  const bind = accessor({ bufferView: view(new Float32Array(inverseBind)), componentType: 5126, count: rig.joints.length, type: 'MAT4' });

  // Nodes: the mesh, the armature, then the joints in order, each placed from its parent.
  const JOINT_NODE = 2;
  const rests = rig.joints.map((joint): Vec3 => {
    const parent = joint.parent === null ? ZERO : rig.joints[jointOf(joint.parent)]!.at;
    return [joint.at[0] - parent[0], joint.at[1] - parent[1], joint.at[2] - parent[2]];
  });
  const nodes: Record<string, unknown>[] = [
    { name: rig.name, mesh: 0, skin: 0 },
    { name: 'Armature', children: [JOINT_NODE] },
    ...rig.joints.map((joint, at) => {
      const children = rig.joints.flatMap((child, childAt) => child.parent === joint.name ? [JOINT_NODE + childAt] : []);
      return { name: joint.name, translation: rests[at], ...(children.length === 0 ? {} : { children }) };
    }),
  ];

  // Clips: one time accessor each, a rotation channel per joint it turns and a translation channel per joint it moves.
  const animations = rig.clips.map((clip) => {
    const samples = Math.max(2, Math.round(clip.duration * SAMPLE_RATE) + 1);
    const times = Array.from({ length: samples }, (_, at) => clip.duration * at / (samples - 1));
    const poses = times.map((time) => clip.pose(time));
    const input = accessor({
      bufferView: view(new Float32Array(times)), componentType: 5126, count: samples, type: 'SCALAR',
      min: [0], max: [Math.fround(clip.duration)],
    });
    const channels: Record<string, unknown>[] = [];
    const samplers: Record<string, unknown>[] = [];
    rig.joints.forEach((joint, at) => {
      if (poses.some((pose) => pose[joint.name]?.rotation !== undefined)) {
        const values: number[] = [];
        let previous: Quat = IDENTITY;
        for (const pose of poses) {
          let q = pose[joint.name]?.rotation ?? IDENTITY;
          // Neighbouring keys stay in one hemisphere, so each step turns the short way.
          if (q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
          values.push(...q);
          previous = q;
        }
        const output = accessor({ bufferView: view(new Float32Array(values)), componentType: 5126, count: samples, type: 'VEC4' });
        samplers.push({ input, output, interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: JOINT_NODE + at, path: 'rotation' } });
      }
      if (poses.some((pose) => pose[joint.name]?.offset !== undefined)) {
        const rest = rests[at]!;
        const values = poses.flatMap((pose) => {
          const offset = pose[joint.name]?.offset ?? ZERO;
          return [rest[0] + offset[0], rest[1] + offset[1], rest[2] + offset[2]];
        });
        const output = accessor({ bufferView: view(new Float32Array(values)), componentType: 5126, count: samples, type: 'VEC3' });
        samplers.push({ input, output, interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: JOINT_NODE + at, path: 'translation' } });
      }
    });
    if (channels.length === 0) throw new Error(`${rig.name}: clip "${clip.name}" moves nothing.`);
    return { name: clip.name, channels, samplers };
  });

  let length = 0;
  const bufferViews = chunks.map((chunk) => {
    const entry = { buffer: 0, byteOffset: length, byteLength: chunk.bytes.byteLength, ...(chunk.target === undefined ? {} : { target: chunk.target }) };
    length = aligned(length + chunk.bytes.byteLength);
    return entry;
  });
  const binary = new Uint8Array(length);
  chunks.forEach((chunk, at) => binary.set(chunk.bytes, bufferViews[at]!.byteOffset));
  const json = {
    asset: { version: '2.0', generator: 'Over the Edge example scenes' },
    scene: 0,
    scenes: [{ name: rig.name, nodes: [0, 1] }],
    nodes,
    meshes: [{
      name: rig.name,
      primitives: [{ attributes: { POSITION: position, COLOR_0: color, JOINTS_0: skinJoints, WEIGHTS_0: skinWeights }, indices: index, material: 0, mode: 4 }],
    }],
    materials: [{ name: rig.name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: rig.metallic, roughnessFactor: rig.roughness } }],
    skins: [{ name: rig.name, joints: rig.joints.map((_, at) => JOINT_NODE + at), inverseBindMatrices: bind, skeleton: JOINT_NODE }],
    animations,
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews,
    accessors,
  };
  return encodeGlb(json, binary);
}
