/**
 * The engine's course checks over one prepared CourseSnapshot (src/course-snapshot.ts): authoring rules for placed
 * collision, and an advisory reach model. The Workshop runs checkLevel on the open level, in a worker
 * (src/editor/level-checks.ts), and the Node course kit runs these same functions on generated courses
 * (docs/course-kit.md). Every check returns LevelFindings: plain data naming the check, how serious it is, what it says,
 * where, and the objects it concerns. DOM-free and three-free.
 */
import type { Bounds, QueryCounter } from './collision-queries';
import { DEFAULT_TUNING } from './config';
import type { Point, Tuning } from './config';
import { createCourseJob, COURSE_FAILURES } from './course-snapshot';
import type { CourseFailures, CourseSnapshot, JobOptions } from './course-snapshot';
import { triggerBounds as triggerBox, triggerContains } from './level';
import type { LevelDefinition, LevelObject, TerrainObject, TriggerObject } from './level';
import { DEFAULT_RIG_SETTINGS, rigGeometry } from './rig';
import type { RigSettings } from './rig';
import { DEFAULT_SURFACE, SURFACE_SETTINGS } from './surfaces';

// The course kit loads this one module, the job with the checks.
export {
  COURSE_FAILURES, CourseCheckError, createCourseJob, DEFAULT_STANDING_SAMPLE_SPACING, DEFAULT_WORK_LIMITS,
} from './course-snapshot';
export type {
  ComponentRecord, CourseCheckCode, CourseFailures, CourseFieldCause, CourseJob, CourseQueryCode, CourseSnapshot, CourseWorkCause,
  JobOptions, TerrainRecord,
} from './course-snapshot';

// Each object's group, and the zone it was built in: separately built groups never merge into a piece's parts.
export type Groups = ReadonlyMap<string, { readonly group: string; readonly zone: string }>;
// One placement of a library set piece: its parts, its group, the bounds it reserves and how it is traversed.
export interface PieceRecord {
  readonly id: string;
  readonly stamp: string;
  readonly group: string;
  readonly direction: 'any' | 'down';
  readonly bounds: Bounds | null;
  readonly objects: readonly LevelObject[];
}
export interface ReachModel {
  readonly shoulder: number;
  readonly pull: number;
  readonly rise: number;
  readonly hop: number;
  readonly drop: number;
  readonly maxStandSlope: number;
  readonly shoulderLipOffset: number;
  readonly transitHeight: number;
  readonly clearanceHeights: readonly number[];
  readonly sideClearanceHeights: readonly number[];
  readonly clearanceHalfWidth: number;
  readonly standingInset: number;
  readonly startFootOffset: number;
  readonly fallDriftBase: number;
  readonly fallDriftPerMetre: number;
  readonly hopDrop: number;
  readonly hopRise: number;
  readonly moveRiseThreshold: number;
  readonly fallMinimum: number;
  readonly fallProbeOffsets: readonly number[];
  readonly fallColumnSpacing: number;
  readonly fallInitialProbeHeight: number;
  readonly fallProbeStartHeight: number;
  readonly fallSurfaceOffset: number;
  readonly anchorRadius: number;
  readonly ventRiderMargin: number;
  readonly ventRiderBelow: number;
  readonly ventRiderAbove: number;
  readonly ventTargetMargin: number;
  readonly ventTargetAbove: number;
  readonly endingBelow: number;
  readonly goalRadius: number;
}
export type ReachRules = ReachModel & { readonly standNormal: number };
export interface StandPoint extends Point {
  id: number;
  object: TerrainObject;
  group: string;
  zone: string;
  illusion: boolean;
}
export interface DesignedLink { readonly from: Point; readonly to: Point; readonly why: string }
interface ReachTrap extends Point { group: string; count: number; objects: string[] }

// A problem breaks an authoring rule. A suggestion comes from the reach model, which cannot prove or disprove play.
export type FindingSeverity = 'problem' | 'suggestion';
export const FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze(['problem', 'suggestion']);

/** What a course check found. Plain data, so it crosses to and from a worker unchanged. */
export interface LevelFinding {
  // The check that found it, such as 'cramped' or 'ending-unreachable'; in the Workshop also a plugin rule's ID.
  readonly check: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  // Where it is, in world metres, or null when it has no single place.
  readonly at: Readonly<Point> | null;
  // The level objects it concerns.
  readonly objects: readonly string[];
}

/** The old engine-default distances and body/rig probes, now completely caller-supplied. */
export const ENGINE_DEFAULT_REACH: ReachModel = Object.freeze({
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
const REACH_FIELDS = Object.keys(ENGINE_DEFAULT_REACH) as (keyof ReachModel)[];
const REACH_ARRAYS: readonly (keyof ReachModel)[] = ['clearanceHeights', 'sideClearanceHeights', 'fallProbeOffsets'];

// Seam/merge policy, not numerical tolerances. Compare to the inscribed-disk thickness of an overlap.
export const POLICY_ALLOWANCES = Object.freeze({ overlap: 0.03, enemyStart: 0.02, keepOut: 0.05, reservationInset: 0.1, vent: 0.02 });
export const CRAMPED = Object.freeze({ small: 1.5, clearance: 1.2 });
const OVERLAP_REPORT_RADIUS_TOLERANCE = 0.0005;
const TRUSTED_DESCENT_RISE = 0.05;
const ENEMY_HALF_BOUNDS = Object.freeze({ bird: { x: 0.26, y: 0.26 }, ground: { x: 0.26, y: 0.7 } });

function finding(check: string, severity: FindingSeverity, message: string, at: Readonly<Point> | null, objects: readonly string[]): LevelFinding {
  return Object.freeze({
    check, severity, message, at: at === null ? null : Object.freeze({ x: at.x, y: at.y }), objects: Object.freeze([...new Set(objects)]),
  });
}

// The middle of where two bounds meet, or of the gap between them when they do not.
function meeting(a: Bounds, b: Bounds): Point {
  return {
    x: (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2,
    y: (Math.max(a.bottom, b.bottom) + Math.min(a.top, b.top)) / 2,
  };
}

const metres = (value: number): string => `${Number(value.toFixed(2))} m`;
const place = (point: Readonly<Point>): string => `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;

function reachRules(model: ReachModel, failures: CourseFailures, work: CourseSnapshot['work'] | null): ReachRules {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw failures.reach('model', model, 'A complete reach model is required; pass ENGINE_DEFAULT_REACH or your own.');
  }
  const unknown = Object.keys(model).filter((field) => !REACH_FIELDS.includes(field as keyof ReachModel));
  if (unknown.length > 0) throw failures.reach('fields', unknown, `Unknown reach model fields: ${unknown.join(', ')}.`);
  for (const field of REACH_FIELDS) {
    const value: unknown = model[field];
    if (REACH_ARRAYS.includes(field)) {
      if (!Array.isArray(value) || value.length === 0) throw failures.reach(field, value, `Reach model "${field}" needs a nonempty array.`);
      work?.spend('geometry', value.length);
      const offsets = field === 'fallProbeOffsets';
      if (value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || (offsets ? entry === 0 : entry <= 0)) ||
        new Set(value).size !== value.length || (!offsets && value.some((entry, at) => at > 0 && entry <= value[at - 1]))) {
        throw failures.reach(field, value, `Reach model "${field}" needs finite ${offsets ? 'nonzero, distinct offsets' : 'positive, strictly increasing heights'}.`);
      }
    } else if (typeof value !== 'number' || !Number.isFinite(value) || (field === 'fallProbeStartHeight' ? value < 0 : value <= 0)) {
      throw failures.reach(field, value, `Reach model "${field}" must be finite and ${field === 'fallProbeStartHeight' ? 'nonnegative' : 'positive'}.`);
    }
  }
  if (model.maxStandSlope >= 90) throw failures.reach('maxStandSlope', model.maxStandSlope, 'maxStandSlope must be below 90 degrees.');
  return Object.freeze({
    ...model,
    clearanceHeights: Object.freeze([...model.clearanceHeights]),
    sideClearanceHeights: Object.freeze([...model.sideClearanceHeights]),
    fallProbeOffsets: Object.freeze([...model.fallProbeOffsets]),
    standNormal: Math.cos(model.maxStandSlope * Math.PI / 180),
  });
}

/** A complete, valid reach model, frozen; anything else throws through `failures`. */
export function checkReachModel(model: unknown, failures: CourseFailures = COURSE_FAILURES): ReachModel {
  // Validation leaves no field but the model's own.
  const rules = reachRules(model as ReachModel, failures, null);
  return Object.freeze({
    ...model as ReachModel,
    clearanceHeights: rules.clearanceHeights, sideClearanceHeights: rules.sideClearanceHeights, fallProbeOffsets: rules.fallProbeOffsets,
  });
}

// The default rig's reach, and the steepest face the pot rests on with the default grip, which ENGINE_DEFAULT_REACH assumes.
const DEFAULT_RIG_REACH = rigGeometry(DEFAULT_RIG_SETTINGS).maxReach;
const centimetres = (metres: number): number => Math.round(metres * 100) / 100;

// The steepest default-surface face, in degrees, the pot rests on before sliding: contact friction is the geometric mean
// of the two sides'.
function slideAngle(physics: Readonly<Tuning>): number {
  return Math.atan(Math.sqrt(physics[SURFACE_SETTINGS[DEFAULT_SURFACE].friction] * physics.potFriction)) * 180 / Math.PI;
}

/**
 * The reach model for a game's settings: ENGINE_DEFAULT_REACH, made for the default rig and grip, moved to the game's.
 * Pull and rise keep the default's margin below the hammer's full reach, so they change by as much as the reach does; a
 * hop changes in proportion to it; and the steepest resting face changes by as much as the angle the pot slides at on
 * the default surface. The body's own probes, its clearances, shoulder and foot, stay the default's.
 */
export function reachForSettings(settings: { readonly rig: Readonly<RigSettings>; readonly physics: Readonly<Tuning> }): ReachModel {
  const reach = rigGeometry(settings.rig).maxReach;
  const slope = ENGINE_DEFAULT_REACH.maxStandSlope + slideAngle(settings.physics) - slideAngle(DEFAULT_TUNING);
  return Object.freeze({
    ...ENGINE_DEFAULT_REACH,
    pull: Math.max(0.1, centimetres(ENGINE_DEFAULT_REACH.pull + reach - DEFAULT_RIG_REACH)),
    rise: Math.max(0.1, centimetres(ENGINE_DEFAULT_REACH.rise + reach - DEFAULT_RIG_REACH)),
    hop: Math.max(0.1, centimetres(ENGINE_DEFAULT_REACH.hop * reach / DEFAULT_RIG_REACH)),
    maxStandSlope: Math.min(85, Math.max(1, Math.round(slope * 10) / 10)),
  });
}

/** The goal a level without an ending trigger measures reach to: its highest bonfire's base, or null without one. */
export function levelGoal(level: LevelDefinition): Point | null {
  let goal: Point | null = null;
  for (const object of level.objects) {
    if (object.kind === 'bonfire' && (goal === null || object.y > goal.y)) goal = { x: object.x, y: object.y };
  }
  return goal;
}

// The library set piece and placement stamp of a part's ID, which placeSetPiece makes `<piece>-<stamp>-<part>`.
function setPiecePart(id: string, pieces: readonly string[]): { readonly piece: string; readonly stamp: string } | null {
  for (const piece of pieces) {
    if (!id.startsWith(`${piece}-`)) continue;
    const match = /^(.+)-\d+$/.exec(id.slice(piece.length + 1));
    if (match !== null) return { piece, stamp: match[1]! };
  }
  return null;
}

/**
 * The groups and pieces of a level that carries no builder records: each placement of a library set piece in
 * `setPieces`, known by the IDs placeSetPiece gives its parts, is one piece and its own group; every other object is a
 * group of its own. Pieces reserve no bounds.
 */
export function levelGroups(level: LevelDefinition, setPieces: readonly string[]): { readonly groups: Groups; readonly pieces: readonly PieceRecord[] } {
  // Longest first, so a piece whose ID starts with another's is matched as itself.
  const known = [...new Set(setPieces)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const groups = new Map<string, { readonly group: string; readonly zone: string }>();
  const placements = new Map<string, { readonly id: string; readonly stamp: string; readonly objects: LevelObject[] }>();
  for (const object of level.objects) {
    const part = setPiecePart(object.id, known);
    const group = part === null ? object.id : `piece:${part.piece}:${part.stamp}`;
    groups.set(object.id, Object.freeze({ group, zone: '' }));
    if (part === null) continue;
    let placement = placements.get(group);
    if (placement === undefined) {
      placement = { id: part.piece, stamp: part.stamp, objects: [] };
      placements.set(group, placement);
    }
    placement.objects.push(object);
  }
  const pieces = [...placements].map(([group, placement]): PieceRecord => Object.freeze({
    id: placement.id, stamp: placement.stamp, group, direction: 'any', bounds: null, objects: Object.freeze(placement.objects),
  }));
  return { groups, pieces: Object.freeze(pieces) };
}

function membership(groups: Groups, object: { id: string }, failures: CourseFailures) {
  const member = groups.get(object.id);
  if (typeof member?.group !== 'string' || typeof member?.zone !== 'string') {
    throw failures.level({ field: 'course group/zone membership', value: member }, object.id);
  }
  return member;
}

const expand = (bounds: Bounds, margin: number): Bounds => ({
  left: bounds.left - margin, right: bounds.right + margin, bottom: bounds.bottom - margin, top: bounds.top + margin,
});
function triggerBounds(trigger: TriggerObject): Bounds {
  const box = triggerBox(trigger);
  return { left: box.minX, right: box.maxX, bottom: box.minY, top: box.maxY };
}

/** Enemies starting inside terrain, illusions included. */
export function enemyStarts(snapshot: CourseSnapshot): LevelFinding[] {
  const findings: LevelFinding[] = [];
  for (const enemy of snapshot.level.objects) {
    if (enemy.kind !== 'enemy') continue;
    const half = enemy.species === 'bird' ? ENEMY_HALF_BOUNDS.bird : ENEMY_HALF_BOUNDS.ground;
    const bounds = { left: enemy.x - half.x, right: enemy.x + half.x, bottom: enemy.y - half.y, top: enemy.y + half.y };
    const box = snapshot.queries.rectangle(bounds);
    for (const record of snapshot.candidates(bounds)) {
      if (snapshot.queries.overlapExceeds(box, record.solid, POLICY_ALLOWANCES.enemyStart)) {
        findings.push(finding('enemy-start', 'problem', `${enemy.id} starts inside ${record.object.id}.`, enemy, [enemy.id, record.object.id]));
      }
    }
  }
  return findings;
}

/**
 * Terrain of separately built groups must not merge into a piece's parts; retain the authored illusion policy. Also
 * reports enemyStarts.
 */
export function overlaps(snapshot: CourseSnapshot, groups: Groups, supports: ReadonlySet<string> = new Set<string>()): LevelFinding[] {
  const findings: LevelFinding[] = [];
  for (const record of snapshot.solids) {
    for (const other of snapshot.candidates(record.bounds)) {
      if (other.order <= record.order) continue;
      const a = membership(groups, record.object, snapshot.failures).group, b = membership(groups, other.object, snapshot.failures).group;
      const part = (object: TerrainObject, group: string) => group.startsWith('piece:') && !supports.has(object.id);
      if (a === b || (!part(record.object, a) && !part(other.object, b))) continue;
      if (!snapshot.queries.overlapExceeds(record.solid, other.solid, POLICY_ALLOWANCES.overlap)) continue;
      const depth = snapshot.queries.overlapDepth(record.solid, other.solid, OVERLAP_REPORT_RADIUS_TOLERANCE);
      findings.push(finding('overlap', 'problem', `${record.object.id} overlaps ${other.object.id} by ${metres(depth)}.`,
        meeting(record.bounds, other.bounds), [record.object.id, other.object.id]));
    }
  }
  findings.push(...enemyStarts(snapshot));
  return findings;
}

/**
 * Apply smallness and clearance to connected solid components, including islands in one mesh.
 * Only actual parts of the same recorded set-piece placement are exempt; group names and supports are not proof.
 */
export function crampedColliders(snapshot: CourseSnapshot, groups: Groups, pieces: readonly PieceRecord[]): LevelFinding[] {
  snapshot.work.spend('geometry', pieces.length);
  const owners = new Map<string, PieceRecord>();
  const terrainIds = new Set(snapshot.solids.map((record) => record.object.id));
  for (const piece of pieces) {
    snapshot.work.spend('geometry', piece.objects.length);
    for (const object of piece.objects) {
      if (object.kind !== 'terrain') continue;
      if (!terrainIds.has(object.id) || membership(groups, object, snapshot.failures).group !== piece.group || owners.has(object.id)) {
        throw snapshot.failures.level({ field: 'unique set-piece part ownership', value: piece.group }, object.id);
      }
      owners.set(object.id, piece);
    }
  }
  const parts = new Map(snapshot.solids.map((record) => [record.object.id, record.components.length]));
  const name = (record: CourseSnapshot['components'][number]) =>
    (parts.get(record.object.id) ?? 1) > 1 ? `${record.object.id} (part ${record.component + 1})` : record.object.id;
  const size = (bounds: Bounds) => Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom);
  const small = new Set(snapshot.components.filter((record) => size(record.bounds) <= CRAMPED.small));
  const findings: LevelFinding[] = [];
  for (const record of small) {
    for (const other of snapshot.componentCandidates(expand(record.bounds, CRAMPED.clearance))) {
      if (other.order <= record.order || !small.has(other)) continue;
      const owner = owners.get(record.object.id);
      if (owner !== undefined && owner === owners.get(other.object.id)) continue;
      const gap = snapshot.queries.separation(record.solid, other.solid);
      if (gap <= CRAMPED.clearance) {
        findings.push(finding('cramped', 'problem',
          `${name(record)} and ${name(other)} are small colliders ${metres(gap)} apart; keep them more than ${metres(CRAMPED.clearance)} apart.`,
          meeting(record.bounds, other.bounds), [record.object.id, other.object.id]));
      }
    }
  }
  return findings;
}

/** A piece's bounds deliberately reserve its movement space, including empty air. */
export function keepOut(snapshot: CourseSnapshot, groups: Groups, pieces: readonly PieceRecord[],
  allowed: ReadonlySet<string> = new Set<string>()): LevelFinding[] {
  snapshot.work.spend('geometry', pieces.length);
  const findings: LevelFinding[] = [];
  for (const piece of pieces) {
    if (piece.bounds === null) continue;
    const box = piece.bounds, inset = POLICY_ALLOWANCES.reservationInset;
    if (box.right - box.left <= inset * 2 || box.top - box.bottom <= inset * 2) {
      throw snapshot.failures.level({ field: 'set-piece reservation after inset', value: piece.id });
    }
    const inner = snapshot.queries.rectangle({ left: box.left + inset, right: box.right - inset, bottom: box.bottom + inset, top: box.top - inset });
    for (const record of snapshot.candidates(inner.bounds)) {
      if (membership(groups, record.object, snapshot.failures).group === piece.group || allowed.has(`${record.object.id}|${piece.id}`)) continue;
      if (!snapshot.queries.overlapExceeds(record.solid, inner, POLICY_ALLOWANCES.keepOut)) continue;
      const depth = snapshot.queries.overlapDepth(record.solid, inner, OVERLAP_REPORT_RADIUS_TOLERANCE);
      findings.push(finding('keep-out', 'problem', `${record.object.id} reaches ${metres(depth)} into ${piece.id}.`,
        meeting(record.bounds, inner.bounds), [record.object.id]));
    }
  }
  return findings;
}

/** A course's own drafts rise through open air above their region, up to the first launch event's apex. */
export function ventShafts(snapshot: CourseSnapshot, groups: Groups): LevelFinding[] {
  const findings: LevelFinding[] = [];
  for (const vent of snapshot.level.objects) {
    if (vent.kind !== 'trigger' || membership(groups, vent, snapshot.failures).group.startsWith('piece:')) continue;
    const launch = vent.events.find((event) => event.type === 'launch-player');
    if (launch === undefined) continue;
    const bounds = triggerBounds(vent), top = bounds.bottom + launch.height;
    if (top <= bounds.top) continue;
    const shaft = snapshot.queries.rectangle({ ...bounds, bottom: bounds.top, top });
    for (const record of snapshot.candidates(shaft.bounds)) {
      if (record.object.illusion) continue;
      if (snapshot.queries.overlapExceeds(record.solid, shaft, POLICY_ALLOWANCES.vent)) {
        findings.push(finding('vent-shaft', 'problem', `${vent.id}'s draft rises into ${record.object.id}.`,
          meeting(shaft.bounds, record.bounds), [vent.id, record.object.id]));
      }
    }
  }
  return findings;
}

function standingClearance(snapshot: CourseSnapshot, point: Point, rules: ReachRules) {
  const clearColumn = (x: number, heights: readonly number[]) => {
    for (let i = 0; i < heights.length; i++) {
      const probe = { x, y: point.y + heights[i]! };
      if (snapshot.inside(probe) !== null) return false;
      if (i > 0 && snapshot.blocksSegment({ x, y: point.y + heights[i - 1]! }, probe)) return false;
    }
    return true;
  };
  // Do not ignore the supporting object: another loop of that same cave may be its ceiling.
  return clearColumn(point.x, rules.clearanceHeights) &&
    clearColumn(point.x - rules.clearanceHalfWidth, rules.sideClearanceHeights) &&
    clearColumn(point.x + rules.clearanceHalfWidth, rules.sideClearanceHeights);
}

/** Upward oriented edges and analytic circle arcs, sampled only for the conservative reach model. */
export function standPoints(snapshot: CourseSnapshot, groups: Groups, reach: ReachModel) {
  return collectStandPoints(snapshot, groups, reachRules(reach, snapshot.failures, snapshot.work));
}

function collectStandPoints(snapshot: CourseSnapshot, groups: Groups, rules: ReachRules) {
  const points: StandPoint[] = [];
  const sampled = new Set<string>();
  for (const record of snapshot.solids) {
    const object = record.object, member = membership(groups, object, snapshot.failures);
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

const clearLine = (from: Point, to: Point, snapshot: CourseSnapshot) => !snapshot.blocksSegment(from, to);

export type ReachResult = ReturnType<typeof reachGraph>;

/**
 * A conservative authoring model, not a physics/playability proof. The complete model is mandatory.
 * Trusted piece membership remains explicit policy: hubs for any-direction pieces, an ordered chain for descents.
 * It measures reach to the level's ending trigger, or without one to `goal`.
 */
export function reachGraph(snapshot: CourseSnapshot, groups: Groups, pieces: readonly PieceRecord[], links: readonly DesignedLink[],
  reach: ReachModel, goal: Point | null = null) {
  const rules = reachRules(reach, snapshot.failures, snapshot.work);
  const maximumDrift = rules.fallDriftBase + rules.fallDriftPerMetre * rules.drop;
  if (!Number.isFinite(maximumDrift)) throw snapshot.failures.reach('fallDriftPerMetre/drop', maximumDrift, 'The modeled fall drift must stay finite.');
  const { points } = collectStandPoints(snapshot, groups, rules);
  const pointIndex = snapshot.createIndex(points,
    (point) => ({ left: point.x, right: point.x, bottom: point.y, top: point.y }));
  const neighbours: Set<number>[] = [];
  const node = () => { snapshot.work.spend('graphNodes'); neighbours.push(new Set()); return neighbours.length - 1; };
  for (let i = 0; i < points.length; i++) node();
  const connect = (from: number, to: number) => {
    if (from === to || neighbours[from]!.has(to)) return;
    snapshot.work.spend('graphEdges');
    neighbours[from]!.add(to);
  };
  const candidates = (bounds: Bounds) => pointIndex.query(bounds);
  const solid = (point: StandPoint) => !point.illusion;
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
  const columns = new Map<number, StandPoint[]>();
  const bin = (x: number) => {
    const column = Math.round(x / rules.fallColumnSpacing);
    if (!Number.isFinite(column)) throw snapshot.failures.reach('fallColumnSpacing', rules.fallColumnSpacing, 'The modeled fall column must stay finite.');
    return column;
  };
  for (const point of points) {
    if (!solid(point)) continue;
    if (!columns.has(bin(point.x))) columns.set(bin(point.x), []);
    columns.get(bin(point.x))!.push(point);
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
        if (list[middle]!.y < a.y - rules.fallSurfaceOffset) high = middle;
        else low = middle + 1;
      }
      const below = list[low];
      if (below === undefined) continue;
      if (clearLine({ x: below.x, y: a.y + rules.fallProbeStartHeight }, { x: below.x, y: below.y + rules.fallSurfaceOffset }, snapshot)) {
        connect(a.id, below.id);
      }
    }
  }
  const byGroup = new Map<string, StandPoint[]>();
  for (const point of points) {
    if (!byGroup.has(point.group)) byGroup.set(point.group, []);
    byGroup.get(point.group)!.push(point);
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
        const upper = ordered[i - 1]!, lower = ordered[i]!;
        connect(upper.id, lower.id);
        if (upper.y < lower.y + TRUSTED_DESCENT_RISE) connect(lower.id, upper.id);
      }
    } else if (piece.direction === 'any') {
      if (members.length === 0) continue;
      const hub = node();
      for (const point of members) { connect(point.id, hub); connect(hub, point.id); }
    } else throw snapshot.failures.level({ field: 'set-piece traversal direction', value: piece.direction });
  }
  for (const vent of snapshot.level.objects) {
    if (vent.kind !== 'trigger') continue;
    const launches = vent.events.filter((event) => event.type === 'launch-player');
    if (launches.length === 0) continue;
    const lift = Math.max(...launches.map((event) => event.height)), bounds = triggerBounds(vent);
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
  const nearest = (target: Point) => {
    let best: { point: StandPoint; distance: number } | null = null;
    for (const point of candidates({ left: target.x - rules.anchorRadius, right: target.x + rules.anchorRadius,
      bottom: target.y - rules.anchorRadius, top: target.y + rules.anchorRadius })) {
      snapshot.work.spend('reachCandidates');
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (distance <= rules.anchorRadius && (best === null || distance < best.distance ||
        (distance === best.distance && point.id < best.point.id))) best = { point, distance };
    }
    if (best === null) {
      throw snapshot.failures.query('QUERY_NO_STAND_POINT', { x: target.x, y: target.y, radius: rules.anchorRadius },
        `No stand point within ${rules.anchorRadius} m of (${target.x}, ${target.y}).`);
    }
    return best.point;
  };
  snapshot.work.spend('reachCandidates', links.length);
  for (const link of links) connect(nearest(link.from).id, nearest(link.to).id);

  const start = snapshot.level.objects.find((object) => object.kind === 'start');
  const ending = snapshot.level.objects.find((object): object is TriggerObject => object.kind === 'trigger' && object.events.some((event) => event.type === 'stop-timer'));
  const origin = nearest({ x: start!.x, y: start!.y - rules.startFootOffset });
  const seenNodes = new Uint8Array(neighbours.length), queue = [origin.id];
  seenNodes[origin.id] = 1;
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours[queue[head]!]!) {
      if (!seenNodes[next]) { seenNodes[next] = 1; queue.push(next); }
    }
  }
  const inEnding = ending !== undefined
    ? (point: Point) => triggerContains(ending, point) || triggerContains(ending, { x: point.x, y: point.y + rules.endingBelow })
    : (point: Point) => goal !== null && Math.hypot(point.x - goal.x, point.y - goal.y) <= rules.goalRadius;
  const incoming = neighbours.map((): number[] => []);
  neighbours.forEach((targets, from) => { for (const to of targets) incoming[to]!.push(from); });
  const finishNodes = new Uint8Array(neighbours.length), back = points.filter(inEnding).map((point) => point.id);
  for (const id of back) finishNodes[id] = 1;
  for (let head = 0; head < back.length; head++) {
    for (const previous of incoming[back[head]!]!) {
      if (!finishNodes[previous]) { finishNodes[previous] = 1; back.push(previous); }
    }
  }
  const seen = seenNodes.slice(0, points.length), finish = finishNodes.slice(0, points.length);
  const traps = new Map<string, ReachTrap>();
  for (const point of points) {
    if (!seen[point.id] || finish[point.id] || !solid(point)) continue;
    let trap = traps.get(point.group);
    if (trap === undefined) {
      trap = { group: point.group, count: 0, x: point.x, y: point.y, objects: [] };
      traps.set(point.group, trap);
    }
    trap.count++;
    if (!trap.objects.includes(point.object.id)) trap.objects.push(point.object.id);
  }
  const reached = points.filter((point) => seen[point.id]);
  const result = {
    model: 'conservative-authoring-model' as const, playabilityProof: false as const, snapshot,
    // What reach is measured to: the ending trigger, the goal, or nothing.
    target: ending !== undefined ? 'ending' as const : goal !== null ? 'goal' as const : null,
    points, seen, reached: reached.length, total: points.length,
    ending: points.some((point) => seen[point.id] && inEnding(point)),
    highest: reached.reduce((best, point) => point.y > best.y ? point : best, origin),
    unreachedPieces: [] as readonly PieceRecord[], finish, traps: [...traps.values()],
  };
  result.unreachedPieces = piecesNeverReached(result, pieces);
  return result;
}

/** The pieces with places to stand of their own, none of them reached. */
export function piecesNeverReached(result: { readonly points: readonly StandPoint[]; readonly seen: Uint8Array },
  pieces: readonly PieceRecord[]): PieceRecord[] {
  const groups = new Map<string, boolean>();
  for (const point of result.points) groups.set(point.group, (groups.get(point.group) ?? false) || result.seen[point.id] === 1);
  return pieces.filter((piece) => groups.get(piece.group) === false);
}

function pieceFinding(piece: PieceRecord, result: { readonly points: readonly StandPoint[] }): LevelFinding {
  const stand = result.points.find((point) => point.group === piece.group);
  const at = piece.bounds !== null
    ? { x: (piece.bounds.left + piece.bounds.right) / 2, y: (piece.bounds.bottom + piece.bounds.top) / 2 }
    : stand ?? null;
  return finding('unreached-piece', 'suggestion', `${piece.id} (${piece.stamp}) is never reached.`, at,
    piece.objects.map((object) => object.id));
}

/**
 * The reach model's findings: an unreachable ending or goal, pieces never reached, and traps. All are suggestions.
 * Anything but a reachGraph result throws through its snapshot's failures, or else `failures`.
 */
export function reachSuggestions(result: ReachResult, failures: CourseFailures = COURSE_FAILURES): LevelFinding[] {
  if (result?.model !== 'conservative-authoring-model') {
    throw (result?.snapshot?.failures ?? failures).reach('result.model', result?.model, 'reachSuggestions requires a reachGraph result.');
  }
  if (result.target === null) {
    return [finding('no-reach-target', 'suggestion', 'The level has no ending trigger, and no goal to measure reach to.', null, [])];
  }
  const findings: LevelFinding[] = [];
  const highest = result.highest;
  if (!result.ending) {
    findings.push(finding('ending-unreachable', 'suggestion',
      `The ${result.target} is not reachable; the highest reached point is ${place(highest)} on ${highest.object.id}.`,
      highest, [highest.object.id]));
  }
  for (const piece of result.unreachedPieces) findings.push(pieceFinding(piece, result));
  for (const trap of result.traps) {
    findings.push(finding('reach-trap', 'suggestion',
      `Reachable, but the ${result.target} is not reachable from ${trap.group}: ${trap.count} place${trap.count === 1 ? '' : 's'} near ${place(trap)}.`,
      trap, trap.objects.slice(0, 8)));
  }
  return findings;
}

export function budget(snapshot: CourseSnapshot) {
  const level = snapshot.level, count = (kind: LevelObject['kind']) => level.objects.filter((object) => object.kind === kind).length;
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

// ---------------------------------------------------------------------------------------------------------------------
// One level, checked as the Workshop checks it

export interface LevelCheckOptions {
  // The complete reach model, and the goal it measures reach to when the level has no ending trigger.
  readonly reach: ReachModel;
  readonly goal: Readonly<Point> | null;
  // The library set pieces' IDs: their placements' parts may sit closer together than the cramped-collider clearance.
  readonly setPieces: readonly string[];
  readonly workLimits?: JobOptions['workLimits'];
  // Whether the report lists every place to stand the reach model sampled.
  readonly stands?: boolean;
}

// A place to stand the reach model sampled: on which object, whether it is reached from the start, and whether the
// ending or goal is reachable from it.
export interface LevelStand extends Readonly<Point> {
  readonly object: string;
  readonly reached: boolean;
  readonly finishing: boolean;
}

export interface LevelReachSummary {
  readonly target: 'ending' | 'goal';
  // Whether the target is reachable.
  readonly reachable: boolean;
  readonly reached: number;
  readonly total: number;
  readonly highest: Readonly<Point>;
  // Every sampled place to stand, when the options ask for them.
  readonly stands: readonly LevelStand[] | null;
}

export interface LevelCheckStop {
  readonly message: string;
  // The work counter that ran out, when it was the job's own budget.
  readonly counter: QueryCounter | null;
}

/** Plain data, as a worker posts it. */
export interface LevelCheckReport {
  readonly findings: readonly LevelFinding[];
  // Null when reach was not measured: no target, nowhere to stand at the start, or the work ran out first.
  readonly reach: LevelReachSummary | null;
  readonly work: Readonly<Record<QueryCounter, number>>;
  // Where the checks stopped, when their work ran out: the findings of the checks before it stand.
  readonly stopped: LevelCheckStop | null;
}

function workCounter(cause: unknown): QueryCounter | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const counter: unknown = Reflect.get(cause, 'counter');
  return typeof counter === 'string' && counter in COURSE_COUNTERS ? counter as QueryCounter : null;
}
const COURSE_COUNTERS: Readonly<Record<QueryCounter, true>> = Object.freeze({
  geometry: true, spatialVisits: true, cells: true, samples: true, reachCandidates: true, graphNodes: true, graphEdges: true,
});

/**
 * Checks one level without builder records, as the Workshop does: enemies starting in terrain, vent shafts, cramped
 * small colliders (set pieces' own parts exempt, known by levelGroups), and the reach model from the start to the ending
 * trigger, or `goal` without one, trusting no set piece. The job's work is cumulative: when it runs out, the checks stop
 * there and report it, keeping the findings before it. Anything else that fails throws through `failures`.
 */
export function checkLevel(level: unknown, options: LevelCheckOptions, failures: CourseFailures = COURSE_FAILURES): LevelCheckReport {
  const stops = new WeakMap<object, LevelCheckStop>();
  const nowhere = new WeakSet<object>();
  const tracked: CourseFailures = {
    level: (cause, objectId) => failures.level(cause, objectId),
    query: (code, cause, message) => {
      const error = failures.query(code, cause, message);
      if (code === 'QUERY_WORK_LIMIT') stops.set(error, Object.freeze({ message, counter: workCounter(cause) }));
      if (code === 'QUERY_NO_STAND_POINT') nowhere.add(error);
      return error;
    },
    reach: (field, value, message) => failures.reach(field, value, message),
  };
  const job = createCourseJob(options.workLimits === undefined ? {} : { workLimits: options.workLimits }, tracked);
  const findings: LevelFinding[] = [];
  let stopped: LevelCheckStop | null = null;
  let reach: LevelReachSummary | null = null;
  const phase = <T>(run: () => T): T | null => {
    if (stopped !== null) return null;
    try {
      return run();
    } catch (error) {
      const stop = typeof error === 'object' && error !== null ? stops.get(error) : undefined;
      if (stop === undefined) throw error;
      stopped = stop;
      return null;
    }
  };
  const snapshot = phase(() => job.prepare(level));
  if (snapshot !== null) {
    const { groups, pieces } = levelGroups(snapshot.level, options.setPieces);
    // One phase each, so a check that runs out of work keeps the findings of those before it.
    phase(() => findings.push(...enemyStarts(snapshot)));
    phase(() => findings.push(...ventShafts(snapshot, groups)));
    phase(() => findings.push(...crampedColliders(snapshot, groups, pieces)));
    const hasEnding = snapshot.level.objects.some((object) => object.kind === 'trigger' && object.events.some((event) => event.type === 'stop-timer'));
    const goal = hasEnding ? null : options.goal;
    if (!hasEnding && goal === null) {
      findings.push(finding('no-reach-target', 'suggestion', 'The level has no ending trigger, and no goal to measure reach to.', null, []));
    } else {
      phase(() => {
        let result: ReachResult;
        try {
          result = reachGraph(snapshot, groups, [], [], options.reach, goal === null ? null : { x: goal.x, y: goal.y });
        } catch (error) {
          if (typeof error !== 'object' || error === null || !nowhere.has(error)) throw error;
          const start = snapshot.level.objects.find((object) => object.kind === 'start')!;
          findings.push(finding('no-stand-point', 'suggestion',
            `Nothing to stand on within ${metres(options.reach.anchorRadius)} of the start's foot, so reach is not measured.`,
            start, [start.id]));
          return;
        }
        findings.push(...reachSuggestions(result));
        for (const piece of piecesNeverReached(result, pieces)) findings.push(pieceFinding(piece, result));
        const target = result.target;
        if (target === null) return;
        reach = Object.freeze({
          target, reachable: result.ending, reached: result.reached, total: result.total,
          highest: Object.freeze({ x: result.highest.x, y: result.highest.y }),
          stands: options.stands === true ? Object.freeze(result.points.map((point): LevelStand => Object.freeze({
            x: point.x, y: point.y, object: point.object.id, reached: result.seen[point.id] === 1, finishing: result.finish[point.id] === 1,
          }))) : null,
        });
      });
    }
  }
  return Object.freeze({ findings: Object.freeze(findings), reach, work: job.work.usage, stopped });
}
