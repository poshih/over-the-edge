// Checks for a generated course: level validation and budgets, overlaps between separately built
// groups, and a conservative reach graph that must lead from the start to the ending.
import { outline } from './course.mjs';

/**
 * What a connector may ask of the player under the engine's default physics: the shoulder rides 1.15 m
 * above the pot's base, and a lip within about 2.5 m of it can be pulled over (see
 * src/editor/set-pieces.ts). Connectors stay inside easier limits, so the difficulty of a course lives in
 * its set pieces. `maxStandSlope` is the steepest face, in degrees, the pot is assumed to rest on.
 *
 * A project passes its own model when its physics differ. Above all, the pot's grip on terrain is
 * sqrt(terrainFriction * potFriction) and it slides on slopes steeper than atan(grip): a game with lower
 * terrain or pot friction stands on fewer slopes, so it lowers `maxStandSlope`, and a longer or shorter
 * rig changes `shoulder`, `pull` and `rise`.
 */
export const ENGINE_DEFAULT_REACH = Object.freeze({ shoulder: 1.15, pull: 2.35, rise: 2.5, hop: 1.9, drop: 9, maxStandSlope: 40 });
const REACH_FIELDS = Object.keys(ENGINE_DEFAULT_REACH);

export class ReachModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReachModelError';
  }
}

/** Validates a reach model and adds `standNormal`, the least upward share of a face's normal the pot stands on. */
function reachRules(model) {
  if (model === null || typeof model !== 'object') throw new ReachModelError('A reach model is required; pass ENGINE_DEFAULT_REACH or your own.');
  const unknown = Object.keys(model).filter((field) => !REACH_FIELDS.includes(field));
  if (unknown.length > 0) throw new ReachModelError(`Unknown reach model fields: ${unknown.join(', ')}. Expected ${REACH_FIELDS.join(', ')}.`);
  for (const field of REACH_FIELDS) {
    const value = model[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ReachModelError(`Reach model field "${field}" must be a finite positive number of metres (degrees for maxStandSlope).`);
    }
  }
  if (model.maxStandSlope >= 90) throw new ReachModelError('Reach model field "maxStandSlope" must be between 0 and 90 degrees.');
  return { ...model, standNormal: Math.cos(model.maxStandSlope * Math.PI / 180) };
}

// Small colliders, about the pot's size or less (it is 1 m wide), must stay farther apart than the pot is
// wide: a narrower slot between them traps the pot or the hammer head.
export const CRAMPED = { small: 1.5, clearance: 1.2 };
const SAMPLE = 0.3;
const CELL = 3;

function contains(polygon, point) {
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) < -1e-9) return false;
  }
  return true;
}

/** Overlap depth of two convex outlines along their separating axes; zero when they only touch. */
export function penetration(first, second) {
  let depth = Infinity;
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-9) continue;
      const axis = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
      const project = (points) => points.map((point) => point.x * axis.x + point.y * axis.y);
      const one = project(first);
      const two = project(second);
      const overlap = Math.min(Math.max(...one), Math.max(...two)) - Math.max(Math.min(...one), Math.min(...two));
      if (overlap <= 0) return 0;
      depth = Math.min(depth, overlap);
    }
  }
  return depth;
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

/** The gap between two convex outlines; zero when they touch or overlap. */
export function separation(first, second) {
  if (penetration(first, second) > 0) return 0;
  let gap = Infinity;
  for (const [points, polygon] of [[first, second], [second, first]]) {
    for (const point of points) {
      for (let index = 0; index < polygon.length; index++) gap = Math.min(gap, segmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
    }
  }
  return gap;
}

function boundsOf(points) {
  return {
    left: Math.min(...points.map((point) => point.x)), right: Math.max(...points.map((point) => point.x)),
    bottom: Math.min(...points.map((point) => point.y)), top: Math.max(...points.map((point) => point.y)),
  };
}

class Grid {
  constructor() { this.cells = new Map(); }
  key(x, y) { return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`; }
  insert(item, bounds) {
    for (let x = Math.floor(bounds.left / CELL); x <= Math.floor(bounds.right / CELL); x++) {
      for (let y = Math.floor(bounds.bottom / CELL); y <= Math.floor(bounds.top / CELL); y++) {
        const key = `${x},${y}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(item);
      }
    }
  }
  near(x, y, radius = 0) {
    const found = new Set();
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
      for (let cy = Math.floor((y - radius) / CELL); cy <= Math.floor((y + radius) / CELL); cy++) {
        for (const item of this.cells.get(`${cx},${cy}`) ?? []) found.add(item);
      }
    }
    return found;
  }
}

export function solidIndex(level) {
  const solids = level.objects.filter((object) => object.kind === 'terrain').map((object) => {
    const polygon = outline(object);
    return { object, polygon, bounds: boundsOf(polygon) };
  });
  const grid = new Grid();
  for (const solid of solids) grid.insert(solid, solid.bounds);
  const inside = (point, ignore = null) => {
    for (const solid of grid.near(point.x, point.y)) {
      if (solid.object === ignore || solid.object.illusion) continue;
      if (point.x < solid.bounds.left || point.x > solid.bounds.right || point.y < solid.bounds.bottom || point.y > solid.bounds.top) continue;
      if (contains(solid.polygon, point)) return solid.object;
    }
    return null;
  };
  return { solids, grid, inside };
}

/** Terrain of different groups must not overlap; enemies must not start inside terrain. */
export function overlaps(level, groups, supports = new Set()) {
  const { solids, grid } = solidIndex(level);
  const problems = [];
  for (const solid of solids) {
    for (const other of grid.near((solid.bounds.left + solid.bounds.right) / 2, (solid.bounds.bottom + solid.bounds.top) / 2,
      Math.max(solid.bounds.right - solid.bounds.left, solid.bounds.top - solid.bounds.bottom) / 2 + CELL)) {
      if (other.object.id <= solid.object.id) continue;
      const a = groups.get(solid.object.id).group;
      const b = groups.get(other.object.id).group;
      // Only a set piece's own parts must stay clear; its ground may merge with anything but other pieces.
      const part = (object, group) => group.startsWith('piece:') && !supports.has(object.id);
      if (a === b || (!part(solid.object, a) && !part(other.object, b))) continue;
      if (solid.bounds.right <= other.bounds.left || other.bounds.right <= solid.bounds.left ||
        solid.bounds.top <= other.bounds.bottom || other.bounds.top <= solid.bounds.bottom) continue;
      const depth = penetration(solid.polygon, other.polygon);
      if (depth > 0.03) problems.push(`${solid.object.id} overlaps ${other.object.id} by ${depth.toFixed(2)} m`);
    }
  }
  for (const enemy of level.objects.filter((object) => object.kind === 'enemy')) {
    const half = enemy.species === 'bird' ? { x: 0.26, y: 0.26 } : { x: 0.26, y: 0.7 };
    const box = [
      { x: enemy.x - half.x, y: enemy.y - half.y }, { x: enemy.x + half.x, y: enemy.y - half.y },
      { x: enemy.x + half.x, y: enemy.y + half.y }, { x: enemy.x - half.x, y: enemy.y + half.y },
    ];
    for (const solid of grid.near(enemy.x, enemy.y, 1)) {
      if (penetration(box, solid.polygon) > 0.02) problems.push(`${enemy.id} starts inside ${solid.object.id}`);
    }
  }
  return problems;
}

/**
 * No two small colliders may lie within the clearance of each other, touching included: dress a course with
 * decorations, never with terrain props. A set piece's own parts are designed and tested together, so only
 * they may sit close.
 */
export function crampedColliders(level, groups) {
  const { solids, grid } = solidIndex(level);
  const size = (bounds) => Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom);
  const small = new Set(solids.filter((solid) => size(solid.bounds) <= CRAMPED.small));
  const problems = [];
  for (const solid of small) {
    const center = { x: (solid.bounds.left + solid.bounds.right) / 2, y: (solid.bounds.bottom + solid.bounds.top) / 2 };
    for (const other of grid.near(center.x, center.y, CRAMPED.small + CRAMPED.clearance + CELL)) {
      if (!small.has(other) || other.object.id <= solid.object.id) continue;
      const group = groups.get(solid.object.id).group;
      if (group.startsWith('piece:') && group === groups.get(other.object.id).group) continue;
      const gap = separation(solid.polygon, other.polygon);
      if (gap < CRAMPED.clearance) problems.push(`${solid.object.id} and ${other.object.id} are small colliders ${gap.toFixed(2)} m apart`);
    }
  }
  return problems;
}

/** Nothing built outside a set piece may reach into its bounds, so its designed moves stay open. */
export function keepOut(level, groups, pieces, allowed = new Set()) {
  const { grid } = solidIndex(level);
  const problems = [];
  for (const piece of pieces) {
    const box = piece.bounds;
    const inner = [
      { x: box.left + 0.1, y: box.bottom + 0.1 }, { x: box.right - 0.1, y: box.bottom + 0.1 },
      { x: box.right - 0.1, y: box.top - 0.1 }, { x: box.left + 0.1, y: box.top - 0.1 },
    ];
    const seen = new Set();
    for (const solid of grid.near((box.left + box.right) / 2, (box.bottom + box.top) / 2, Math.max(box.right - box.left, box.top - box.bottom) / 2 + 3)) {
      if (seen.has(solid) || groups.get(solid.object.id).group === piece.group || allowed.has(`${solid.object.id}|${piece.id}`)) continue;
      seen.add(solid);
      const depth = penetration(solid.polygon, inner);
      if (depth > 0.05) problems.push(`${solid.object.id} reaches ${depth.toFixed(2)} m into ${piece.id}`);
    }
  }
  return problems;
}

/** The course's own drafts rise through open air: nothing solid in a vent's column below its apex. */
export function ventShafts(level, groups) {
  const { solids } = solidIndex(level);
  const problems = [];
  for (const vent of level.objects.filter((object) => object.kind === 'trigger' && !groups.get(object.id).group.startsWith('piece:'))) {
    const launch = vent.events.find((event) => event.type === 'launch-player');
    if (launch === undefined) continue;
    const left = vent.x - vent.region.width / 2;
    const right = vent.x + vent.region.width / 2;
    const top = vent.y - vent.region.height / 2 + launch.height;
    const floor = vent.y + vent.region.height / 2;
    const shaft = [{ x: left, y: floor }, { x: right, y: floor }, { x: right, y: top }, { x: left, y: top }];
    for (const solid of solids) {
      if (solid.object.illusion || solid.bounds.right <= left || solid.bounds.left >= right || solid.bounds.top <= floor || solid.bounds.bottom >= top) continue;
      const depth = penetration(solid.polygon, shaft);
      if (depth > 0.02) problems.push(`${vent.id} rises into ${solid.object.id}`);
    }
  }
  return problems;
}

/** Points where the pot can stand: upward faces no steeper than the reach model's `maxStandSlope` with room above them. */
export function standPoints(level, groups, reach) {
  return collectStandPoints(level, groups, reachRules(reach));
}

function collectStandPoints(level, groups, rules) {
  const index = solidIndex(level);
  const points = [];
  for (const { object, polygon } of index.solids) {
    for (let edge = 0; edge < polygon.length; edge++) {
      const a = polygon[edge];
      const b = polygon[(edge + 1) % polygon.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-6) continue;
      const normal = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
      if (normal.y < rules.standNormal) continue;
      const count = Math.max(1, Math.floor(length / SAMPLE));
      const inset = Math.min(0.5, 0.1 / length);
      for (let step = 0; step <= count; step++) {
        const t = Math.min(1 - inset, Math.max(inset, step / count));
        const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const probe = (dy) => ({ x: point.x, y: point.y + dy });
        if (index.inside(probe(0.05), object) || index.inside(probe(0.45), object) || index.inside(probe(0.85), object)) continue;
        // The pot is a metre wide: a slot narrower than its body cannot hold it.
        if ([0.45, 0.85].some((dy) => index.inside({ x: point.x - 0.35, y: point.y + dy }, object) !== null ||
          index.inside({ x: point.x + 0.35, y: point.y + dy }, object) !== null)) continue;
        points.push({ ...point, object, group: groups.get(object.id).group, zone: groups.get(object.id).zone, illusion: object.illusion });
      }
    }
  }
  return { points, index };
}

function clearLine(index, from, to, ignore) {
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    const hit = index.inside({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    if (hit !== null && !ignore.has(hit)) return false;
  }
  return true;
}

/**
 * Breadth-first search over stand points. Moves between separately built groups must fit the reach
 * model; inside a set piece every surface reaches every other (downward only for descents), as the
 * library designed it; updrafts lift the player to anything beside their column; `links` add designed
 * moves. While a course is being built, `goal` stands in for its missing ending.
 */
export function reachGraph(level, groups, pieces, links, reach, goal = null) {
  const rules = reachRules(reach);
  const { points, index } = collectStandPoints(level, groups, rules);
  const grid = new Grid();
  points.forEach((point, id) => { point.id = id; grid.insert(point, { left: point.x, right: point.x, bottom: point.y, top: point.y }); });
  const neighbours = points.map(() => new Set());
  const connect = (a, b) => { if (a !== b) neighbours[a.id].add(b.id); };
  const solid = (point) => !point.illusion;
  for (const a of points) {
    if (!solid(a)) continue;
    const shoulder = { x: a.x, y: a.y + rules.shoulder };
    for (const b of grid.near(a.x, a.y, Math.max(rules.pull + 0.5, 3))) {
      if (a === b || !solid(b)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // Climbing pulls the pot over a lip; hops and drops carry it over anything below knee height.
      const ignore = new Set([a.object, b.object]);
      if (dy > 0.05 && a.object !== b.object) {
        if (dy <= rules.rise && Math.hypot(dx, b.y - shoulder.y) <= rules.pull &&
          clearLine(index, shoulder, { x: b.x, y: b.y + 0.3 }, ignore)) connect(a, b);
      } else if (dy >= -2.5 && dy <= 0.6 && Math.abs(dx) <= rules.hop) {
        if (clearLine(index, { x: a.x, y: a.y + 1.2 }, { x: b.x, y: b.y + 1.2 }, ignore)) connect(a, b);
      }
    }
    // Dropping off an edge onto something below, drifting a little further the longer the fall.
    for (const b of grid.near(a.x, a.y - rules.drop / 2, rules.drop / 2 + 3)) {
      const fall = a.y - b.y;
      if (b === a || !solid(b) || fall < 0.05 || fall > rules.drop || Math.abs(b.x - a.x) > 2.2 + 0.25 * fall) continue;
      if (clearLine(index, { x: a.x, y: a.y + 1.2 }, { x: b.x, y: b.y + 1.2 }, new Set([a.object, b.object]))) connect(a, b);
    }
  }
  // Falling: off either side of a point the player lands on the first surface below.
  const columns = new Map();
  const bin = (x) => Math.round(x / 0.4);
  for (const point of points) {
    if (!solid(point)) continue;
    if (!columns.has(bin(point.x))) columns.set(bin(point.x), []);
    columns.get(bin(point.x)).push(point);
  }
  for (const list of columns.values()) list.sort((first, second) => second.y - first.y);
  for (const a of points) {
    if (!solid(a)) continue;
    for (const offset of [-2.4, -1.2, 1.2, 2.4]) {
      const x = a.x + offset;
      if (index.inside({ x, y: a.y + 0.3 }) !== null) continue;
      const below = (columns.get(bin(x)) ?? []).find((point) => point.y < a.y - 0.3);
      if (below === undefined) continue;
      let open = true;
      for (let y = a.y; y > below.y + 0.3; y -= 0.6) {
        if (index.inside({ x: below.x, y }) !== null) { open = false; break; }
      }
      if (open) connect(a, below);
    }
  }
  const byGroup = new Map();
  for (const point of points) {
    if (!byGroup.has(point.group)) byGroup.set(point.group, []);
    byGroup.get(point.group).push(point);
  }
  for (const piece of pieces) {
    const members = byGroup.get(piece.group) ?? [];
    for (const a of members) {
      for (const b of members) if (piece.direction !== 'down' || b.y < a.y + 0.05) connect(a, b);
    }
  }
  for (const vent of level.objects.filter((object) => object.kind === 'trigger' && object.events.some((event) => event.type === 'launch-player'))) {
    const lift = Math.max(...vent.events.filter((event) => event.type === 'launch-player').map((event) => event.height));
    const bottom = vent.y - vent.region.height / 2;
    const riders = points.filter((point) => Math.abs(point.x - vent.x) <= vent.region.width / 2 + 1.6 &&
      point.y >= bottom - 1 && point.y <= vent.y + vent.region.height / 2 + 0.2);
    const targets = points.filter((point) => solid(point) && Math.abs(point.x - vent.x) <= vent.region.width / 2 + 2.6 &&
      point.y > bottom && point.y <= bottom + lift + 0.3);
    for (const a of riders) for (const b of targets) connect(a, b);
  }
  const nearest = (target) => {
    let best = null;
    for (const point of grid.near(target.x, target.y, 1.6)) {
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (distance <= 1.6 && (best === null || distance < best.distance)) best = { point, distance };
    }
    if (best === null) throw new Error(`No stand point near (${target.x}, ${target.y}).`);
    return best.point;
  };
  for (const link of links) connect(nearest(link.from), nearest(link.to));

  const start = level.objects.find((object) => object.kind === 'start');
  const ending = level.objects.find((object) => object.kind === 'trigger' && object.events.some((event) => event.type === 'stop-timer'));
  const origin = nearest({ x: start.x, y: start.y - 0.65 });
  const seen = new Uint8Array(points.length);
  const queue = [origin.id];
  seen[origin.id] = 1;
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of neighbours[current]) {
      if (!seen[next]) {
        seen[next] = 1;
        queue.push(next);
      }
    }
  }
  // While a course is being built, the end of its route stands in for the ending.
  const inEnding = ending !== undefined
    ? (point) => Math.abs(point.x - ending.x) <= ending.region.width / 2 &&
      point.y >= ending.y - ending.region.height / 2 - 0.1 && point.y <= ending.y + ending.region.height / 2
    : (point) => goal !== null && Math.hypot(point.x - goal.x, point.y - goal.y) <= 1.5;
  // Points from which the ending can still be reached; anything the player can reach but not leave is a trap.
  const incoming = points.map(() => []);
  neighbours.forEach((targets, from) => { for (const to of targets) incoming[to].push(from); });
  const finish = new Uint8Array(points.length);
  const back = points.filter(inEnding).map((point) => point.id);
  for (const id of back) finish[id] = 1;
  while (back.length > 0) {
    for (const previous of incoming[back.pop()]) {
      if (!finish[previous]) {
        finish[previous] = 1;
        back.push(previous);
      }
    }
  }
  const traps = new Map();
  for (const point of points) {
    if (!seen[point.id] || finish[point.id] || !solid(point)) continue;
    const key = point.group;
    if (!traps.has(key)) traps.set(key, { group: key, count: 0, x: point.x, y: point.y });
    traps.get(key).count++;
  }
  const reached = points.filter((point) => seen[point.id]);
  const unreachedPieces = pieces.filter((piece) => (byGroup.get(piece.group) ?? []).length > 0 &&
    !(byGroup.get(piece.group) ?? []).some((point) => seen[point.id])).map((piece) => `${piece.id} (${piece.stamp})`);
  return {
    points, seen, reached: reached.length, total: points.length,
    ending: points.some((point) => seen[point.id] && inEnding(point)),
    highest: reached.reduce((best, point) => point.y > best.y ? point : best, origin),
    unreachedPieces, finish, traps: [...traps.values()],
  };
}

export function budget(level) {
  const count = (kind) => level.objects.filter((object) => object.kind === kind).length;
  const terrain = level.objects.filter((object) => object.kind === 'terrain');
  return {
    terrain: count('terrain'), illusions: terrain.filter((object) => object.illusion).length,
    triggers: count('trigger'), updrafts: level.objects.filter((object) => object.kind === 'trigger' &&
      object.events.some((event) => event.type === 'launch-player')).length,
    enemies: count('enemy'), birds: level.objects.filter((object) => object.kind === 'enemy' && object.species === 'bird').length,
    decorations: count('decoration'),
    labels: level.labels.length, shapes: [...new Set(terrain.map((object) => object.shape.type))].sort(),
    top: Math.max(...terrain.map((object) => Math.max(...outline(object).map((point) => point.y)))),
    left: Math.min(...terrain.map((object) => Math.min(...outline(object).map((point) => point.x)))),
    right: Math.max(...terrain.map((object) => Math.max(...outline(object).map((point) => point.x)))),
  };
}
