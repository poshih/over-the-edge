// A mesh's collision, worked out from its GLB: the simple shape it declares, or else outlines generated from it, its
// slice unless it declares its projection. It needs no DOM and depends only on the GLB's bytes, so the Workshop, the
// project server and build tools derive the same collision from the same mesh.
//
// A GLB declares its collision with `"extras": { "collision": "box" }` on its scene or a root node (a custom property
// `collision` in Blender): one of the built-in shapes, fitted to the mesh's bounds, `slice` or `projection`. Without
// one the mesh is sliced where it meets the obstacle line: the plane through the middle of its depth, which a placed
// mesh centres on the line. The cross-section is rasterized with the nonzero rule, so overlapping parts merge. A
// projection is instead the mesh's silhouette seen along the view, its parallel projection onto the course plane, so
// its outermost surface collides wherever it lies in the depth. Either is traced into outlines and simplified to the
// level's limits. A mesh turned about its vertical axis shows another slice and silhouette, so its outlines are baked
// for its turn: a GLB is read once and baked for each turn asked of it.
import { ArtError } from './art-types';
import { accessor, index, list, readContainer, record } from './glb-reader';
import type { Gltf, Record_ } from './glb-reader';
import { validateCourseModel } from './course-art-model';
import { LEVEL_LIMITS, LevelError, MESH_OUTLINES, polygonArea, SHAPE_KINDS, validateMeshCollision } from './level';
import type { MeshCollision, MeshOutlines, ShapeKind, TerrainMesh } from './level';

/** A course GLB read once: its triangles and every vertex in its own space, and the collision it declares. */
export interface CourseMesh {
  // x, y, z of each triangle's corners, nine numbers per triangle, wound so their normals face out.
  readonly corners: Float64Array;
  // x, y, z of every vertex, used by a triangle or not, which together bound the mesh as three.js measures it.
  readonly points: Float64Array;
  readonly declared: ShapeKind | MeshOutlines;
}

/** A mesh ready to place: its terrain mesh, turned and with its collision, and its own size in metres as turned. */
export interface MeshTerrain {
  readonly mesh: Extract<TerrainMesh, { type: 'asset' }>;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

// Cells across the longer side of the mesh's box: about 2.6 mm for a 1 m rock and 5 cm for a 20 m cliff.
const RESOLUTION = 384;
const MIN_CELLS = 8;
// Outlines smaller than this many cells, or this share of the box, are specks: they are dropped, holes filled.
const SPECK_CELLS = 9;
const SPECK_SHARE = 0.0002;
// Simplification tolerances tried in turn, in cells, until the outlines fit the level's limits.
const TOLERANCES = [0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24];
// Rows that cross the mesh's surface an odd number of times come from holes in it; a few are bridged from their neighbours.
const OPEN_ROWS = 0.05;
const DIGITS = 1e6;

type Matrix = Float64Array;

function fail(message: string): never {
  throw new ArtError(message);
}

function identity(): Matrix {
  const matrix = new Float64Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  return matrix;
}

// a × b, both column-major.
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

function numbers(value: unknown, length: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    fail(`A GLB node has an invalid ${label}.`);
  }
  return value as number[];
}

// A node's own transform: its matrix, or its translation, rotation and scale composed as glTF defines.
function localMatrix(node: Record_): Matrix {
  if (node.matrix !== undefined) return Float64Array.from(numbers(node.matrix, 16, 'matrix'));
  const [tx, ty, tz] = node.translation === undefined ? [0, 0, 0] : numbers(node.translation, 3, 'translation');
  const [x, y, z, w] = node.rotation === undefined ? [0, 0, 0, 1] : numbers(node.rotation, 4, 'rotation');
  const [sx, sy, sz] = node.scale === undefined ? [1, 1, 1] : numbers(node.scale, 3, 'scale');
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

function determinant3(m: Matrix): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

// Every triangle of the default scene in the model's space, as turned, as flat coordinates, wound so their normals face
// out, and the bounds of every vertex.
interface Triangles {
  // x, y, z of each corner, nine numbers per triangle.
  readonly corners: Float64Array;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function sceneGeometry(json: Gltf, buffers: readonly Uint8Array[]): Pick<CourseMesh, 'corners' | 'points'> {
  const scenes = list(json.scenes, 'scene');
  if (scenes.length === 0) fail('The GLB has no scene.');
  const scene = record(scenes[json.scene === undefined ? 0 : index(json.scene, scenes.length, 'scene')], 'scene');
  const nodes = list(json.nodes, 'node');
  const meshes = list(json.meshes, 'mesh');
  const corners: number[] = [];
  const vertices: number[] = [];
  const visited = new Set<number>();
  const visit = (at: number, parent: Matrix): void => {
    if (visited.has(at)) fail('The GLB\'s node hierarchy repeats a node.');
    visited.add(at);
    const node = record(nodes[at], 'node');
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = record(meshes[index(node.mesh, meshes.length, 'mesh')], 'mesh');
      const flip = determinant3(world) < 0;
      for (const entry of list(mesh.primitives, 'primitive')) {
        const primitive = record(entry, 'primitive');
        const attributes = record(primitive.attributes, 'primitive attributes');
        const positions = accessor(json, buffers, index(attributes.POSITION, list(json.accessors, 'accessor').length, 'position accessor'));
        const points = new Float64Array(positions.count * 3);
        for (let vertex = 0; vertex < positions.count; vertex++) {
          const px = positions.read(vertex, 0), py = positions.read(vertex, 1), pz = positions.read(vertex, 2);
          for (let axis = 0; axis < 3; axis++) {
            const value = world[axis] * px + world[4 + axis] * py + world[8 + axis] * pz + world[12 + axis];
            points[vertex * 3 + axis] = value;
            // Every vertex counts toward the bounds, as three.js measures a mesh, used or not.
            vertices.push(value);
          }
        }
        const indices = primitive.indices === undefined ? null
          : accessor(json, buffers, index(primitive.indices, list(json.accessors, 'accessor').length, 'index accessor'));
        const count = indices === null ? positions.count : indices.count;
        for (let corner = 0; corner + 2 < count; corner += 3) {
          const order = flip ? [0, 2, 1] : [0, 1, 2];
          for (const offset of order) {
            const vertex = indices === null ? corner + offset : indices.read(corner + offset, 0);
            if (!Number.isInteger(vertex) || vertex < 0 || vertex >= positions.count) fail('A GLB triangle names a missing vertex.');
            corners.push(points[vertex * 3], points[vertex * 3 + 1], points[vertex * 3 + 2]);
          }
        }
      }
    }
    for (const child of list(node.children, 'child')) visit(index(child, nodes.length, 'child node'), world);
  };
  for (const root of list(scene.nodes, 'scene node')) visit(index(root, nodes.length, 'scene node'), identity());
  if (corners.length === 0 || !vertices.every(Number.isFinite)) fail('The mesh has no triangles in its scene.');
  return { corners: Float64Array.from(corners), points: Float64Array.from(vertices) };
}

// The mesh turned `turn` radians about its vertical axis, as three.js turns a model (about +y, so +z swings toward +x),
// with the bounds of every vertex as turned.
function turnedTriangles(mesh: CourseMesh, turn: number): Triangles {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const turned = (source: Float64Array): Float64Array => {
    if (turn === 0) return source;
    const out = new Float64Array(source.length);
    for (let at = 0; at < source.length; at += 3) {
      const x = source[at], z = source[at + 2];
      out[at] = x * cos + z * sin;
      out[at + 1] = source[at + 1];
      out[at + 2] = z * cos - x * sin;
    }
    return out;
  };
  const points = turned(mesh.points);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < points.length; at += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = points[at + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { corners: turned(mesh.corners), min, max };
}

// The collision the GLB declares on its scene or a root node: a simple shape, or how to generate its outlines, its
// slice unless it declares its projection.
function declaredCollision(json: Gltf): ShapeKind | MeshOutlines {
  const scenes = list(json.scenes, 'scene');
  const scene = record(scenes[json.scene === undefined ? 0 : index(json.scene, scenes.length, 'scene')], 'scene');
  const nodes = list(json.nodes, 'node');
  const holders = [scene, ...list(scene.nodes, 'scene node').map((root) => record(nodes[index(root, nodes.length, 'scene node')], 'node'))];
  const declared = new Set<unknown>();
  for (const holder of holders) {
    const extras = holder.extras;
    if (typeof extras === 'object' && extras !== null && Object.hasOwn(extras, 'collision')) declared.add(Reflect.get(extras, 'collision'));
  }
  if (declared.size === 0) return 'slice';
  if (declared.size > 1) fail('The GLB declares more than one collision type; declare one, on its scene or a root node.');
  const value = [...declared][0];
  const kind = [...SHAPE_KINDS, ...MESH_OUTLINES].find((candidate) => candidate === value);
  if (kind === undefined) {
    fail(`The GLB declares collision "${String(value)}". Use ${[...SHAPE_KINDS, ...MESH_OUTLINES].join(', ')}, or leave it out to slice the mesh.`);
  }
  return kind;
}

interface Grid {
  readonly columns: number;
  readonly rows: number;
  // One byte per cell, row by row from the bottom: 1 where the collision is solid.
  readonly solid: Uint8Array;
}

// The grid over the mesh's box, and the model's x and y in grid units.
function gridFrame(triangles: Triangles): { columns: number; rows: number; gx: (x: number) => number; gy: (y: number) => number } {
  const [minX, minY] = triangles.min;
  const width = triangles.max[0] - minX;
  const height = triangles.max[1] - minY;
  const longer = Math.max(width, height);
  const columns = Math.max(MIN_CELLS, Math.round(RESOLUTION * width / longer));
  const rows = Math.max(MIN_CELLS, Math.round(RESOLUTION * height / longer));
  return { columns, rows, gx: (x) => (x - minX) / width * columns, gy: (y) => (y - minY) / height * rows };
}

// The cross-section on the plane z = `plane`, rasterized over the box with the nonzero rule: a cell is solid where the
// mesh's surface winds around its centre.
function sliceGrid(triangles: Triangles, plane: number): Grid {
  const { columns, rows, gx, gy } = gridFrame(triangles);
  // Each crossing segment in grid units, oriented with the solid on its left: along ẑ × n for the face normal n.
  const segments: number[] = [];
  const { corners } = triangles;
  for (let at = 0; at < corners.length; at += 9) {
    const z = [corners[at + 2] - plane, corners[at + 5] - plane, corners[at + 8] - plane];
    const above = z.map((value) => value > 0);
    if (above[0] === above[1] && above[1] === above[2]) continue;
    const ux = corners[at + 3] - corners[at], uy = corners[at + 4] - corners[at + 1], uz = corners[at + 5] - corners[at + 2];
    const vx = corners[at + 6] - corners[at], vy = corners[at + 7] - corners[at + 1], vz = corners[at + 8] - corners[at + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    // A face standing on its edge has no side to keep the solid on.
    if (nx === 0 && ny === 0) continue;
    const ends: number[] = [];
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      if (above[a] === above[b]) continue;
      const t = z[a] / (z[a] - z[b]);
      ends.push(corners[at + a * 3] + (corners[at + b * 3] - corners[at + a * 3]) * t,
        corners[at + a * 3 + 1] + (corners[at + b * 3 + 1] - corners[at + a * 3 + 1]) * t);
    }
    if (ends.length !== 4) continue;
    // Scaling into the grid keeps orientation, so the segment is oriented in the model's space.
    const forward = (ends[2] - ends[0]) * -ny + (ends[3] - ends[1]) * nx >= 0;
    const [x1, y1, x2, y2] = forward ? ends : [ends[2], ends[3], ends[0], ends[1]];
    segments.push(gx(x1), gy(y1), gx(x2), gy(y2));
  }
  if (segments.length === 0) {
    fail('The mesh has nothing where it meets the obstacle line, the middle of its depth. Declare a collision type, such as projection, or reshape it.');
  }
  // Each row's crossings: a segment crosses row j when its centre j + 0.5 lies in [lower y, upper y).
  const crossings: number[][] = Array.from({ length: rows }, () => []);
  for (let at = 0; at < segments.length; at += 4) {
    const y1 = segments[at + 1];
    const y2 = segments[at + 3];
    if (y1 === y2) continue;
    const low = Math.min(y1, y2);
    const high = Math.max(y1, y2);
    const first = Math.max(0, Math.ceil(low - 0.5));
    const last = Math.min(rows - 1, Math.ceil(high - 0.5) - 1);
    for (let row = first; row <= last; row++) {
      const centre = row + 0.5;
      const x = segments[at] + (centre - y1) * (segments[at + 2] - segments[at]) / (y2 - y1);
      // Upward edges have the solid to their left, so they close a span the sweep from the left opened.
      crossings[row].push(x, y2 > y1 ? 1 : -1);
    }
  }
  const solid = new Uint8Array(columns * rows);
  const open: number[] = [];
  for (let row = 0; row < rows; row++) {
    const entries = crossings[row];
    const order = Array.from({ length: entries.length / 2 }, (_, at) => at).sort((a, b) => entries[a * 2] - entries[b * 2]);
    let winding = 0;
    let next = 0;
    for (let column = 0; column < columns; column++) {
      const centre = column + 0.5;
      while (next < order.length && entries[order[next] * 2] < centre) winding += entries[order[next++] * 2 + 1];
      solid[row * columns + column] = winding === 0 ? 0 : 1;
    }
    while (next < order.length) winding += entries[order[next++] * 2 + 1];
    if (winding !== 0) open.push(row);
  }
  if (open.length > rows * OPEN_ROWS) {
    fail('The mesh is not closed where it meets the obstacle line, so its slice has no inside. Close the mesh, or declare a collision type, such as projection.');
  }
  // A row crossing an opening in the surface takes the nearest closed row.
  const closed = (row: number): boolean => !open.includes(row);
  for (const row of open) {
    let source = -1;
    for (let distance = 1; distance < rows && source < 0; distance++) {
      if (row - distance >= 0 && closed(row - distance)) source = row - distance;
      else if (row + distance < rows && closed(row + distance)) source = row + distance;
    }
    if (source < 0) fail('The mesh is not closed where it meets the obstacle line. Close the mesh, or declare a collision type, such as projection.');
    solid.copyWithin(row * columns, source * columns, source * columns + columns);
  }
  return { columns, rows, solid };
}

// The mesh's silhouette seen along the view, its parallel projection along z onto the course plane, rasterized over the
// box: a cell is solid where any face's shadow covers its centre, whichever way the face turns, so the outermost surface
// collides wherever it lies in the depth. The mesh need not be closed.
function projectionGrid(triangles: Triangles): Grid {
  const { columns, rows, gx, gy } = gridFrame(triangles);
  const solid = new Uint8Array(columns * rows);
  const { corners } = triangles;
  const xs = [0, 0, 0];
  const ys = [0, 0, 0];
  for (let at = 0; at < corners.length; at += 9) {
    for (let corner = 0; corner < 3; corner++) {
      xs[corner] = gx(corners[at + corner * 3]);
      ys[corner] = gy(corners[at + corner * 3 + 1]);
    }
    // A face seen edge-on casts no shadow.
    if ((xs[1] - xs[0]) * (ys[2] - ys[0]) === (ys[1] - ys[0]) * (xs[2] - xs[0])) continue;
    const first = Math.max(0, Math.ceil(Math.min(ys[0], ys[1], ys[2]) - 0.5));
    const last = Math.min(rows - 1, Math.floor(Math.max(ys[0], ys[1], ys[2]) - 0.5));
    for (let row = first; row <= last; row++) {
      const centre = row + 0.5;
      let left = Infinity;
      let right = -Infinity;
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3;
        // Each edge is followed from its lower end, so the faces sharing it find the same crossings and leave no gap.
        const low = ys[a] <= ys[b] ? a : b;
        const high = low === a ? b : a;
        if (centre < ys[low] || centre > ys[high]) continue;
        const x = ys[low] === ys[high] ? xs[low] : xs[low] + (centre - ys[low]) * (xs[high] - xs[low]) / (ys[high] - ys[low]);
        const other = ys[low] === ys[high] ? xs[high] : x;
        left = Math.min(left, x, other);
        right = Math.max(right, x, other);
      }
      const from = Math.max(0, Math.ceil(left - 0.5));
      const to = Math.min(columns - 1, Math.floor(right - 0.5));
      if (from <= to) solid.fill(1, row * columns + from, row * columns + to + 1);
    }
  }
  if (!solid.includes(1)) fail('The mesh casts no shadow along the view: every face is seen edge-on. Declare another collision type, or reshape it.');
  return { columns, rows, solid };
}

// Fills one cell of every pair of solid cells that meet only at a corner, so outlines never touch themselves or each
// other.
function joinCorners(grid: Grid): void {
  const { columns, rows, solid } = grid;
  const at = (column: number, row: number): number => solid[row * columns + column];
  for (let changed = true; changed;) {
    changed = false;
    for (let row = 0; row + 1 < rows; row++) {
      for (let column = 0; column + 1 < columns; column++) {
        const a = at(column, row), b = at(column + 1, row), c = at(column, row + 1), d = at(column + 1, row + 1);
        if (a === d && b === c && a !== b) {
          solid[row * columns + column + (a === 0 ? 0 : 1)] = 1;
          changed = true;
        }
      }
    }
  }
}

type GridPoint = readonly [number, number];

// The solid's boundary along cell edges, as loops with the solid on each edge's left, without collinear corners.
function traceOutlines(grid: Grid): GridPoint[][] {
  const { columns, rows, solid } = grid;
  const filled = (column: number, row: number): boolean =>
    column >= 0 && row >= 0 && column < columns && row < rows && solid[row * columns + column] === 1;
  const key = (x: number, y: number): number => y * (columns + 1) + x;
  const next = new Map<number, number>();
  const edge = (x1: number, y1: number, x2: number, y2: number): void => { next.set(key(x1, y1), key(x2, y2)); };
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (!filled(column, row)) continue;
      if (!filled(column, row - 1)) edge(column, row, column + 1, row);
      if (!filled(column + 1, row)) edge(column + 1, row, column + 1, row + 1);
      if (!filled(column, row + 1)) edge(column + 1, row + 1, column, row + 1);
      if (!filled(column - 1, row)) edge(column, row + 1, column, row);
    }
  }
  const loops: GridPoint[][] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const points: GridPoint[] = [];
    let at = start;
    do {
      points.push([at % (columns + 1), Math.floor(at / (columns + 1))]);
      const following = next.get(at);
      next.delete(at);
      if (following === undefined) fail('The mesh\'s outlines could not be traced.');
      at = following;
    } while (at !== start);
    loops.push(points.filter((point, position) => {
      const previous = points[(position + points.length - 1) % points.length];
      const following = points[(position + 1) % points.length];
      return (following[0] - previous[0]) * (point[1] - previous[1]) !== (following[1] - previous[1]) * (point[0] - previous[0]);
    }));
  }
  return loops;
}

function distanceToSegment(point: GridPoint, a: GridPoint, b: GridPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length));
  return Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t);
}

// Douglas-Peucker on an open run of points, keeping its ends.
function simplifyRun(points: readonly GridPoint[], tolerance: number): GridPoint[] {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let at = first + 1; at < last; at++) {
      const candidate = distanceToSegment(points[at], points[first], points[last]);
      if (candidate > distance) { distance = candidate; farthest = at; }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }
  return points.filter((_, at) => keep[at] === 1);
}

// A closed loop simplified: split at its first point and the point farthest from it, each half kept within tolerance.
function simplifyLoop(points: readonly GridPoint[], tolerance: number): GridPoint[] {
  let far = 0;
  for (let at = 1; at < points.length; at++) {
    if (Math.hypot(points[at][0] - points[0][0], points[at][1] - points[0][1]) >
      Math.hypot(points[far][0] - points[0][0], points[far][1] - points[0][1])) far = at;
  }
  const first = simplifyRun(points.slice(0, far + 1), tolerance);
  const second = simplifyRun([...points.slice(far), points[0]], tolerance);
  return [...first, ...second.slice(1, -1)];
}

// Traced along cell edges, a slanted edge is a staircase of one-cell steps whose corners stray up to a cell from it:
// each step becomes its midpoint, within half a cell of the edge, and only corners between two longer runs stay, so
// simplifying keeps the edge without its staircase.
function straighten(points: readonly GridPoint[]): GridPoint[] {
  const step = (a: GridPoint, b: GridPoint): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
  const result: GridPoint[] = [];
  for (let at = 0; at < points.length; at++) {
    const previous = points[(at + points.length - 1) % points.length];
    const point = points[at];
    const next = points[(at + 1) % points.length];
    if (!step(previous, point) && !step(point, next)) result.push(point);
    if (step(point, next)) result.push([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]);
  }
  return result;
}

function gridArea(points: readonly GridPoint[]): number {
  return polygonArea(points.map(([x, y]) => ({ x, y })));
}

const GENERATED: Readonly<Record<MeshOutlines, string>> = { slice: 'slice on the obstacle line', projection: 'projection along the view' };

// The traced loops as the mesh's `type` of outlines within the level's limits, in the unit box: specks dropped, then
// simplified as little as fits.
function meshOutlines(grid: Grid, loops: readonly GridPoint[][], type: MeshOutlines): MeshCollision {
  const speck = Math.max(SPECK_CELLS, SPECK_SHARE * grid.columns * grid.rows);
  // A loop nested in another is smaller than it, so keeping the largest never keeps a hole without its outline.
  const kept = loops.filter((loop) => Math.abs(gridArea(loop)) >= speck)
    .sort((a, b) => Math.abs(gridArea(b)) - Math.abs(gridArea(a))).slice(0, LEVEL_LIMITS.meshLoops).map(straighten);
  if (kept.length === 0) fail(`The mesh's ${GENERATED[type]} is too small to collide with. Declare a collision type, or reshape it.`);
  const unit = (point: GridPoint) => ({
    x: Math.round((point[0] / grid.columns - 0.5) * DIGITS) / DIGITS + 0,
    y: Math.round((point[1] / grid.rows - 0.5) * DIGITS) / DIGITS + 0,
  });
  let problem = 'it has too much detail';
  for (const tolerance of TOLERANCES) {
    const simplified = kept.map((loop) => simplifyLoop(loop, tolerance)).filter((loop) => loop.length >= 3);
    const points = simplified.reduce((sum, loop) => sum + loop.length, 0);
    if (simplified.length === 0 || points > LEVEL_LIMITS.meshPoints || simplified.some((loop) => loop.length > LEVEL_LIMITS.polygonVertices)) continue;
    try {
      return validateMeshCollision({ type, loops: simplified.map((loop) => loop.map(unit)) });
    } catch (error) {
      if (!(error instanceof LevelError)) throw error;
      problem = error.message;
    }
  }
  fail(`The mesh's ${GENERATED[type]} could not be simplified to the level's limits (${problem}). Declare a collision type, or simplify the mesh.`);
}

// The mesh's `type` of outlines: its slice through the middle of its depth, or its projection along the view.
function generated(triangles: Triangles, type: MeshOutlines): MeshCollision {
  const grid = type === 'slice' ? sliceGrid(triangles, (triangles.min[2] + triangles.max[2]) / 2) : projectionGrid(triangles);
  joinCorners(grid);
  return meshOutlines(grid, traceOutlines(grid), type);
}

/** Reads a course GLB once, to bake at any turn. Fails with an ArtError naming what to change when it is not a course mesh. */
export function readCourseMesh(data: ArrayBuffer): CourseMesh {
  validateCourseModel(data);
  const { json, buffers } = readContainer(data);
  return Object.freeze({ ...sceneGeometry(json, buffers), declared: declaredCollision(json) });
}

/**
 * The terrain mesh of a read course GLB, `assetId` its asset ID, turned `turn` radians about its vertical axis, with its
 * collision: the shape it declares, whatever the turn, or else the turned mesh's slice on the obstacle line or, when it
 * declares it, its projection along the view. Fails with an ArtError naming what to change when the turned mesh has no
 * usable outlines.
 */
export function bakeMeshTerrain(assetId: string, mesh: CourseMesh, turn: number): MeshTerrain {
  if (!Number.isFinite(turn) || Math.abs(turn) > Math.PI) fail('A mesh turns between -π and π radians.');
  const triangles = turnedTriangles(mesh, turn);
  const [width, height, depth] = [0, 1, 2].map((axis) => triangles.max[axis] - triangles.min[axis]);
  if (Math.min(width, height, depth) < 0.000001) fail('Course meshes need nonzero width, height, and depth.');
  const { declared } = mesh;
  const collision = declared === 'slice' || declared === 'projection' ? generated(triangles, declared) : validateMeshCollision({ type: declared });
  return Object.freeze({ mesh: Object.freeze({ type: 'asset', assetId, turn, collision }), width, height, depth });
}

/** The terrain mesh of a course GLB, `assetId` its asset ID, turned `turn` radians: readCourseMesh, then bakeMeshTerrain. */
export function meshTerrain(assetId: string, data: ArrayBuffer, turn = 0): MeshTerrain {
  return bakeMeshTerrain(assetId, readCourseMesh(data), turn);
}

