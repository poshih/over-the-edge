export const FACING_DIRECTIONS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'] as const;
export type FacingDirection = (typeof FACING_DIRECTIONS)[number];

export interface BoneDefinition {
  readonly id: string;
  readonly name: string;
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly length: number;
}

export interface BonePose {
  readonly bone: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

export interface SkeletonKeyframe {
  readonly time: number;
  readonly pose: readonly BonePose[];
}

export interface SkeletonClip {
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly frames: readonly SkeletonKeyframe[];
}

export interface SkeletonIk {
  readonly id: string;
  readonly upper: string;
  readonly lower: string;
  readonly hand: string;
  readonly target: string;
  readonly bend: -1 | 1;
  readonly mix: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly handRotation: number;
}

export interface HairChain {
  readonly id: string;
  readonly bones: readonly string[];
  readonly stiffness: number;
  readonly damping: number;
  readonly gravity: number;
  readonly radius: number;
}

export interface SkeletonCollider {
  readonly id: string;
  readonly bone: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface SkeletonDefinition {
  readonly anchor: string;
  readonly bones: readonly BoneDefinition[];
  readonly poses: readonly { readonly direction: FacingDirection; readonly pose: readonly BonePose[] }[];
  readonly clips: readonly SkeletonClip[];
  readonly animation: string | null;
  readonly ik: readonly SkeletonIk[];
  readonly hair: readonly HairChain[];
  readonly colliders: readonly SkeletonCollider[];
}

export interface BoneWeight {
  readonly bone: string;
  readonly weight: number;
}

export interface SpriteSkin {
  readonly columns: number;
  readonly rows: number;
  readonly weights: readonly (readonly BoneWeight[])[];
}

export interface SkeletonPreview {
  readonly time: number;
  readonly clip: string | null;
  readonly direction: FacingDirection;
  readonly pose: readonly BonePose[];
  readonly constraints: 'enabled' | 'disabled';
}

export const SKELETON_LIMITS = {
  bones: 64, clips: 16, frames: 128, ik: 8, hair: 16, colliders: 32,
  name: 120, id: 80, position: 16, rotation: 720, length: 16,
  duration: 60, grid: 32, influences: 4, vertices: 16_384,
} as const;

export class SkeletonError extends Error {}

const JOINT_TOLERANCE = 1e-6;

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new SkeletonError(`${label} must contain exactly ${keys.join(', ')}.`);
  }
  return Object.fromEntries(keys.map(key => [key, Reflect.get(value, key)]));
}

function text(value: unknown, label: string, maximum: number = SKELETON_LIMITS.id): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SkeletonError(`${label} requires nonempty text of at most ${maximum} characters.`);
  }
  return value.trim();
}

function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SkeletonError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new SkeletonError(`${label} allows at most ${maximum} entries.`);
  return value;
}

function unique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) throw new SkeletonError(`${label} contains duplicate "${id}".`);
    seen.add(id);
  }
}

export function validateDirection(value: unknown): FacingDirection {
  for (const direction of FACING_DIRECTIONS) if (direction === value) return direction;
  throw new SkeletonError('Choose one of the eight facing directions.');
}

function pose(value: unknown, ids: ReadonlySet<string>): readonly BonePose[] {
  const result = list(value, SKELETON_LIMITS.bones, 'A bone pose').map(entry => {
    const data = record(entry, ['bone', 'x', 'y', 'rotation'], 'A bone pose');
    const bone = text(data.bone, 'Pose bone');
    if (!ids.has(bone)) throw new SkeletonError(`Pose references missing bone "${bone}".`);
    return Object.freeze({
      bone,
      x: number(data.x, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Pose X'),
      y: number(data.y, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Pose Y'),
      rotation: number(data.rotation, -SKELETON_LIMITS.rotation, SKELETON_LIMITS.rotation, 'Pose rotation'),
    });
  });
  unique(result, item => item.bone, 'Pose');
  return Object.freeze(result);
}

export function fixedJointIds(definition: Pick<SkeletonDefinition, 'ik' | 'hair'>): ReadonlySet<string> {
  return new Set([
    ...definition.ik.flatMap(chain => [chain.lower, chain.hand]),
    ...definition.hair.flatMap(chain => chain.bones.slice(1)),
  ]);
}

export function isTipAttached(child: BoneDefinition, parent: BoneDefinition): boolean {
  return child.parent === parent.id && Math.abs(child.x - parent.length) <= JOINT_TOLERANCE &&
    Math.abs(child.y) <= JOINT_TOLERANCE;
}

function validateJointPose(values: readonly BonePose[], joints: ReadonlySet<string>): void {
  for (const value of values) {
    if (joints.has(value.bone) && (Math.abs(value.x) > JOINT_TOLERANCE || Math.abs(value.y) > JOINT_TOLERANCE)) {
      throw new SkeletonError(`Tip-attached bone "${value.bone}" can rotate, but cannot translate in an IK or hair pose.`);
    }
  }
}

export function validateSkeleton(value: unknown): SkeletonDefinition {
  const data = record(value, ['anchor', 'bones', 'poses', 'clips', 'animation', 'ik', 'hair', 'colliders'], 'A skeleton');
  const bones = list(data.bones, SKELETON_LIMITS.bones, 'Skeleton bones').map(entry => {
    const bone = record(entry, ['id', 'name', 'parent', 'x', 'y', 'rotation', 'length'], 'A bone');
    return Object.freeze({
      id: text(bone.id, 'Bone ID'), name: text(bone.name, 'Bone name', SKELETON_LIMITS.name),
      parent: bone.parent === null ? null : text(bone.parent, 'Parent bone'),
      x: number(bone.x, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Bone X'),
      y: number(bone.y, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Bone Y'),
      rotation: number(bone.rotation, -SKELETON_LIMITS.rotation, SKELETON_LIMITS.rotation, 'Bone rotation'),
      length: number(bone.length, 0.01, SKELETON_LIMITS.length, 'Bone length'),
    });
  });
  if (bones.length === 0) throw new SkeletonError('A skeleton needs at least one bone.');
  unique(bones, bone => bone.id, 'Skeleton');
  const byId = new Map(bones.map(bone => [bone.id, bone]));
  const ids = new Set(byId.keys());
  for (const bone of bones) {
    const ancestors = new Set([bone.id]);
    let parent = bone.parent;
    while (parent !== null) {
      if (ancestors.has(parent)) throw new SkeletonError('Bone parents must not form a cycle.');
      ancestors.add(parent);
      const next = byId.get(parent);
      if (!next) throw new SkeletonError(`Missing parent bone "${parent}".`);
      parent = next.parent;
    }
  }
  const poses = list(data.poses, FACING_DIRECTIONS.length, 'Directional poses').map(entry => {
    const definition = record(entry, ['direction', 'pose'], 'A directional pose');
    return Object.freeze({ direction: validateDirection(definition.direction), pose: pose(definition.pose, ids) });
  });
  unique(poses, entry => entry.direction, 'Directional poses');
  let frameCount = 0;
  const clips = list(data.clips, SKELETON_LIMITS.clips, 'Animation clips').map(entry => {
    const clip = record(entry, ['id', 'name', 'duration', 'loop', 'frames'], 'An animation clip');
    if (typeof clip.loop !== 'boolean') throw new SkeletonError('Animation loop must be enabled or disabled.');
    const duration = number(clip.duration, 0.05, SKELETON_LIMITS.duration, 'Clip duration');
    let previous = -1;
    const frames = list(clip.frames, SKELETON_LIMITS.frames, 'Animation frames').map(entry => {
      const frame = record(entry, ['time', 'pose'], 'An animation frame');
      const time = number(frame.time, 0, duration, 'Frame time');
      if (time <= previous) throw new SkeletonError('Keyframe times must be unique and increasing.');
      previous = time;
      return Object.freeze({ time, pose: pose(frame.pose, ids) });
    });
    if (frames.length === 0) throw new SkeletonError('An animation clip needs at least one keyframe.');
    frameCount += frames.length;
    return Object.freeze({
      id: text(clip.id, 'Clip ID'), name: text(clip.name, 'Clip name', SKELETON_LIMITS.name),
      duration, loop: clip.loop, frames: Object.freeze(frames),
    });
  });
  if (frameCount > SKELETON_LIMITS.frames) throw new SkeletonError('The skeleton exceeds its total keyframe budget.');
  unique(clips, clip => clip.id, 'Animation clips');
  const animation = data.animation === null ? null : text(data.animation, 'Default animation');
  if (animation !== null && !clips.some(clip => clip.id === animation)) throw new SkeletonError('The default animation is missing.');
  const boneId = (value: unknown): string => {
    const id = text(value, 'Bone reference');
    if (!ids.has(id)) throw new SkeletonError(`Missing bone "${id}".`);
    return id;
  };
  const connected = (parent: string, child: string): void => {
    const first = byId.get(parent)!;
    const next = byId.get(child)!;
    if (!isTipAttached(next, first)) {
      throw new SkeletonError(`"${child}" must start at the tip of parent "${parent}" for IK or hair.`);
    }
  };
  const constrained = new Set<string>();
  const ik = list(data.ik, SKELETON_LIMITS.ik, 'IK constraints').map(entry => {
    const constraint = record(entry, ['id', 'upper', 'lower', 'hand', 'target', 'bend', 'mix', 'offsetX', 'offsetY', 'handRotation'], 'An IK constraint');
    const upper = boneId(constraint.upper), lower = boneId(constraint.lower), hand = boneId(constraint.hand);
    connected(upper, lower); connected(lower, hand);
    for (const id of [upper, lower, hand]) {
      if (constrained.has(id)) throw new SkeletonError(`Bone "${id}" belongs to more than one constraint.`);
      constrained.add(id);
    }
    if (constraint.bend !== -1 && constraint.bend !== 1) throw new SkeletonError('IK bend must be -1 or 1.');
    return Object.freeze({
      id: text(constraint.id, 'IK ID'), upper, lower, hand, target: text(constraint.target, 'IK target'),
      bend: constraint.bend,
      mix: number(constraint.mix, 0, 1, 'IK mix'),
      offsetX: number(constraint.offsetX, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Grip offset X'),
      offsetY: number(constraint.offsetY, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Grip offset Y'),
      handRotation: number(constraint.handRotation, -SKELETON_LIMITS.rotation, SKELETON_LIMITS.rotation, 'Hand rotation'),
    });
  });
  unique(ik, entry => entry.id, 'IK constraints');
  const hairBones = new Set<string>();
  const hair = list(data.hair, SKELETON_LIMITS.hair, 'Hair chains').map(entry => {
    const chain = record(entry, ['id', 'bones', 'stiffness', 'damping', 'gravity', 'radius'], 'A hair chain');
    const links = list(chain.bones, SKELETON_LIMITS.bones, 'Hair bones').map(boneId);
    if (links.length === 0) throw new SkeletonError('A hair chain needs at least one bone.');
    for (const [index, id] of links.entries()) {
      if (constrained.has(id)) throw new SkeletonError(`Bone "${id}" belongs to more than one constraint.`);
      constrained.add(id); hairBones.add(id);
      if (index > 0) connected(links[index - 1], id);
    }
    return Object.freeze({
      id: text(chain.id, 'Hair ID'), bones: Object.freeze(links),
      stiffness: number(chain.stiffness, 0, 1, 'Hair stiffness'),
      damping: number(chain.damping, 0, 1, 'Hair damping'),
      gravity: number(chain.gravity, -50, 50, 'Hair gravity'),
      radius: number(chain.radius, 0, 1, 'Hair collision radius'),
    });
  });
  unique(hair, entry => entry.id, 'Hair chains');
  const hasHairAncestor = (id: string): boolean => {
    let parent = byId.get(id)!.parent;
    while (parent !== null) {
      if (hairBones.has(parent)) return true;
      parent = byId.get(parent)!.parent;
    }
    return false;
  };
  for (const chain of ik) {
    if (hasHairAncestor(chain.upper)) throw new SkeletonError('IK chains cannot descend from simulated hair.');
  }
  for (const chain of hair) {
    if (hasHairAncestor(chain.bones[0])) throw new SkeletonError('Separate hair chains cannot descend from other simulated hair. Use one continuous chain.');
  }
  const joints = fixedJointIds({ ik, hair });
  for (const entry of poses) validateJointPose(entry.pose, joints);
  for (const clip of clips) for (const frame of clip.frames) validateJointPose(frame.pose, joints);
  const colliders = list(data.colliders, SKELETON_LIMITS.colliders, 'Hair colliders').map(entry => {
    const collider = record(entry, ['id', 'bone', 'x', 'y', 'radius'], 'A hair collider');
    const bone = boneId(collider.bone);
    if (hairBones.has(bone) || hasHairAncestor(bone)) throw new SkeletonError('Hair colliders must attach outside simulated hair hierarchies.');
    return Object.freeze({
      id: text(collider.id, 'Collider ID'), bone,
      x: number(collider.x, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Collider X'),
      y: number(collider.y, -SKELETON_LIMITS.position, SKELETON_LIMITS.position, 'Collider Y'),
      radius: number(collider.radius, 0.01, SKELETON_LIMITS.length, 'Collider radius'),
    });
  });
  unique(colliders, entry => entry.id, 'Hair colliders');
  return Object.freeze({
    anchor: text(data.anchor, 'Skeleton anchor'),
    bones: Object.freeze(bones), poses: Object.freeze(poses), clips: Object.freeze(clips), animation,
    ik: Object.freeze(ik), hair: Object.freeze(hair), colliders: Object.freeze(colliders),
  });
}

export function validateSkin(value: unknown): SpriteSkin {
  const data = record(value, ['columns', 'rows', 'weights'], 'A weighted sprite mesh');
  const columns = number(data.columns, 1, SKELETON_LIMITS.grid, 'Mesh columns');
  const rows = number(data.rows, 1, SKELETON_LIMITS.grid, 'Mesh rows');
  if (!Number.isInteger(columns) || !Number.isInteger(rows)) throw new SkeletonError('Mesh dimensions must be whole numbers.');
  const weights = list(data.weights, (SKELETON_LIMITS.grid + 1) ** 2, 'Vertex weights').map(entry => {
    const influences = list(entry, SKELETON_LIMITS.influences, 'Bone influences').map(entry => {
      const influence = record(entry, ['bone', 'weight'], 'A bone weight');
      return Object.freeze({ bone: text(influence.bone, 'Weight bone'), weight: number(influence.weight, 0, 1, 'Bone weight') });
    });
    unique(influences, entry => entry.bone, 'Vertex weights');
    if (influences.length === 0 || Math.abs(influences.reduce((sum, value) => sum + value.weight, 0) - 1) > 1e-6) {
      throw new SkeletonError('Each vertex needs 1-4 bone weights totaling 1.');
    }
    return Object.freeze(influences);
  });
  if (weights.length !== (columns + 1) * (rows + 1)) throw new SkeletonError('The weight count must match the mesh grid vertices.');
  return Object.freeze({ columns, rows, weights: Object.freeze(weights) });
}

export function validateSkeletonPreview(value: unknown, skeleton: SkeletonDefinition): SkeletonPreview {
  const data = record(value, ['time', 'clip', 'direction', 'pose', 'constraints'], 'A skeleton preview');
  const clip = data.clip === null ? null : text(data.clip, 'Preview clip');
  if (clip !== null && !skeleton.clips.some(item => item.id === clip)) throw new SkeletonError('The preview clip is missing.');
  if (data.constraints !== 'enabled' && data.constraints !== 'disabled') throw new SkeletonError('Choose enabled or disabled preview constraints.');
  const values = pose(data.pose, new Set(skeleton.bones.map(bone => bone.id)));
  if (data.constraints === 'enabled') validateJointPose(values, fixedJointIds(skeleton));
  return Object.freeze({
    time: number(data.time, 0, SKELETON_LIMITS.duration, 'Preview time'),
    clip, direction: validateDirection(data.direction), pose: values,
    constraints: data.constraints,
  });
}
