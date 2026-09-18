import { RIG } from './config';
import type { PlayerSpawn, Point } from './config';
import { transformPoint } from './math';
import { upgradeLevelV1 } from './level-migration';
import { fields, LevelError, number, point, text } from './level-validation';
import type { TriggerAction } from './trigger-events';
import { LAUNCH_FIELDS } from './trigger-events';
import { ENEMY_FACINGS, ENEMY_FIELDS, ENEMY_LIMITS, ENEMY_SPECIES } from './enemy-types';
import type { EnemyFacing, EnemySpecies } from './enemy-types';

export { LevelError } from './level-validation';
export type { TriggerAction } from './trigger-events';

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
export const TRIGGER_LIMITS = {
  objects: 128,
  events: 8,
  title: 120,
  message: 2000,
  source: 2048,
  coordinate: LEVEL_LIMITS.coordinate + LEVEL_LIMITS.maximumSize,
  maximumSize: LEVEL_LIMITS.coordinate * 2,
  exitMargin: 0.08,
  endingHeight: RIG.maxReach * 2,
} as const;
export const LEVEL_OBJECT_LIMIT = LEVEL_LIMITS.objects + TRIGGER_LIMITS.objects + ENEMY_LIMITS.objects + 1;
export const TRIGGER_MARKERS = ['none', 'flag', 'updraft'] as const;
export const ROCK_COLOR = 0x71817a;
export const SHAPE_KINDS = ['box', 'ramp', 'triangle', 'circle', 'hexagon'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type LevelShape = { readonly type: ShapeKind } |
  { readonly type: 'polygon'; readonly vertices: readonly Readonly<Point>[] };

export interface TerrainObject {
  readonly kind: 'terrain';
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

export interface StartObject extends Readonly<Point> {
  readonly kind: 'start';
  readonly id: string;
  readonly angle: number;
  readonly extension: number;
}

export type TriggerRegion =
  | { readonly type: 'circle'; readonly radius: number }
  | { readonly type: 'box'; readonly width: number; readonly height: number };

export interface TriggerObject extends Readonly<Point> {
  readonly kind: 'trigger';
  readonly id: string;
  readonly name: string;
  readonly region: TriggerRegion;
  readonly activation: 'once' | 'on-enter';
  readonly marker: (typeof TRIGGER_MARKERS)[number];
  readonly events: readonly TriggerAction[];
}

export interface EnemyObject extends Readonly<Point> {
  readonly kind: 'enemy';
  readonly id: string;
  readonly species: EnemySpecies;
  readonly facing: EnemyFacing;
  readonly patrolDistance: number;
  readonly speed: number;
}

export type LevelObject = TerrainObject | StartObject | TriggerObject | EnemyObject;

export interface LevelLabel extends Readonly<Point> {
  readonly text: string;
}

export interface LevelDefinition {
  readonly schemaVersion: 2;
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
  | { readonly type: 'reset'; readonly objects: readonly TerrainObject[] }
  | { readonly type: 'upsert'; readonly object: TerrainObject }
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
const MIN_POLYGON_AREA = 5e-6;

for (const vertices of Object.values(SHAPE_VERTICES)) {
  for (const vertex of vertices) Object.freeze(vertex);
  Object.freeze(vertices);
}

function cross(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Point>): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Readonly<Point>, b: Readonly<Point>, p: Readonly<Point>): boolean {
  return Math.abs(cross(a, b, p)) < 1e-10 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

function polygonArea(vertices: readonly Readonly<Point>[]): number {
  let area = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function polygon(value: unknown): readonly Readonly<Point>[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > LEVEL_LIMITS.polygonVertices) {
    throw new LevelError(`A polygon needs 3 to ${LEVEL_LIMITS.polygonVertices} vertices.`);
  }
  const vertices = value.map((entry) => point(entry, 0.5, 'Polygon vertex'));
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-5) throw new LevelError('Polygon edges must have nonzero length.');
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
  if (polygonArea(vertices) <= MIN_POLYGON_AREA) throw new LevelError('Polygon vertices must enclose an area in counterclockwise order.');
  return Object.freeze(vertices);
}

export function terrainFromOutline(
  outline: Pick<TerrainObject, 'id' | 'color' | 'depth'> & { readonly vertices: readonly Readonly<Point>[] },
): TerrainObject {
  if (outline.vertices.length < 3 || outline.vertices.length > LEVEL_LIMITS.polygonVertices) {
    throw new LevelError(`An outline needs 3 to ${LEVEL_LIMITS.polygonVertices} points.`);
  }
  const minX = Math.min(...outline.vertices.map((vertex) => vertex.x));
  const maxX = Math.max(...outline.vertices.map((vertex) => vertex.x));
  const minY = Math.min(...outline.vertices.map((vertex) => vertex.y));
  const maxY = Math.max(...outline.vertices.map((vertex) => vertex.y));
  const width = number(maxX - minX, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Polygon width');
  const height = number(maxY - minY, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Polygon height');
  // Min-relative normalization keeps both extrema exactly inside the shape's [-0.5, 0.5] bounds.
  const vertices = outline.vertices.map((vertex) => ({
    x: (vertex.x - minX) / width - 0.5, y: (vertex.y - minY) / height - 0.5,
  }));
  if (polygonArea(vertices) < 0) vertices.reverse();
  return validateTerrain({
    kind: 'terrain', id: outline.id, shape: { type: 'polygon', vertices },
    x: (minX + maxX) / 2, y: (minY + maxY) / 2, width, height, angle: 0,
    color: outline.color, depth: outline.depth, illusion: false,
  });
}

export function shapeVertices(shape: LevelShape): readonly Readonly<Point>[] {
  return shape.type === 'polygon' ? shape.vertices : SHAPE_VERTICES[shape.type];
}

export function geometryKey(shape: LevelShape): string {
  return shape.type === 'polygon' ? `polygon:${JSON.stringify(shape.vertices)}` : shape.type;
}

export function objectVertices(object: TerrainObject): Point[] {
  return shapeVertices(object.shape).map((vertex) =>
    transformPoint({ x: vertex.x * object.width, y: vertex.y * object.height }, object, object.angle));
}

export function objectContains(object: TerrainObject, position: Point): boolean {
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

function objectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new LevelError('Object IDs must be unique letters, numbers, hyphens or underscores, up to 64 characters.');
  }
  return value;
}

export function validateLevelObject(value: unknown): LevelObject {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'kind')) {
    throw new LevelError('Choose a terrain, start, trigger, or enemy object.');
  }
  const kind: unknown = Reflect.get(value, 'kind');
  if (kind === 'start') {
    fields(value, ['kind', 'id', 'x', 'y', 'angle', 'extension'], 'Start object');
    return Object.freeze({
      kind, id: objectId(value.id),
      x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Start X'),
      y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Start Y'),
      angle: number(value.angle, -Math.PI, Math.PI, 'Starting hammer angle'),
      extension: number(value.extension, RIG.minExtension, RIG.maxExtension, 'Starting extension'),
    });
  }
  if (kind === 'trigger') return validateTrigger(value);
  if (kind === 'enemy') return validateEnemy(value);
  if (kind !== 'terrain') throw new LevelError('Choose a terrain, start, trigger, or enemy object.');
  return validateTerrain(value);
}

function validateEnemy(value: unknown): EnemyObject {
  fields(value, ['kind', 'id', 'species', 'x', 'y', 'facing', 'patrolDistance', 'speed'], 'Enemy object');
  const species = ENEMY_SPECIES.find((candidate) => candidate === value.species);
  const facing = ENEMY_FACINGS.find((candidate) => candidate === value.facing);
  if (species === undefined) throw new LevelError('Choose a bird or hollow soldier.');
  if (facing === undefined) throw new LevelError('Choose a left or right starting direction.');
  return Object.freeze({
    kind: 'enemy', id: objectId(value.id), species, facing,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Enemy X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Enemy Y'),
    patrolDistance: number(value.patrolDistance, ENEMY_FIELDS.patrolDistance.min, ENEMY_FIELDS.patrolDistance.max, ENEMY_FIELDS.patrolDistance.label),
    speed: number(value.speed, ENEMY_FIELDS.speed.min, ENEMY_FIELDS.speed.max, ENEMY_FIELDS.speed.label),
  });
}

function validateTerrain(value: unknown): TerrainObject {
  fields(value, ['kind', 'id', 'shape', 'x', 'y', 'width', 'height', 'angle', 'depth', 'color', 'illusion'], 'Terrain object');
  const id = objectId(value.id);
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
    kind: 'terrain', id, shape,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Position X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Position Y'),
    width, height, angle: number(value.angle, -Math.PI, Math.PI, 'Rotation'),
    depth: number(value.depth, LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth, 'Depth'),
    color, illusion: value.illusion,
  });
}

export function validateLevelMetadata(value: unknown): Pick<LevelDefinition, 'labels'> {
  fields(value, ['labels'], 'Level settings');
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
  return { labels: Object.freeze(labels) };
}

export function validateLevel(value: unknown): LevelDefinition {
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'schemaVersion') === 1) {
    value = upgradeLevelV1(value, { coordinate: LEVEL_LIMITS.coordinate, objects: LEVEL_LIMITS.objects, endingHeight: TRIGGER_LIMITS.endingHeight });
  }
  fields(value, ['schemaVersion', 'labels', 'objects'], 'Level');
  if (value.schemaVersion !== 2) throw new LevelError('This level format is not supported.');
  const metadata = validateLevelMetadata({ labels: value.labels });
  if (!Array.isArray(value.objects) || value.objects.length > LEVEL_OBJECT_LIMIT) {
    throw new LevelError(`A level supports ${LEVEL_LIMITS.objects} terrain objects, ${TRIGGER_LIMITS.objects} triggers, ${ENEMY_LIMITS.objects} enemies, and one start.`);
  }
  const objects = value.objects.map(validateLevelObject);
  if (new Set(objects.map((object) => object.id)).size !== objects.length) throw new LevelError('Every object needs a unique ID.');
  if (objects.filter((object) => object.kind === 'start').length !== 1) throw new LevelError('A level needs exactly one start location.');
  const terrain = objects.filter(isTerrainObject);
  if (terrain.length > LEVEL_LIMITS.objects) throw new LevelError(`A level supports up to ${LEVEL_LIMITS.objects} terrain objects.`);
  if (objects.filter(isTriggerObject).length > TRIGGER_LIMITS.objects) throw new LevelError(`A level supports up to ${TRIGGER_LIMITS.objects} triggers.`);
  if (objects.filter(isEnemyObject).length > ENEMY_LIMITS.objects) throw new LevelError(`A level supports up to ${ENEMY_LIMITS.objects} enemies.`);
  if (new Set(terrain.map((object) => geometryKey(object.shape))).size > LEVEL_LIMITS.geometryKinds) {
    throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct geometry templates.`);
  }
  return Object.freeze({ schemaVersion: 2, ...metadata, objects: Object.freeze(objects) });
}

function validateTrigger(value: unknown): TriggerObject {
  fields(value, ['kind', 'id', 'x', 'y', 'name', 'region', 'activation', 'marker', 'events'], 'Trigger object');
  const raw = value.region;
  if (typeof raw !== 'object' || raw === null) throw new LevelError('Choose a circle or box trigger region.');
  const type: unknown = Reflect.get(raw, 'type');
  let region: TriggerRegion;
  if (type === 'circle') {
    fields(raw, ['type', 'radius'], 'Circle region');
    region = Object.freeze({ type, radius: number(raw.radius, Number.MIN_VALUE, TRIGGER_LIMITS.maximumSize / 2, 'Trigger radius') });
  } else if (type === 'box') {
    fields(raw, ['type', 'width', 'height'], 'Box region');
    region = Object.freeze({
      type,
      width: number(raw.width, Number.MIN_VALUE, TRIGGER_LIMITS.maximumSize, 'Trigger width'),
      height: number(raw.height, Number.MIN_VALUE, TRIGGER_LIMITS.maximumSize, 'Trigger height'),
    });
  } else throw new LevelError('Choose a circle or box trigger region.');
  if (value.activation !== 'once' && value.activation !== 'on-enter') throw new LevelError('Choose once per run or on each entry.');
  const marker = TRIGGER_MARKERS.find((candidate) => candidate === value.marker);
  if (marker === undefined) throw new LevelError('Choose no marker, a flag, or an updraft.');
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > TRIGGER_LIMITS.events) {
    throw new LevelError(`A trigger needs 1 to ${TRIGGER_LIMITS.events} events.`);
  }
  return Object.freeze({
    kind: 'trigger', id: objectId(value.id), name: text(value.name, LEVEL_LIMITS.text, 'Trigger name'),
    x: number(value.x, -TRIGGER_LIMITS.coordinate, TRIGGER_LIMITS.coordinate, 'Trigger X'),
    y: number(value.y, -TRIGGER_LIMITS.coordinate, TRIGGER_LIMITS.coordinate, 'Trigger Y'),
    region, activation: value.activation, marker,
    events: Object.freeze(value.events.map(validateTriggerAction)),
  });
}

export function validateTriggerAction(value: unknown): TriggerAction {
  if (typeof value !== 'object' || value === null) throw new LevelError('Choose a supported trigger event.');
  const type: unknown = Reflect.get(value, 'type');
  if (type === 'stop-timer') {
    fields(value, ['type'], 'Stop timer event');
    return Object.freeze({ type });
  }
  if (type === 'launch-player') {
    fields(value, ['type', 'height', 'strength'], 'Launch player event');
    return Object.freeze({
      type,
      height: number(value.height, LAUNCH_FIELDS.height.min, LAUNCH_FIELDS.height.max, LAUNCH_FIELDS.height.label),
      strength: number(value.strength, LAUNCH_FIELDS.strength.min, LAUNCH_FIELDS.strength.max, LAUNCH_FIELDS.strength.label),
    });
  }
  if (type === 'popup') {
    fields(value, ['type', 'title', 'message'], 'Popup event');
    return Object.freeze({
      type, title: text(value.title, TRIGGER_LIMITS.title, 'Popup title'),
      message: text(value.message, TRIGGER_LIMITS.message, 'Popup message'),
    });
  }
  if (type === 'play-video') {
    fields(value, ['type', 'source'], 'Video event');
    const source = text(value.source, TRIGGER_LIMITS.source, 'Video source').trim();
    let url: URL;
    try {
      url = new URL(source, 'https://level.invalid');
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new LevelError('Use an HTTP(S) video URL or a site-relative /media/video path.');
    }
    const local = source.startsWith('/') && !source.startsWith('//') && url.origin === 'https://level.invalid';
    const remote = /^https?:\/\//i.test(source) && (url.protocol === 'https:' || url.protocol === 'http:');
    if ((!local && !remote) || url.username || url.password) throw new LevelError('Use an HTTP(S) video URL without credentials, or a site-relative /media/video path.');
    return Object.freeze({ type, source });
  }
  throw new LevelError('Choose popup, play video, stop timer, or launch player.');
}

export function isTerrainObject(object: LevelObject): object is TerrainObject { return object.kind === 'terrain'; }
export function isTriggerObject(object: LevelObject): object is TriggerObject { return object.kind === 'trigger'; }
export function isEnemyObject(object: LevelObject): object is EnemyObject { return object.kind === 'enemy'; }

export function levelStart(level: LevelDefinition): StartObject {
  const start = level.objects.find((object): object is StartObject => object.kind === 'start');
  if (!start) throw new Error('Validated levels must contain a start location.');
  return start;
}

export function levelSpawn(level: LevelDefinition): Readonly<PlayerSpawn> {
  const start = levelStart(level);
  return { position: { x: start.x, y: start.y }, angle: start.angle, extension: start.extension };
}

export function triggerBounds(object: TriggerObject) {
  const halfWidth = object.region.type === 'circle' ? object.region.radius : object.region.width / 2;
  const halfHeight = object.region.type === 'circle' ? object.region.radius : object.region.height / 2;
  return { minX: object.x - halfWidth, maxX: object.x + halfWidth, minY: object.y - halfHeight, maxY: object.y + halfHeight };
}

export function triggerContains(object: TriggerObject, position: Readonly<Point>, margin = 0): boolean {
  const dx = position.x - object.x;
  const dy = position.y - object.y;
  return object.region.type === 'circle'
    ? dx * dx + dy * dy <= (object.region.radius + margin) ** 2
    : Math.abs(dx) <= object.region.width / 2 + margin && Math.abs(dy) <= object.region.height / 2 + margin;
}
