// Policies over one prepared snapshot of the engine's authored collision.
import { CourseLevelError, CourseQueryError, ReachModelError } from './errors.mjs';
export { ReachModelError } from './errors.mjs';

/** @typedef {import('./job.mjs').CourseSnapshot} CourseSnapshot */
/** @typedef {import('../../src/collision-queries.ts').Bounds} Bounds */
/** @typedef {import('../../src/level.ts').TerrainObject} TerrainObject */
/** @typedef {Map<string, {group: string, zone: string}>} Groups */
/**
 * @typedef {object} PieceRecord
 * @property {string} id
 * @property {string} stamp
 * @property {string} group
 * @property {'any' | 'down'} direction
 * @property {Bounds | null} bounds
 * @property {readonly import('../../src/level.ts').LevelObject[]} objects
 *
 * @typedef {object} ReachModel
 * @property {number} shoulder
 * @property {number} pull
 * @property {number} rise
 * @property {number} hop
 * @property {number} drop
 * @property {number} maxStandSlope
 * @property {number} shoulderLipOffset
 * @property {number} transitHeight
 * @property {readonly number[]} clearanceHeights
 * @property {readonly number[]} sideClearanceHeights
 * @property {number} clearanceHalfWidth
 * @property {number} standingInset
 * @property {number} startFootOffset
 * @property {number} fallDriftBase
 * @property {number} fallDriftPerMetre
 * @property {number} hopDrop
 * @property {number} hopRise
 * @property {number} moveRiseThreshold
 * @property {number} fallMinimum
 * @property {readonly number[]} fallProbeOffsets
 * @property {number} fallColumnSpacing
 * @property {number} fallInitialProbeHeight
 * @property {number} fallProbeStartHeight
 * @property {number} fallSurfaceOffset
 * @property {number} anchorRadius
 * @property {number} ventRiderMargin
 * @property {number} ventRiderBelow
 * @property {number} ventRiderAbove
 * @property {number} ventTargetMargin
 * @property {number} ventTargetAbove
 * @property {number} endingBelow
 * @property {number} goalRadius
 *
 * @typedef {ReachModel & {standNormal: number}} ReachRules
 * @typedef {{id: number, x: number, y: number, object: TerrainObject, group: string, zone: string, illusion: boolean}} StandPoint
 * @typedef {{from: {x: number, y: number}, to: {x: number, y: number}, why: string}} DesignedLink
 */

/** The old engine-default distances and body/rig probes, now completely caller-supplied. */
export const ENGINE_DEFAULT_REACH = Object.freeze({
  shoulder: 1.15, pull: 2.35, rise: 2.5, hop: 1.9, drop: 9, maxStandSlope: 40,
  shoulderLipOffset: 0.3, transitHeight: 1.2,
  clearanceHeights: Object.freeze([0.05, 0.45, 0.85]), sideClearanceHeights: Object.freeze([0.45, 0.85]),
  clearanceHalfWidth: 0.35, standingInset: 0.1, startFootOffset: 0.65,
  fallDriftBase: 2.2, fallDriftPerMetre: 0.25, hopDrop: 2.5, hopRise: 0.6,
  moveRiseThreshold: 0.05, fallMinimum: 0.05,
  fallProbeOffsets: Object.freeze([-2.4, -1.2, 1.2, 2.4]), fallColumnSpacing: 0.4,
  fallInitialProbeHeight: 0.3, fallProbeStartHeight: 0, fallSurfaceOffset: 0.3,
  anchorRadius: 1.6, ventRiderMargin: 1.6, ventRiderBelow: 1, ventRiderAbove: 0.2,
  ventTargetMargin: 2.6, ventTargetAbove: 0.3, endingBelow: 0.1, goalRadius: 1.5,
});
const REACH_FIELDS = Object.keys(ENGINE_DEFAULT_REACH);
const REACH_ARRAYS = ['clearanceHeights', 'sideClearanceHeights', 'fallProbeOffsets'];

// Seam/merge policy, not numerical tolerances. Compare to the inscribed-disk thickness of an overlap.
export const POLICY_ALLOWANCES = Object.freeze({ overlap: 0.03, enemyStart: 0.02, keepOut: 0.05, reservationInset: 0.1, vent: 0.02 });
export const CRAMPED = Object.freeze({ small: 1.5, clearance: 1.2 });
const OVERLAP_REPORT_RADIUS_TOLERANCE = 0.0005;
const TRUSTED_DESCENT_RISE = 0.05;
const ENEMY_HALF_BOUNDS = Object.freeze({ bird: { x: 0.26, y: 0.26 }, ground: { x: 0.26, y: 0.7 } });

/** @param {ReachModel} model @param {CourseSnapshot} snapshot @returns {ReachRules} */
function reachRules(model, snapshot) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new ReachModelError('model', model, 'A complete reach model is required; pass ENGINE_DEFAULT_REACH or your own.');
  }
  const unknown = Object.keys(model).filter((field) => !REACH_FIELDS.includes(field));
  if (unknown.length > 0) throw new ReachModelError('fields', unknown, `Unknown reach model fields: ${unknown.join(', ')}.`);
  for (const field of REACH_FIELDS) {
    const value = model[field];
    if (REACH_ARRAYS.includes(field)) {
      if (!Array.isArray(value) || value.length === 0) throw new ReachModelError(field, value, `Reach model "${field}" needs a nonempty array.`);
      snapshot.work.spend('geometry', value.length);
      const offsets = field === 'fallProbeOffsets';
      if (value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || (offsets ? entry === 0 : entry <= 0)) ||
        new Set(value).size !== value.length || (!offsets && value.some((entry, at) => at > 0 && entry <= value[at - 1]))) {
        throw new ReachModelError(field, value, `Reach model "${field}" needs finite ${offsets ? 'nonzero, distinct offsets' : 'positive, strictly increasing heights'}.`);
      }
    } else if (typeof value !== 'number' || !Number.isFinite(value) || (field === 'fallProbeStartHeight' ? value < 0 : value <= 0)) {
      throw new ReachModelError(field, value, `Reach model "${field}" must be finite and ${field === 'fallProbeStartHeight' ? 'nonnegative' : 'positive'}.`);
    }
  }
  if (model.maxStandSlope >= 90) throw new ReachModelError('maxStandSlope', model.maxStandSlope, 'maxStandSlope must be below 90 degrees.');
  return Object.freeze({
    ...model,
    clearanceHeights: Object.freeze([...model.clearanceHeights]),
    sideClearanceHeights: Object.freeze([...model.sideClearanceHeights]),
    fallProbeOffsets: Object.freeze([...model.fallProbeOffsets]),
    standNormal: Math.cos(model.maxStandSlope * Math.PI / 180),
  });
}

/** @param {Groups} groups @param {{id: string}} object */
function membership(groups, object) {
  const member = groups.get(object.id);
  if (typeof member?.group !== 'string' || typeof member?.zone !== 'string') {
    throw new CourseLevelError({ field: 'course group/zone membership', value: member }, object.id);
  }
  return member;
}

/** @param {Bounds} bounds @param {number} margin @returns {Bounds} */
const expand = (bounds, margin) => ({
  left: bounds.left - margin, right: bounds.right + margin, bottom: bounds.bottom - margin, top: bounds.top + margin,
});
/** @param {import('../../src/level.ts').TriggerObject} trigger @param {CourseSnapshot} snapshot @returns {Bounds} */
function triggerBounds(trigger, snapshot) {
  const box = snapshot.engine.level.triggerBounds(trigger);
  return { left: box.minX, right: box.maxX, bottom: box.minY, top: box.maxY };
}

/** Terrain of separately built groups must not merge into a piece's parts; retain the authored illusion policy.
 * @param {CourseSnapshot} snapshot @param {Groups} groups @param {Set<string>} [supports]
 */
export function overlaps(snapshot, groups, supports = new Set()) {
  const problems = [];
  for (const record of snapshot.solids) {
    for (const other of snapshot.candidates(record.bounds)) {
      if (other.order <= record.order) continue;
      const a = membership(groups, record.object).group, b = membership(groups, other.object).group;
      const part = (object, group) => group.startsWith('piece:') && !supports.has(object.id);
      if (a === b || (!part(record.object, a) && !part(other.object, b))) continue;
      if (!snapshot.queries.overlapExceeds(record.solid, other.solid, POLICY_ALLOWANCES.overlap)) continue;
      const depth = snapshot.queries.overlapDepth(record.solid, other.solid, OVERLAP_REPORT_RADIUS_TOLERANCE);
      problems.push(`${record.object.id} overlaps ${other.object.id} by ${depth.toFixed(2)} m`);
    }
  }
  for (const enemy of snapshot.level.objects.filter((object) => object.kind === 'enemy')) {
    const half = enemy.species === 'bird' ? ENEMY_HALF_BOUNDS.bird : ENEMY_HALF_BOUNDS.ground;
    const bounds = { left: enemy.x - half.x, right: enemy.x + half.x, bottom: enemy.y - half.y, top: enemy.y + half.y };
    const box = snapshot.queries.rectangle(bounds);
    for (const record of snapshot.candidates(bounds)) {
      if (snapshot.queries.overlapExceeds(box, record.solid, POLICY_ALLOWANCES.enemyStart)) {
        problems.push(`${enemy.id} starts inside ${record.object.id}`);
      }
    }
  }
  return problems;
}

/**
 * Apply smallness and clearance to connected solid components, including islands in one mesh.
 * Only actual parts of the same recorded set-piece placement are exempt; group names and supports are not proof.
 * @param {CourseSnapshot} snapshot @param {Groups} groups @param {readonly PieceRecord[]} pieces
 */
export function crampedColliders(snapshot, groups, pieces) {
  snapshot.work.spend('geometry', pieces.length);
  const owners = new Map();
  const terrainIds = new Set(snapshot.solids.map((record) => record.object.id));
  for (const piece of pieces) {
    snapshot.work.spend('geometry', piece.objects.length);
    for (const object of piece.objects) {
      if (object.kind !== 'terrain') continue;
      if (!terrainIds.has(object.id) || membership(groups, object).group !== piece.group || owners.has(object.id)) {
        throw new CourseLevelError({ field: 'unique set-piece part ownership', value: piece.group }, object.id);
      }
      owners.set(object.id, piece);
    }
  }
  const size = (bounds) => Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom);
  const small = new Set(snapshot.components.filter((record) => size(record.bounds) <= CRAMPED.small));
  const problems = [];
  for (const record of small) {
    for (const other of snapshot.componentCandidates(expand(record.bounds, CRAMPED.clearance))) {
      if (other.order <= record.order || !small.has(other)) continue;
      const owner = owners.get(record.object.id);
      if (owner !== undefined && owner === owners.get(other.object.id)) continue;
      const gap = snapshot.queries.separation(record.solid, other.solid);
      if (gap <= CRAMPED.clearance) {
        problems.push(`${record.object.id} component ${record.component + 1} and ${other.object.id} component ${other.component + 1} are small colliders ${gap.toFixed(2)} m apart`);
      }
    }
  }
  return problems;
}

/** A piece's bounds deliberately reserve its movement space, including empty air.
 * @param {CourseSnapshot} snapshot @param {Groups} groups @param {readonly PieceRecord[]} pieces @param {Set<string>} [allowed]
 */
export function keepOut(snapshot, groups, pieces, allowed = new Set()) {
  snapshot.work.spend('geometry', pieces.length);
  const problems = [];
  for (const piece of pieces) {
    if (piece.bounds === null) continue;
    const box = piece.bounds, inset = POLICY_ALLOWANCES.reservationInset;
    if (box.right - box.left <= inset * 2 || box.top - box.bottom <= inset * 2) {
      throw new CourseLevelError({ field: 'set-piece reservation after inset', value: piece.id });
    }
    const inner = snapshot.queries.rectangle({ left: box.left + inset, right: box.right - inset, bottom: box.bottom + inset, top: box.top - inset });
    for (const record of snapshot.candidates(inner.bounds)) {
      if (membership(groups, record.object).group === piece.group || allowed.has(`${record.object.id}|${piece.id}`)) continue;
      if (!snapshot.queries.overlapExceeds(record.solid, inner, POLICY_ALLOWANCES.keepOut)) continue;
      const depth = snapshot.queries.overlapDepth(record.solid, inner, OVERLAP_REPORT_RADIUS_TOLERANCE);
      problems.push(`${record.object.id} reaches ${depth.toFixed(2)} m into ${piece.id}`);
    }
  }
  return problems;
}

/** A course's own drafts rise through open air above their region, up to the first launch event's apex.
 * @param {CourseSnapshot} snapshot @param {Groups} groups
 */
export function ventShafts(snapshot, groups) {
  const problems = [];
  for (const vent of snapshot.level.objects) {
    if (vent.kind !== 'trigger' || membership(groups, vent).group.startsWith('piece:')) continue;
    const launch = vent.events.find((event) => event.type === 'launch-player');
    if (launch === undefined) continue;
    const bounds = triggerBounds(vent, snapshot), top = bounds.bottom + launch.height;
    if (top <= bounds.top) continue;
    const shaft = snapshot.queries.rectangle({ ...bounds, bottom: bounds.top, top });
    for (const record of snapshot.candidates(shaft.bounds)) {
      if (record.object.illusion) continue;
      if (snapshot.queries.overlapExceeds(record.solid, shaft, POLICY_ALLOWANCES.vent)) problems.push(`${vent.id} rises into ${record.object.id}`);
    }
  }
  return problems;
}

/** @param {CourseSnapshot} snapshot @param {{x: number, y: number}} point @param {ReachRules} rules */
function standingClearance(snapshot, point, rules) {
  const clearColumn = (x, heights) => {
    for (let i = 0; i < heights.length; i++) {
      const probe = { x, y: point.y + heights[i] };
      if (snapshot.inside(probe) !== null) return false;
      if (i > 0 && snapshot.blocksSegment({ x, y: point.y + heights[i - 1] }, probe)) return false;
    }
    return true;
  };
  // Do not ignore the supporting object: another loop of that same cave may be its ceiling.
  return clearColumn(point.x, rules.clearanceHeights) &&
    clearColumn(point.x - rules.clearanceHalfWidth, rules.sideClearanceHeights) &&
    clearColumn(point.x + rules.clearanceHalfWidth, rules.sideClearanceHeights);
}

/** Upward oriented edges and analytic circle arcs, sampled only for the conservative reach model.
 * @param {CourseSnapshot} snapshot @param {Groups} groups @param {ReachModel} reach
 */
export function standPoints(snapshot, groups, reach) {
  return collectStandPoints(snapshot, groups, reachRules(reach, snapshot));
}

/** @param {CourseSnapshot} snapshot @param {Groups} groups @param {ReachRules} rules */
function collectStandPoints(snapshot, groups, rules) {
  /** @type {StandPoint[]} */
  const points = [];
  const sampled = new Set();
  for (const record of snapshot.solids) {
    const object = record.object, member = membership(groups, object);
    for (const surface of snapshot.queries.standingSurfaces(record.solid, rules.standNormal)) {
      const count = Math.max(1, Math.floor(surface.length / snapshot.standingSampleSpacing));
      snapshot.work.spend('samples', count + 1);
      const inset = surface.length === 0 ? 0.5 : Math.min(0.5, rules.standingInset / surface.length);
      for (let step = 0; step <= count; step++) {
        const t = Math.min(1 - inset, Math.max(inset, step / count));
        const angle = surface.type === 'arc' ? surface.from + (surface.to - surface.from) * t : 0;
        const point = surface.type === 'edge'
          ? { x: surface.a.x + (surface.b.x - surface.a.x) * t, y: surface.a.y + (surface.b.y - surface.a.y) * t }
          : { x: surface.center.x + surface.radius * Math.cos(angle), y: surface.center.y + surface.radius * Math.sin(angle) };
        const key = `${object.id}|${point.x}|${point.y}`;
        if (sampled.has(key)) continue;
        sampled.add(key);
        if (!standingClearance(snapshot, point, rules)) continue;
        points.push({ ...point, id: points.length, object, group: member.group, zone: member.zone, illusion: object.illusion });
      }
    }
  }
  return { points, index: snapshot.index };
}

/** @param {{x: number, y: number}} from @param {{x: number, y: number}} to @param {CourseSnapshot} snapshot */
const clearLine = (from, to, snapshot) => !snapshot.blocksSegment(from, to);

/**
 * A conservative authoring model, not a physics/playability proof. The complete model is mandatory.
 * Trusted piece membership remains explicit policy: hubs for any-direction pieces, an ordered chain for descents.
 * @param {CourseSnapshot} snapshot @param {Groups} groups @param {readonly PieceRecord[]} pieces
 * @param {readonly DesignedLink[]} links @param {ReachModel} reach @param {{x: number, y: number} | null} [goal]
 */
export function reachGraph(snapshot, groups, pieces, links, reach, goal = null) {
  const rules = reachRules(reach, snapshot);
  const maximumDrift = rules.fallDriftBase + rules.fallDriftPerMetre * rules.drop;
  if (!Number.isFinite(maximumDrift)) throw new ReachModelError('fallDriftPerMetre/drop', maximumDrift, 'The modeled fall drift must stay finite.');
  const { points } = collectStandPoints(snapshot, groups, rules);
  const pointIndex = snapshot.createIndex(points,
    (point) => ({ left: point.x, right: point.x, bottom: point.y, top: point.y }));
  /** @type {Set<number>[]} */
  const neighbours = [];
  const node = () => { snapshot.work.spend('graphNodes'); neighbours.push(new Set()); return neighbours.length - 1; };
  for (let i = 0; i < points.length; i++) node();
  const connect = (from, to) => {
    if (from === to || neighbours[from].has(to)) return;
    snapshot.work.spend('graphEdges');
    neighbours[from].add(to);
  };
  const candidates = (bounds) => pointIndex.query(bounds);
  const solid = (point) => !point.illusion;
  for (const a of points) {
    if (!solid(a)) continue;
    const shoulder = { x: a.x, y: a.y + rules.shoulder }, horizontal = Math.max(rules.pull, rules.hop);
    for (const b of candidates({ left: a.x - horizontal, right: a.x + horizontal, bottom: a.y - rules.hopDrop, top: a.y + Math.max(rules.rise, rules.hopRise) })) {
      snapshot.work.spend('reachCandidates');
      if (a === b || !solid(b)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dy > rules.moveRiseThreshold && a.object !== b.object) {
        if (dy <= rules.rise && Math.hypot(dx, b.y - shoulder.y) <= rules.pull &&
          clearLine(shoulder, { x: b.x, y: b.y + rules.shoulderLipOffset }, snapshot)) connect(a.id, b.id);
      } else if (dy >= -rules.hopDrop && dy <= rules.hopRise && Math.abs(dx) <= rules.hop &&
        clearLine({ x: a.x, y: a.y + rules.transitHeight }, { x: b.x, y: b.y + rules.transitHeight }, snapshot)) connect(a.id, b.id);
    }
    for (const b of candidates({ left: a.x - maximumDrift, right: a.x + maximumDrift, bottom: a.y - rules.drop, top: a.y - rules.fallMinimum })) {
      snapshot.work.spend('reachCandidates');
      const fall = a.y - b.y;
      if (b === a || !solid(b) || fall < rules.fallMinimum || fall > rules.drop ||
        Math.abs(b.x - a.x) > rules.fallDriftBase + rules.fallDriftPerMetre * fall) continue;
      if (clearLine({ x: a.x, y: a.y + rules.transitHeight }, { x: b.x, y: b.y + rules.transitHeight }, snapshot)) connect(a.id, b.id);
    }
  }
  const columns = new Map();
  const bin = (x) => {
    const column = Math.round(x / rules.fallColumnSpacing);
    if (!Number.isFinite(column)) throw new ReachModelError('fallColumnSpacing', rules.fallColumnSpacing, 'The modeled fall column must stay finite.');
    return column;
  };
  for (const point of points) {
    if (!solid(point)) continue;
    if (!columns.has(bin(point.x))) columns.set(bin(point.x), []);
    columns.get(bin(point.x)).push(point);
  }
  for (const list of columns.values()) list.sort((a, b) => {
    snapshot.work.spend('reachCandidates');
    return b.y - a.y || a.id - b.id;
  });
  for (const a of points) {
    if (!solid(a)) continue;
    for (const offset of rules.fallProbeOffsets) {
      snapshot.work.spend('reachCandidates');
      const x = a.x + offset;
      if (snapshot.inside({ x, y: a.y + rules.fallInitialProbeHeight }) !== null) continue;
      const list = columns.get(bin(x)) ?? [];
      let low = 0, high = list.length;
      while (low < high) {
        snapshot.work.spend('reachCandidates');
        const middle = Math.floor((low + high) / 2);
        if (list[middle].y < a.y - rules.fallSurfaceOffset) high = middle;
        else low = middle + 1;
      }
      const below = list[low];
      if (below === undefined) continue;
      if (clearLine({ x: below.x, y: a.y + rules.fallProbeStartHeight }, { x: below.x, y: below.y + rules.fallSurfaceOffset }, snapshot)) {
        connect(a.id, below.id);
      }
    }
  }
  const byGroup = new Map();
  for (const point of points) {
    if (!byGroup.has(point.group)) byGroup.set(point.group, []);
    byGroup.get(point.group).push(point);
  }
  snapshot.work.spend('reachCandidates', pieces.length);
  for (const piece of pieces) {
    const members = byGroup.get(piece.group) ?? [];
    snapshot.work.spend('reachCandidates', members.length);
    if (piece.direction === 'down') {
      const ordered = [...members].sort((a, b) => {
        snapshot.work.spend('reachCandidates');
        return b.y - a.y || a.id - b.id;
      });
      for (let i = 1; i < ordered.length; i++) {
        const upper = ordered[i - 1], lower = ordered[i];
        connect(upper.id, lower.id);
        if (upper.y < lower.y + TRUSTED_DESCENT_RISE) connect(lower.id, upper.id);
      }
    } else if (piece.direction === 'any') {
      if (members.length === 0) continue;
      const hub = node();
      for (const point of members) { connect(point.id, hub); connect(hub, point.id); }
    } else throw new CourseLevelError({ field: 'set-piece traversal direction', value: piece.direction });
  }
  for (const vent of snapshot.level.objects) {
    if (vent.kind !== 'trigger') continue;
    const launches = vent.events.filter((event) => event.type === 'launch-player');
    if (launches.length === 0) continue;
    const lift = Math.max(...launches.map((event) => event.height)), bounds = triggerBounds(vent, snapshot);
    const riders = candidates({
      left: bounds.left - rules.ventRiderMargin, right: bounds.right + rules.ventRiderMargin,
      bottom: bounds.bottom - rules.ventRiderBelow, top: bounds.top + rules.ventRiderAbove,
    });
    const targetCandidates = candidates({
      left: bounds.left - rules.ventTargetMargin, right: bounds.right + rules.ventTargetMargin,
      bottom: bounds.bottom, top: bounds.bottom + lift + rules.ventTargetAbove,
    });
    snapshot.work.spend('reachCandidates', riders.length + targetCandidates.length);
    const targets = targetCandidates.filter((point) => solid(point) && point.y > bounds.bottom);
    if (riders.length === 0 || targets.length === 0) continue;
    const hub = node();
    for (const point of riders) connect(point.id, hub);
    for (const point of targets) connect(hub, point.id);
  }
  const nearest = (target) => {
    let best = null;
    for (const point of candidates({ left: target.x - rules.anchorRadius, right: target.x + rules.anchorRadius,
      bottom: target.y - rules.anchorRadius, top: target.y + rules.anchorRadius })) {
      snapshot.work.spend('reachCandidates');
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (distance <= rules.anchorRadius && (best === null || distance < best.distance ||
        (distance === best.distance && point.id < best.point.id))) best = { point, distance };
    }
    if (best === null) throw new CourseQueryError('QUERY_NO_STAND_POINT', { x: target.x, y: target.y, radius: rules.anchorRadius },
      `No stand point within ${rules.anchorRadius} m of (${target.x}, ${target.y}).`);
    return best.point;
  };
  snapshot.work.spend('reachCandidates', links.length);
  for (const link of links) connect(nearest(link.from).id, nearest(link.to).id);

  const start = snapshot.level.objects.find((object) => object.kind === 'start');
  const ending = snapshot.level.objects.find((object) => object.kind === 'trigger' && object.events.some((event) => event.type === 'stop-timer'));
  const origin = nearest({ x: start.x, y: start.y - rules.startFootOffset });
  const seenNodes = new Uint8Array(neighbours.length), queue = [origin.id];
  seenNodes[origin.id] = 1;
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours[queue[head]]) {
      if (!seenNodes[next]) { seenNodes[next] = 1; queue.push(next); }
    }
  }
  const inEnding = ending !== undefined
    ? (point) => snapshot.engine.level.triggerContains(ending, point) ||
      snapshot.engine.level.triggerContains(ending, { x: point.x, y: point.y + rules.endingBelow })
    : (point) => goal !== null && Math.hypot(point.x - goal.x, point.y - goal.y) <= rules.goalRadius;
  const incoming = neighbours.map(() => []);
  neighbours.forEach((targets, from) => { for (const to of targets) incoming[to].push(from); });
  const finishNodes = new Uint8Array(neighbours.length), back = points.filter(inEnding).map((point) => point.id);
  for (const id of back) finishNodes[id] = 1;
  for (let head = 0; head < back.length; head++) {
    for (const previous of incoming[back[head]]) {
      if (!finishNodes[previous]) { finishNodes[previous] = 1; back.push(previous); }
    }
  }
  const seen = seenNodes.slice(0, points.length), finish = finishNodes.slice(0, points.length);
  const traps = new Map();
  for (const point of points) {
    if (!seen[point.id] || finish[point.id] || !solid(point)) continue;
    if (!traps.has(point.group)) traps.set(point.group, { group: point.group, count: 0, x: point.x, y: point.y });
    traps.get(point.group).count++;
  }
  const reached = points.filter((point) => seen[point.id]);
  const unreachedPieces = pieces.filter((piece) => (byGroup.get(piece.group) ?? []).length > 0 &&
    !(byGroup.get(piece.group) ?? []).some((point) => seen[point.id])).map((piece) => `${piece.id} (${piece.stamp})`);
  return {
    model: 'conservative-authoring-model', playabilityProof: false, snapshot,
    points, seen, reached: reached.length, total: points.length,
    ending: points.some((point) => seen[point.id] && inEnding(point)),
    highest: reached.reduce((best, point) => point.y > best.y ? point : best, origin),
    unreachedPieces, finish, traps: [...traps.values()],
  };
}

/** @param {ReturnType<typeof reachGraph>} result @returns {string[]} */
export function reachSuggestions(result) {
  if (result?.model !== 'conservative-authoring-model') {
    throw new ReachModelError('result.model', result?.model, 'reachSuggestions requires a reachGraph result.');
  }
  const suggestions = [];
  if (!result.ending) {
    suggestions.push(`Suggestion: The ending is not reachable; the highest reached point is (${result.highest.x.toFixed(1)}, ${result.highest.y.toFixed(1)}) in ${result.highest.group}.`);
  }
  if (result.unreachedPieces.length > 0) suggestions.push(`Suggestion: Pieces never reached: ${result.unreachedPieces.join(', ')}`);
  if (result.traps.length > 0) {
    suggestions.push(`Suggestion: Traps (reachable, but the ending is not reachable from them): ${result.traps.map((trap) =>
      `${trap.group} x${trap.count} near (${trap.x.toFixed(1)}, ${trap.y.toFixed(1)})`).join('; ')}`);
  }
  return suggestions;
}

/** @param {CourseSnapshot} snapshot */
export function budget(snapshot) {
  const level = snapshot.level, count = (kind) => level.objects.filter((object) => object.kind === kind).length;
  return {
    terrain: snapshot.solids.length, illusions: snapshot.solids.filter((record) => record.object.illusion).length,
    triggers: count('trigger'), updrafts: level.objects.filter((object) => object.kind === 'trigger' &&
      object.events.some((event) => event.type === 'launch-player')).length,
    enemies: count('enemy'), birds: level.objects.filter((object) => object.kind === 'enemy' && object.species === 'bird').length,
    decorations: count('decoration'), labels: level.labels.length,
    meshes: [...new Set(snapshot.solids.map(({ object }) => object.mesh.type === 'shape' ? object.mesh.shape : object.mesh.type))].sort(),
    bounds: snapshot.bounds, top: snapshot.bounds?.top ?? null, left: snapshot.bounds?.left ?? null, right: snapshot.bounds?.right ?? null,
    work: snapshot.work.usage,
  };
}
