import { accessor, accessorValues, index, list, readContainer, record } from './glb-reader';
import { ENEMY_CLIP_ROLES, ENEMY_MOTION, motionSamples } from './enemy-motion-data';
import { MODEL_LIMITS, ModelError } from './model-data';
import type { EnemyClipMotion, EnemyClipRole } from './enemy-motion-data';
import type { Accessor, Gltf, Record_ } from './glb-reader';

export interface EnemyModelFacts {
  // The model's clips, by name, with their lengths in seconds.
  readonly clips: readonly { readonly name: string; readonly duration: number }[];
  // The bind-pose height, in the model's own units, that travel is measured in.
  readonly height: number;
}

interface SceneData {
  readonly json: Gltf;
  readonly buffers: readonly Uint8Array[];
  readonly nodes: readonly Record_[];
  readonly meshes: readonly Record_[];
  readonly skins: readonly Record_[];
  readonly animations: readonly Record_[];
  readonly parents: readonly (number | null)[];
  readonly world: ReadonlyMap<number, Matrix>;
  readonly top: number;
  readonly height: number;
  readonly clips: ReadonlyMap<string, ClipInfo>;
  readonly accessorData: (at: number) => AccessorData;
}

interface ClipInfo {
  readonly name: string;
  readonly duration: number;
  readonly animation: Record_;
}

interface AccessorData {
  readonly accessor: Accessor;
  readonly values: Float64Array;
}

interface TranslationChannel {
  readonly input: AccessorData;
  readonly output: AccessorData;
  readonly interpolation: string;
}

type Matrix = Float64Array;
type Vec3 = [number, number, number];

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const ROUND_DURATION = 10_000;
// A normalized integer accessor's min and max are its stored integers; times these, by component type, they are the
// fractions its values read as.
const NORMALIZED_SCALE: Readonly<Record<number, number>> = { 5120: 1 / 127, 5121: 1 / 255, 5122: 1 / 32767, 5123: 1 / 65535 };

export function readEnemyModel(data: ArrayBuffer): EnemyModelFacts {
  return readModel(() => {
    const scene = readSceneData(data);
    return Object.freeze({
      clips: Object.freeze([...scene.clips.values()].map((clip) => Object.freeze({ name: clip.name, duration: clip.duration }))),
      height: scene.height,
    });
  });
}

// The name of the model's top joint (the node name, or '' when unnamed), the one whose travel along the facing is root motion.
export function enemyTopJoint(data: ArrayBuffer): { readonly node: number; readonly name: string } {
  return readModel(() => {
    const scene = readSceneData(data);
    const name = scene.nodes[scene.top]?.name;
    return Object.freeze({ node: scene.top, name: typeof name === 'string' ? name : '' });
  });
}

export function bakeEnemyMotion(
  data: ArrayBuffer,
  clips: Readonly<Partial<Record<EnemyClipRole, string>>>,
): Readonly<Partial<Record<EnemyClipRole, EnemyClipMotion>>> {
  return readModel(() => {
    const scene = readSceneData(data);
    const result: Partial<Record<EnemyClipRole, EnemyClipMotion>> = {};
    for (const role of ENEMY_CLIP_ROLES) {
      const clipName = clips[role];
      if (clipName === undefined) continue;
      if (typeof clipName !== 'string' || clipName.length === 0) throw new ModelError(`Choose a named animation clip for ${role}.`);
      const clip = scene.clips.get(clipName);
      if (clip === undefined) throw new ModelError(`The enemy model has no animation clip named "${clipName}". Choose an existing clip.`);
      result[role] = bakeClip(scene, clip);
    }
    return Object.freeze(result);
  });
}

// Every clip's root motion, by clip name, read in one pass: a model entry's motion is these, for the clips its roles choose.
export function bakeEnemyClips(data: ArrayBuffer): Readonly<Record<string, EnemyClipMotion>> {
  return readModel(() => {
    const scene = readSceneData(data);
    return Object.freeze(Object.fromEntries([...scene.clips.values()].map((clip) => [clip.name, bakeClip(scene, clip)])));
  });
}

function readModel<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (error instanceof Error) throw new ModelError(error.message);
    throw new ModelError('The enemy model GLB is invalid. Export a valid binary glTF 2.0 file.');
  }
}

function validateContainer(data: ArrayBuffer): void {
  if (data.byteLength < 20 || data.byteLength > MODEL_LIMITS.bytes) throw new ModelError('Choose an enemy model GLB no larger than 20 MiB.');
  const view = new DataView(data);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) {
    throw new ModelError('Export the enemy model as a valid binary glTF 2.0 (.glb) file.');
  }
  let sawJson = false;
  let sawBinary = false;
  let parsedJson: unknown;
  for (let offset = 12; offset < data.byteLength;) {
    if (offset + 8 > data.byteLength) throw new ModelError('Export the enemy model with complete GLB chunk headers.');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length % 4 !== 0 || start + length > data.byteLength) throw new ModelError('Export the enemy model with valid GLB chunk lengths.');
    if (offset === 12 && type !== JSON_CHUNK) throw new ModelError('Export the enemy model with the JSON chunk first.');
    if (type === JSON_CHUNK) {
      if (sawJson) throw new ModelError('Export the enemy model with one JSON chunk.');
      sawJson = true;
      try {
        parsedJson = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, length)));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ModelError('Export the enemy model with valid JSON in its GLB description.');
      }
    } else if (type === BIN_CHUNK) {
      if (sawBinary) throw new ModelError('Export the enemy model with one binary chunk.');
      sawBinary = true;
    }
    offset = start + length;
  }
  if (!sawJson) throw new ModelError('Export the enemy model with a GLB JSON description.');
  const json = record(parsedJson, 'description');
  const asset = record(json.asset, 'asset');
  if (asset.version !== '2.0') throw new ModelError('Export the enemy model as glTF 2.0.');
  const nodes = list(json.nodes, 'node');
  if (nodes.length > MODEL_LIMITS.nodes) throw new ModelError(`Use an enemy model with at most ${MODEL_LIMITS.nodes} nodes.`);
}

function readSceneData(data: ArrayBuffer): SceneData {
  validateContainer(data);
  const { json, buffers } = readContainer(data);
  const nodes = list(json.nodes, 'node').map((node) => record(node, 'node'));
  const meshes = list(json.meshes, 'mesh').map((mesh) => record(mesh, 'mesh'));
  const skins = list(json.skins, 'skin').map((skin) => record(skin, 'skin'));
  const animations = list(json.animations, 'animation').map((animation) => record(animation, 'animation'));
  if (nodes.length > MODEL_LIMITS.nodes) throw new ModelError(`Use an enemy model with at most ${MODEL_LIMITS.nodes} nodes.`);
  const accessorCache = new Map<number, AccessorData>();
  const accessorData = (at: number): AccessorData => {
    let values = accessorCache.get(at);
    if (values === undefined) {
      values = accessorValues(json, buffers, at);
      accessorCache.set(at, values);
    }
    return values;
  };
  const parents = nodeParents(nodes);
  const world = sceneWorld(json, nodes, parents);
  const skinned = skinnedMeshNodes(nodes, meshes, skins, world);
  const top = sharedTopJoint(skins, nodes, parents, world);
  const clips = readClips(json, animations, top, parents, accessorData);
  const height = skinnedHeight(json, buffers, nodes, meshes, skinned, world);
  return { json, buffers, nodes, meshes, skins, animations, parents, world, top, height, clips, accessorData };
}

function nodeParents(nodes: readonly Record_[]): readonly (number | null)[] {
  const parents: (number | null)[] = nodes.map(() => null);
  nodes.forEach((node, parent) => {
    for (const child of list(node.children, 'node children')) {
      const childIndex = index(child, nodes.length, 'child node');
      if (childIndex === parent || parents[childIndex] !== null) throw new ModelError('Export the enemy model with a tree of nodes; a node cannot repeat or parent itself.');
      parents[childIndex] = parent;
    }
  });
  return Object.freeze(parents);
}

function sceneWorld(json: Gltf, nodes: readonly Record_[], parents: readonly (number | null)[]): ReadonlyMap<number, Matrix> {
  const scenes = list(json.scenes, 'scene');
  if (scenes.length === 0) throw new ModelError('Export the enemy model with a scene.');
  const scene = record(scenes[json.scene === undefined ? 0 : index(json.scene, scenes.length, 'scene')], 'scene');
  const world = new Map<number, Matrix>();
  const visit = (nodeIndex: number, parentWorld: Matrix, depth: number): void => {
    if (world.has(nodeIndex) || depth > nodes.length) throw new ModelError('Export the enemy model with an acyclic scene node tree.');
    const matrix = multiply(parentWorld, localMatrix(nodes[nodeIndex]!));
    world.set(nodeIndex, matrix);
    for (const child of list(nodes[nodeIndex]!.children, 'node children')) visit(index(child, nodes.length, 'child node'), matrix, depth + 1);
  };
  for (const root of list(scene.nodes, 'scene node')) {
    const rootIndex = index(root, nodes.length, 'scene node');
    if (parents[rootIndex] !== null) throw new ModelError('Export the enemy model with scene roots that have no parent.');
    visit(rootIndex, identity(), 0);
  }
  return world;
}

function skinnedMeshNodes(
  nodes: readonly Record_[],
  meshes: readonly Record_[],
  skins: readonly Record_[],
  world: ReadonlyMap<number, Matrix>,
): readonly { readonly node: number; readonly mesh: number; readonly skin: number }[] {
  const skinned: { readonly node: number; readonly mesh: number; readonly skin: number }[] = [];
  for (const node of world.keys()) {
    const data = nodes[node]!;
    if (data.mesh === undefined || data.skin === undefined) continue;
    skinned.push({ node, mesh: index(data.mesh, meshes.length, 'mesh'), skin: index(data.skin, skins.length, 'skin') });
  }
  if (skinned.length === 0) throw new ModelError('Export the enemy model with at least one skinned mesh: a node needs both mesh and skin.');
  return Object.freeze(skinned);
}

function sharedTopJoint(
  skins: readonly Record_[],
  nodes: readonly Record_[],
  parents: readonly (number | null)[],
  world: ReadonlyMap<number, Matrix>,
): number {
  let shared: number | null = null;
  for (const skin of skins) {
    const joints = list(skin.joints, 'skin joint').map((joint) => index(joint, nodes.length, 'joint node'));
    if (joints.length === 0) throw new ModelError('Export every enemy model skin with at least one joint.');
    const jointSet = new Set(joints);
    const roots = joints.filter((joint) => {
      for (let parent = parents[joint]; parent !== null; parent = parents[parent]) if (jointSet.has(parent)) return false;
      return true;
    });
    if (roots.length !== 1) throw new ModelError('Export each enemy model skin with one top joint, not several skeleton roots.');
    const root = roots[0]!;
    if (!world.has(root)) throw new ModelError('Put every enemy model skin joint in the model scene.');
    if (shared === null) shared = root;
    else if (shared !== root) throw new ModelError('Use one skeleton for the enemy model: every skin must share the same top joint.');
  }
  if (shared === null) throw new ModelError('Export the enemy model with a skin for its animated mesh.');
  return shared;
}

function readClips(
  json: Gltf,
  animations: readonly Record_[],
  top: number,
  parents: readonly (number | null)[],
  accessorData: (at: number) => AccessorData,
): ReadonlyMap<string, ClipInfo> {
  if (animations.length === 0) throw new ModelError('Export the enemy model with at least one named animation clip.');
  if (animations.length > ENEMY_MOTION.maxClips) throw new ModelError(`Use at most ${ENEMY_MOTION.maxClips} enemy animation clips.`);
  const byName = new Map<string, ClipInfo>();
  const topAncestors = new Set<number>();
  for (let parent = parents[top]; parent !== null; parent = parents[parent]) topAncestors.add(parent);
  for (const animation of animations) {
    const name = animation.name;
    if (typeof name !== 'string' || name.length === 0) throw new ModelError('Name every enemy animation clip before exporting.');
    if (byName.has(name)) throw new ModelError(`Rename duplicate enemy animation clip "${name}".`);
    const channels = list(animation.channels, 'animation channel');
    const samplers = list(animation.samplers, 'animation sampler');
    let duration = 0;
    if (channels.length === 0) throw new ModelError(`Give enemy animation clip "${name}" at least one channel.`);
    for (const entry of channels) {
      const channel = record(entry, 'animation channel');
      const target = record(channel.target, 'animation channel target');
      const node = index(target.node, list(json.nodes, 'node').length, 'animation target node');
      if (topAncestors.has(node)) throw new ModelError('Move root motion onto the top joint: do not animate any ancestor of that joint.');
      const sampler = record(samplers[index(channel.sampler, samplers.length, 'animation sampler')], 'animation sampler');
      const input = accessorData(index(sampler.input, list(json.accessors, 'accessor').length, 'animation input accessor'));
      checkTimes(input, name);
      duration = Math.max(duration, input.values[input.values.length - 1] ?? 0);
    }
    if (!(duration > 0) || duration > ENEMY_MOTION.maxDuration || Math.round(duration * ROUND_DURATION) <= 0) {
      throw new ModelError(`Keep enemy animation clip "${name}" at least 0.0001 and at most ${ENEMY_MOTION.maxDuration} seconds.`);
    }
    byName.set(name, Object.freeze({ name, duration, animation }));
  }
  return byName;
}

function checkTimes(input: AccessorData, clipName: string): void {
  if (input.accessor.components !== 1 || input.accessor.count === 0) throw new ModelError(`Give enemy animation clip "${clipName}" valid scalar keyframe times.`);
  let previous = -Infinity;
  for (const time of input.values) {
    if (!Number.isFinite(time) || time < 0 || time < previous) throw new ModelError(`Give enemy animation clip "${clipName}" finite, sorted, non-negative keyframe times.`);
    previous = time;
  }
}

function skinnedHeight(
  json: Gltf,
  buffers: readonly Uint8Array[],
  nodes: readonly Record_[],
  meshes: readonly Record_[],
  skinned: readonly { readonly node: number; readonly mesh: number }[],
  world: ReadonlyMap<number, Matrix>,
): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const item of skinned) {
    if (nodes[item.node] === undefined) continue;
    const matrix = world.get(item.node)!;
    const mesh = meshes[item.mesh]!;
    for (const entry of list(mesh.primitives, 'primitive')) {
      const primitive = record(entry, 'primitive');
      const attributes = record(primitive.attributes, 'primitive attributes');
      const positionIndex = index(attributes.POSITION, list(json.accessors, 'accessor').length, 'position accessor');
      const position = accessor(json, buffers, positionIndex);
      if (position.components !== 3) throw new ModelError('Export skinned mesh positions as VEC3 accessors.');
      const source = record(list(json.accessors, 'accessor')[positionIndex], 'position accessor');
      // Read as three.js reads normalized integers: scaled, a signed one no lower than -1.
      const read = position.normalized
        ? (value: number): number => Math.max(value * (NORMALIZED_SCALE[position.componentType] ?? 1), -1)
        : (value: number): number => value;
      const min = vector(source.min, 3, 'POSITION min').map(read);
      const max = vector(source.max, 3, 'POSITION max').map(read);
      for (let corner = 0; corner < 8; corner++) {
        const point = transformPoint(matrix, corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]);
        minY = Math.min(minY, point[1]);
        maxY = Math.max(maxY, point[1]);
      }
    }
  }
  const height = maxY - minY;
  if (!Number.isFinite(height) || height <= 0) throw new ModelError('Export skinned enemy meshes with POSITION min/max bounds and nonzero height.');
  return height;
}

function bakeClip(scene: SceneData, clip: ClipInfo): EnemyClipMotion {
  const duration = Math.round(clip.duration * ROUND_DURATION) / ROUND_DURATION;
  const count = motionSamples(duration);
  const travel = new Array<number>(count);
  const channel = topTranslationChannel(scene, clip);
  const parent = scene.parents[scene.top];
  const parentWorld = parent === null ? identity() : scene.world.get(parent)!;
  const base = restTranslation(scene.nodes[scene.top]!);
  const start = jointPosition(parentWorld, channel, base, 0);
  for (let sample = 0; sample < count; sample++) {
    const time = Math.min(sample / ENEMY_MOTION.sampleRate, duration);
    const position = jointPosition(parentWorld, channel, base, time);
    const value = Math.round((position[2] - start[2]) / scene.height * ENEMY_MOTION.unit);
    if (Math.abs(value) > ENEMY_MOTION.maxTravel) throw new ModelError(`Reduce root motion in clip "${clip.name}"; baked travel exceeds ${ENEMY_MOTION.maxTravel}.`);
    travel[sample] = sample === 0 ? 0 : value;
  }
  return Object.freeze({ duration, travel: Object.freeze(travel) });
}

function topTranslationChannel(scene: SceneData, clip: ClipInfo): TranslationChannel | null {
  const samplers = list(clip.animation.samplers, 'animation sampler');
  let found: TranslationChannel | null = null;
  for (const entry of list(clip.animation.channels, 'animation channel')) {
    const channel = record(entry, 'animation channel');
    const target = record(channel.target, 'animation channel target');
    const path = target.path;
    if (target.node !== scene.top || path !== 'translation') continue;
    if (found !== null) throw new ModelError(`Give clip "${clip.name}" only one translation channel for the top joint.`);
    const sampler = record(samplers[index(channel.sampler, samplers.length, 'animation sampler')], 'animation sampler');
    const input = scene.accessorData(index(sampler.input, list(scene.json.accessors, 'accessor').length, 'animation input accessor'));
    const output = scene.accessorData(index(sampler.output, list(scene.json.accessors, 'accessor').length, 'animation output accessor'));
    if (output.accessor.componentType !== 5126 || output.accessor.components !== 3) {
      throw new ModelError(`Export clip "${clip.name}" top-joint translation keys as float VEC3 values.`);
    }
    const interpolation = typeof sampler.interpolation === 'string' ? sampler.interpolation : 'LINEAR';
    if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) {
      throw new ModelError(`Use LINEAR, STEP or CUBICSPLINE interpolation for clip "${clip.name}".`);
    }
    const required = interpolation === 'CUBICSPLINE' ? input.accessor.count * 3 : input.accessor.count;
    if (output.accessor.count !== required) throw new ModelError(`Export clip "${clip.name}" with matching translation keyframes.`);
    found = { input, output, interpolation };
  }
  return found;
}

function jointPosition(parentWorld: Matrix, channel: TranslationChannel | null, rest: Vec3, time: number): Vec3 {
  const local = channel === null ? rest : sampleTranslation(channel, time);
  return transformPoint(parentWorld, local[0], local[1], local[2]);
}

function sampleTranslation(channel: TranslationChannel, time: number): Vec3 {
  const input = channel.input.values;
  const count = channel.input.accessor.count;
  if (count === 1 || time <= input[0]!) return outputValue(channel, 0, 1);
  if (time >= input[count - 1]!) return outputValue(channel, count - 1, 1);
  let low = 0;
  let high = count - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (input[mid]! <= time) low = mid;
    else high = mid;
  }
  if (channel.interpolation === 'STEP') return outputValue(channel, low, 1);
  const t0 = input[low]!;
  const t1 = input[low + 1]!;
  const span = t1 - t0;
  const mix = span <= 0 ? 0 : (time - t0) / span;
  const a = outputValue(channel, low, 1);
  const b = outputValue(channel, low + 1, 1);
  if (channel.interpolation === 'LINEAR') return [lerp(a[0], b[0], mix), lerp(a[1], b[1], mix), lerp(a[2], b[2], mix)];
  const out = outputValue(channel, low, 2);
  const incoming = outputValue(channel, low + 1, 0);
  const t2 = mix * mix;
  const t3 = t2 * mix;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + mix;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [
    h00 * a[0] + h10 * span * out[0] + h01 * b[0] + h11 * span * incoming[0],
    h00 * a[1] + h10 * span * out[1] + h01 * b[1] + h11 * span * incoming[1],
    h00 * a[2] + h10 * span * out[2] + h01 * b[2] + h11 * span * incoming[2],
  ];
}

function outputValue(channel: TranslationChannel, key: number, part: number): Vec3 {
  const offset = channel.interpolation === 'CUBICSPLINE' ? (key * 3 + part) * 3 : key * 3;
  const values = channel.output.values;
  return [values[offset]!, values[offset + 1]!, values[offset + 2]!];
}

function identity(): Matrix {
  const matrix = new Float64Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  return matrix;
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function localMatrix(node: Record_): Matrix {
  if (node.matrix !== undefined) return Float64Array.from(vector(node.matrix, 16, 'matrix'));
  const [tx, ty, tz] = node.translation === undefined ? [0, 0, 0] : vector(node.translation, 3, 'translation');
  const [x, y, z, w] = node.rotation === undefined ? [0, 0, 0, 1] : vector(node.rotation, 4, 'rotation');
  const [sx, sy, sz] = node.scale === undefined ? [1, 1, 1] : vector(node.scale, 3, 'scale');
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return Float64Array.from([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

function restTranslation(node: Record_): Vec3 {
  if (node.translation !== undefined) return vector(node.translation, 3, 'translation') as Vec3;
  if (node.matrix !== undefined) {
    const matrix = vector(node.matrix, 16, 'matrix');
    return [matrix[12]!, matrix[13]!, matrix[14]!];
  }
  return [0, 0, 0];
}

function transformPoint(matrix: Matrix, x: number, y: number, z: number): Vec3 {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function vector(value: unknown, length: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    throw new ModelError(`The GLB node has an invalid ${label}; fix the enemy model export.`);
  }
  return value as number[];
}

function lerp(a: number, b: number, mix: number): number {
  return a + (b - a) * mix;
}
