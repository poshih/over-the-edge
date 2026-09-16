import { RIG } from './config';
import type { PlayerSpawn, Point } from './config';
import { transformPoint } from './math';

export const LEVEL_LIMITS = {
  objects: 1000,
  geometryKinds: 32,
  polygonVertices: 64,
  labels: 16,
  text: 80,
  coordinate: 2048,
  minimumSize: 0.25,
  maximumSize: 128,
  minimumDepth: 0.1,
  maximumDepth: 8,
  fileBytes: 4 * 1024 * 1024,
} as const;

export const ILLUSION = { fadeSeconds: 0.8, minimumTopNormal: 0.5 } as const;
export const ROCK_COLOR = 0x71817a;
export const SHAPE_KINDS = ['box', 'ramp', 'triangle', 'circle', 'hexagon'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type LevelShape = { readonly type: ShapeKind } |
  { readonly type: 'polygon'; readonly vertices: readonly Readonly<Point>[] };

export interface LevelObject {
  readonly id: string;
  readonly shape: LevelShape;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly depth: number;
  readonly color: number;
  readonly illusion: boolean;
}

export interface Summit {
  readonly xMin: number;
  readonly xMax: number;
  readonly y: number;
  readonly arrivalTolerance: number;
}

export interface LevelLabel extends Readonly<Point> {
  readonly text: string;
}

export interface LevelDefinition {
  readonly schemaVersion: 1;
  readonly spawn: Readonly<PlayerSpawn>;
  readonly summit: Summit;
  readonly labels: readonly LevelLabel[];
  readonly objects: readonly LevelObject[];
}

export interface LevelChange {
  readonly kind: 'replace' | 'edit';
  readonly level: LevelDefinition;
  readonly upsert: readonly LevelObject[];
  readonly remove: readonly string[];
}

export type TerrainEvent =
  | { readonly type: 'reset'; readonly objects: readonly LevelObject[] }
  | { readonly type: 'upsert'; readonly object: LevelObject }
  | { readonly type: 'remove' | 'disappear'; readonly id: string }
  | { readonly type: 'fade'; readonly id: string; readonly startedAt: number };

const SHAPE_VERTICES: Record<ShapeKind, readonly Readonly<Point>[]> = {
  box: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }],
  ramp: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }],
  triangle: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0, y: 0.5 }],
  circle: Array.from({ length: 32 }, (_, index) => ({
    x: Math.cos(index * Math.PI / 16) / 2, y: Math.sin(index * Math.PI / 16) / 2,
  })),
  hexagon: [{ x: 0.5, y: 0 }, { x: 0.25, y: 0.5 }, { x: -0.25, y: 0.5 },
    { x: -0.5, y: 0 }, { x: -0.25, y: -0.5 }, { x: 0.25, y: -0.5 }],
};

for (const vertices of Object.values(SHAPE_VERTICES)) {
  for (const vertex of vertices) Object.freeze(vertex);
  Object.freeze(vertices);
}

export class LevelError extends Error {}

function fields(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new LevelError(`${label} contains missing or unknown fields.`);
  }
}

function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new LevelError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function point(value: unknown, range: number, label: string): Readonly<Point> {
  fields(value, ['x', 'y'], label);
  return Object.freeze({
    x: number(value.x, -range, range, `${label} X`),
    y: number(value.y, -range, range, `${label} Y`),
  });
}

function cross(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Point>): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Readonly<Point>, b: Readonly<Point>, p: Readonly<Point>): boolean {
  return Math.abs(cross(a, b, p)) < 1e-10 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

function polygon(value: unknown): readonly Readonly<Point>[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > LEVEL_LIMITS.polygonVertices) {
    throw new LevelError(`A polygon needs 3 to ${LEVEL_LIMITS.polygonVertices} vertices.`);
  }
  const vertices = value.map((entry) => point(entry, 0.5, 'Polygon vertex'));
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-5) throw new LevelError('Polygon edges must have nonzero length.');
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 1; j < vertices.length; j++) {
      if (j === i + 1 || (i === 0 && j === vertices.length - 1)) continue;
      const c = vertices[j];
      const d = vertices[(j + 1) % vertices.length];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
        onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) {
        throw new LevelError('Polygon edges cannot cross or overlap.');
      }
    }
  }
  if (area <= 1e-5) throw new LevelError('Polygon vertices must enclose an area in counterclockwise order.');
  return Object.freeze(vertices);
}

export function shapeVertices(shape: LevelShape): readonly Readonly<Point>[] {
  return shape.type === 'polygon' ? shape.vertices : SHAPE_VERTICES[shape.type];
}

export function geometryKey(shape: LevelShape): string {
  return shape.type === 'polygon' ? `polygon:${JSON.stringify(shape.vertices)}` : shape.type;
}

export function objectVertices(object: LevelObject): Point[] {
  return shapeVertices(object.shape).map((vertex) =>
    transformPoint({ x: vertex.x * object.width, y: vertex.y * object.height }, object, object.angle));
}

export function objectContains(object: LevelObject, position: Point): boolean {
  const local = transformPoint({ x: position.x - object.x, y: position.y - object.y }, { x: 0, y: 0 }, -object.angle);
  const p = { x: local.x / object.width, y: local.y / object.height };
  if (Math.abs(p.x) > 0.5 || Math.abs(p.y) > 0.5) return false;
  if (object.shape.type === 'circle') return p.x ** 2 + p.y ** 2 <= 0.25;
  const vertices = shapeVertices(object.shape);
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[j];
    const b = vertices[i];
    if (onSegment(a, b, p)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function validateLevelObject(value: unknown): LevelObject {
  fields(value, ['id', 'shape', 'x', 'y', 'width', 'height', 'angle', 'depth', 'color', 'illusion'], 'Level object');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id)) {
    throw new LevelError('Object IDs must be unique letters, numbers, hyphens or underscores, up to 64 characters.');
  }
  const raw = value.shape;
  if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'type')) throw new LevelError('Choose a supported shape.');
  const type: unknown = Reflect.get(raw, 'type');
  let shape: LevelShape;
  if (type === 'polygon') {
    fields(raw, ['type', 'vertices'], 'Polygon shape');
    shape = Object.freeze({ type, vertices: polygon(raw.vertices) });
  } else {
    fields(raw, ['type'], 'Shape');
    const kind = SHAPE_KINDS.find((candidate) => candidate === type);
    if (kind === undefined) throw new LevelError('Choose a supported shape.');
    shape = Object.freeze({ type: kind });
  }
  const width = number(value.width, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Width');
  const height = number(value.height, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Height');
  if (shape.type === 'circle' && width !== height) throw new LevelError('A circle must have equal width and height.');
  if (typeof value.illusion !== 'boolean') throw new LevelError('Illusion must be enabled or disabled.');
  const color = number(value.color, 0, 0xffffff, 'Rock color');
  if (!Number.isInteger(color)) throw new LevelError('Rock color must be a whole RGB value.');
  return Object.freeze({
    id: value.id, shape,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Position X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Position Y'),
    width, height, angle: number(value.angle, -Math.PI, Math.PI, 'Rotation'),
    depth: number(value.depth, LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth, 'Depth'),
    color, illusion: value.illusion,
  });
}

export function validateLevelMetadata(value: unknown): Pick<LevelDefinition, 'spawn' | 'summit' | 'labels'> {
  fields(value, ['spawn', 'summit', 'labels'], 'Level settings');
  fields(value.spawn, ['position', 'angle', 'extension'], 'Player start');
  const spawn = Object.freeze({
    position: point(value.spawn.position, LEVEL_LIMITS.coordinate, 'Player start'),
    angle: number(value.spawn.angle, -Math.PI, Math.PI, 'Starting hammer angle'),
    extension: number(value.spawn.extension, RIG.minExtension, RIG.maxExtension, 'Starting extension'),
  });
  fields(value.summit, ['xMin', 'xMax', 'y', 'arrivalTolerance'], 'Summit');
  const summit = Object.freeze({
    xMin: number(value.summit.xMin, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Summit left'),
    xMax: number(value.summit.xMax, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Summit right'),
    y: number(value.summit.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Summit height'),
    arrivalTolerance: number(value.summit.arrivalTolerance, 0, 0.25, 'Summit tolerance'),
  });
  if (summit.xMax <= summit.xMin) throw new LevelError('The summit right edge must be to the right of its left edge.');
  if (!Array.isArray(value.labels) || value.labels.length > LEVEL_LIMITS.labels) throw new LevelError('Too many course labels.');
  const labels = value.labels.map((label): LevelLabel => {
    fields(label, ['x', 'y', 'text'], 'Course label');
    if (typeof label.text !== 'string' || !label.text.trim() || label.text.length > LEVEL_LIMITS.text) {
      throw new LevelError(`Course labels need 1 to ${LEVEL_LIMITS.text} characters.`);
    }
    return Object.freeze({
      x: number(label.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Label X'),
      y: number(label.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Label Y'),
      text: label.text,
    });
  });
  return { spawn, summit, labels: Object.freeze(labels) };
}

export function validateLevel(value: unknown): LevelDefinition {
  fields(value, ['schemaVersion', 'spawn', 'summit', 'labels', 'objects'], 'Level');
  if (value.schemaVersion !== 1) throw new LevelError('This level format is not supported.');
  const metadata = validateLevelMetadata({ spawn: value.spawn, summit: value.summit, labels: value.labels });
  if (!Array.isArray(value.objects) || value.objects.length > LEVEL_LIMITS.objects) {
    throw new LevelError(`A level supports up to ${LEVEL_LIMITS.objects} objects.`);
  }
  const objects = value.objects.map(validateLevelObject);
  if (new Set(objects.map((object) => object.id)).size !== objects.length) throw new LevelError('Every object needs a unique ID.');
  if (new Set(objects.map((object) => geometryKey(object.shape))).size > LEVEL_LIMITS.geometryKinds) {
    throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct geometry templates.`);
  }
  return Object.freeze({ schemaVersion: 1, ...metadata, objects: Object.freeze(objects) });
}
