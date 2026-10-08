import type { PlayerSpawn, Point } from './config';
import { transformPoint } from './math';
import { fields, LevelError, number, point, text } from './level-validation';
import { MAX_RIG_REACH } from './rig';
import type { TriggerAction } from './trigger-events';
import { FIRE_TRAP_FIELDS, LAUNCH_FIELDS, PLATFORM_DESTINATIONS, SOUND_VOLUME } from './trigger-events';
import { ENEMY_FACINGS, ENEMY_FIELDS, ENEMY_LIMITS, ENEMY_SPECIES } from './enemy-types';
import type { EnemyFacing, EnemySpecies } from './enemy-types';
import { AXE_FIELDS, HAZARD_LIMITS, SHOOTER_FIELDS } from './hazards';
import { LIQUID_LIMITS, LIQUIDS } from './liquids';
import type { Liquid } from './liquids';
import { ArtError, artId } from './art-types';
import { isSurface, SURFACES } from './surfaces';
import type { Surface } from './surfaces';

export { LevelError } from './level-validation';
export type { TriggerAction } from './trigger-events';

export const LEVEL_SCHEMA_VERSION = 10;
export const LEVEL_LIMITS = {
  objects: 1000,
  // Distinct collision geometry across a level's terrain: one physics shape and one extruded template each.
  geometryKinds: 64,
  // Points of a drawn outline, and of each loop of a mesh's slice or projection.
  polygonVertices: 64,
  // A mesh's slice or projection: its loops, and their points together.
  meshLoops: 16,
  meshPoints: 256,
  labels: 16,
  text: 80,
  coordinate: 2048,
  minimumSize: 0.25,
  maximumSize: 128,
  minimumDepth: 0.1,
  maximumDepth: 8,
  fileBytes: 8 * 1024 * 1024,
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
  // The default height of an ending zone above its summit.
  endingHeight: 5.3,
} as const;
// Decorations are scenery only: they never collide, and depth places them anywhere from the far
// background (negative) to just in front of the course (positive, toward the camera).
export const DECORATION_LIMITS = {
  objects: 1000,
  back: 1000,
  front: 15,
  minimumHeight: 0.1,
  maximumHeight: 1000,
  modelId: 40,
} as const;
export const DECORATION_MODEL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PLATFORM_LIMITS = {
  objects: 64,
  minimumWidth: 0.5,
  maximumWidth: 20,
  minimumHeight: 0.1,
  maximumHeight: 4,
  minimumSpeed: 0.1,
  maximumSpeed: 10,
  maximumTravel: 200,
} as const;
export const LEVEL_OBJECT_LIMIT = LEVEL_LIMITS.objects + TRIGGER_LIMITS.objects + ENEMY_LIMITS.objects + DECORATION_LIMITS.objects +
  HAZARD_LIMITS.bonfires + HAZARD_LIMITS.traps + LIQUID_LIMITS.pools + PLATFORM_LIMITS.objects + 1;
export const TRIGGER_MARKERS = ['none', 'flag', 'updraft', 'switch'] as const;
export const ROCK_COLOR = 0x71817a;
// The simple outlines the engine knows, each filling the unit box: the built-in meshes, and the collision types a mesh
// may declare.
export const SHAPE_KINDS = ['box', 'ramp', 'triangle', 'circle', 'hexagon'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
// A closed outline in a terrain object's unit box, [-0.5, 0.5] on both axes, before it is sized, mirrored, turned and
// placed.
export type Outline = readonly Readonly<Point>[];

/**
 * How a mesh collides: the simple shape it declares, fitted to its box, or outlines generated from the mesh
 * (src/mesh-collision.ts): its slice, its cross-section on the obstacle line, unless it declares its projection, its
 * silhouette seen along the view. Their loops keep the solid on each edge's left, so outer loops run counterclockwise
 * and holes clockwise.
 */
export type MeshCollision =
  | { readonly type: ShapeKind }
  | { readonly type: MeshOutlines; readonly loops: readonly Outline[] };

// How a mesh's collision outlines are generated: its slice or its projection.
export const MESH_OUTLINES = ['slice', 'projection'] as const;
export type MeshOutlines = (typeof MESH_OUTLINES)[number];

/** What a terrain object is: a mesh, which draws it and brings its collision. */
export type TerrainMesh =
  // A built-in mesh: the shape extruded, colliding as the shape.
  | { readonly type: 'shape'; readonly shape: ShapeKind }
  // A drawn outline extruded, colliding as the outline: counterclockwise, normalized to the unit box.
  | { readonly type: 'outline'; readonly vertices: Outline }
  // A GLB from the course's meshes, its artwork assets, with the collision it declares or its slice.
  | { readonly type: 'asset'; readonly assetId: string; readonly collision: MeshCollision };

export interface TerrainObject {
  readonly kind: 'terrain';
  readonly id: string;
  readonly mesh: TerrainMesh;
  readonly x: number;
  readonly y: number;
  // The mesh's box: its bounds fill `width` and `height`, and `depth` centred on the obstacle line.
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly depth: number;
  // Reflects the mesh, and with it its collision, left to right before it turns.
  readonly mirror: boolean;
  // The colour of a built-in mesh or a drawn outline, and of a mesh drawn as its collision in a shapes release.
  readonly color: number;
  readonly illusion: boolean;
  // What it is made of, which sets how bouncy it is (src/surfaces.ts).
  readonly surface: Surface;
}

/**
 * A terrain object's collision in its unit box, mirrored as placed: a true circle, or outline loops with the solid on
 * each edge's left.
 */
export type TerrainCollision = { readonly type: 'circle' } | { readonly type: 'loops'; readonly loops: readonly Outline[] };

// The hammer starts along `angle` with its head `reach` metres from the shoulder hinge, so a start
// means the same pose for every rig; a rig that cannot reach that far starts fully extended, and one whose minimum
// reach is farther starts at its minimum reach.
export interface StartObject extends Readonly<Point> {
  readonly kind: 'start';
  readonly id: string;
  readonly angle: number;
  readonly reach: number;
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

// A model placed for its look alone, by the centre of its base. It is scaled uniformly to `height`,
// then turned by `angle` and flipped left to right when mirrored; `tint` multiplies its colours.
export interface DecorationObject extends Readonly<Point> {
  readonly kind: 'decoration';
  readonly id: string;
  readonly model: string;
  readonly z: number;
  readonly height: number;
  readonly angle: number;
  readonly mirror: boolean;
  readonly tint: number;
}

// Where a fallen player comes back once the player has reached it, by the centre of its base on the ground.
export interface BonfireObject extends Readonly<Point> {
  readonly kind: 'bonfire';
  readonly id: string;
}

// A trap that fires along `angle` from its muzzle. Its timer starts at `delay` seconds into the run; a triggered burst
// starts `delay` seconds after its event. Both use `interval` between shots.
export interface ShooterObject extends Readonly<Point> {
  readonly kind: 'shooter';
  readonly id: string;
  readonly firing: 'timer' | 'trigger';
  readonly angle: number;
  readonly interval: number;
  readonly delay: number;
  readonly speed: number;
  readonly damage: number;
}

// A blade hung `length` below a pivot at its position, swinging in and out of the view through the obstacle line
// once every half `period` (src/hazards.ts).
export interface AxeObject extends Readonly<Point> {
  readonly kind: 'axe';
  readonly id: string;
  readonly length: number;
  readonly period: number;
  readonly offset: number;
  readonly damage: number;
}

export type TrapObject = ShooterObject | AxeObject;

// A still pool of `liquid` filling a box centred on (x, y), its top the liquid's surface, reaching half its `depth`
// each side of the obstacle line. It never collides (src/liquid-world.ts).
export interface PoolObject extends Readonly<Point> {
  readonly kind: 'pool';
  readonly id: string;
  readonly liquid: Liquid;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

// A kinematic slab whose other end is (travelX, travelY) metres from its start centre (x, y).
// With ride enabled, the pot boarding its resting top sends it toward the other end.
export interface PlatformObject extends Readonly<Point> {
  readonly kind: 'platform';
  readonly id: string;
  readonly ride: boolean;
  readonly travelX: number;
  readonly travelY: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly speed: number;
  readonly surface: Surface;
}

export type LevelObject =
  | TerrainObject | StartObject | TriggerObject | EnemyObject | DecorationObject | BonfireObject | TrapObject | PoolObject | PlatformObject;

export interface LevelLabel extends Readonly<Point> {
  readonly text: string;
}

export interface LevelDefinition {
  readonly schemaVersion: typeof LEVEL_SCHEMA_VERSION;
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

const SHAPE_VERTICES: Record<ShapeKind, Outline> = {
  box: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }],
  ramp: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }],
  triangle: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0, y: 0.5 }],
  circle: Array.from({ length: 32 }, (_, index) => ({
    x: Math.cos(index * Math.PI / 16) / 2, y: Math.sin(index * Math.PI / 16) / 2,
  })),
  hexagon: [{ x: 0.5, y: 0 }, { x: 0.25, y: 0.5 }, { x: -0.25, y: 0.5 },
    { x: -0.5, y: 0 }, { x: -0.25, y: -0.5 }, { x: 0.25, y: -0.5 }],
};
// Shapes that mirroring leaves unchanged.
const SYMMETRIC: ReadonlySet<ShapeKind> = new Set(['box', 'triangle', 'circle', 'hexagon']);
const MIN_POLYGON_AREA = 5e-6;

for (const vertices of Object.values(SHAPE_VERTICES)) {
  for (const vertex of vertices) Object.freeze(vertex);
  Object.freeze(vertices);
}

const SHAPE_MESHES = Object.freeze(Object.fromEntries(SHAPE_KINDS.map((shape) =>
  [shape, Object.freeze({ type: 'shape', shape })]))) as Readonly<Record<ShapeKind, TerrainMesh>>;
const SHAPE_COLLISIONS = Object.freeze(Object.fromEntries(SHAPE_KINDS.map((shape) =>
  [shape, Object.freeze({ type: shape })]))) as Readonly<Record<ShapeKind, MeshCollision>>;

// The built-in mesh of a shape, one shared object per shape.
export function shapeMesh(shape: ShapeKind): TerrainMesh {
  return SHAPE_MESHES[shape];
}

// A shape's outline in the unit box; the circle's is its polygon approximation.
export function shapeOutline(shape: ShapeKind): Outline {
  return SHAPE_VERTICES[shape];
}

function cross(a: Readonly<Point>, b: Readonly<Point>, x: number, y: number): number {
  return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
}

function onSegment(a: Readonly<Point>, b: Readonly<Point>, x: number, y: number, tolerance = 1e-10): boolean {
  const area = cross(a, b, x, y);
  return (area === 0 || Math.abs(area) < tolerance) && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) &&
    y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y);
}

// True when segment ab crosses or overlaps segment cd.
function segmentsTouch(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Point>, d: Readonly<Point>): boolean {
  return (cross(a, b, c.x, c.y) * cross(a, b, d.x, d.y) < 0 && cross(c, d, a.x, a.y) * cross(c, d, b.x, b.y) < 0) ||
    onSegment(a, b, c.x, c.y) || onSegment(a, b, d.x, d.y) || onSegment(c, d, a.x, a.y) || onSegment(c, d, b.x, b.y);
}

export function polygonArea(vertices: readonly Readonly<Point>[]): number {
  let area = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

// A closed outline's points: within the unit box, with nonzero edges, no edges that cross or overlap, and an area.
function outlinePoints(value: unknown, label: string): Outline {
  if (!Array.isArray(value) || value.length < 3 || value.length > LEVEL_LIMITS.polygonVertices) {
    throw new LevelError(`${label} needs 3 to ${LEVEL_LIMITS.polygonVertices} points.`);
  }
  const vertices = value.map((entry) => point(entry, 0.5, `${label} point`));
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-5) throw new LevelError(`${label}'s edges must have nonzero length.`);
    for (let j = i + 1; j < vertices.length; j++) {
      if (j === i + 1 || (i === 0 && j === vertices.length - 1)) continue;
      if (segmentsTouch(a, b, vertices[j], vertices[(j + 1) % vertices.length])) {
        throw new LevelError(`${label}'s edges cannot cross or overlap.`);
      }
    }
  }
  if (Math.abs(polygonArea(vertices)) <= MIN_POLYGON_AREA) throw new LevelError(`${label} must enclose an area.`);
  return Object.freeze(vertices);
}

// A drawn outline: its points run counterclockwise.
function polygon(value: unknown): Outline {
  const vertices = outlinePoints(value, 'A drawn outline');
  if (polygonArea(vertices) < 0) throw new LevelError('A drawn outline\'s points must run counterclockwise.');
  return vertices;
}

// A closed outline is simple when no two non-adjacent edges cross or overlap.
export function isSimplePolygon(vertices: readonly Readonly<Point>[]): boolean {
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (j === i + 1 || (i === 0 && j === vertices.length - 1)) continue;
      if (segmentsTouch(vertices[i], vertices[(i + 1) % vertices.length], vertices[j], vertices[(j + 1) % vertices.length])) return false;
    }
  }
  return true;
}

// Whether `p`, a point on no edge, lies inside the closed outline.
function insideOutline(vertices: Outline, p: Readonly<Point>): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[j];
    const b = vertices[i];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function outlineBounds(vertices: Outline): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const vertex of vertices) {
    minX = Math.min(minX, vertex.x); maxX = Math.max(maxX, vertex.x);
    minY = Math.min(minY, vertex.y); maxY = Math.max(maxY, vertex.y);
  }
  return { minX, maxX, minY, maxY };
}

function outlinesTouch(first: Outline, second: Outline): boolean {
  const a = outlineBounds(first);
  const b = outlineBounds(second);
  if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) return false;
  for (let i = 0; i < first.length; i++) {
    for (let j = 0; j < second.length; j++) {
      if (segmentsTouch(first[i], first[(i + 1) % first.length], second[j], second[(j + 1) % second.length])) return true;
    }
  }
  return false;
}

// Generated outlines validated already, by their JSON: every placement of a mesh shares them, checked once.
const OUTLINES = new Map<string, MeshCollision>();
const OUTLINE_MEMORY = 256;

function validateMeshOutlines(value: unknown, type: MeshOutlines): MeshCollision {
  const label = `A mesh ${type}`;
  fields(value, ['type', 'loops'], label);
  const key = `${type}:${JSON.stringify(value.loops)}`;
  const known = OUTLINES.get(key);
  if (known !== undefined) return known;
  if (!Array.isArray(value.loops) || value.loops.length === 0 || value.loops.length > LEVEL_LIMITS.meshLoops) {
    throw new LevelError(`${label} has 1 to ${LEVEL_LIMITS.meshLoops} loops.`);
  }
  const loops = value.loops.map((entry, index) => outlinePoints(entry, `${label} loop ${index + 1}`));
  if (loops.reduce((sum, loop) => sum + loop.length, 0) > LEVEL_LIMITS.meshPoints) {
    throw new LevelError(`${label} has at most ${LEVEL_LIMITS.meshPoints} points.`);
  }
  for (let a = 0; a < loops.length; a++) {
    for (let b = a + 1; b < loops.length; b++) {
      if (outlinesTouch(loops[a], loops[b])) throw new LevelError(`${label}'s loops cannot cross or touch.`);
    }
  }
  // Loops never touch, so a loop nests as deep as any of its points: inside an even number of others it bounds solid.
  loops.forEach((loop, index) => {
    const depth = loops.filter((other, at) => at !== index && insideOutline(other, loop[0])).length;
    if ((polygonArea(loop) > 0) !== (depth % 2 === 0)) {
      throw new LevelError(`${label} keeps the solid on each edge's left: outer loops run counterclockwise and holes clockwise.`);
    }
  });
  const collision: MeshCollision = Object.freeze({ type, loops: Object.freeze(loops) });
  if (OUTLINES.size >= OUTLINE_MEMORY) OUTLINES.clear();
  OUTLINES.set(key, collision);
  return collision;
}

function shapeKind(value: unknown, label: string): ShapeKind {
  const kind = SHAPE_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new LevelError(`${label} must be one of ${SHAPE_KINDS.join(', ')}.`);
  return kind;
}

export function validateMeshCollision(value: unknown): MeshCollision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LevelError('A mesh needs its collision: a simple shape, its slice or its projection.');
  }
  const type: unknown = Reflect.get(value, 'type');
  const outlines = MESH_OUTLINES.find((candidate) => candidate === type);
  if (outlines !== undefined) return validateMeshOutlines(value, outlines);
  fields(value, ['type'], 'A mesh collision');
  return SHAPE_COLLISIONS[shapeKind(type, 'A mesh collision type')];
}

export function validateTerrainMesh(value: unknown): TerrainMesh {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LevelError('Terrain needs a mesh: a built-in shape, a drawn outline or a mesh asset.');
  }
  const type: unknown = Reflect.get(value, 'type');
  if (type === 'shape') {
    fields(value, ['type', 'shape'], 'A built-in mesh');
    return SHAPE_MESHES[shapeKind(value.shape, 'A built-in mesh shape')];
  }
  if (type === 'outline') {
    fields(value, ['type', 'vertices'], 'A drawn outline');
    return Object.freeze({ type, vertices: polygon(value.vertices) });
  }
  if (type === 'asset') {
    fields(value, ['type', 'assetId', 'collision'], 'A mesh asset');
    let assetId: string;
    try {
      assetId = artId(value.assetId);
    } catch (error) {
      if (!(error instanceof ArtError)) throw error;
      throw new LevelError('A mesh asset names its GLB as asset-<SHA-256 of the GLB>.');
    }
    return Object.freeze({ type, assetId, collision: validateMeshCollision(value.collision) });
  }
  throw new LevelError('Terrain needs a mesh: a built-in shape, a drawn outline or a mesh asset.');
}

// A mesh's collision before mirroring: a shape, or outline loops.
function meshSource(mesh: TerrainMesh): ShapeKind | readonly Outline[] {
  if (mesh.type === 'shape') return mesh.shape;
  if (mesh.type === 'outline') return [mesh.vertices];
  return 'loops' in mesh.collision ? mesh.collision.loops : mesh.collision.type;
}

const CIRCLE: TerrainCollision = Object.freeze({ type: 'circle' });
// Each mesh's collision, as placed and mirrored, worked out once.
const COLLISIONS = new WeakMap<TerrainMesh, [TerrainCollision | null, TerrainCollision | null]>();
const GEOMETRY_KEYS = new WeakMap<TerrainMesh, string>();

// Reflects an outline left to right; reversing it keeps the solid on each edge's left.
function mirrorOutline(vertices: Outline): Outline {
  return Object.freeze(vertices.map((vertex) => Object.freeze({ x: -vertex.x + 0, y: vertex.y })).reverse());
}

export function terrainCollision(object: Pick<TerrainObject, 'mesh' | 'mirror'>): TerrainCollision {
  let cached = COLLISIONS.get(object.mesh);
  if (cached === undefined) {
    cached = [null, null];
    COLLISIONS.set(object.mesh, cached);
  }
  const index = object.mirror ? 1 : 0;
  let collision = cached[index];
  if (collision === null) {
    const source = meshSource(object.mesh);
    if (source === 'circle') collision = CIRCLE;
    else {
      const loops = typeof source === 'string' ? [SHAPE_VERTICES[source]] : source;
      collision = Object.freeze({ type: 'loops', loops: object.mirror ? Object.freeze(loops.map(mirrorOutline)) : loops });
    }
    cached[index] = collision;
  }
  return collision;
}

// Whether a mesh collides as a true circle, which needs equal width and height.
export function meshIsCircle(mesh: TerrainMesh): boolean {
  return meshSource(mesh) === 'circle';
}

/**
 * The key of a terrain object's collision geometry in its unit box, the same for everything that collides alike: one
 * physics shape and one extruded template each. A mesh that declares a box shares the built-in box's.
 */
export function geometryKey(object: Pick<TerrainObject, 'mesh' | 'mirror'>): string {
  let key = GEOMETRY_KEYS.get(object.mesh);
  const source = meshSource(object.mesh);
  if (key === undefined) {
    key = typeof source === 'string' ? source : `loops:${JSON.stringify(source)}`;
    GEOMETRY_KEYS.set(object.mesh, key);
  }
  return object.mirror && !(typeof source === 'string' && SYMMETRIC.has(source)) ? `${key}|mirror` : key;
}

/** The mesh assets the level's terrain draws, each once. */
export function terrainAssets(level: LevelDefinition): Set<string> {
  const assets = new Set<string>();
  for (const object of level.objects) if (object.kind === 'terrain' && object.mesh.type === 'asset') assets.add(object.mesh.assetId);
  return assets;
}

export function terrainFromOutline(
  outline: Pick<TerrainObject, 'id' | 'color' | 'depth' | 'surface'> & { readonly vertices: readonly Readonly<Point>[] },
): TerrainObject {
  if (outline.vertices.length < 3 || outline.vertices.length > LEVEL_LIMITS.polygonVertices) {
    throw new LevelError(`An outline needs 3 to ${LEVEL_LIMITS.polygonVertices} points.`);
  }
  const minX = Math.min(...outline.vertices.map((vertex) => vertex.x));
  const maxX = Math.max(...outline.vertices.map((vertex) => vertex.x));
  const minY = Math.min(...outline.vertices.map((vertex) => vertex.y));
  const maxY = Math.max(...outline.vertices.map((vertex) => vertex.y));
  const width = number(maxX - minX, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Outline width');
  const height = number(maxY - minY, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Outline height');
  // Min-relative normalization keeps both extrema exactly inside the shape's [-0.5, 0.5] bounds.
  const vertices = outline.vertices.map((vertex) => ({
    x: (vertex.x - minX) / width - 0.5, y: (vertex.y - minY) / height - 0.5,
  }));
  if (polygonArea(vertices) < 0) vertices.reverse();
  return validateTerrain({
    kind: 'terrain', id: outline.id, mesh: { type: 'outline', vertices },
    x: (minX + maxX) / 2, y: (minY + maxY) / 2, width, height, angle: 0, mirror: false,
    color: outline.color, depth: outline.depth, illusion: false, surface: outline.surface,
  });
}

// A terrain object's collision outlines in the course; a circle's is its polygon approximation.
export function objectLoops(object: TerrainObject): Point[][] {
  const collision = terrainCollision(object);
  const loops = collision.type === 'circle' ? [SHAPE_VERTICES.circle] : collision.loops;
  return loops.map((loop) => loop.map((vertex) =>
    transformPoint({ x: vertex.x * object.width, y: vertex.y * object.height }, object, object.angle)));
}

export type PointLocation = 'outside' | 'boundary' | 'inside';

/** Even-odd location; contact queries retain the engine's unit-space edge tolerance, geometric queries pass zero. */
export function loopsPointLocation(loops: readonly Outline[], p: Readonly<Point>, boundaryTolerance = 1e-10): PointLocation {
  return loopsLocation(loops, p.x, p.y, boundaryTolerance);
}

function loopsLocation(loops: readonly Outline[], x: number, y: number, boundaryTolerance: number): PointLocation {
  if (!Number.isFinite(boundaryTolerance) || boundaryTolerance < 0) throw new LevelError('Boundary tolerance must be finite and nonnegative.');
  let inside = false;
  for (let loop = 0; loop < loops.length; loop++) {
    const vertices = loops[loop]!;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const a = vertices[j];
      const b = vertices[i];
      if (onSegment(a, b, x, y, boundaryTolerance)) return 'boundary';
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

export function objectPointLocation(object: TerrainObject, position: Readonly<Point>, boundaryTolerance = 1e-10): PointLocation {
  const dx = position.x - object.x, dy = position.y - object.y;
  const cosine = Math.cos(-object.angle), sine = Math.sin(-object.angle);
  // Preserve transformPoint's origin addition and rounding order.
  const x = (0 + dx * cosine - dy * sine) / object.width;
  const y = (0 + dx * sine + dy * cosine) / object.height;
  if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) return 'outside';
  const collision = terrainCollision(object);
  if (collision.type === 'circle') {
    const radiusSquared = x ** 2 + y ** 2;
    return radiusSquared < 0.25 ? 'inside' : radiusSquared === 0.25 ? 'boundary' : 'outside';
  }
  return loopsLocation(collision.loops, x, y, boundaryTolerance);
}

export function objectContains(object: TerrainObject, position: Point): boolean {
  return objectPointLocation(object, position) !== 'outside';
}

function objectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new LevelError('Object IDs must be unique letters, numbers, hyphens or underscores, up to 64 characters.');
  }
  return value;
}

export function validateLevelObject(value: unknown): LevelObject {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'kind')) {
    throw new LevelError(OBJECT_KINDS);
  }
  const kind: unknown = Reflect.get(value, 'kind');
  if (kind === 'start') {
    fields(value, ['kind', 'id', 'x', 'y', 'angle', 'reach'], 'Start object');
    return Object.freeze({
      kind, id: objectId(value.id),
      x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Start X'),
      y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Start Y'),
      angle: number(value.angle, -Math.PI, Math.PI, 'Starting hammer angle'),
      reach: number(value.reach, 0, MAX_RIG_REACH, 'Starting reach'),
    });
  }
  if (kind === 'trigger') return validateTrigger(value);
  if (kind === 'enemy') return validateEnemy(value);
  if (kind === 'decoration') return validateDecoration(value);
  if (kind === 'bonfire') {
    fields(value, ['kind', 'id', 'x', 'y'], 'Bonfire object');
    return Object.freeze({
      kind, id: objectId(value.id),
      x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Bonfire X'),
      y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Bonfire Y'),
    });
  }
  if (kind === 'shooter') return validateShooter(value);
  if (kind === 'axe') return validateAxe(value);
  if (kind === 'pool') return validatePool(value);
  if (kind === 'platform') return validatePlatform(value);
  if (kind !== 'terrain') throw new LevelError(OBJECT_KINDS);
  return validateTerrain(value);
}

const OBJECT_KINDS = 'Choose a terrain, start, trigger, enemy, decoration, bonfire, projectile trap, swinging axe, liquid pool or platform object.';

function validatePlatform(value: unknown): PlatformObject {
  fields(value, ['kind', 'id', 'x', 'y', 'ride', 'travelX', 'travelY', 'width', 'height', 'depth', 'speed', 'surface'], 'Platform object');
  if (typeof value.ride !== 'boolean') throw new LevelError('Platform ride must be true or false.');
  if (!isSurface(value.surface)) throw new LevelError(`Surface must be one of ${SURFACES.join(', ')}.`);
  return Object.freeze({
    kind: 'platform', id: objectId(value.id), ride: value.ride,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Platform X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Platform Y'),
    travelX: number(value.travelX, -PLATFORM_LIMITS.maximumTravel, PLATFORM_LIMITS.maximumTravel, 'Platform travel X'),
    travelY: number(value.travelY, -PLATFORM_LIMITS.maximumTravel, PLATFORM_LIMITS.maximumTravel, 'Platform travel Y'),
    width: number(value.width, PLATFORM_LIMITS.minimumWidth, PLATFORM_LIMITS.maximumWidth, 'Platform width'),
    height: number(value.height, PLATFORM_LIMITS.minimumHeight, PLATFORM_LIMITS.maximumHeight, 'Platform height'),
    depth: number(value.depth, LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth, 'Platform depth'),
    speed: number(value.speed, PLATFORM_LIMITS.minimumSpeed, PLATFORM_LIMITS.maximumSpeed, 'Platform speed'),
    surface: value.surface,
  });
}

function validatePool(value: unknown): PoolObject {
  fields(value, ['kind', 'id', 'liquid', 'x', 'y', 'width', 'height', 'depth'], 'Liquid pool object');
  const liquid = LIQUIDS.find((candidate) => candidate === value.liquid);
  if (liquid === undefined) throw new LevelError('Choose lava or swamp.');
  return Object.freeze({
    kind: 'pool', id: objectId(value.id), liquid,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Pool X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Pool Y'),
    width: number(value.width, LIQUID_LIMITS.minimumSize, LIQUID_LIMITS.maximumSize, 'Pool width'),
    height: number(value.height, LIQUID_LIMITS.minimumSize, LIQUID_LIMITS.maximumSize, 'Pool height'),
    depth: number(value.depth, LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth, 'Pool depth'),
  });
}

function validateShooter(value: unknown): ShooterObject {
  fields(value, ['kind', 'id', 'firing', 'x', 'y', 'angle', 'interval', 'delay', 'speed', 'damage'], 'Projectile trap object');
  if (value.firing !== 'timer' && value.firing !== 'trigger') throw new LevelError('Projectile trap firing must be timer or trigger.');
  return Object.freeze({
    kind: 'shooter', id: objectId(value.id), firing: value.firing,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Trap X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Trap Y'),
    angle: number(value.angle, -Math.PI, Math.PI, 'Firing direction'),
    interval: number(value.interval, SHOOTER_FIELDS.interval.min, SHOOTER_FIELDS.interval.max, SHOOTER_FIELDS.interval.label),
    delay: number(value.delay, SHOOTER_FIELDS.delay.min, SHOOTER_FIELDS.delay.max, SHOOTER_FIELDS.delay.label),
    speed: number(value.speed, SHOOTER_FIELDS.speed.min, SHOOTER_FIELDS.speed.max, SHOOTER_FIELDS.speed.label),
    damage: damage(value.damage, SHOOTER_FIELDS.damage),
  });
}

function validateAxe(value: unknown): AxeObject {
  fields(value, ['kind', 'id', 'x', 'y', 'length', 'period', 'offset', 'damage'], 'Swinging axe object');
  return Object.freeze({
    kind: 'axe', id: objectId(value.id),
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Axe pivot X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Axe pivot Y'),
    length: number(value.length, AXE_FIELDS.length.min, AXE_FIELDS.length.max, AXE_FIELDS.length.label),
    period: number(value.period, AXE_FIELDS.period.min, AXE_FIELDS.period.max, AXE_FIELDS.period.label),
    offset: number(value.offset, AXE_FIELDS.offset.min, AXE_FIELDS.offset.max, AXE_FIELDS.offset.label),
    damage: damage(value.damage, AXE_FIELDS.damage),
  });
}

function damage(value: unknown, field: { readonly label: string; readonly min: number; readonly max: number }): number {
  const amount = number(value, field.min, field.max, field.label);
  if (!Number.isInteger(amount)) throw new LevelError(`${field.label} must be a whole number.`);
  return amount;
}

export function decorationModelId(value: unknown): string {
  if (typeof value !== 'string' || value.length > DECORATION_LIMITS.modelId || !DECORATION_MODEL_ID.test(value)) {
    throw new LevelError(`Decoration model IDs use lowercase letters, numbers and single hyphens, up to ${DECORATION_LIMITS.modelId} characters.`);
  }
  return value;
}

function validateDecoration(value: unknown): DecorationObject {
  fields(value, ['kind', 'id', 'model', 'x', 'y', 'z', 'height', 'angle', 'mirror', 'tint'], 'Decoration object');
  if (typeof value.mirror !== 'boolean') throw new LevelError('Mirror must be enabled or disabled.');
  const tint = number(value.tint, 0, 0xffffff, 'Decoration tint');
  if (!Number.isInteger(tint)) throw new LevelError('Decoration tint must be a whole RGB value.');
  return Object.freeze({
    kind: 'decoration', id: objectId(value.id), model: decorationModelId(value.model),
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Decoration X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Decoration Y'),
    z: number(value.z, -DECORATION_LIMITS.back, DECORATION_LIMITS.front, 'Decoration depth'),
    height: number(value.height, DECORATION_LIMITS.minimumHeight, DECORATION_LIMITS.maximumHeight, 'Decoration height'),
    angle: number(value.angle, -Math.PI, Math.PI, 'Decoration rotation'),
    mirror: value.mirror, tint,
  });
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
  fields(value, ['kind', 'id', 'mesh', 'x', 'y', 'width', 'height', 'angle', 'depth', 'mirror', 'color', 'illusion', 'surface'],
    'Terrain object');
  const id = objectId(value.id);
  const mesh = validateTerrainMesh(value.mesh);
  const width = number(value.width, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Width');
  const height = number(value.height, LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize, 'Height');
  if (meshIsCircle(mesh) && width !== height) throw new LevelError('A circle must have equal width and height.');
  if (typeof value.mirror !== 'boolean') throw new LevelError('Mirror must be enabled or disabled.');
  if (typeof value.illusion !== 'boolean') throw new LevelError('Illusion must be enabled or disabled.');
  if (!isSurface(value.surface)) throw new LevelError(`Surface must be one of ${SURFACES.join(', ')}.`);
  const color = number(value.color, 0, 0xffffff, 'Rock color');
  if (!Number.isInteger(color)) throw new LevelError('Rock color must be a whole RGB value.');
  return Object.freeze({
    kind: 'terrain', id, mesh,
    x: number(value.x, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Position X'),
    y: number(value.y, -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate, 'Position Y'),
    width, height, angle: number(value.angle, -Math.PI, Math.PI, 'Rotation'),
    depth: number(value.depth, LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth, 'Depth'),
    mirror: value.mirror, color, illusion: value.illusion, surface: value.surface,
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

export function validateTriggerTargets(trigger: TriggerObject, lookup: (id: string) => LevelObject | undefined): void {
  for (const event of trigger.events) {
    if (event.type === 'fire-trap' && lookup(event.trap)?.kind !== 'shooter') {
      throw new LevelError(`Trigger "${trigger.id}" fires unknown projectile trap "${event.trap}".`);
    }
    if (event.type === 'move-platform' && lookup(event.platform)?.kind !== 'platform') {
      throw new LevelError(`Trigger "${trigger.id}" moves unknown platform "${event.platform}".`);
    }
  }
}

export function validateLevel(value: unknown): LevelDefinition {
  fields(value, ['schemaVersion', 'labels', 'objects'], 'Level');
  if (value.schemaVersion !== LEVEL_SCHEMA_VERSION) {
    throw new LevelError(`Levels require schema version ${LEVEL_SCHEMA_VERSION}.`);
  }
  const metadata = validateLevelMetadata({ labels: value.labels });
  if (!Array.isArray(value.objects) || value.objects.length > LEVEL_OBJECT_LIMIT) {
    throw new LevelError(`A level supports ${LEVEL_LIMITS.objects} terrain objects, ${TRIGGER_LIMITS.objects} triggers, ${ENEMY_LIMITS.objects} enemies, ` +
      `${DECORATION_LIMITS.objects} decorations, ${HAZARD_LIMITS.bonfires} bonfires, ${HAZARD_LIMITS.traps} traps, ${LIQUID_LIMITS.pools} liquid pools, ` +
      `${PLATFORM_LIMITS.objects} platforms, and one start.`);
  }
  const objects = value.objects.map(validateLevelObject);
  if (new Set(objects.map((object) => object.id)).size !== objects.length) throw new LevelError('Every object needs a unique ID.');
  if (objects.filter((object) => object.kind === 'start').length !== 1) throw new LevelError('A level needs exactly one start location.');
  const terrain = objects.filter(isTerrainObject);
  if (terrain.length > LEVEL_LIMITS.objects) throw new LevelError(`A level supports up to ${LEVEL_LIMITS.objects} terrain objects.`);
  if (objects.filter(isTriggerObject).length > TRIGGER_LIMITS.objects) throw new LevelError(`A level supports up to ${TRIGGER_LIMITS.objects} triggers.`);
  if (objects.filter(isEnemyObject).length > ENEMY_LIMITS.objects) throw new LevelError(`A level supports up to ${ENEMY_LIMITS.objects} enemies.`);
  if (objects.filter(isDecorationObject).length > DECORATION_LIMITS.objects) throw new LevelError(`A level supports up to ${DECORATION_LIMITS.objects} decorations.`);
  if (objects.filter(isBonfireObject).length > HAZARD_LIMITS.bonfires) throw new LevelError(`A level supports up to ${HAZARD_LIMITS.bonfires} bonfires.`);
  if (objects.filter(isTrapObject).length > HAZARD_LIMITS.traps) throw new LevelError(`A level supports up to ${HAZARD_LIMITS.traps} traps.`);
  if (objects.filter(isPoolObject).length > LIQUID_LIMITS.pools) throw new LevelError(`A level supports up to ${LIQUID_LIMITS.pools} liquid pools.`);
  if (objects.filter(isPlatformObject).length > PLATFORM_LIMITS.objects) throw new LevelError(`A level supports up to ${PLATFORM_LIMITS.objects} platforms.`);
  const lookup = new Map(objects.map((object) => [object.id, object]));
  for (const object of objects) if (isTriggerObject(object)) validateTriggerTargets(object, (id) => lookup.get(id));
  if (new Set(terrain.map(geometryKey)).size > LEVEL_LIMITS.geometryKinds) {
    throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct terrain collision shapes.`);
  }
  return Object.freeze({ schemaVersion: LEVEL_SCHEMA_VERSION, ...metadata, objects: Object.freeze(objects) });
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
  if (marker === undefined) throw new LevelError('Choose no marker, a flag, an updraft or a switch.');
  if (!Array.isArray(value.events) || value.events.length > TRIGGER_LIMITS.events) {
    throw new LevelError(`A trigger has at most ${TRIGGER_LIMITS.events} events.`);
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
  if (type === 'fire-trap') {
    fields(value, ['type', 'trap', 'shots'], 'Fire trap event');
    const shots = number(value.shots, FIRE_TRAP_FIELDS.shots.min, FIRE_TRAP_FIELDS.shots.max, FIRE_TRAP_FIELDS.shots.label);
    if (!Number.isInteger(shots)) throw new LevelError(`${FIRE_TRAP_FIELDS.shots.label} must be a whole number.`);
    return Object.freeze({ type, trap: objectId(value.trap), shots });
  }
  if (type === 'move-platform') {
    fields(value, ['type', 'platform', 'to'], 'Move platform event');
    const to = PLATFORM_DESTINATIONS.find((candidate) => candidate === value.to);
    if (to === undefined) throw new LevelError(`Platform destination must be one of ${PLATFORM_DESTINATIONS.join(', ')}.`);
    return Object.freeze({ type, platform: objectId(value.platform), to });
  }
  if (type === 'message') {
    fields(value, ['type', 'title', 'message'], 'Message event');
    return Object.freeze({
      type, title: text(value.title, TRIGGER_LIMITS.title, 'Message title'),
      message: text(value.message, TRIGGER_LIMITS.message, 'Message text'),
    });
  }
  if (type === 'play-video') {
    fields(value, ['type', 'source'], 'Video event');
    return Object.freeze({ type, source: mediaSource(value.source, 'video') });
  }
  if (type === 'play-sound') {
    fields(value, ['type', 'source', 'volume'], 'Sound event');
    return Object.freeze({
      type, source: mediaSource(value.source, 'sound'),
      volume: number(value.volume, SOUND_VOLUME.min, SOUND_VOLUME.max, SOUND_VOLUME.label),
    });
  }
  throw new LevelError('Choose message, play video, play sound, stop timer, launch player, fire trap, or move platform.');
}

function mediaSource(value: unknown, kind: 'video' | 'sound'): string {
  const label = kind === 'video' ? 'Video source' : 'Sound source';
  const source = text(value, TRIGGER_LIMITS.source, label).trim();
  let url: URL;
  try {
    url = new URL(source, 'https://level.invalid');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new LevelError(`Use an HTTP(S) ${kind} URL or a site-relative /media/${kind} path.`);
  }
  const local = source.startsWith('/') && !source.startsWith('//') && url.origin === 'https://level.invalid';
  const remote = /^https?:\/\//i.test(source) && (url.protocol === 'https:' || url.protocol === 'http:');
  if ((!local && !remote) || url.username || url.password) {
    throw new LevelError(`Use an HTTP(S) ${kind} URL without credentials, or a site-relative /media/${kind} path.`);
  }
  return source;
}

export function isTerrainObject(object: LevelObject): object is TerrainObject { return object.kind === 'terrain'; }
export function isTriggerObject(object: LevelObject): object is TriggerObject { return object.kind === 'trigger'; }
export function isEnemyObject(object: LevelObject): object is EnemyObject { return object.kind === 'enemy'; }
export function isDecorationObject(object: LevelObject): object is DecorationObject { return object.kind === 'decoration'; }
export function isBonfireObject(object: LevelObject): object is BonfireObject { return object.kind === 'bonfire'; }
export function isTrapObject(object: LevelObject): object is TrapObject { return object.kind === 'shooter' || object.kind === 'axe'; }
export function isPoolObject(object: LevelObject): object is PoolObject { return object.kind === 'pool'; }
export function isPlatformObject(object: LevelObject): object is PlatformObject { return object.kind === 'platform'; }

// Whether anything in the level can hurt the player: an enemy, a trap or lava.
export function levelHurts(level: LevelDefinition): boolean {
  return level.objects.some((object) => object.kind === 'enemy' || isTrapObject(object) || (isPoolObject(object) && object.liquid === 'lava'));
}

export function levelStart(level: LevelDefinition): StartObject {
  const start = level.objects.find((object): object is StartObject => object.kind === 'start');
  if (!start) throw new Error('Validated levels must contain a start location.');
  return start;
}

export function levelSpawn(level: LevelDefinition): Readonly<PlayerSpawn> {
  const start = levelStart(level);
  return { position: { x: start.x, y: start.y }, angle: start.angle, reach: start.reach };
}

// Lowest authored point that could still catch the player: terrain, a zone that launches upward, a liquid pool or a platform.
export function levelFloor(level: LevelDefinition): number | null {
  let floor = Infinity;
  for (const object of level.objects) {
    if (object.kind !== 'terrain') continue;
    floor = Math.min(floor, meshIsCircle(object.mesh)
      ? object.y - object.width / 2
      : Math.min(...objectLoops(object).flat().map((vertex) => vertex.y)));
  }
  for (const object of level.objects) {
    if (object.kind === 'trigger' && object.events.some((event) => event.type === 'launch-player')) {
      floor = Math.min(floor, triggerBounds(object).minY);
    } else if (object.kind === 'pool') floor = Math.min(floor, object.y - object.height / 2);
    else if (object.kind === 'platform') {
      floor = Math.min(floor, object.y + Math.min(0, object.travelY) - object.height / 2);
    }
  }
  return floor === Infinity ? null : floor;
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
