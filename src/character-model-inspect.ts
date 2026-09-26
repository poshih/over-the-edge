// Validates character GLBs from their glTF JSON and binary data, without a DOM or GLTFLoader,
// so release builds and the browser loader apply identical typed checks.
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { ArtError } from './art-types';
import { MODEL_LIMITS, ModelError } from './model-data';
import { forEachModelImage } from './model-images';
import { validateContainer } from './visual-model';
import {
  AVATAR_JOINT_IDS, AVATAR_JOINT_PARENTS, CharacterModelError, missingAvatarJoints, validatePartialBoneMap,
} from './character-profile';
import type { AvatarBoneMap, AvatarJointId, PartialAvatarBoneMap } from './character-profile';

export type CharacterModelUsage = 'avatar' | 'hammer' | 'pot';

export interface CharacterModelJoint {
  readonly node: number;
  readonly name: string;
  // The joint's bind-pose transform in model space: the inverse of its inverse bind matrix.
  readonly bind: readonly number[];
}

export interface CharacterModelReport {
  readonly usage: CharacterModelUsage;
  readonly bytes: number;
  readonly nodes: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly textures: number;
  readonly skinnedVertices: number;
  readonly joints: readonly CharacterModelJoint[];
  // Parent node index for every node; null for scene roots and nodes outside the scene.
  readonly parents: readonly (number | null)[];
  // Model-space bounds of the scene's meshes in their node rest pose.
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
}

export interface UnmappedAvatarJoint {
  readonly name: string;
  readonly node: number;
  // The mapped joint it follows rigidly; null above the body, where it stays in its bind pose.
  readonly follows: AvatarJointId | null;
}

export interface ResolvedAvatarJoints {
  readonly nodes: Readonly<Record<AvatarJointId, number>>;
  readonly unmapped: readonly UnmappedAvatarJoint[];
}

// Hammers follow the physical tool frame: origin at the butt, handle along +X, in metres.
export const HAMMER_MODEL_BOUNDS = { minimumLength: 0.1, maximumExtent: 4 } as const;
// Pots follow the physical pot body: +Y up, origin at the bottom-centre, front facing +Z, in metres.
export const POT_MODEL_BOUNDS = { baseTolerance: 0.05, minimumHeight: 0.1, maximumExtent: 4 } as const;

const metres = (value: number): string => `${Number(value.toFixed(3))} m`;

function checkHammer(bounds: Box3): void {
  if (bounds.isEmpty() || bounds.max.x < HAMMER_MODEL_BOUNDS.minimumLength || bounds.max.x <= -bounds.min.x) {
    throw new CharacterModelError('invalid-model',
      'Model the hammer with its origin at the butt of the handle and the handle along +X.');
  }
  if (Math.max(...bounds.min.toArray().map(Math.abs), ...bounds.max.toArray().map(Math.abs)) > HAMMER_MODEL_BOUNDS.maximumExtent) {
    throw new CharacterModelError('invalid-model',
      `Model the hammer in metres: it must stay within ${HAMMER_MODEL_BOUNDS.maximumExtent} m of its origin.`);
  }
}

// Unit, axis and origin mistakes all move the base off the origin or the origin off the footprint.
function checkPot(bounds: Box3): void {
  if (bounds.isEmpty()) {
    throw new CharacterModelError('invalid-model', 'Model the pot with +Y up and its origin at the bottom-centre.');
  }
  if (Math.max(...bounds.min.toArray().map(Math.abs), ...bounds.max.toArray().map(Math.abs)) > POT_MODEL_BOUNDS.maximumExtent) {
    throw new CharacterModelError('invalid-model',
      `Model the pot in metres: it must stay within ${POT_MODEL_BOUNDS.maximumExtent} m of its origin.`);
  }
  if (Math.abs(bounds.min.y) > POT_MODEL_BOUNDS.baseTolerance) {
    throw new CharacterModelError('invalid-model',
      `Put the pot's origin at its bottom-centre with +Y up: its lowest point is at y = ${metres(bounds.min.y)}, ` +
      `not within ${metres(POT_MODEL_BOUNDS.baseTolerance)} of the origin.`);
  }
  if (bounds.max.y < POT_MODEL_BOUNDS.minimumHeight) {
    throw new CharacterModelError('invalid-model',
      `Model the pot with +Y up: it must rise at least ${metres(POT_MODEL_BOUNDS.minimumHeight)} above its origin.`);
  }
  const size = bounds.getSize(new Vector3());
  const centre = bounds.getCenter(new Vector3());
  if (Math.abs(centre.x) > size.x / 4 || Math.abs(centre.z) > size.z / 4) {
    throw new CharacterModelError('invalid-model',
      'Centre the pot on its origin: the origin must lie in the middle of the pot\'s footprint.');
  }
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const TRIANGLE_MODES = new Set([4, 5, 6]);
const COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
// Exporters store float weights with rounding error; quantized weights lose up to a step per component.
const FLOAT_WEIGHT_TOLERANCE = 2e-3;
const QUANTIZED_WEIGHT_TOLERANCE = 1e-2;
const MINIMUM_RIG_SPAN = 1e-6;
const MINIMUM_BONE_FRACTION = 1e-3;

type Json = Record<string, unknown>;

function object(value: unknown, label: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CharacterModelError('invalid-model', `The GLB ${label} is invalid.`);
  }
  return value as Json;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CharacterModelError('invalid-model', `The GLB ${label} list is invalid.`);
  return value;
}

function index(value: unknown, length: number, label: string, code: 'invalid-model' | 'invalid-skin' = 'invalid-model'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) {
    throw new CharacterModelError(code, `The GLB has an invalid ${label} reference.`);
  }
  return value;
}

interface Accessor {
  readonly count: number;
  readonly components: number;
  readonly componentType: number;
  read(element: number, component: number): number;
}

class GlbReader {
  readonly json: Json;
  private readonly binary: Uint8Array | null;
  private readonly buffers = new Map<number, Uint8Array>();

  constructor(data: ArrayBuffer) {
    const header = new DataView(data);
    let json: Json | null = null;
    let binary: Uint8Array | null = null;
    for (let offset = 12; offset < data.byteLength;) {
      const length = header.getUint32(offset, true);
      const type = header.getUint32(offset + 4, true);
      if (type === JSON_CHUNK) json = object(JSON.parse(new TextDecoder().decode(new Uint8Array(data, offset + 8, length))), 'description');
      else if (type === BIN_CHUNK) binary = new Uint8Array(data, offset + 8, length);
      offset += length + 8;
    }
    if (json === null) throw new CharacterModelError('invalid-model', 'The GLB model description is missing.');
    this.json = json;
    this.binary = binary;
  }

  private buffer(bufferIndex: number): Uint8Array {
    let buffer = this.buffers.get(bufferIndex);
    if (buffer !== undefined) return buffer;
    const buffers = list(this.json.buffers, 'buffer');
    const description = object(buffers[index(bufferIndex, buffers.length, 'buffer')], 'buffer');
    if (description.uri === undefined) {
      if (bufferIndex !== 0 || this.binary === null) throw new CharacterModelError('invalid-model', 'A GLB buffer has no data.');
      buffer = this.binary;
    } else {
      const uri = description.uri;
      if (typeof uri !== 'string' || !uri.includes(';base64,')) {
        throw new CharacterModelError('invalid-model', 'Embed every character model buffer.');
      }
      try {
        buffer = Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), character => character.charCodeAt(0));
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        throw new CharacterModelError('invalid-model', 'An embedded character model buffer is not valid base64.');
      }
    }
    this.buffers.set(bufferIndex, buffer);
    return buffer;
  }

  accessor(accessorIndex: number, code: 'invalid-model' | 'invalid-skin'): Accessor {
    const accessors = list(this.json.accessors, 'accessor');
    const accessor = object(accessors[index(accessorIndex, accessors.length, 'accessor', code)], 'accessor');
    const componentType = accessor.componentType;
    const componentBytes = typeof componentType === 'number' ? COMPONENT_BYTES[componentType] : undefined;
    const components = typeof accessor.type === 'string' ? TYPE_COMPONENTS[accessor.type] : undefined;
    const count = accessor.count;
    if (componentBytes === undefined || components === undefined || typeof count !== 'number' ||
      !Number.isInteger(count) || count < 1) {
      throw new CharacterModelError(code, 'The GLB has an invalid accessor.');
    }
    if (accessor.sparse !== undefined) {
      throw new CharacterModelError(code, 'Character skins and bind matrices cannot use sparse accessors.');
    }
    const normalized = accessor.normalized === true;
    if (accessor.bufferView === undefined) {
      return { count, components, componentType: componentType as number, read: () => 0 };
    }
    const views = list(this.json.bufferViews, 'buffer view');
    const view = object(views[index(accessor.bufferView, views.length, 'buffer view', code)], 'buffer view');
    const buffer = this.buffer(index(view.buffer, list(this.json.buffers, 'buffer').length, 'buffer', code));
    const viewOffset = view.byteOffset ?? 0;
    const viewLength = view.byteLength;
    const elementBytes = componentBytes * components;
    const stride = view.byteStride ?? elementBytes;
    const offset = accessor.byteOffset ?? 0;
    const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    if (!whole(viewOffset) || !whole(viewLength) || !whole(stride) || !whole(offset) || stride < elementBytes ||
      offset + stride * (count - 1) + elementBytes > viewLength || viewOffset + viewLength > buffer.byteLength) {
      throw new CharacterModelError(code, 'A GLB accessor exceeds its buffer.');
    }
    const data = new DataView(buffer.buffer, buffer.byteOffset + viewOffset, viewLength);
    const scale = !normalized ? 1 : componentType === 5121 ? 255 : componentType === 5123 ? 65535 : 1;
    const read = (element: number, component: number): number => {
      const at = offset + element * stride + component * componentBytes;
      switch (componentType) {
        case 5120: return data.getInt8(at);
        case 5121: return data.getUint8(at) / scale;
        case 5122: return data.getInt16(at, true);
        case 5123: return data.getUint16(at, true) / scale;
        case 5125: return data.getUint32(at, true);
        default: return data.getFloat32(at, true);
      }
    };
    return { count, components, componentType: componentType as number, read };
  }
}

function nodeMatrix(node: Json): Matrix4 {
  const matrix = new Matrix4();
  if (Array.isArray(node.matrix)) {
    if (node.matrix.length !== 16 || !node.matrix.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new CharacterModelError('invalid-model', 'A GLB node has an invalid matrix.');
    }
    return matrix.fromArray(node.matrix as number[]);
  }
  const vector = (value: unknown, length: number, fallback: readonly number[]): number[] => {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value) || value.length !== length || !value.every(entry => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new CharacterModelError('invalid-model', 'A GLB node has an invalid transform.');
    }
    return value as number[];
  };
  const [x, y, z] = vector(node.translation, 3, [0, 0, 0]);
  const [qx, qy, qz, qw] = vector(node.rotation, 4, [0, 0, 0, 1]);
  const [sx, sy, sz] = vector(node.scale, 3, [1, 1, 1]);
  return matrix.compose(new Vector3(x, y, z), new Quaternion(qx, qy, qz, qw).normalize(), new Vector3(sx, sy, sz));
}

function limit(message: string): CharacterModelError {
  return new CharacterModelError('model-limits', message);
}

// Throws CharacterModelError for any container, limit, skin, influence or weight problem,
// including malformed JSON structures that would otherwise fail inside a lower-level reader.
export function inspectCharacterModel(data: ArrayBuffer, usage: CharacterModelUsage): CharacterModelReport {
  try {
    return inspect(data, usage);
  } catch (error) {
    if (error instanceof CharacterModelError) throw error;
    if (error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError ||
      error instanceof ArtError || error instanceof ModelError || error instanceof DOMException) {
      throw new CharacterModelError('invalid-model', `The character GLB is malformed: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function inspect(data: ArrayBuffer, usage: CharacterModelUsage): CharacterModelReport {
  if (data.byteLength > MODEL_LIMITS.bytes) throw limit(`Character models must be at most ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  let reader: GlbReader;
  try {
    validateContainer(data);
    reader = new GlbReader(data);
  } catch (error) {
    if (error instanceof CharacterModelError) throw error;
    if (error instanceof ModelError || error instanceof SyntaxError) {
      const code = /at most \d+ nodes/.test(error.message) ? 'model-limits' : 'invalid-model';
      throw new CharacterModelError(code, error.message, { cause: error });
    }
    throw error;
  }
  const json = reader.json;
  const nodes = list(json.nodes, 'node').map(node => object(node, 'node'));
  const meshes = list(json.meshes, 'mesh').map(mesh => object(mesh, 'mesh'));
  if (nodes.length > MODEL_LIMITS.nodes) throw limit(`Use a character model with at most ${MODEL_LIMITS.nodes} nodes.`);

  const parents: (number | null)[] = nodes.map(() => null);
  nodes.forEach((node, parent) => {
    for (const child of list(node.children, 'node children')) {
      const childIndex = index(child, nodes.length, 'child node');
      if (parents[childIndex] !== null || childIndex === parent) {
        throw new CharacterModelError('invalid-model', 'GLB nodes must form a tree: a node has more than one parent.');
      }
      parents[childIndex] = parent;
    }
  });
  const scenes = list(json.scenes, 'scene').map(scene => object(scene, 'scene'));
  const sceneIndex = json.scene === undefined ? 0 : index(json.scene, scenes.length, 'scene');
  if (scenes.length === 0) throw new CharacterModelError('invalid-model', 'The GLB has no scene.');
  const roots = list(scenes[sceneIndex]!.nodes, 'scene node').map(root => index(root, nodes.length, 'scene node'));
  const world = new Map<number, Matrix4>();
  const visit = (node: number, parent: Matrix4, depth: number): void => {
    if (world.has(node) || depth > nodes.length) throw new CharacterModelError('invalid-model', 'GLB nodes must form an acyclic tree.');
    const matrix = new Matrix4().multiplyMatrices(parent, nodeMatrix(nodes[node]!));
    world.set(node, matrix);
    for (const child of list(nodes[node]!.children, 'node children')) visit(child as number, matrix, depth + 1);
  };
  for (const root of roots) {
    if (parents[root] !== null) throw new CharacterModelError('invalid-model', 'A GLB scene root must not have a parent.');
    visit(root, new Matrix4(), 0);
  }

  let meshCount = 0;
  let triangles = 0;
  const bounds = new Box3();
  const corner = new Vector3();
  const skinnedMeshes: { mesh: number; skin: number }[] = [];
  for (const [nodeIndex, matrix] of world) {
    const node = nodes[nodeIndex]!;
    if (node.extensions !== undefined && Object.hasOwn(object(node.extensions, 'node extensions'), 'EXT_mesh_gpu_instancing')) {
      throw new CharacterModelError('invalid-model', 'Character models cannot use GPU-instanced nodes.');
    }
    if (node.mesh === undefined) continue;
    const mesh = meshes[index(node.mesh, meshes.length, 'mesh')]!;
    if (node.skin !== undefined) skinnedMeshes.push({ mesh: node.mesh as number, skin: index(node.skin, list(json.skins, 'skin').length, 'skin', 'invalid-skin') });
    for (const entry of list(mesh.primitives, 'primitive')) {
      const primitive = object(entry, 'primitive');
      const mode = primitive.mode ?? 4;
      if (!TRIANGLE_MODES.has(mode as number)) continue;
      const attributes = object(primitive.attributes, 'primitive attributes');
      const position = reader.accessor(index(attributes.POSITION, list(json.accessors, 'accessor').length, 'position accessor'), 'invalid-model');
      const count = primitive.indices === undefined ? position.count : reader.accessor(primitive.indices as number, 'invalid-model').count;
      meshCount += 1;
      triangles += mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
      const positionAccessor = object(list(json.accessors, 'accessor')[attributes.POSITION as number], 'position accessor');
      const min = positionAccessor.min, max = positionAccessor.max;
      if (Array.isArray(min) && Array.isArray(max) && min.length === 3 && max.length === 3) {
        for (let corners = 0; corners < 8; corners++) {
          corner.set(
            Number((corners & 1 ? max : min)[0]), Number((corners & 2 ? max : min)[1]), Number((corners & 4 ? max : min)[2]),
          ).applyMatrix4(matrix);
          bounds.expandByPoint(corner);
        }
      }
    }
  }
  if (meshCount === 0) throw new CharacterModelError('invalid-model', 'The character model has no triangle meshes.');
  if (meshCount > MODEL_LIMITS.meshes || triangles > MODEL_LIMITS.triangles) {
    throw limit(`Use a character model with 1-${MODEL_LIMITS.meshes} meshes and at most ${MODEL_LIMITS.triangles.toLocaleString('en-US')} triangles.`);
  }
  let textures = 0;
  try {
    forEachModelImage(data, json, 'character model', (width, height) => {
      textures += 1;
      if (width < 1 || height < 1 || width > MODEL_LIMITS.textureEdge || height > MODEL_LIMITS.textureEdge) {
        throw limit(`Character model textures must be at most ${MODEL_LIMITS.textureEdge} pixels on either edge.`);
      }
    });
  } catch (error) {
    if (error instanceof ModelError) throw new CharacterModelError('invalid-model', error.message, { cause: error });
    throw error;
  }

  const skins = list(json.skins, 'skin').map(skin => object(skin, 'skin'));
  if (usage === 'avatar') {
    if (skinnedMeshes.length === 0) {
      throw new CharacterModelError('no-skin', 'This GLB has no skinned mesh. Export the character with its armature and skin weights.');
    }
  } else {
    // Props follow a rigid physical frame, so they must be static.
    if (skins.length > 0 || skinnedMeshes.length > 0) {
      throw new CharacterModelError('unexpected-skin', `A ${usage} model must be a static mesh without skins.`);
    }
    if (usage === 'hammer') checkHammer(bounds);
    else checkPot(bounds);
  }

  const joints = new Map<number, CharacterModelJoint>();
  const inverse = new Matrix4();
  for (const skin of skins) {
    const jointList = list(skin.joints, 'skin joint');
    if (jointList.length === 0) throw new CharacterModelError('invalid-skin', 'A GLB skin has no joints.');
    if (skin.inverseBindMatrices === undefined) {
      throw new CharacterModelError('invalid-skin', 'Every GLB skin needs inverse bind matrices describing its bind pose.');
    }
    const matrices = reader.accessor(skin.inverseBindMatrices as number, 'invalid-skin');
    if (matrices.components !== 16 || matrices.componentType !== 5126 || matrices.count < jointList.length) {
      throw new CharacterModelError('invalid-skin', 'GLB inverse bind matrices must be one float MAT4 per joint.');
    }
    const seen = new Set<number>();
    jointList.forEach((entry, jointIndex) => {
      const node = index(entry, nodes.length, 'joint node', 'invalid-skin');
      if (seen.has(node)) throw new CharacterModelError('invalid-skin', 'A GLB skin lists the same joint twice.');
      seen.add(node);
      if (!world.has(node)) throw new CharacterModelError('invalid-skin', 'Every skin joint must be part of the model scene.');
      if (joints.has(node)) return;
      const elements = Array.from({ length: 16 }, (_, element) => matrices.read(jointIndex, element));
      inverse.fromArray(elements);
      const determinant = inverse.determinant();
      if (!elements.every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
        throw new CharacterModelError('invalid-skin', 'A GLB inverse bind matrix is not invertible.');
      }
      const name = typeof nodes[node]!.name === 'string' ? nodes[node]!.name as string : '';
      joints.set(node, Object.freeze({ node, name, bind: Object.freeze(Array.from(inverse.clone().invert().elements)) }));
    });
  }

  let skinnedVertices = 0;
  const checked = new Set<string>();
  for (const { mesh, skin } of skinnedMeshes) {
    const key = `${mesh}:${skin}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const jointCount = list(skins[skin]!.joints, 'skin joint').length;
    for (const entry of list(meshes[mesh]!.primitives, 'primitive')) {
      const primitive = object(entry, 'primitive');
      if (!TRIANGLE_MODES.has((primitive.mode ?? 4) as number)) continue;
      const attributes = object(primitive.attributes, 'primitive attributes');
      if (Object.keys(attributes).some(name => /^(JOINTS|WEIGHTS)_[1-9]\d*$/.test(name))) {
        throw new CharacterModelError('too-many-influences',
          'Skinned vertices may use at most 4 joint influences. Limit weights to 4 per vertex when exporting.');
      }
      if (attributes.JOINTS_0 === undefined || attributes.WEIGHTS_0 === undefined) {
        throw new CharacterModelError('invalid-skin', 'Every skinned primitive needs JOINTS_0 and WEIGHTS_0 attributes.');
      }
      const jointsAccessor = reader.accessor(attributes.JOINTS_0 as number, 'invalid-skin');
      const weightsAccessor = reader.accessor(attributes.WEIGHTS_0 as number, 'invalid-skin');
      if (jointsAccessor.components !== 4 || weightsAccessor.components !== 4 || jointsAccessor.count !== weightsAccessor.count ||
        (jointsAccessor.componentType !== 5121 && jointsAccessor.componentType !== 5123) ||
        ![5121, 5123, 5126].includes(weightsAccessor.componentType)) {
        throw new CharacterModelError('invalid-skin', 'Skin JOINTS_0/WEIGHTS_0 must be matching VEC4 accessors.');
      }
      const tolerance = weightsAccessor.componentType === 5126 ? FLOAT_WEIGHT_TOLERANCE : QUANTIZED_WEIGHT_TOLERANCE;
      for (let vertex = 0; vertex < weightsAccessor.count; vertex++) {
        let sum = 0;
        for (let component = 0; component < 4; component++) {
          const weight = weightsAccessor.read(vertex, component);
          if (!Number.isFinite(weight) || weight < 0) {
            throw new CharacterModelError('unnormalized-weights', `Skin weights must be finite and non-negative (vertex ${vertex}).`);
          }
          if (weight > 0 && jointsAccessor.read(vertex, component) >= jointCount) {
            throw new CharacterModelError('invalid-skin', `Vertex ${vertex} references a joint outside its skin.`);
          }
          sum += weight;
        }
        if (Math.abs(sum - 1) > tolerance) {
          throw new CharacterModelError('unnormalized-weights',
            `Skin weights must sum to 1 for every vertex; vertex ${vertex} sums to ${Number(sum.toFixed(4))}. Normalize the weights when exporting.`);
        }
      }
      skinnedVertices += weightsAccessor.count;
    }
  }

  return Object.freeze({
    usage, bytes: data.byteLength, nodes: nodes.length, meshes: meshCount, triangles, textures, skinnedVertices,
    joints: Object.freeze([...joints.values()].sort((left, right) => left.node - right.node)),
    parents: Object.freeze(parents.map((parent, node) => world.has(node) ? parent : null)),
    bounds: Object.freeze({
      min: Object.freeze(bounds.isEmpty() ? [0, 0, 0] : bounds.min.toArray()),
      max: Object.freeze(bounds.isEmpty() ? [0, 0, 0] : bounds.max.toArray()),
    }),
  });
}

function jointPosition(joint: CharacterModelJoint): Vector3 {
  return new Vector3(joint.bind[12], joint.bind[13], joint.bind[14]);
}

// Resolves a bone map against a model. Checks completeness, names, the body -> upper -> forearm -> hand
// ancestor chains, screen sides and bone lengths, throwing a typed CharacterModelError.
export function resolveAvatarJoints(report: CharacterModelReport, boneMap: PartialAvatarBoneMap | AvatarBoneMap): ResolvedAvatarJoints {
  const map = validatePartialBoneMap(boneMap);
  const missing = missingAvatarJoints(map);
  if (missing.length > 0) {
    throw new CharacterModelError('missing-joint',
      `The bone map has no GLB joint for ${missing.join(', ')}. Map all eight avatar joints.`, { joints: missing });
  }
  const byName = new Map<string, CharacterModelJoint[]>();
  for (const joint of report.joints) byName.set(joint.name, [...byName.get(joint.name) ?? [], joint]);
  const unknown = AVATAR_JOINT_IDS.map(id => map[id]!).filter(name => !byName.has(name));
  if (unknown.length > 0) {
    throw new CharacterModelError('unknown-joint',
      `The model has no skin joint named ${unknown.map(name => `"${name}"`).join(', ')}.`, { joints: unknown });
  }
  const ambiguous = AVATAR_JOINT_IDS.map(id => map[id]!).filter(name => byName.get(name)!.length > 1);
  if (ambiguous.length > 0) {
    throw new CharacterModelError('ambiguous-joint',
      `Several skin joints are named ${ambiguous.map(name => `"${name}"`).join(', ')}. Give mapped joints unique names.`,
      { joints: ambiguous });
  }
  const joints = {} as Record<AvatarJointId, CharacterModelJoint>;
  const mapped = new Map<number, AvatarJointId>();
  for (const id of AVATAR_JOINT_IDS) {
    joints[id] = byName.get(map[id]!)![0]!;
    mapped.set(joints[id].node, id);
  }
  const nearestMapped = (node: number): AvatarJointId | null => {
    for (let parent = report.parents[node] ?? null; parent !== null; parent = report.parents[parent] ?? null) {
      const id = mapped.get(parent);
      if (id !== undefined) return id;
    }
    return null;
  };
  const broken = AVATAR_JOINT_IDS.filter(id => nearestMapped(joints[id].node) !== AVATAR_JOINT_PARENTS[id]);
  if (broken.length > 0) {
    throw new CharacterModelError('broken-chain',
      `Mapped joints must form ancestor chains body -> upper arm -> forearm -> hand, with the head under the body. ` +
      `Check ${broken.join(', ')}.`, { joints: broken });
  }
  const left = jointPosition(joints['left-upper-arm']);
  const right = jointPosition(joints['right-upper-arm']);
  if (right.x - left.x <= MINIMUM_RIG_SPAN) {
    throw new CharacterModelError(right.x - left.x < -MINIMUM_RIG_SPAN ? 'crossed-arms' : 'degenerate-rig',
      'The left-* joints must be the arm on the viewer\'s left (-X) of a model facing +Z; ' +
      'for most rigs that is the character\'s anatomical right arm.',
      { joints: ['left-upper-arm', 'right-upper-arm'] });
  }
  const span = right.x - left.x;
  const short: AvatarJointId[] = [];
  for (const side of ['left', 'right'] as const) {
    const shoulder = jointPosition(joints[`${side}-upper-arm`]);
    const elbow = jointPosition(joints[`${side}-forearm`]);
    const wrist = jointPosition(joints[`${side}-hand`]);
    if (shoulder.distanceTo(elbow) < span * MINIMUM_BONE_FRACTION) short.push(`${side}-upper-arm`);
    if (elbow.distanceTo(wrist) < span * MINIMUM_BONE_FRACTION) short.push(`${side}-forearm`);
  }
  if (short.length > 0) {
    throw new CharacterModelError('degenerate-rig', `These arm bones have no length in the bind pose: ${short.join(', ')}.`,
      { joints: short });
  }
  const nodes = Object.fromEntries(AVATAR_JOINT_IDS.map(id => [id, joints[id].node])) as Record<AvatarJointId, number>;
  return Object.freeze({
    nodes: Object.freeze(nodes),
    unmapped: Object.freeze(report.joints.filter(joint => !mapped.has(joint.node)).map(joint => Object.freeze({
      name: joint.name, node: joint.node, follows: nearestMapped(joint.node),
    }))),
  });
}

function side(name: string): 'left' | 'right' | null {
  const lower = name.toLowerCase();
  if (lower.includes('left')) return 'left';
  if (lower.includes('right')) return 'right';
  if (/(^|[._\s-])l($|[._\s-])/.test(lower)) return 'left';
  if (/(^|[._\s-])r($|[._\s-])/.test(lower)) return 'right';
  return null;
}

function core(name: string): string {
  return name.replace(/^.*:/, '').toLowerCase().replace(/left|right/g, '')
    .replace(/(^|[._\s-])[lr]($|[._\s-])/g, '$1$2').replace(/[^a-z0-9]/g, '');
}

const ARM_NAMES = {
  upper: ['arm', 'upperarm'],
  forearm: ['forearm', 'lowerarm'],
  hand: ['hand'],
} as const;

// Suggests a bone map for Mixamo-style names (with or without a "mixamorig:" prefix). Arm sides are
// chosen by bind position, so a rig's anatomical right arm drives the screen-left joints.
export function suggestAvatarBoneMap(report: CharacterModelReport): PartialAvatarBoneMap {
  const unique = (predicate: (joint: CharacterModelJoint) => boolean): CharacterModelJoint | null => {
    const matches = report.joints.filter(predicate);
    return matches.length === 1 ? matches[0]! : null;
  };
  const map: Partial<Record<AvatarJointId, string>> = {};
  const body = unique(joint => core(joint.name) === 'hips') ?? unique(joint => core(joint.name) === 'pelvis');
  if (body !== null) map.body = body.name;
  const head = unique(joint => core(joint.name) === 'head');
  if (head !== null) map.head = head.name;
  const chains = (['left', 'right'] as const).map(anatomical => {
    const find = (names: readonly string[]) =>
      unique(joint => side(joint.name) === anatomical && names.includes(core(joint.name)));
    return { upper: find(ARM_NAMES.upper), forearm: find(ARM_NAMES.forearm), hand: find(ARM_NAMES.hand) };
  });
  const [first, second] = chains as [typeof chains[0], typeof chains[0]];
  if (first.upper !== null && second.upper !== null) {
    const screen = jointPosition(first.upper).x < jointPosition(second.upper).x ? [first, second] : [second, first];
    for (const [prefix, chain] of [['left', screen[0]!], ['right', screen[1]!]] as const) {
      if (chain.upper !== null) map[`${prefix}-upper-arm`] = chain.upper.name;
      if (chain.forearm !== null) map[`${prefix}-forearm`] = chain.forearm.name;
      if (chain.hand !== null) map[`${prefix}-hand`] = chain.hand.name;
    }
  }
  const names = new Set<string>();
  for (const id of AVATAR_JOINT_IDS) {
    const name = map[id];
    if (name === undefined) continue;
    if (names.has(name)) delete map[id];
    else names.add(name);
  }
  return Object.freeze(map);
}
