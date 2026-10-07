import { HairSolver } from './hair-solver';
import type { HairChainState } from './hair-solver';
import { angleDifference, clamp, transformPoint } from './math';
import { FACING_DIRECTIONS, fixedJointIds, SkeletonError } from './skeleton-data';
import type {
  BonePose,
  BoneWeight,
  FacingDirection,
  SkeletonClip,
  SkeletonCollider,
  SkeletonDefinition,
  SkeletonIk,
} from './skeleton-data';

export interface RigPoint {
  readonly x: number;
  readonly y: number;
}

export interface RigTarget extends RigPoint {
  readonly angle: number;
}

export interface BoneWorld extends RigPoint {
  readonly id: string;
  readonly angle: number;
  readonly length: number;
  // How far the bone is stretched along its length; 1 as authored.
  readonly scale: number;
}

export interface SkeletonRotation {
  // Automatic head owners keep their authored neck attachment instead of orbiting a shared pivot.
  readonly pivot: RigPoint | 'bone-origin';
  readonly angle: number;
}
export interface HeldSkeletonFrame {
  readonly targets: ReadonlyMap<string, RigTarget>;
  readonly rootAngle: number;
}
export type MutableBoneWorld = { -readonly [K in keyof BoneWorld]: BoneWorld[K] };

const DEG_TO_RAD = Math.PI / 180;
const EIGHTH_TURN = Math.PI / 4;
const JOINT_TOLERANCE = 1e-6;
const DISTANCE_EPSILON = 1e-8;
const SEGMENT_EPSILON = 1e-6;
const AUTO_WEIGHT_EPSILON = 1e-6;

interface DensePose {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly rotation: Float64Array;
}

interface CompiledFrame extends DensePose {
  readonly time: number;
}

interface CompiledClip {
  readonly duration: number;
  readonly loop: boolean;
  readonly frames: readonly CompiledFrame[];
}

interface Hierarchy {
  readonly indexById: ReadonlyMap<string, number>;
  readonly parentIndex: Int16Array;
  readonly depth: Int16Array;
  readonly topology: readonly number[];
}

interface CompiledIk {
  readonly upper: number;
  readonly lower: number;
  readonly hand: number;
  readonly target: string;
  readonly bend: -1 | 1;
  readonly mix: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly handRotation: number;
}

// A hair chain's bones, root first; the shared solver owns its particles.
interface CompiledHair {
  readonly bones: readonly number[];
}

// A collision circle riding on a bone; the shared solver owns its radius.
interface CompiledCollider {
  readonly bone: number;
  readonly x: number;
  readonly y: number;
}

const FACING_DIRECTION_SET = new Set<string>(FACING_DIRECTIONS);

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new SkeletonError(`${label} must be finite.`);
  return value;
}

function requirePoint(point: RigPoint, label: string): void {
  if (!Number.isFinite(point.x)) requireFinite(point.x, `${label} X`);
  if (!Number.isFinite(point.y)) requireFinite(point.y, `${label} Y`);
}

function requireTarget(target: RigTarget, label: string): void {
  requirePoint(target, label);
  requireFinite(target.angle, `${label} angle`);
}

function zeroPose(size: number): DensePose {
  return { x: new Float64Array(size), y: new Float64Array(size), rotation: new Float64Array(size) };
}

function positiveModulo(value: number, divisor: number): number {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}

function directionIndex(angle: number): number {
  const sector = Math.round(angle / EIGHTH_TURN);
  return positiveModulo(sector, FACING_DIRECTIONS.length);
}

function rotateX(x: number, y: number, angle: number): number {
  return x * Math.cos(angle) - y * Math.sin(angle);
}

function rotateY(x: number, y: number, angle: number): number {
  return x * Math.sin(angle) + y * Math.cos(angle);
}

function buildHierarchy(definition: SkeletonDefinition): Hierarchy {
  const indexById = new Map<string, number>();
  for (const [index, bone] of definition.bones.entries()) {
    if (indexById.has(bone.id)) throw new SkeletonError(`Duplicate bone "${bone.id}".`);
    indexById.set(bone.id, index);
  }

  const parentIndex = new Int16Array(definition.bones.length);
  parentIndex.fill(-1);
  const children = Array.from({ length: definition.bones.length }, () => [] as number[]);
  const indegree = new Int16Array(definition.bones.length);

  for (const [index, bone] of definition.bones.entries()) {
    if (bone.parent === null) continue;
    const parent = indexById.get(bone.parent);
    if (parent === undefined) throw new SkeletonError(`Missing parent bone "${bone.parent}".`);
    parentIndex[index] = parent;
    indegree[index] = 1;
    children[parent].push(index);
  }

  const queue: number[] = [];
  for (let index = 0; index < indegree.length; index += 1) if (indegree[index] === 0) queue.push(index);
  const topology: number[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    topology.push(current);
    for (const child of children[current]) {
      indegree[child] -= 1;
      if (indegree[child] === 0) queue.push(child);
    }
  }

  if (topology.length !== definition.bones.length) throw new SkeletonError('Bone parents must not form a cycle.');
  const depth = new Int16Array(definition.bones.length);
  for (const index of topology) {
    const parent = parentIndex[index];
    depth[index] = parent < 0 ? 0 : depth[parent] + 1;
  }
  return { indexById, parentIndex, depth, topology };
}

function compilePose(entries: readonly BonePose[], size: number, indexById: ReadonlyMap<string, number>): DensePose {
  const pose = zeroPose(size);
  for (const entry of entries) {
    const index = indexById.get(entry.bone);
    if (index === undefined) throw new SkeletonError(`Unknown bone "${entry.bone}".`);
    pose.x[index] = entry.x;
    pose.y[index] = entry.y;
    pose.rotation[index] = entry.rotation * DEG_TO_RAD;
  }
  return pose;
}

function applyDensePose(localX: Float64Array, localY: Float64Array, localAngle: Float64Array, pose: DensePose): void {
  for (let index = 0; index < localX.length; index += 1) {
    localX[index] += pose.x[index];
    localY[index] += pose.y[index];
    localAngle[index] += pose.rotation[index];
  }
}

// A stretched parent stretches its local space along its length, so its children move with its tip.
function reflowPose(
  topology: readonly number[],
  parentIndex: Int16Array,
  localX: Float64Array,
  localY: Float64Array,
  localAngle: Float64Array,
  worldX: Float64Array,
  worldY: Float64Array,
  worldAngle: Float64Array,
  lengthScale: Float64Array | null,
): void {
  for (const index of topology) {
    const parent = parentIndex[index];
    if (parent < 0) {
      worldX[index] = localX[index];
      worldY[index] = localY[index];
      worldAngle[index] = localAngle[index];
      continue;
    }
    const angle = worldAngle[parent];
    const x = lengthScale === null ? localX[index] : localX[index] * lengthScale[parent];
    const y = localY[index];
    worldX[index] = worldX[parent] + rotateX(x, y, angle);
    worldY[index] = worldY[parent] + rotateY(x, y, angle);
    worldAngle[index] = angle + localAngle[index];
  }
}

function copyPose(definition: SkeletonDefinition): {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly angle: Float64Array;
} {
  const x = new Float64Array(definition.bones.length);
  const y = new Float64Array(definition.bones.length);
  const angle = new Float64Array(definition.bones.length);
  for (const [index, bone] of definition.bones.entries()) {
    x[index] = bone.x;
    y[index] = bone.y;
    angle[index] = bone.rotation * DEG_TO_RAD;
  }
  return { x, y, angle };
}

function snapshotPose(
  definition: SkeletonDefinition,
  worldX: Float64Array,
  worldY: Float64Array,
  worldAngle: Float64Array,
  lengthScale: Float64Array | null,
): readonly BoneWorld[] {
  return definition.bones.map((bone, index) => {
    const x = worldX[index];
    const y = worldY[index];
    const angle = worldAngle[index];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle)) {
      throw new SkeletonError(`Pose evaluation produced an invalid transform for bone "${bone.id}".`);
    }
    const scale = lengthScale === null ? 1 : lengthScale[index];
    return { id: bone.id, x, y, angle, length: bone.length * scale, scale };
  });
}

function pointToSegmentDistanceSquared(point: RigPoint, start: RigPoint, end: RigPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= DISTANCE_EPSILON) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return px * px + py * py;
  }
  const projection = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  const closestX = start.x + dx * projection;
  const closestY = start.y + dy * projection;
  const px = point.x - closestX;
  const py = point.y - closestY;
  return px * px + py * py;
}

function compileClip(clip: SkeletonClip, size: number, indexById: ReadonlyMap<string, number>): CompiledClip {
  return {
    duration: clip.duration,
    loop: clip.loop,
    frames: clip.frames.map(frame => ({ time: frame.time, ...compilePose(frame.pose, size, indexById) })),
  };
}

function sampleClipInto(clip: CompiledClip, time: number, localX: Float64Array, localY: Float64Array, localAngle: Float64Array): void {
  if (clip.frames.length === 1) {
    applyDensePose(localX, localY, localAngle, clip.frames[0]);
    return;
  }

  const sampledTime = clip.loop ? positiveModulo(time, clip.duration) : clamp(time, 0, clip.duration);
  const first = clip.frames[0];
  if (sampledTime <= first.time) {
    applyDensePose(localX, localY, localAngle, first);
    return;
  }
  const last = clip.frames[clip.frames.length - 1];
  if (sampledTime >= last.time) {
    applyDensePose(localX, localY, localAngle, last);
    return;
  }

  let low = 0;
  let high = clip.frames.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (clip.frames[middle].time <= sampledTime) low = middle;
    else high = middle;
  }
  const left = clip.frames[low];
  const right = clip.frames[high];
  const alpha = (sampledTime - left.time) / (right.time - left.time);
  for (let index = 0; index < localX.length; index += 1) {
    localX[index] += left.x[index] + (right.x[index] - left.x[index]) * alpha;
    localY[index] += left.y[index] + (right.y[index] - left.y[index]) * alpha;
    localAngle[index] += left.rotation[index] + (right.rotation[index] - left.rotation[index]) * alpha;
  }
}

function nearestDirection(angle: number): FacingDirection {
  return FACING_DIRECTIONS[directionIndex(angle)];
}

export function restPose(definition: SkeletonDefinition): readonly BoneWorld[] {
  const hierarchy = buildHierarchy(definition);
  const rest = copyPose(definition);
  const worldX = new Float64Array(definition.bones.length);
  const worldY = new Float64Array(definition.bones.length);
  const worldAngle = new Float64Array(definition.bones.length);
  reflowPose(hierarchy.topology, hierarchy.parentIndex, rest.x, rest.y, rest.angle, worldX, worldY, worldAngle, null);
  return snapshotPose(definition, worldX, worldY, worldAngle, null);
}

export function facingDirection(angle: number): FacingDirection {
  requireFinite(angle, 'Facing angle');
  return nearestDirection(angle);
}

export function autoWeights(
  definition: SkeletonDefinition,
  points: readonly RigPoint[],
  boneIds: readonly string[],
): readonly (readonly BoneWeight[])[] {
  if (boneIds.length === 0) throw new SkeletonError('Choose at least one bone for automatic weights.');

  const bones = restPose(definition);
  const byId = new Map(bones.map(bone => [bone.id, bone]));
  const seen = new Set<string>();
  const candidates = boneIds.map(id => {
    if (seen.has(id)) throw new SkeletonError(`Automatic weights include duplicate bone "${id}".`);
    seen.add(id);
    const bone = byId.get(id);
    if (!bone) throw new SkeletonError(`Automatic weights reference unknown bone "${id}".`);
    const tip = transformPoint({ x: bone.length, y: 0 }, bone, bone.angle);
    return { id, start: bone, end: tip };
  });

  return points.map(point => {
    requirePoint(point, 'Weight point');
    const bestIds = ['', '', '', ''];
    const bestDistances = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    for (const candidate of candidates) {
      const distanceSquared = pointToSegmentDistanceSquared(point, candidate.start, candidate.end);
      for (let slot = 0; slot < bestIds.length; slot += 1) {
        if (distanceSquared > bestDistances[slot] + DISTANCE_EPSILON) continue;
        for (let shift = bestIds.length - 1; shift > slot; shift -= 1) {
          bestIds[shift] = bestIds[shift - 1];
          bestDistances[shift] = bestDistances[shift - 1];
        }
        bestIds[slot] = candidate.id;
        bestDistances[slot] = distanceSquared;
        break;
      }
    }

    const zeroDistance: BoneWeight[] = [];
    for (let index = 0; index < bestIds.length; index += 1) {
      if (!bestIds[index]) continue;
      if (bestDistances[index] <= AUTO_WEIGHT_EPSILON ** 2) zeroDistance.push({ bone: bestIds[index], weight: 0 });
    }
    if (zeroDistance.length > 0) {
      const weight = 1 / zeroDistance.length;
      return zeroDistance.map(entry => ({ bone: entry.bone, weight }));
    }

    const raw: BoneWeight[] = [];
    let total = 0;
    for (let index = 0; index < bestIds.length; index += 1) {
      if (!bestIds[index]) continue;
      const weight = 1 / Math.max(bestDistances[index], AUTO_WEIGHT_EPSILON ** 2);
      raw.push({ bone: bestIds[index], weight });
      total += weight;
    }
    return raw.map(entry => ({ bone: entry.bone, weight: entry.weight / total }));
  });
}

export class SkeletonPose {
  private readonly definition: SkeletonDefinition;
  private readonly indexById: ReadonlyMap<string, number>;
  private readonly parentIndex: Int16Array;
  private readonly boneDepth: Int16Array;
  private readonly topology: readonly number[];
  private readonly restX: Float64Array;
  private readonly restY: Float64Array;
  private readonly restAngle: Float64Array;
  private readonly localX: Float64Array;
  private readonly localY: Float64Array;
  private readonly localAngle: Float64Array;
  private readonly worldX: Float64Array;
  private readonly worldY: Float64Array;
  private readonly worldAngle: Float64Array;
  // Each bone's stretch along its length; 1 as authored.
  private readonly lengthScale: Float64Array;
  private readonly directionPose = new Map<FacingDirection, DensePose>();
  private readonly clips = new Map<string, CompiledClip>();
  private readonly fixedJoints: Uint8Array;
  private readonly ik: readonly CompiledIk[];
  private readonly hair: readonly CompiledHair[];
  private readonly colliders: readonly CompiledCollider[];
  private readonly hairSolver: HairSolver;
  private rotationRoots: readonly number[] = [];
  private rotationTopology: readonly number[] = [];
  private readonly heldX: Float64Array;
  private readonly heldY: Float64Array;
  private readonly heldAngle: Float64Array;
  private readonly heldOutput: MutableBoneWorld[];
  private readonly poseSeen: Uint8Array;
  private readonly validateTarget = (target: RigTarget, id: string): void => {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.angle)) {
      requireTarget(target, `IK target "${id}"`);
    }
  };
  private heldRootAngle = 0;
  private heldHeads: readonly { readonly bone: number; readonly x: number; readonly y: number; readonly angle: number; readonly anchor: RigTarget }[] = [];

  constructor(definition: SkeletonDefinition) {
    this.definition = definition;
    const hierarchy = buildHierarchy(definition);
    this.indexById = hierarchy.indexById;
    this.parentIndex = hierarchy.parentIndex;
    this.boneDepth = hierarchy.depth;
    this.topology = hierarchy.topology;

    const rest = copyPose(definition);
    this.restX = rest.x;
    this.restY = rest.y;
    this.restAngle = rest.angle;
    this.localX = new Float64Array(definition.bones.length);
    this.localY = new Float64Array(definition.bones.length);
    this.localAngle = new Float64Array(definition.bones.length);
    this.worldX = new Float64Array(definition.bones.length);
    this.worldY = new Float64Array(definition.bones.length);
    this.worldAngle = new Float64Array(definition.bones.length);
    this.lengthScale = new Float64Array(definition.bones.length).fill(1);
    this.heldX = new Float64Array(definition.bones.length);
    this.heldY = new Float64Array(definition.bones.length);
    this.heldAngle = new Float64Array(definition.bones.length);
    this.heldOutput = definition.bones.map(bone => ({ id: bone.id, x: 0, y: 0, angle: 0, length: bone.length, scale: 1 }));
    this.poseSeen = new Uint8Array(definition.bones.length);

    for (const pose of definition.poses) this.directionPose.set(pose.direction, compilePose(pose.pose, definition.bones.length, this.indexById));
    for (const clip of definition.clips) this.clips.set(clip.id, compileClip(clip, definition.bones.length, this.indexById));

    this.fixedJoints = new Uint8Array(definition.bones.length);
    for (const id of fixedJointIds(definition)) this.fixedJoints[this.requireBone(id, 'Constrained bone')] = 1;

    this.ik = definition.ik
      .map((chain, index) => ({ chain, index }))
      .sort((left, right) => {
        const depthDifference = this.boneDepth[this.indexById.get(left.chain.upper)!] -
          this.boneDepth[this.indexById.get(right.chain.upper)!];
        return depthDifference !== 0 ? depthDifference : left.index - right.index;
      })
      .map(({ chain }) => this.compileIk(chain));
    this.hair = definition.hair.map(chain => ({ bones: chain.bones.map(id => this.requireBone(id, 'Hair bone')) }));
    this.colliders = definition.colliders.map(collider => this.compileCollider(collider));
    this.hairSolver = new HairSolver(definition.hair.map(chain => ({ parameters: chain, segments: chain.bones.length })),
      definition.colliders.map(collider => collider.radius));
    // A sprite chain's segments are its bones at their authored lengths: particles at each bone and the last tip.
    for (const [index, chain] of this.hair.entries()) {
      this.hairSolver.chains[index].lengths.set(chain.bones.map(bone => definition.bones[bone].length));
    }
  }

  configureRotation(bones: readonly string[]): void {
    this.rotationRoots = bones.map(id => this.requireBone(id, 'Directional rotation bone'));
    const roots = new Set(this.rotationRoots);
    const affected = new Set<number>();
    this.rotationTopology = this.topology.filter(index => {
      if (!roots.has(index) && !affected.has(this.parentIndex[index])) return false;
      affected.add(index);
      return true;
    });
  }

  // Stretches the named bones to these lengths, moving their children with them; others keep theirs.
  setBoneLengths(lengths: ReadonlyMap<string, number>): void {
    this.lengthScale.fill(1);
    for (const [id, length] of lengths) {
      if (!Number.isFinite(length) || length <= 0) throw new SkeletonError(`Bone "${id}" needs a positive length.`);
      const index = this.requireBone(id, 'Stretched bone');
      this.lengthScale[index] = length / this.definition.bones[index].length;
    }
  }

  // Seeds a preallocated preview after the live frame.
  copyMotionFrom(source: SkeletonPose): void {
    if (source.definition !== this.definition) throw new SkeletonError('Motion can only be copied between poses of the same skeleton.');
    this.lengthScale.set(source.lengthScale);
    this.rotationRoots = source.rotationRoots;
    this.rotationTopology = source.rotationTopology;
    this.hairSolver.copyFrom(source.hairSolver);
  }

  // Direction, animation and hair base pose stop at entry. Existing anatomical ownership comes
  // from artwork's head anchor, not guessed bone names or a second sprite schema.
  hold(rootAngle: number, targets: ReadonlyMap<string, RigTarget>, headBones: readonly string[], preserveBase = false): void {
    if (preserveBase) this.restoreHeldPose(rootAngle, targets);
    this.heldX.set(this.localX); this.heldY.set(this.localY); this.heldAngle.set(this.localAngle);
    this.heldRootAngle = rootAngle;
    const target = targets.get('character-head');
    if (target === undefined) throw new SkeletonError('The held skeleton needs its character-head anchor.');
    this.heldHeads = headBones.map(id => {
      const bone = this.requireBone(id, 'Held head bone');
      return { bone, x: this.worldX[bone], y: this.worldY[bone], angle: this.worldAngle[bone], anchor: { ...target } };
    });
  }

  evaluateHeld(frame: HeldSkeletonFrame): readonly BoneWorld[] {
    this.restoreHeldPose(frame.rootAngle, frame.targets);
    this.solveIk(frame.targets, true);
    for (let index = 0; index < this.heldOutput.length; index++) {
      const out = this.heldOutput[index]!;
      out.x = this.worldX[index]; out.y = this.worldY[index]; out.angle = this.worldAngle[index];
      out.scale = this.lengthScale[index]; out.length = this.definition.bones[index]!.length * out.scale;
      if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.angle)) {
        throw new SkeletonError(`Physical pose produced a non-finite transform for bone "${out.id}".`);
      }
    }
    return this.heldOutput;
  }

  private restoreHeldPose(rootAngle: number, targets: ReadonlyMap<string, RigTarget>): void {
    this.localX.set(this.heldX); this.localY.set(this.heldY); this.localAngle.set(this.heldAngle);
    const turn = rootAngle - this.heldRootAngle, cos = Math.cos(turn), sin = Math.sin(turn);
    for (const bone of this.topology) {
      if (this.parentIndex[bone] >= 0) continue;
      const x = this.localX[bone], y = this.localY[bone];
      this.localX[bone] = cos * x - sin * y; this.localY[bone] = sin * x + cos * y;
      this.localAngle[bone] += turn;
    }
    reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle,
      this.worldX, this.worldY, this.worldAngle, this.lengthScale);
    const head = targets.get('character-head');
    if (head === undefined) throw new SkeletonError('The physical skeleton needs its character-head anchor.');
    for (const held of this.heldHeads) {
      const rotation = head.angle - held.anchor.angle;
      const dx = held.x - held.anchor.x, dy = held.y - held.anchor.y;
      const x = head.x + Math.cos(rotation) * dx - Math.sin(rotation) * dy;
      const y = head.y + Math.sin(rotation) * dx + Math.cos(rotation) * dy;
      const angle = held.angle + rotation, bone = held.bone, parent = this.parentIndex[bone];
      if (parent < 0) {
        this.localX[bone] = x; this.localY[bone] = y; this.localAngle[bone] = angle;
      } else {
        const px = x - this.worldX[parent], py = y - this.worldY[parent], pa = this.worldAngle[parent];
        this.localX[bone] = rotateX(px, py, -pa) / this.lengthScale[parent];
        this.localY[bone] = rotateY(px, py, -pa); this.localAngle[bone] = angle - pa;
      }
      reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle,
        this.worldX, this.worldY, this.worldAngle, this.lengthScale);
    }
  }

  evaluate(options: {
    time: number;
    origin: RigPoint;
    direction: FacingDirection;
    targets: ReadonlyMap<string, RigTarget>;
    clip: string | null;
    pose: readonly BonePose[];
    constraints: 'enabled' | 'disabled';
    rotation?: SkeletonRotation | null;
  }, out?: readonly MutableBoneWorld[]): readonly BoneWorld[] {
    if (out !== undefined && out.length !== this.definition.bones.length) {
      throw new SkeletonError('The pose output must have one record per bone.');
    }
    const time = requireFinite(options.time, 'Pose time');
    requirePoint(options.origin, 'Pose origin');
    if (!FACING_DIRECTION_SET.has(options.direction)) throw new SkeletonError('Choose one of the eight facing directions.');
    if (options.constraints !== 'enabled' && options.constraints !== 'disabled') {
      throw new SkeletonError('Constraints must be enabled or disabled.');
    }

    this.validateTargets(options.targets);
    const clip = this.resolveClip(options.clip);
    this.validateRuntimePose(options.pose, options.constraints);

    this.localX.set(this.restX);
    this.localY.set(this.restY);
    this.localAngle.set(this.restAngle);

    const directional = this.directionPose.get(options.direction);
    if (directional) applyDensePose(this.localX, this.localY, this.localAngle, directional);
    if (clip !== null) sampleClipInto(clip, time, this.localX, this.localY, this.localAngle);
    for (const entry of options.pose) {
      const index = this.indexById.get(entry.bone)!;
      this.localX[index] += entry.x;
      this.localY[index] += entry.y;
      this.localAngle[index] += entry.rotation * DEG_TO_RAD;
    }

    reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle, this.worldX, this.worldY, this.worldAngle,
      this.lengthScale);

    if (options.constraints === 'enabled') this.solveIk(options.targets);
    if (options.rotation !== undefined && options.rotation !== null) this.applyRotation(options.rotation);

    if (options.constraints === 'disabled') {
      this.hairSolver.interrupt();
    } else if (this.hair.length > 0) this.solveHair(time, options.origin);

    if (out === undefined) return snapshotPose(this.definition, this.worldX, this.worldY, this.worldAngle, this.lengthScale);
    for (let index = 0; index < out.length; index++) {
      const bone = this.definition.bones[index]!, target = out[index]!;
      const x = this.worldX[index], y = this.worldY[index], angle = this.worldAngle[index], scale = this.lengthScale[index];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle)) {
        throw new SkeletonError(`Pose evaluation produced an invalid transform for bone "${bone.id}".`);
      }
      target.id = bone.id; target.x = x; target.y = y; target.angle = angle;
      target.length = bone.length * scale; target.scale = scale;
    }
    return out;
  }

  private applyRotation(rotation: SkeletonRotation): void {
    requireFinite(rotation.angle, 'Directional rotation');
    if (rotation.pivot !== 'bone-origin') requirePoint(rotation.pivot, 'Directional pivot');
    if (rotation.angle === 0 || this.rotationRoots.length === 0) return;
    for (const bone of this.rotationRoots) {
      if (rotation.pivot !== 'bone-origin') {
        const x = this.worldX[bone] - rotation.pivot.x;
        const y = this.worldY[bone] - rotation.pivot.y;
        const rotatedX = rotation.pivot.x + rotateX(x, y, rotation.angle);
        const rotatedY = rotation.pivot.y + rotateY(x, y, rotation.angle);
        const parent = this.parentIndex[bone];
        if (parent < 0) {
          this.localX[bone] = rotatedX;
          this.localY[bone] = rotatedY;
        } else {
          const dx = rotatedX - this.worldX[parent];
          const dy = rotatedY - this.worldY[parent];
          // The reflow stretches local x by the parent's scale, so store it unstretched.
          this.localX[bone] = rotateX(dx, dy, -this.worldAngle[parent]) / this.lengthScale[parent];
          this.localY[bone] = rotateY(dx, dy, -this.worldAngle[parent]);
        }
      }
      this.localAngle[bone] += rotation.angle;
    }
    // Move sockets and their collision guides before hair consumes them; particles stay in world space.
    reflowPose(this.rotationTopology, this.parentIndex, this.localX, this.localY, this.localAngle,
      this.worldX, this.worldY, this.worldAngle, this.lengthScale);
  }

  private requireBone(id: string, label: string): number {
    const index = this.indexById.get(id);
    if (index === undefined) throw new SkeletonError(`${label} "${id}" is missing.`);
    return index;
  }

  private compileIk(chain: SkeletonIk): CompiledIk {
    return {
      upper: this.requireBone(chain.upper, 'IK upper bone'),
      lower: this.requireBone(chain.lower, 'IK lower bone'),
      hand: this.requireBone(chain.hand, 'IK hand bone'),
      target: chain.target,
      bend: chain.bend,
      mix: chain.mix,
      offsetX: chain.offsetX,
      offsetY: chain.offsetY,
      handRotation: chain.handRotation * DEG_TO_RAD,
    };
  }

  private compileCollider(collider: SkeletonCollider): CompiledCollider {
    return { bone: this.requireBone(collider.bone, 'Hair collider bone'), x: collider.x, y: collider.y };
  }

  private resolveClip(id: string | null): CompiledClip | null {
    if (id === null) return null;
    const clip = this.clips.get(id);
    if (!clip) throw new SkeletonError(`Missing animation clip "${id}".`);
    return clip;
  }

  private validateRuntimePose(pose: readonly BonePose[], constraints: 'enabled' | 'disabled'): void {
    if (pose.length === 0) return;
    const seen = this.poseSeen;
    seen.fill(0);
    for (const entry of pose) {
      const index = this.indexById.get(entry.bone);
      if (index === undefined) throw new SkeletonError(`Pose references missing bone "${entry.bone}".`);
      if (seen[index] !== 0) throw new SkeletonError(`Pose contains duplicate bone "${entry.bone}".`);
      seen[index] = 1;
      if (!Number.isFinite(entry.x)) requireFinite(entry.x, `Pose X for "${entry.bone}"`);
      if (!Number.isFinite(entry.y)) requireFinite(entry.y, `Pose Y for "${entry.bone}"`);
      if (!Number.isFinite(entry.rotation)) requireFinite(entry.rotation, `Pose rotation for "${entry.bone}"`);
      if (constraints === 'enabled' && this.fixedJoints[index] !== 0 &&
        (Math.abs(entry.x) > JOINT_TOLERANCE || Math.abs(entry.y) > JOINT_TOLERANCE)) {
        throw new SkeletonError(`Tip-attached bone "${entry.bone}" can rotate, but cannot translate in a constrained pose.`);
      }
    }
  }

  private validateTargets(targets: ReadonlyMap<string, RigTarget>): void {
    targets.forEach(this.validateTarget);
  }

  private solveIk(targets: ReadonlyMap<string, RigTarget>, released = false): void {
    for (const chain of this.ik) {
      const target = targets.get(chain.target);
      if (!target) throw new SkeletonError(`Missing IK target "${chain.target}".`);

      const shoulderX = this.worldX[chain.upper];
      const shoulderY = this.worldY[chain.upper];
      const offsetX = released ? 0 : chain.offsetX, offsetY = released ? 0 : chain.offsetY;
      const reachX = target.x + Math.cos(target.angle) * offsetX - Math.sin(target.angle) * offsetY - shoulderX;
      const reachY = target.y + Math.sin(target.angle) * offsetX + Math.cos(target.angle) * offsetY - shoulderY;
      const reach = Math.hypot(reachX, reachY);

      const upperLength = this.definition.bones[chain.upper].length * this.lengthScale[chain.upper];
      const lowerLength = this.definition.bones[chain.lower].length * this.lengthScale[chain.lower];
      const minimumReach = Math.max(SEGMENT_EPSILON, Math.abs(upperLength - lowerLength));
      const maximumReach = upperLength + lowerLength;
      const clampedReach = clamp(reach, minimumReach, maximumReach);
      const directionX = reach > SEGMENT_EPSILON ? reachX / reach : Math.cos(this.worldAngle[chain.upper]);
      const directionY = reach > SEGMENT_EPSILON ? reachY / reach : Math.sin(this.worldAngle[chain.upper]);
      const wristX = shoulderX + directionX * clampedReach;
      const wristY = shoulderY + directionY * clampedReach;
      const along = (upperLength * upperLength - lowerLength * lowerLength + clampedReach * clampedReach) / (2 * clampedReach);
      const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along)) * chain.bend;
      const elbowX = shoulderX + directionX * along - directionY * height;
      const elbowY = shoulderY + directionY * along + directionX * height;

      const upperAngle = Math.atan2(elbowY - shoulderY, elbowX - shoulderX);
      const lowerAngle = Math.atan2(wristY - elbowY, wristX - elbowX);
      const handAngle = target.angle + chain.handRotation;

      const blendedUpper = this.worldAngle[chain.upper] + angleDifference(upperAngle, this.worldAngle[chain.upper]) * chain.mix;
      const blendedLower = this.worldAngle[chain.lower] + angleDifference(lowerAngle, this.worldAngle[chain.lower]) * chain.mix;
      const blendedHand = this.worldAngle[chain.hand] + angleDifference(handAngle, this.worldAngle[chain.hand]) * chain.mix;

      const upperParent = this.parentIndex[chain.upper];
      this.localAngle[chain.upper] = upperParent < 0 ? blendedUpper : blendedUpper - this.worldAngle[upperParent];
      this.localAngle[chain.lower] = blendedLower - blendedUpper;
      this.localAngle[chain.hand] = blendedHand - blendedLower;

      reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle, this.worldX, this.worldY, this.worldAngle,
      this.lengthScale);
    }
  }

  private solveHair(time: number, origin: RigPoint): void {
    this.populateHairTargets(origin);
    this.populateColliderWorld(origin);
    this.hairSolver.solve(time);
    for (let index = 0; index < this.hair.length; index++) this.applyHairPose(this.hair[index], this.hairSolver.chains[index], origin);
    reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle, this.worldX, this.worldY, this.worldAngle,
      this.lengthScale);
  }

  private populateHairTargets(origin: RigPoint): void {
    for (let chainIndex = 0; chainIndex < this.hair.length; chainIndex++) {
      const chain = this.hair[chainIndex];
      const state = this.hairSolver.chains[chainIndex];
      for (let index = 0; index < chain.bones.length; index += 1) {
        const bone = chain.bones[index];
        state.targetX[index] = this.worldX[bone] + origin.x;
        state.targetY[index] = this.worldY[bone] + origin.y;
      }
      const last = chain.bones[chain.bones.length - 1];
      const length = this.definition.bones[last].length * this.lengthScale[last], angle = this.worldAngle[last];
      state.targetX[chain.bones.length] = length * Math.cos(angle) + this.worldX[last] + origin.x;
      state.targetY[chain.bones.length] = length * Math.sin(angle) + this.worldY[last] + origin.y;
    }
  }

  private populateColliderWorld(origin: RigPoint): void {
    for (let index = 0; index < this.colliders.length; index++) {
      const collider = this.colliders[index], angle = this.worldAngle[collider.bone];
      const x = collider.x * this.lengthScale[collider.bone], y = collider.y, cos = Math.cos(angle), sin = Math.sin(angle);
      this.hairSolver.colliderX[index] = x * cos - y * sin + this.worldX[collider.bone] + origin.x;
      this.hairSolver.colliderY[index] = x * sin + y * cos + this.worldY[collider.bone] + origin.y;
    }
  }

  private applyHairPose(chain: CompiledHair, state: HairChainState, origin: RigPoint): void {
    let parentAngle = 0;
    for (let index = 0; index < chain.bones.length; index += 1) {
      const bone = chain.bones[index];
      const worldAngle = Math.atan2(
        state.currentY[index + 1] - state.currentY[index],
        state.currentX[index + 1] - state.currentX[index],
      );
      if (index === 0) {
        const parent = this.parentIndex[bone];
        parentAngle = parent < 0 ? 0 : this.worldAngle[parent];
      }
      this.localAngle[bone] = worldAngle - parentAngle;
      parentAngle = worldAngle;
    }

    const root = chain.bones[0];
    const rootWorldX = state.currentX[0] - origin.x;
    const rootWorldY = state.currentY[0] - origin.y;
    const parent = this.parentIndex[root];
    if (parent < 0) {
      this.localX[root] = rootWorldX;
      this.localY[root] = rootWorldY;
      return;
    }
    const dx = rootWorldX - this.worldX[parent];
    const dy = rootWorldY - this.worldY[parent];
    const rootParentAngle = this.worldAngle[parent];
    // The reflow stretches local x by the parent's scale, so store it unstretched.
    this.localX[root] = rotateX(dx, dy, -rootParentAngle) / this.lengthScale[parent];
    this.localY[root] = rotateY(dx, dy, -rootParentAngle);
  }
}
