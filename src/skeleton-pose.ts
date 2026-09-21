import { angleDifference, clamp, transformPoint } from './math';
import { FACING_DIRECTIONS, fixedJointIds, SkeletonError } from './skeleton-data';
import type {
  BonePose,
  BoneWeight,
  FacingDirection,
  HairChain,
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
}

const DEG_TO_RAD = Math.PI / 180;
const EIGHTH_TURN = Math.PI / 4;
const JOINT_TOLERANCE = 1e-6;
const DISTANCE_EPSILON = 1e-8;
const SEGMENT_EPSILON = 1e-6;
const AUTO_WEIGHT_EPSILON = 1e-6;
const HAIR_FIXED_STEP_SECONDS = 1 / 60;
const HAIR_MAX_STEPS = 15;
const HAIR_MAX_CATCHUP_SECONDS = HAIR_FIXED_STEP_SECONDS * HAIR_MAX_STEPS;
const HAIR_TIME_EPSILON = 1e-9;
const HAIR_CONSTRAINT_ITERATIONS = 8;
const HAIR_STIFFNESS_FACTOR = 0.35;
const HAIR_COLLISION_SLOP = 1e-6;

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

interface HairState {
  readonly currentX: Float64Array;
  readonly currentY: Float64Array;
  readonly previousX: Float64Array;
  readonly previousY: Float64Array;
  readonly targetX: Float64Array;
  readonly targetY: Float64Array;
  readonly solvedTargetX: Float64Array;
  readonly solvedTargetY: Float64Array;
  initialized: boolean;
}

interface CompiledHair {
  readonly bones: readonly number[];
  readonly lengths: Float64Array;
  readonly stiffness: number;
  readonly damping: number;
  readonly gravity: number;
  readonly radius: number;
  readonly state: HairState;
}

interface CompiledCollider {
  readonly bone: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

const FACING_DIRECTION_SET = new Set<string>(FACING_DIRECTIONS);

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new SkeletonError(`${label} must be finite.`);
  return value;
}

function requirePoint(point: RigPoint, label: string): void {
  requireFinite(point.x, `${label} X`);
  requireFinite(point.y, `${label} Y`);
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

function reflowPose(
  topology: readonly number[],
  parentIndex: Int16Array,
  localX: Float64Array,
  localY: Float64Array,
  localAngle: Float64Array,
  worldX: Float64Array,
  worldY: Float64Array,
  worldAngle: Float64Array,
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
    const x = localX[index];
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
): readonly BoneWorld[] {
  return definition.bones.map((bone, index) => {
    const x = worldX[index];
    const y = worldY[index];
    const angle = worldAngle[index];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle)) {
      throw new SkeletonError(`Pose evaluation produced an invalid transform for bone "${bone.id}".`);
    }
    return { id: bone.id, x, y, angle, length: bone.length };
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
  reflowPose(hierarchy.topology, hierarchy.parentIndex, rest.x, rest.y, rest.angle, worldX, worldY, worldAngle);
  return snapshotPose(definition, worldX, worldY, worldAngle);
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
  private readonly directionPose = new Map<FacingDirection, DensePose>();
  private readonly clips = new Map<string, CompiledClip>();
  private readonly fixedJoints: Uint8Array;
  private readonly ik: readonly CompiledIk[];
  private readonly hair: readonly CompiledHair[];
  private readonly colliders: readonly CompiledCollider[];
  private readonly colliderWorldX: Float64Array;
  private readonly colliderWorldY: Float64Array;
  private readonly solvedColliderWorldX: Float64Array;
  private readonly solvedColliderWorldY: Float64Array;
  private lastEvaluatedTime: number | null = null;
  private hairRemainder = 0;
  private constraintsActive = false;

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
    this.hair = definition.hair.map(chain => this.compileHair(chain));
    this.colliders = definition.colliders.map(collider => this.compileCollider(collider));
    this.colliderWorldX = new Float64Array(this.colliders.length);
    this.colliderWorldY = new Float64Array(this.colliders.length);
    this.solvedColliderWorldX = new Float64Array(this.colliders.length);
    this.solvedColliderWorldY = new Float64Array(this.colliders.length);
  }

  evaluate(options: {
    time: number;
    origin: RigPoint;
    direction: FacingDirection;
    targets: ReadonlyMap<string, RigTarget>;
    clip: string | null;
    pose: readonly BonePose[];
    constraints: 'enabled' | 'disabled';
  }): readonly BoneWorld[] {
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

    reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle, this.worldX, this.worldY, this.worldAngle);

    if (options.constraints === 'disabled') {
      this.constraintsActive = false;
      this.lastEvaluatedTime = time;
      return snapshotPose(this.definition, this.worldX, this.worldY, this.worldAngle);
    }

    this.solveIk(options.targets);
    if (this.hair.length > 0) this.solveHair(time, options.origin);
    else {
      this.constraintsActive = true;
      this.lastEvaluatedTime = time;
    }

    return snapshotPose(this.definition, this.worldX, this.worldY, this.worldAngle);
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

  private compileHair(chain: HairChain): CompiledHair {
    const bones = chain.bones.map(id => this.requireBone(id, 'Hair bone'));
    return {
      bones,
      lengths: Float64Array.from(bones.map(index => this.definition.bones[index].length)),
      stiffness: chain.stiffness,
      damping: chain.damping,
      gravity: chain.gravity,
      radius: chain.radius,
      state: {
        currentX: new Float64Array(bones.length + 1),
        currentY: new Float64Array(bones.length + 1),
        previousX: new Float64Array(bones.length + 1),
        previousY: new Float64Array(bones.length + 1),
        targetX: new Float64Array(bones.length + 1),
        targetY: new Float64Array(bones.length + 1),
        solvedTargetX: new Float64Array(bones.length + 1),
        solvedTargetY: new Float64Array(bones.length + 1),
        initialized: false,
      },
    };
  }

  private compileCollider(collider: SkeletonCollider): CompiledCollider {
    return {
      bone: this.requireBone(collider.bone, 'Hair collider bone'),
      x: collider.x,
      y: collider.y,
      radius: collider.radius,
    };
  }

  private resolveClip(id: string | null): CompiledClip | null {
    if (id === null) return null;
    const clip = this.clips.get(id);
    if (!clip) throw new SkeletonError(`Missing animation clip "${id}".`);
    return clip;
  }

  private validateRuntimePose(pose: readonly BonePose[], constraints: 'enabled' | 'disabled'): void {
    const seen = new Set<string>();
    for (const entry of pose) {
      if (seen.has(entry.bone)) throw new SkeletonError(`Pose contains duplicate bone "${entry.bone}".`);
      seen.add(entry.bone);
      const index = this.indexById.get(entry.bone);
      if (index === undefined) throw new SkeletonError(`Pose references missing bone "${entry.bone}".`);
      requireFinite(entry.x, `Pose X for "${entry.bone}"`);
      requireFinite(entry.y, `Pose Y for "${entry.bone}"`);
      requireFinite(entry.rotation, `Pose rotation for "${entry.bone}"`);
      if (constraints === 'enabled' && this.fixedJoints[index] !== 0 &&
        (Math.abs(entry.x) > JOINT_TOLERANCE || Math.abs(entry.y) > JOINT_TOLERANCE)) {
        throw new SkeletonError(`Tip-attached bone "${entry.bone}" can rotate, but cannot translate in a constrained pose.`);
      }
    }
  }

  private validateTargets(targets: ReadonlyMap<string, RigTarget>): void {
    for (const [id, target] of targets) {
      requireTarget(target, `IK target "${id}"`);
    }
  }

  private solveIk(targets: ReadonlyMap<string, RigTarget>): void {
    for (const chain of this.ik) {
      const target = targets.get(chain.target);
      if (!target) throw new SkeletonError(`Missing IK target "${chain.target}".`);

      const shoulderX = this.worldX[chain.upper];
      const shoulderY = this.worldY[chain.upper];
      const desiredWrist = transformPoint({ x: chain.offsetX, y: chain.offsetY }, target, target.angle);
      const reachX = desiredWrist.x - shoulderX;
      const reachY = desiredWrist.y - shoulderY;
      const reach = Math.hypot(reachX, reachY);

      const upperLength = this.definition.bones[chain.upper].length;
      const lowerLength = this.definition.bones[chain.lower].length;
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

      reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle, this.worldX, this.worldY, this.worldAngle);
    }
  }

  private solveHair(time: number, origin: RigPoint): void {
    this.populateHairTargets(origin);
    this.populateColliderWorld(origin);

    const lastTime = this.lastEvaluatedTime;
    const reset = !this.constraintsActive || lastTime === null || time < lastTime ||
      time - lastTime > HAIR_MAX_CATCHUP_SECONDS || this.hair.some(chain => !chain.state.initialized);
    if (reset) {
      this.hairRemainder = 0;
      for (const chain of this.hair) {
        this.resetHairState(chain);
        this.constrainHair(chain, 'kinematic');
        chain.state.previousX.set(chain.state.currentX);
        chain.state.previousY.set(chain.state.currentY);
      }
    } else {
      this.hairRemainder += time - lastTime;
      const steps = Math.min(HAIR_MAX_STEPS, Math.floor((this.hairRemainder + HAIR_TIME_EPSILON) / HAIR_FIXED_STEP_SECONDS));
      this.hairRemainder = Math.max(0, this.hairRemainder - steps * HAIR_FIXED_STEP_SECONDS);
      if (steps === 0) {
        const collidersChanged = this.colliders.some((_, index) =>
          Math.abs(this.colliderWorldX[index] - this.solvedColliderWorldX[index]) > JOINT_TOLERANCE ||
          Math.abs(this.colliderWorldY[index] - this.solvedColliderWorldY[index]) > JOINT_TOLERANCE);
        for (const chain of this.hair) {
          if (collidersChanged || this.targetsChanged(chain)) this.constrainHair(chain, 'kinematic');
        }
      } else {
        for (let step = 0; step < steps; step += 1) {
          for (const chain of this.hair) {
            this.integrateHair(chain, HAIR_FIXED_STEP_SECONDS);
            this.constrainHair(chain, 'dynamic');
          }
        }
      }
    }
    for (const chain of this.hair) this.rememberTargets(chain);
    this.solvedColliderWorldX.set(this.colliderWorldX);
    this.solvedColliderWorldY.set(this.colliderWorldY);

    for (const chain of this.hair) this.applyHairPose(chain, origin);
    reflowPose(this.topology, this.parentIndex, this.localX, this.localY, this.localAngle, this.worldX, this.worldY, this.worldAngle);
    this.constraintsActive = true;
    this.lastEvaluatedTime = time;
  }

  private populateHairTargets(origin: RigPoint): void {
    for (const chain of this.hair) {
      for (let index = 0; index < chain.bones.length; index += 1) {
        const bone = chain.bones[index];
        chain.state.targetX[index] = this.worldX[bone] + origin.x;
        chain.state.targetY[index] = this.worldY[bone] + origin.y;
      }
      const last = chain.bones[chain.bones.length - 1];
      const tip = transformPoint(
        { x: this.definition.bones[last].length, y: 0 },
        { x: this.worldX[last] + origin.x, y: this.worldY[last] + origin.y },
        this.worldAngle[last],
      );
      chain.state.targetX[chain.bones.length] = tip.x;
      chain.state.targetY[chain.bones.length] = tip.y;
    }
  }

  private populateColliderWorld(origin: RigPoint): void {
    for (const [index, collider] of this.colliders.entries()) {
      const position = transformPoint(
        { x: collider.x, y: collider.y },
        { x: this.worldX[collider.bone] + origin.x, y: this.worldY[collider.bone] + origin.y },
        this.worldAngle[collider.bone],
      );
      this.colliderWorldX[index] = position.x;
      this.colliderWorldY[index] = position.y;
    }
  }

  private resetHairState(chain: CompiledHair): void {
    for (let index = 0; index < chain.state.targetX.length; index += 1) {
      chain.state.currentX[index] = chain.state.targetX[index];
      chain.state.currentY[index] = chain.state.targetY[index];
      chain.state.previousX[index] = chain.state.targetX[index];
      chain.state.previousY[index] = chain.state.targetY[index];
      chain.state.solvedTargetX[index] = chain.state.targetX[index];
      chain.state.solvedTargetY[index] = chain.state.targetY[index];
    }
    chain.state.initialized = true;
  }

  private targetsChanged(chain: CompiledHair): boolean {
    for (let index = 0; index < chain.state.targetX.length; index += 1) {
      if (Math.abs(chain.state.targetX[index] - chain.state.solvedTargetX[index]) > JOINT_TOLERANCE ||
        Math.abs(chain.state.targetY[index] - chain.state.solvedTargetY[index]) > JOINT_TOLERANCE) {
        return true;
      }
    }
    return false;
  }

  private rememberTargets(chain: CompiledHair): void {
    for (let index = 0; index < chain.state.targetX.length; index += 1) {
      chain.state.solvedTargetX[index] = chain.state.targetX[index];
      chain.state.solvedTargetY[index] = chain.state.targetY[index];
    }
  }

  private integrateHair(chain: CompiledHair, dt: number): void {
    const drag = clamp(1 - chain.damping, 0, 1);
    const gravity = chain.gravity * dt * dt;
    chain.state.currentX[0] = chain.state.targetX[0];
    chain.state.currentY[0] = chain.state.targetY[0];
    chain.state.previousX[0] = chain.state.targetX[0];
    chain.state.previousY[0] = chain.state.targetY[0];
    for (let index = 1; index < chain.state.currentX.length; index += 1) {
      const currentX = chain.state.currentX[index];
      const currentY = chain.state.currentY[index];
      const velocityX = (currentX - chain.state.previousX[index]) * drag;
      const velocityY = (currentY - chain.state.previousY[index]) * drag;
      chain.state.previousX[index] = currentX;
      chain.state.previousY[index] = currentY;
      chain.state.currentX[index] = currentX + velocityX;
      chain.state.currentY[index] = currentY + velocityY - gravity;
    }
  }

  private constrainHair(chain: CompiledHair, mode: 'dynamic' | 'kinematic'): void {
    for (let iteration = 0; iteration < HAIR_CONSTRAINT_ITERATIONS; iteration += 1) {
      chain.state.currentX[0] = chain.state.targetX[0];
      chain.state.currentY[0] = chain.state.targetY[0];
      if (mode === 'dynamic' && chain.stiffness > 0) {
        const follow = chain.stiffness * HAIR_STIFFNESS_FACTOR;
        for (let index = 1; index < chain.state.currentX.length; index += 1) {
          chain.state.currentX[index] += (chain.state.targetX[index] - chain.state.currentX[index]) * follow;
          chain.state.currentY[index] += (chain.state.targetY[index] - chain.state.currentY[index]) * follow;
        }
      }

      for (let index = 0; index < chain.lengths.length; index += 1) {
        this.enforceDistance(chain, index, index + 1, chain.lengths[index]);
      }
      for (let particle = 1; particle < chain.state.currentX.length; particle += 1) {
        this.enforceCollisions(chain, particle);
      }
      chain.state.currentX[0] = chain.state.targetX[0];
      chain.state.currentY[0] = chain.state.targetY[0];
    }
    // Reflow renders exact bone lengths, so its endpoints must match the collision particles.
    for (let index = 0; index < chain.lengths.length; index += 1) this.projectHairTip(chain, index);
  }

  private enforceDistance(chain: CompiledHair, leftIndex: number, rightIndex: number, length: number): void {
    const dx = chain.state.currentX[rightIndex] - chain.state.currentX[leftIndex];
    const dy = chain.state.currentY[rightIndex] - chain.state.currentY[leftIndex];
    const distance = Math.hypot(dx, dy);
    const angle = this.worldAngle[chain.bones[leftIndex]];
    const correctionX = (distance > SEGMENT_EPSILON ? dx / distance : Math.cos(angle)) * (distance - length);
    const correctionY = (distance > SEGMENT_EPSILON ? dy / distance : Math.sin(angle)) * (distance - length);
    if (leftIndex === 0) {
      chain.state.currentX[rightIndex] -= correctionX;
      chain.state.currentY[rightIndex] -= correctionY;
      return;
    }

    chain.state.currentX[leftIndex] += correctionX * 0.5;
    chain.state.currentY[leftIndex] += correctionY * 0.5;
    chain.state.currentX[rightIndex] -= correctionX * 0.5;
    chain.state.currentY[rightIndex] -= correctionY * 0.5;
  }

  private collisionPenetration(chain: CompiledHair, x: number, y: number): number {
    let penetration = 0;
    for (const [index, collider] of this.colliders.entries()) {
      const distance = Math.hypot(x - this.colliderWorldX[index], y - this.colliderWorldY[index]);
      penetration += Math.max(0, collider.radius + chain.radius + HAIR_COLLISION_SLOP - distance);
    }
    return penetration;
  }

  private projectHairTip(chain: CompiledHair, index: number): void {
    const x = chain.state.currentX[index], y = chain.state.currentY[index];
    const dx = chain.state.currentX[index + 1] - x, dy = chain.state.currentY[index + 1] - y;
    const distance = Math.hypot(dx, dy), length = chain.lengths[index];
    const angle = this.worldAngle[chain.bones[index]];
    const desiredX = x + length * (distance > SEGMENT_EPSILON ? dx / distance : Math.cos(angle));
    const desiredY = y + length * (distance > SEGMENT_EPSILON ? dy / distance : Math.sin(angle));
    let bestX = desiredX, bestY = desiredY;
    let bestPenetration = this.collisionPenetration(chain, bestX, bestY), bestDistance = 0;
    if (bestPenetration > DISTANCE_EPSILON) {
      const consider = (candidateX: number, candidateY: number): void => {
        const penetration = this.collisionPenetration(chain, candidateX, candidateY);
        const separation = (candidateX - desiredX) ** 2 + (candidateY - desiredY) ** 2;
        if (penetration < bestPenetration - DISTANCE_EPSILON ||
          Math.abs(penetration - bestPenetration) <= DISTANCE_EPSILON && separation < bestDistance) {
          bestX = candidateX; bestY = candidateY; bestPenetration = penetration; bestDistance = separation;
        }
      };
      for (const [colliderIndex, collider] of this.colliders.entries()) {
        const toX = this.colliderWorldX[colliderIndex] - x, toY = this.colliderWorldY[colliderIndex] - y;
        const centerDistance = Math.hypot(toX, toY);
        const radius = collider.radius + chain.radius + HAIR_COLLISION_SLOP;
        if (centerDistance <= DISTANCE_EPSILON) continue;
        const axisX = toX / centerDistance, axisY = toY / centerDistance;
        const along = (length ** 2 + centerDistance ** 2 - radius ** 2) / (2 * centerDistance);
        if (Math.abs(along) <= length) {
          const across = Math.sqrt(Math.max(0, length ** 2 - along ** 2));
          consider(x + axisX * along - axisY * across, y + axisY * along + axisX * across);
          consider(x + axisX * along + axisY * across, y + axisY * along - axisX * across);
        }
        consider(x - axisX * length, y - axisY * length);
      }
    }
    chain.state.currentX[index + 1] = bestX;
    chain.state.currentY[index + 1] = bestY;
  }

  private enforceCollisions(chain: CompiledHair, particle: number): void {
    for (const [index, collider] of this.colliders.entries()) {
      const minimum = collider.radius + chain.radius;
      const dx = chain.state.currentX[particle] - this.colliderWorldX[index];
      const dy = chain.state.currentY[particle] - this.colliderWorldY[index];
      const distance = Math.hypot(dx, dy);
      if (distance >= minimum) continue;
      if (distance <= SEGMENT_EPSILON) {
        chain.state.currentX[particle] = this.colliderWorldX[index] + minimum;
        chain.state.currentY[particle] = this.colliderWorldY[index];
        continue;
      }
      const scale = minimum / distance;
      chain.state.currentX[particle] = this.colliderWorldX[index] + dx * scale;
      chain.state.currentY[particle] = this.colliderWorldY[index] + dy * scale;
    }
  }

  private applyHairPose(chain: CompiledHair, origin: RigPoint): void {
    let parentAngle = 0;
    for (let index = 0; index < chain.bones.length; index += 1) {
      const bone = chain.bones[index];
      const worldAngle = Math.atan2(
        chain.state.currentY[index + 1] - chain.state.currentY[index],
        chain.state.currentX[index + 1] - chain.state.currentX[index],
      );
      if (index === 0) {
        const parent = this.parentIndex[bone];
        parentAngle = parent < 0 ? 0 : this.worldAngle[parent];
      }
      this.localAngle[bone] = worldAngle - parentAngle;
      parentAngle = worldAngle;
    }

    const root = chain.bones[0];
    const rootWorldX = chain.state.currentX[0] - origin.x;
    const rootWorldY = chain.state.currentY[0] - origin.y;
    const parent = this.parentIndex[root];
    if (parent < 0) {
      this.localX[root] = rootWorldX;
      this.localY[root] = rootWorldY;
      return;
    }
    const dx = rootWorldX - this.worldX[parent];
    const dy = rootWorldY - this.worldY[parent];
    const rootParentAngle = this.worldAngle[parent];
    this.localX[root] = rotateX(dx, dy, -rootParentAngle);
    this.localY[root] = rotateY(dx, dy, -rootParentAngle);
  }
}
