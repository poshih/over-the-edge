import { FACING_DIRECTIONS, SKELETON_LIMITS } from './skeleton-data.ts';
import type { FacingDirection, SkeletonDefinition } from './skeleton-data.ts';
import type { SpriteLayer } from './sprite-data.ts';

// Angles are degrees, positive counterclockwise; responseTime is in seconds.
export interface DirectionalRule {
  readonly direction: FacingDirection;
  readonly clockwiseHold: number;
  readonly counterclockwiseHold: number;
  readonly neutralAngle: number;
  readonly minimumRotation: number;
  readonly maximumRotation: number;
  readonly responseTime: number;
}

export interface DirectionalPresentation {
  readonly hysteresis: boolean;
  readonly rotation: boolean;
  // Shared [start, nextStart) sector boundaries in FACING_DIRECTIONS order.
  readonly boundaries: readonly number[];
  readonly directions: readonly DirectionalRule[];
  readonly pivot: { readonly anchor: string; readonly x: number; readonly y: number };
  readonly layers: readonly string[];
  readonly bones: readonly string[];
}

const FULL_TURN = 360;
const HALF_TURN = FULL_TURN / 2;
const DEFAULT_SECTOR = FULL_TURN / FACING_DIRECTIONS.length;
const DEFAULT_HOLD = 7.5;
const DEFAULT_MINIMUM_ROTATION = -12;
const DEFAULT_MAXIMUM_ROTATION = 15;
const DEFAULT_RESPONSE_TIME = 0.12;

export const DIRECTIONAL_LIMITS = Object.freeze({
  angle: FULL_TURN,
  halfTurn: HALF_TURN,
  minimumSector: 0.01,
  epsilon: 1e-9,
  hold: HALF_TURN,
  responseTime: 10,
  pivot: SKELETON_LIMITS.position,
  layers: 256,
  bones: SKELETON_LIMITS.bones,
  id: SKELETON_LIMITS.id,
} as const);

export class DirectionalError extends Error {}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new DirectionalError(`${label} must contain exactly ${keys.join(', ')}.`);
  }
  return Object.fromEntries(keys.map(key => [key, Reflect.get(value, key)]));
}

function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new DirectionalError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function angle(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= FULL_TURN) {
    throw new DirectionalError(`${label} must be at least 0 and less than ${FULL_TURN} degrees.`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > DIRECTIONAL_LIMITS.id ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DirectionalError(`${label} requires nonempty text of at most ${DIRECTIONAL_LIMITS.id} characters.`);
  }
  return value.trim();
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new DirectionalError(`${label} allows at most ${maximum} entries.`);
  }
  return value;
}

function references(value: unknown, maximum: number, label: string): readonly string[] {
  const result = Array.from(list(value, maximum, label), entry => text(entry, label));
  if (new Set(result).size !== result.length) throw new DirectionalError(`${label} must not contain duplicate references.`);
  return Object.freeze(result);
}

export function normalizeDegrees(angle: number): number {
  if (!Number.isFinite(angle)) throw new DirectionalError('An angle must be finite.');
  const remainder = angle % FULL_TURN;
  const positive = remainder < 0 ? remainder + FULL_TURN : remainder;
  return positive === FULL_TURN || positive === 0 ? 0 : positive;
}

// The half-turn tie is clockwise: 180 and -180 both become -180.
export function signedDegrees(angle: number): number {
  const normalized = normalizeDegrees(angle);
  return normalized >= HALF_TURN ? normalized - FULL_TURN : normalized;
}

export function sectorSpan(presentation: DirectionalPresentation, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= FACING_DIRECTIONS.length) {
    throw new DirectionalError('A directional sector index must identify one of the eight directions.');
  }
  return normalizeDegrees(presentation.boundaries[(index + 1) % FACING_DIRECTIONS.length] - presentation.boundaries[index]);
}

export function validateDirectionalPresentation(value: unknown): DirectionalPresentation {
  const data = record(value, ['hysteresis', 'rotation', 'boundaries', 'directions', 'pivot', 'layers', 'bones'],
    'A directional presentation');
  if (typeof data.hysteresis !== 'boolean' || typeof data.rotation !== 'boolean') {
    throw new DirectionalError('Directional hysteresis and rotation must each be enabled or disabled.');
  }
  const starts = list(data.boundaries, FACING_DIRECTIONS.length, 'Directional sector starts');
  const rules = list(data.directions, FACING_DIRECTIONS.length, 'Directional rules');
  if (starts.length !== FACING_DIRECTIONS.length || rules.length !== FACING_DIRECTIONS.length) {
    throw new DirectionalError('A directional presentation needs eight shared sector starts and eight rules in facing-direction order.');
  }
  const boundaries = Array.from(starts, (value, index) => angle(value, `${FACING_DIRECTIONS[index]} sector start`));
  const directions = Array.from(rules, (entry, index): DirectionalRule => {
    const rule = record(entry, ['direction', 'clockwiseHold', 'counterclockwiseHold', 'neutralAngle',
      'minimumRotation', 'maximumRotation', 'responseTime'], 'A directional rule');
    const direction = FACING_DIRECTIONS[index];
    if (rule.direction !== direction) {
      throw new DirectionalError(`Directional rule ${index + 1} must be "${direction}"; rules must follow facing-direction order.`);
    }
    return Object.freeze({
      direction,
      clockwiseHold: number(rule.clockwiseHold, 0, DIRECTIONAL_LIMITS.hold, `${direction} clockwise hold`),
      counterclockwiseHold: number(rule.counterclockwiseHold, 0, DIRECTIONAL_LIMITS.hold, `${direction} counterclockwise hold`),
      neutralAngle: angle(rule.neutralAngle, `${direction} neutral angle`),
      minimumRotation: number(rule.minimumRotation, -HALF_TURN, 0, `${direction} minimum rotation`),
      maximumRotation: number(rule.maximumRotation, 0, HALF_TURN, `${direction} maximum rotation`),
      responseTime: number(rule.responseTime, 0, DIRECTIONAL_LIMITS.responseTime, `${direction} response time`),
    });
  });
  const pivot = record(data.pivot, ['anchor', 'x', 'y'], 'A directional pivot');
  const presentation: DirectionalPresentation = {
    hysteresis: data.hysteresis,
    rotation: data.rotation,
    boundaries: Object.freeze(boundaries),
    directions: Object.freeze(directions),
    pivot: Object.freeze({
      anchor: text(pivot.anchor, 'Directional pivot anchor'),
      x: number(pivot.x, -DIRECTIONAL_LIMITS.pivot, DIRECTIONAL_LIMITS.pivot, 'Directional pivot X'),
      y: number(pivot.y, -DIRECTIONAL_LIMITS.pivot, DIRECTIONAL_LIMITS.pivot, 'Directional pivot Y'),
    }),
    layers: references(data.layers, DIRECTIONAL_LIMITS.layers, 'Directional layers'),
    bones: references(data.bones, DIRECTIONAL_LIMITS.bones, 'Directional bones'),
  };
  let coverage = 0;
  for (const [index, rule] of directions.entries()) {
    const span = sectorSpan(presentation, index);
    if (span + DIRECTIONAL_LIMITS.epsilon < DIRECTIONAL_LIMITS.minimumSector) {
      throw new DirectionalError(`${rule.direction} selection sector must span at least ${DIRECTIONAL_LIMITS.minimumSector} degrees.`);
    }
    coverage += span;
    if (span + rule.clockwiseHold + rule.counterclockwiseHold >= FULL_TURN) {
      throw new DirectionalError(`${rule.direction} hold sector must span less than ${FULL_TURN} degrees, including both hold margins.`);
    }
  }
  if (Math.abs(coverage - FULL_TURN) > DIRECTIONAL_LIMITS.epsilon) {
    throw new DirectionalError('Directional sector starts must make exactly one counterclockwise turn in facing-direction order, without overlaps or reordering.');
  }
  return Object.freeze(presentation);
}

// Call after validating the layer and skeleton definitions.
export function validateDirectionalReferences(
  presentation: DirectionalPresentation | null,
  layers: readonly SpriteLayer[],
  skeleton: SkeletonDefinition | null,
): void {
  if (presentation === null) return;
  const layersById = new Map(layers.map(layer => [layer.id, layer]));
  for (const id of presentation.layers) {
    const layer = layersById.get(id);
    if (layer === undefined) throw new DirectionalError(`Directional presentation references missing layer "${id}".`);
    if (layer.bone !== null || layer.skin !== null) {
      throw new DirectionalError(`Directional layer "${id}" must be unbound and unweighted. Rotate its owning bone instead.`);
    }
  }
  if (presentation.bones.length === 0) return;
  if (skeleton === null) throw new DirectionalError('Directional bones require a skeleton.');
  const bonesById = new Map(skeleton.bones.map(bone => [bone.id, bone]));
  const selected = new Set(presentation.bones);
  const hair = new Set(skeleton.hair.flatMap(chain => chain.bones));
  for (const id of selected) {
    const bone = bonesById.get(id);
    if (bone === undefined) throw new DirectionalError(`Directional presentation references missing bone "${id}".`);
    if (hair.has(id)) {
      throw new DirectionalError(`Directional bone "${id}" is simulated hair. Select its head or attachment owner instead.`);
    }
    let parent = bone.parent;
    while (parent !== null) {
      if (hair.has(parent)) {
        throw new DirectionalError(`Directional bone "${id}" descends from simulated hair. Select the head or attachment owner above the chain.`);
      }
      if (selected.has(parent)) {
        throw new DirectionalError(`Directional bones "${parent}" and "${id}" overlap. Select each subtree only once.`);
      }
      parent = bonesById.get(parent)!.parent;
    }
  }
  for (const chain of skeleton.ik) {
    // A validated IK hand descends through both lower and upper arm bones.
    let owner: string | null = chain.hand;
    while (owner !== null) {
      if (selected.has(owner)) {
        throw new DirectionalError(`Directional bone "${owner}" owns IK chain "${chain.id}". Select a subtree outside the IK chain.`);
      }
      owner = bonesById.get(owner)!.parent;
    }
  }
}

export function createDirectionalPresentation(anchor: string): DirectionalPresentation {
  return validateDirectionalPresentation({
    hysteresis: false,
    rotation: false,
    boundaries: FACING_DIRECTIONS.map((_, index) => normalizeDegrees((index - 0.5) * DEFAULT_SECTOR)),
    directions: FACING_DIRECTIONS.map((direction, index) => ({
      direction,
      clockwiseHold: DEFAULT_HOLD,
      counterclockwiseHold: DEFAULT_HOLD,
      neutralAngle: index * DEFAULT_SECTOR,
      minimumRotation: DEFAULT_MINIMUM_ROTATION,
      maximumRotation: DEFAULT_MAXIMUM_ROTATION,
      responseTime: DEFAULT_RESPONSE_TIME,
    })),
    pivot: { anchor, x: 0, y: 0 },
    layers: [],
    bones: [],
  });
}
