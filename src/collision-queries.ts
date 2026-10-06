// Queries against engine-authored collision, not artwork bounds or Planck's welded chain approximation.
import type { Point } from './config';
import {
  geometryKey, LEVEL_LIMITS, LevelError, loopsPointLocation, objectLoops,
  polygonArea, shapeMesh, terrainCollision,
} from './level';
import type { Outline, PointLocation, TerrainCollision, TerrainObject } from './level';

export interface Bounds {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

export type QueryCounter = 'geometry' | 'spatialVisits' | 'cells' | 'samples' | 'reachCandidates' | 'graphNodes' | 'graphEdges';
export interface QueryWork {
  spend(counter: QueryCounter, amount?: number): void;
}

export class CollisionQueryError extends Error {
  readonly code: 'QUERY_CAPABILITY_UNSUPPORTED' | 'QUERY_WORK_LIMIT';
  readonly repair: string;

  constructor(code: CollisionQueryError['code'], message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'CollisionQueryError';
    this.code = code;
    this.repair = code === 'QUERY_WORK_LIMIT'
      ? 'Simplify or partition the authoring job, or explicitly raise its work budget.'
      : 'Use matching engine collision-query exports and validated collision geometry.';
  }
}

interface Entry<T> {
  readonly item: T;
  readonly bounds: Bounds;
}

type Tree<T> =
  | { readonly bounds: Bounds; readonly entries: readonly Entry<T>[] }
  | { readonly bounds: Bounds; readonly left: Tree<T>; readonly right: Tree<T> };

export interface CollisionEdge {
  readonly a: Readonly<Point>;
  readonly b: Readonly<Point>;
  readonly bounds: Bounds;
}

interface TemplateComponent {
  readonly loops: readonly number[];
  readonly edges: readonly number[];
  readonly tree: Tree<number>;
}

export type CollisionTemplate =
  | { readonly key: string; readonly collision: Extract<TerrainCollision, { type: 'circle' }> }
  | {
    readonly key: string;
    readonly collision: Extract<TerrainCollision, { type: 'loops' }>;
    readonly edges: readonly CollisionEdge[];
    readonly edgeIds: readonly number[];
    readonly tree: Tree<number>;
    readonly components: readonly TemplateComponent[];
  };

interface SolidBase {
  readonly object: TerrainObject;
  readonly bounds: Bounds;
}

export interface CircleSolid extends SolidBase {
  readonly type: 'circle';
  readonly center: Readonly<Point>;
  readonly radius: number;
}

export interface LoopSolid extends SolidBase {
  readonly type: 'loops';
  readonly loops: readonly Outline[];
  readonly edges: readonly CollisionEdge[];
  readonly edgeIds: readonly number[];
  readonly tree: Tree<number>;
}

export type Solid = CircleSolid | LoopSolid;
export interface CollisionPlacement {
  readonly solid: Solid;
  readonly components: readonly Solid[];
}

export type Intersection = 'disjoint' | 'touching' | 'overlapping';
/** The segment parameters between which points are strictly interior; endpoints may be boundary points. */
export type InteriorInterval = readonly [number, number];
export type StandingSurface =
  | { readonly type: 'edge'; readonly a: Readonly<Point>; readonly b: Readonly<Point>; readonly normal: Readonly<Point>; readonly length: number }
  | { readonly type: 'arc'; readonly center: Readonly<Point>; readonly radius: number; readonly from: number; readonly to: number; readonly length: number };

export const OVERLAP_RADIUS_TOLERANCE = 0.00005;
const LEAF_SIZE = 4;
const TAU = Math.PI * 2;

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.left <= b.right && b.left <= a.right && a.bottom <= b.top && b.bottom <= a.top;
}

export function unionBounds(bounds: readonly Bounds[]): Bounds | null {
  if (bounds.length === 0) return null;
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const box of bounds) {
    left = Math.min(left, box.left); right = Math.max(right, box.right);
    bottom = Math.min(bottom, box.bottom); top = Math.max(top, box.top);
  }
  return Object.freeze({ left, right, bottom, top });
}

function edgeBounds(a: Readonly<Point>, b: Readonly<Point>): Bounds {
  return Object.freeze({ left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), bottom: Math.min(a.y, b.y), top: Math.max(a.y, b.y) });
}

function finiteArithmetic(capability: string, values: readonly number[]): void {
  if (!values.every(Number.isFinite)) {
    throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', `Collision query requires finite ${capability}.`, { capability, values });
  }
}

function queryBounds(bounds: Bounds): void {
  finiteArithmetic('query bounds', [bounds.left, bounds.right, bounds.bottom, bounds.top]);
  if (bounds.left > bounds.right || bounds.bottom > bounds.top) {
    throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Collision query bounds cannot be inverted.', { capability: 'query bounds', bounds });
  }
}

function buildTree<T>(entries: Entry<T>[], work: QueryWork, counter: QueryCounter): Tree<T> {
  work.spend(counter, entries.length);
  const bounds = unionBounds(entries.map((entry) => entry.bounds))!;
  if (entries.length <= LEAF_SIZE) return Object.freeze({ bounds, entries: Object.freeze(entries.map((entry) => Object.freeze(entry))) });
  const horizontal = bounds.right - bounds.left >= bounds.top - bounds.bottom;
  entries.sort((a, b) => {
    work.spend(counter);
    return horizontal
      ? (a.bounds.left + a.bounds.right) - (b.bounds.left + b.bounds.right)
      : (a.bounds.bottom + a.bounds.top) - (b.bounds.bottom + b.bounds.top);
  });
  const middle = Math.floor(entries.length / 2);
  return Object.freeze({
    bounds, left: buildTree(entries.slice(0, middle), work, counter), right: buildTree(entries.slice(middle), work, counter),
  });
}

function queryTree<T>(root: Tree<T>, bounds: Bounds, work: QueryWork, counter: QueryCounter, visit: (item: T) => void): void {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    work.spend(counter);
    if (!boundsIntersect(node.bounds, bounds)) continue;
    if ('entries' in node) {
      for (const entry of node.entries) {
        work.spend(counter);
        if (boundsIntersect(entry.bounds, bounds)) visit(entry.item);
      }
    } else stack.push(node.left, node.right);
  }
}

/** A balanced, non-replicating broad phase. Each query accounts for every visited node and candidate. */
export class BoundsIndex<T> {
  private readonly root: Tree<T> | null;

  constructor(items: readonly T[], bounds: (item: T) => Bounds, work: QueryWork) {
    work.spend('spatialVisits', items.length);
    const entries = items.map((item) => {
      const box = bounds(item);
      queryBounds(box);
      return { item, bounds: Object.freeze({ ...box }) };
    });
    this.root = entries.length === 0 ? null : buildTree(entries, work, 'spatialVisits');
  }

  query(bounds: Bounds, work: QueryWork): T[] {
    queryBounds(bounds);
    const result: T[] = [];
    if (this.root !== null) queryTree(this.root, bounds, work, 'spatialVisits', (item) => result.push(item));
    return result;
  }
}

function loopEdges(loops: readonly Outline[], work: QueryWork): CollisionEdge[] {
  const edges: CollisionEdge[] = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      work.spend('geometry');
      const a = loop[i], b = loop[(i + 1) % loop.length];
      finiteArithmetic('edge coordinates', [a.x, a.y, b.x, b.y]);
      const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (!Number.isFinite(lengthSquared) || lengthSquared <= 0) {
        throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'A collision edge has no usable length at numerical precision.',
          { capability: 'nonzero placed edges', a, b });
      }
      edges.push(Object.freeze({ a, b, bounds: edgeBounds(a, b) }));
    }
  }
  return edges;
}

/** Compile only normalized topology. A job caches this by geometryKey, never by a world placement. */
export function compileCollision(object: Pick<TerrainObject, 'mesh' | 'mirror'>, work: QueryWork): CollisionTemplate {
  const collision = terrainCollision(object);
  const key = geometryKey(object);
  if (collision.type === 'circle') return Object.freeze({ key, collision });
  if (collision.type !== 'loops') {
    throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Unsupported engine collision discriminator.', { collision });
  }
  const loops = collision.loops;
  if (loops.length === 0 || loops.length > LEVEL_LIMITS.sliceLoops) throw new LevelError('Collision queries require loops within LEVEL_LIMITS.');
  const vertices = loops.reduce((sum, loop) => sum + loop.length, 0);
  if (vertices > LEVEL_LIMITS.sliceVertices ||
    loops.some((loop) => loop.length < 3 || loop.length > LEVEL_LIMITS.polygonVertices)) {
    throw new LevelError('Collision queries require loops within LEVEL_LIMITS.');
  }
  work.spend('geometry', vertices);
  const areas = loops.map((loop) => Math.abs(polygonArea(loop)));
  const parents = loops.map((loop, at) => {
    let parent = -1;
    for (let i = 0; i < loops.length; i++) {
      if (i === at) continue;
      work.spend('geometry', loops[i].length);
      if (loopsPointLocation([loops[i]], loop[0], 0) === 'inside' && (parent < 0 || areas[i] < areas[parent])) parent = i;
    }
    return parent;
  });
  const depths = parents.map((parent) => {
    let depth = 0;
    for (let at = parent; at >= 0; at = parents[at]) {
      work.spend('geometry');
      if (++depth > loops.length) throw new LevelError('Collision loop nesting must be acyclic.');
    }
    return depth;
  });
  const edges = Object.freeze(loopEdges(loops, work));
  const edgeIds = Object.freeze(edges.map((_, id) => id));
  const starts: number[] = [];
  let start = 0;
  for (const loop of loops) { starts.push(start); start += loop.length; }
  const treeFor = (ids: readonly number[]) => buildTree(ids.map((id) => ({ item: id, bounds: edges[id].bounds })), work, 'geometry');
  const tree = treeFor(edgeIds);
  const components: TemplateComponent[] = [];
  for (let i = 0; i < loops.length; i++) {
    if (depths[i] % 2 !== 0) continue;
    const members = [i, ...parents.flatMap((parent, at) => parent === i ? [at] : [])];
    const ids = members.flatMap((at) => Array.from({ length: loops[at].length }, (_, edge) => starts[at] + edge));
    components.push(Object.freeze({
      loops: Object.freeze(members), edges: Object.freeze(ids), tree: ids.length === edges.length ? tree : treeFor(ids),
    }));
  }
  return Object.freeze({ key, collision, edges, edgeIds, tree, components: Object.freeze(components) });
}

function refitTree(tree: Tree<number>, edges: readonly CollisionEdge[], work: QueryWork): Tree<number> {
  work.spend('geometry');
  if ('entries' in tree) {
    const entries = tree.entries.map(({ item }) => Object.freeze({ item, bounds: edges[item].bounds }));
    return Object.freeze({ bounds: unionBounds(entries.map((entry) => entry.bounds))!, entries: Object.freeze(entries) });
  }
  const left = refitTree(tree.left, edges, work), right = refitTree(tree.right, edges, work);
  return Object.freeze({ bounds: unionBounds([left.bounds, right.bounds])!, left, right });
}

export function placeCollision(object: TerrainObject, template: CollisionTemplate, work: QueryWork): CollisionPlacement {
  if (![object.x, object.y, object.width, object.height, object.angle].every(Number.isFinite) || object.width <= 0 || object.height <= 0) {
    throw new LevelError('Collision placements need finite positions, rotation and positive dimensions.');
  }
  if (geometryKey(object) !== template.key) {
    throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Collision template does not match this placement.', { objectId: object.id, key: template.key });
  }
  work.spend('geometry');
  if (template.collision.type === 'circle') {
    if (object.width !== object.height) throw new LevelError('A circle must have equal width and height.');
    const radius = object.width / 2;
    const solid: CircleSolid = Object.freeze({
      type: 'circle', object, center: Object.freeze({ x: object.x, y: object.y }), radius,
      bounds: Object.freeze({ left: object.x - radius, right: object.x + radius, bottom: object.y - radius, top: object.y + radius }),
    });
    return Object.freeze({ solid, components: Object.freeze([solid]) });
  }
  // TypeScript cannot narrow a union by a discriminator nested in another property.
  if (!('tree' in template)) throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Loop template has no topology.', { key: template.key });
  if (terrainCollision(object).type !== 'loops') throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Placement has no collision loops.', { objectId: object.id });
  work.spend('geometry', template.edges.length);
  const loops = Object.freeze(objectLoops(object).map((loop) => Object.freeze(loop.map((p) => Object.freeze(p)))));
  const edges = Object.freeze(loopEdges(loops, work));
  const tree = refitTree(template.tree, edges, work);
  const solid: LoopSolid = Object.freeze({
    type: 'loops', object, bounds: tree.bounds, loops, edges, edgeIds: template.edgeIds, tree,
  });
  const components = template.components.map((component): LoopSolid => {
    if (component.edges.length === edges.length) return solid;
    const componentTree = refitTree(component.tree, edges, work);
    return Object.freeze({
      type: 'loops', object, bounds: componentTree.bounds,
      loops: Object.freeze(component.loops.map((id) => loops[id])),
      edges, edgeIds: component.edges, tree: componentTree,
    });
  });
  return Object.freeze({ solid, components: Object.freeze(components) });
}

/** A deliberate query region, using the engine's canonical box, not a terrain-bounds collision substitute. */
export function rectangleSolid(bounds: Bounds, template: CollisionTemplate, work: QueryWork): Solid {
  if (![bounds.left, bounds.right, bounds.bottom, bounds.top].every(Number.isFinite) ||
    bounds.left >= bounds.right || bounds.bottom >= bounds.top) throw new LevelError('A query rectangle needs finite, positive bounds.');
  const width = bounds.right - bounds.left, height = bounds.top - bounds.bottom;
  if (![width, height].every(Number.isFinite)) throw new LevelError('Query rectangle dimensions must stay finite.');
  const object: TerrainObject = Object.freeze({
    kind: 'terrain', id: 'query-region', mesh: shapeMesh('box'),
    x: bounds.left / 2 + bounds.right / 2, y: bounds.bottom / 2 + bounds.top / 2, width, height,
    angle: 0, mirror: false, depth: 1, color: 0, illusion: false, surface: 'rock',
  });
  return placeCollision(object, template, work).solid;
}

export function pointLocation(solid: Solid, p: Readonly<Point>, work: QueryWork): PointLocation {
  finiteArithmetic('point coordinates', [p.x, p.y]);
  work.spend('geometry', solid.type === 'circle' ? 1 : solid.edgeIds.length);
  if (p.x < solid.bounds.left || p.x > solid.bounds.right || p.y < solid.bounds.bottom || p.y > solid.bounds.top) return 'outside';
  if (solid.type === 'circle') {
    const squared = (p.x - solid.center.x) ** 2 + (p.y - solid.center.y) ** 2;
    finiteArithmetic('circle point arithmetic', [squared, solid.radius ** 2]);
    return squared < solid.radius ** 2 ? 'inside' : squared === solid.radius ** 2 ? 'boundary' : 'outside';
  }
  // The contact tolerance must not classify nearly coincident *contained* solids as mere touching.
  // Use the same engine parity predicate on objectLoops, with strict boundary membership.
  return loopsPointLocation(solid.loops, p, 0);
}

function pointSegmentDistance(p: Readonly<Point>, a: Readonly<Point>, b: Readonly<Point>): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const projection = (p.x - a.x) * dx + (p.y - a.y) * dy, lengthSquared = dx * dx + dy * dy;
  finiteArithmetic('distance arithmetic', [projection, lengthSquared]);
  const t = Math.max(0, Math.min(1, projection / lengthSquared));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function pointBoundsDistance(p: Readonly<Point>, bounds: Bounds): number {
  return Math.hypot(Math.max(bounds.left - p.x, 0, p.x - bounds.right), Math.max(bounds.bottom - p.y, 0, p.y - bounds.top));
}

function boundaryDistance(solid: LoopSolid, p: Readonly<Point>, work: QueryWork): number {
  let best = Infinity;
  const stack = [solid.tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    work.spend('geometry');
    if (pointBoundsDistance(p, node.bounds) >= best) continue;
    if ('entries' in node) {
      for (const { item, bounds } of node.entries) {
        work.spend('geometry');
        if (pointBoundsDistance(p, bounds) >= best) continue;
        const edge = solid.edges[item];
        best = Math.min(best, pointSegmentDistance(p, edge.a, edge.b));
      }
    } else {
      const left = pointBoundsDistance(p, node.left.bounds), right = pointBoundsDistance(p, node.right.bounds);
      if (left < right) stack.push(node.right, node.left);
      else stack.push(node.left, node.right);
    }
  }
  return best;
}

export function signedDistance(solid: Solid, p: Readonly<Point>, work: QueryWork): number {
  finiteArithmetic('point coordinates', [p.x, p.y]);
  if (solid.type === 'circle') {
    work.spend('geometry');
    return solid.radius - Math.hypot(p.x - solid.center.x, p.y - solid.center.y);
  }
  const location = pointLocation(solid, p, work);
  if (location === 'boundary') return 0;
  const distance = boundaryDistance(solid, p, work);
  return location === 'inside' ? distance : -distance;
}

function at(a: Readonly<Point>, b: Readonly<Point>, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Roundoff bounds, not authoring seam allowances or a centimetre-scale geometric tolerance.
function roundoff(...terms: number[]): number {
  return Number.EPSILON * 16 * Math.max(1, ...terms.map(Math.abs));
}

interface SegmentContact {
  readonly cuts: readonly number[];
  readonly proper: boolean;
  readonly sameSide: boolean;
  readonly coincident: InteriorInterval | null;
}

function segmentContact(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Point>, d: Readonly<Point>): SegmentContact | null {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
  const qx = c.x - a.x, qy = c.y - a.y;
  const denominator = dx * ey - dy * ex;
  finiteArithmetic('segment arithmetic', [denominator, qx * ey - qy * ex, qx * dy - qy * dx, dx * dx + dy * dy]);
  if (Math.abs(denominator) > roundoff(dx * ey, dy * ex)) {
    const t = (qx * ey - qy * ex) / denominator, u = (qx * dy - qy * dx) / denominator;
    const error = roundoff(t, u);
    if (t < -error || t > 1 + error || u < -error || u > 1 + error) return null;
    return {
      cuts: [Math.max(0, Math.min(1, t))], proper: t > error && t < 1 - error && u > error && u < 1 - error,
      sameSide: false, coincident: null,
    };
  }
  if (Math.abs(qx * dy - qy * dx) > roundoff(qx * dy, qy * dx)) return null;
  const lengthSquared = dx * dx + dy * dy;
  const from = (qx * dx + qy * dy) / lengthSquared;
  const to = ((d.x - a.x) * dx + (d.y - a.y) * dy) / lengthSquared;
  const low = Math.max(0, Math.min(from, to)), high = Math.min(1, Math.max(from, to));
  if (low > high) return null;
  // Solid is left of every oriented edge, including holes and engine-mirrored loops.
  return {
    cuts: [low, high], proper: false, sameSide: high > low && dx * ex + dy * ey > 0,
    coincident: high > low ? [low, high] : null,
  };
}

function circleCuts(circle: CircleSolid, a: Readonly<Point>, b: Readonly<Point>): number[] {
  const dx = b.x - a.x, dy = b.y - a.y, px = a.x - circle.center.x, py = a.y - circle.center.y;
  const aa = dx * dx + dy * dy, bb = 2 * (px * dx + py * dy), cc = px * px + py * py - circle.radius ** 2;
  if (aa <= 0) throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'A segment has no usable length at numerical precision.',
    { capability: 'nonzero squared segment length', a, b });
  const discriminant = bb * bb - 4 * aa * cc;
  finiteArithmetic('circle/segment arithmetic', [aa, bb, cc, discriminant]);
  if (discriminant < -roundoff(bb * bb, 4 * aa * cc)) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  // The stable quadratic formula retains a small root near an endpoint.
  const q = -0.5 * (bb + (bb < 0 ? -root : root));
  const values = q === 0 ? [-bb / (2 * aa)] : [q / aa, cc / q];
  return values.filter((t) => t >= -roundoff(t) && t <= 1 + roundoff(t)).map((t) => Math.max(0, Math.min(1, t)));
}

interface SegmentCuts {
  readonly cuts: number[];
  readonly boundaries: InteriorInterval[];
  touching: boolean;
  overlapping: boolean;
}

function boundaryCuts(solid: Solid, a: Readonly<Point>, b: Readonly<Point>, work: QueryWork): SegmentCuts {
  const result: SegmentCuts = { cuts: [0, 1], boundaries: [], touching: false, overlapping: false };
  if (solid.type === 'circle') {
    work.spend('geometry');
    const cuts = circleCuts(solid, a, b);
    result.cuts.push(...cuts);
    result.touching = cuts.length > 0;
  } else {
    queryTree(solid.tree, edgeBounds(a, b), work, 'geometry', (id) => {
      const edge = solid.edges[id];
      const contact = segmentContact(a, b, edge.a, edge.b);
      if (contact === null) return;
      result.cuts.push(...contact.cuts);
      if (contact.coincident !== null) result.boundaries.push(contact.coincident);
      result.touching = true;
      result.overlapping ||= contact.proper || contact.sameSide;
    });
  }
  result.cuts.sort((one, two) => one - two);
  return result;
}

function interiorIntervals(
  solid: Solid, a: Readonly<Point>, b: Readonly<Point>, cuts: readonly number[], work: QueryWork,
  boundaries: readonly InteriorInterval[] = [],
): InteriorInterval[] {
  const intervals: InteriorInterval[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1], to = cuts[i];
    if (to <= from) continue;
    const middle = (from + to) / 2;
    work.spend('geometry', boundaries.length);
    if (boundaries.some(([low, high]) => middle >= low && middle <= high)) continue;
    if (pointLocation(solid, at(a, b, middle), work) === 'inside') intervals.push(Object.freeze([from, to]));
  }
  return intervals;
}

/** Split at every analytic boundary event, then classify each constant-location open interval. */
export function segmentInteriorIntervals(solid: Solid, a: Readonly<Point>, b: Readonly<Point>, work: QueryWork): readonly InteriorInterval[] {
  finiteArithmetic('segment coordinates', [a.x, a.y, b.x, b.y]);
  if (a.x === b.x && a.y === b.y) return pointLocation(solid, a, work) === 'inside' ? [[0, 1]] : [];
  if (!boundsIntersect(solid.bounds, edgeBounds(a, b))) return [];
  const { cuts, boundaries } = boundaryCuts(solid, a, b, work);
  return Object.freeze(interiorIntervals(solid, a, b, cuts, work, boundaries));
}

function loopsIntersection(a: LoopSolid, b: LoopSolid, work: QueryWork): Intersection {
  let touching = false;
  for (const [one, two] of [[a, b], [b, a]]) {
    for (const id of one.edgeIds) {
      work.spend('geometry');
      const edge = one.edges[id];
      const events = boundaryCuts(two, edge.a, edge.b, work);
      if (events.overlapping || interiorIntervals(two, edge.a, edge.b, events.cuts, work, events.boundaries).length > 0) return 'overlapping';
      touching ||= events.touching;
    }
  }
  return touching ? 'touching' : 'disjoint';
}

function circleLoopsIntersection(circle: CircleSolid, loops: LoopSolid, work: QueryWork): Intersection {
  const angles = [0, TAU];
  let touching = false;
  for (const id of loops.edgeIds) {
    work.spend('geometry');
    const edge = loops.edges[id];
    if (!boundsIntersect(edge.bounds, circle.bounds)) continue;
    const roots = circleCuts(circle, edge.a, edge.b);
    const cuts = [0, 1, ...roots].sort((a, b) => a - b);
    if (interiorIntervals(circle, edge.a, edge.b, cuts, work).length > 0) return 'overlapping';
    touching ||= roots.length > 0;
    for (const t of roots) {
      const p = at(edge.a, edge.b, t);
      angles.push((Math.atan2(p.y - circle.center.y, p.x - circle.center.x) + TAU) % TAU);
    }
  }
  angles.sort((a, b) => a - b);
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] <= angles[i - 1]) continue;
    const angle = (angles[i - 1] + angles[i]) / 2;
    const p = { x: circle.center.x + circle.radius * Math.cos(angle), y: circle.center.y + circle.radius * Math.sin(angle) };
    const location = pointLocation(loops, p, work);
    if (location === 'inside') return 'overlapping';
    touching ||= location === 'boundary';
  }
  return touching ? 'touching' : 'disjoint';
}

/** Interior intersection, including containment and coincident boundaries with solid on the same side. */
export function intersection(a: Solid, b: Solid, work: QueryWork): Intersection {
  work.spend('geometry');
  if (!boundsIntersect(a.bounds, b.bounds)) return 'disjoint';
  if (a.type === 'circle' && b.type === 'circle') {
    const distance = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
    return distance < a.radius + b.radius ? 'overlapping' : distance === a.radius + b.radius ? 'touching' : 'disjoint';
  }
  if (a.type === 'loops' && b.type === 'loops') return loopsIntersection(a, b, work);
  if (a.type === 'circle' && b.type === 'loops') return circleLoopsIntersection(a, b, work);
  if (a.type === 'loops' && b.type === 'circle') return circleLoopsIntersection(b, a, work);
  throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Unsupported intersection query.', { capability: 'solid discriminators', a, b });
}

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly half: number;
  readonly upper: number;
}

class CellQueue {
  private readonly items: Cell[] = [];

  get length(): number { return this.items.length; }

  push(cell: Cell): void {
    let at = this.items.length;
    this.items.push(cell);
    while (at > 0) {
      const parent = Math.floor((at - 1) / 2);
      if (this.items[parent].upper >= cell.upper) break;
      this.items[at] = this.items[parent];
      at = parent;
    }
    this.items[at] = cell;
  }

  pop(): Cell {
    const first = this.items[0], last = this.items.pop()!;
    if (this.items.length === 0) return first;
    let at = 0;
    while (at * 2 + 1 < this.items.length) {
      let child = at * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].upper > this.items[child].upper) child++;
      if (this.items[child].upper <= last.upper) break;
      this.items[at] = this.items[child];
      at = child;
    }
    this.items[at] = last;
    return first;
  }
}

// A threshold search returns a witness radius, not a measured maximum. Both searches share cell bounds and accounting.
function overlapRadius(a: Solid, b: Solid, work: QueryWork, radiusTolerance: number, threshold: number | null): number {
  if (intersection(a, b, work) !== 'overlapping') return 0;
  const bounds: Bounds = {
    left: Math.max(a.bounds.left, b.bounds.left), right: Math.min(a.bounds.right, b.bounds.right),
    bottom: Math.max(a.bounds.bottom, b.bounds.bottom), top: Math.min(a.bounds.top, b.bounds.top),
  };
  const width = bounds.right - bounds.left, height = bounds.top - bounds.bottom;
  if (width <= 0 || height <= 0) return 0;
  const maximum = Math.min(width / 2, height / 2, a.type === 'circle' ? a.radius : Infinity, b.type === 'circle' ? b.radius : Infinity);
  if (threshold !== null && maximum <= threshold) return 0;
  if (a.type === 'circle' && b.type === 'circle') {
    return Math.max(0, Math.min(a.radius, b.radius,
      (a.radius + b.radius - Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)) / 2));
  }
  const queue = new CellQueue();
  let best = 0;
  const add = (x: number, y: number, half: number) => {
    work.spend('cells');
    if (!boundsIntersect(bounds, { left: x - half, right: x + half, bottom: y - half, top: y + half })) return false;
    const value = Math.min(signedDistance(a, { x, y }, work), signedDistance(b, { x, y }, work));
    best = Math.max(best, value);
    if (threshold !== null && value > threshold) return true;
    const upper = Math.min(maximum, value + half * Math.SQRT2);
    if (upper > (threshold ?? best + radiusTolerance)) queue.push({ x, y, half, upper });
    return false;
  };
  if (add((bounds.left + bounds.right) / 2, (bounds.bottom + bounds.top) / 2, Math.max(width, height) / 2)) return best;
  while (queue.length > 0) {
    work.spend('cells');
    const cell = queue.pop();
    if (cell.upper <= (threshold ?? best + radiusTolerance)) break;
    const half = cell.half / 2;
    if (add(cell.x - half, cell.y - half, half) || add(cell.x + half, cell.y - half, half) ||
      add(cell.x - half, cell.y + half, half) || add(cell.x + half, cell.y + half, half)) return best;
  }
  return best;
}

/**
 * Decide whether inscribed-disk thickness strictly exceeds an allowance, without measuring its maximum.
 * Signed distances and their minimum are 1-Lipschitz: f(center) + half * sqrt(2) bounds a cell.
 * A value above allowance / 2 proves a violation; an upper bound at or below it prunes the cell.
 */
export function overlapExceeds(a: Solid, b: Solid, allowance: number, work: QueryWork): boolean {
  if (!Number.isFinite(allowance) || allowance < 0) {
    throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Overlap allowance must be finite and nonnegative.',
      { capability: 'overlap allowance', allowance });
  }
  const threshold = allowance / 2;
  return overlapRadius(a, b, work, 0, threshold) > threshold;
}

/**
 * Thickness of the overlap: the diameter of its largest inscribed disk, within twice radiusTolerance (0.1 mm by default).
 * For an axis-aligned rectangular overlap this is its shorter side, exactly the old minimum
 * projection-overlap depth (identical, contained, corner and sliver box overlaps included).
 * For convex solids on unchanged geometry each projection overlap contains the overlap region's projection, which
 * contains the inscribed disk's diameter. Thus thickness never exceeds the old SAT depth.
 */
export function overlapDepth(a: Solid, b: Solid, work: QueryWork, radiusTolerance = OVERLAP_RADIUS_TOLERANCE): number {
  if (!Number.isFinite(radiusTolerance) || radiusTolerance <= 0) {
    throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Overlap radius tolerance must be finite and positive.',
      { capability: 'overlap radius tolerance', radiusTolerance });
  }
  return 2 * overlapRadius(a, b, work, radiusTolerance, null);
}

function boundsDistance(a: Bounds, b: Bounds): number {
  return Math.hypot(Math.max(a.left - b.right, b.left - a.right, 0), Math.max(a.bottom - b.top, b.bottom - a.top, 0));
}

function segmentDistance(a: CollisionEdge, b: CollisionEdge): number {
  if (segmentContact(a.a, a.b, b.a, b.b) !== null) return 0;
  return Math.min(
    pointSegmentDistance(a.a, b.a, b.b), pointSegmentDistance(a.b, b.a, b.b),
    pointSegmentDistance(b.a, a.a, a.b), pointSegmentDistance(b.b, a.a, a.b),
  );
}

/** Minimum solid-to-solid gap, including hole boundaries; pass component solids to enforce component clearance. */
export function separation(a: Solid, b: Solid, work: QueryWork): number {
  if (intersection(a, b, work) !== 'disjoint') return 0;
  if (a.type === 'circle' && b.type === 'circle') return Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) - a.radius - b.radius;
  if (a.type === 'circle' && b.type === 'loops') return Math.max(0, boundaryDistance(b, a.center, work) - a.radius);
  if (a.type === 'loops' && b.type === 'circle') return Math.max(0, boundaryDistance(a, b.center, work) - b.radius);
  if (a.type !== 'loops' || b.type !== 'loops') throw new CollisionQueryError('QUERY_CAPABILITY_UNSUPPORTED', 'Unsupported separation query.', { a: a.type, b: b.type });
  let best = Infinity;
  const stack: [Tree<number>, Tree<number>][] = [[a.tree, b.tree]];
  while (stack.length > 0) {
    const [one, two] = stack.pop()!;
    work.spend('geometry');
    if (boundsDistance(one.bounds, two.bounds) >= best) continue;
    if ('entries' in one && 'entries' in two) {
      for (const first of one.entries) {
        for (const second of two.entries) {
          work.spend('geometry');
          if (boundsDistance(first.bounds, second.bounds) < best) best = Math.min(best, segmentDistance(a.edges[first.item], b.edges[second.item]));
        }
      }
    } else if ('entries' in one) {
      if (!('entries' in two)) stack.push([one, two.left], [one, two.right]);
    } else if ('entries' in two) stack.push([one.left, two], [one.right, two]);
    else {
      const oneSize = (one.bounds.right - one.bounds.left) + (one.bounds.top - one.bounds.bottom);
      const twoSize = (two.bounds.right - two.bounds.left) + (two.bounds.top - two.bounds.bottom);
      if (oneSize >= twoSize) stack.push([one.left, two], [one.right, two]);
      else stack.push([one, two.left], [one, two.right]);
    }
  }
  return best;
}

/** Normals are taken after placement. Clockwise hole floors face up; hole ceilings do not. */
export function standingSurfaces(solid: Solid, minUp: number, work: QueryWork): readonly StandingSurface[] {
  if (!Number.isFinite(minUp) || minUp <= 0 || minUp > 1) throw new LevelError('Standing surfaces require an upward normal in (0, 1].');
  if (solid.type === 'circle') {
    work.spend('geometry');
    const slope = Math.acos(minUp), from = Math.PI / 2 - slope, to = Math.PI / 2 + slope;
    return [Object.freeze({ type: 'arc', center: solid.center, radius: solid.radius, from, to, length: solid.radius * (to - from) })];
  }
  const surfaces: StandingSurface[] = [];
  for (const id of solid.edgeIds) {
    work.spend('geometry');
    const { a, b } = solid.edges[id];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const normal = Object.freeze({ x: dy / length, y: -dx / length });
    if (normal.y >= minUp) surfaces.push(Object.freeze({ type: 'edge', a, b, normal, length }));
  }
  return Object.freeze(surfaces);
}
