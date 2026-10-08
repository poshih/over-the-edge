/**
 * The prepared collision a level's course checks query: each terrain object placed once by the engine's collision
 * authority, spatial indexes over the placements, and collision queries that count their work against the job's
 * limits. DOM-free and three-free: the Workshop runs it in a worker, and the Node course kit loads it through its engine
 * loader (docs/course-kit.md). What it cannot do it throws through its CourseFailures, so each caller keeps its own
 * typed errors.
 */
import {
  BoundsIndex, CollisionQueryError, compileCollision, intersection, overlapDepth, overlapExceeds, placeCollision, pointLocation,
  rectangleSolid, segmentInteriorIntervals, separation, standingSurfaces, unionBounds,
} from './collision-queries';
import type { Bounds, CollisionTemplate, QueryCounter, Solid } from './collision-queries';
import type { Point } from './config';
import { geometryKey, LEVEL_LIMITS, LevelError, shapeMesh, validateLevel, validateLevelObject } from './level';
import type { LevelObject, TerrainObject } from './level';

export interface TerrainRecord {
  readonly order: number;
  readonly object: TerrainObject;
  readonly solid: Solid;
  readonly components: readonly Solid[];
  readonly bounds: Bounds;
}
export interface ComponentRecord {
  readonly order: number;
  readonly component: number;
  readonly object: TerrainObject;
  readonly solid: Solid;
  readonly bounds: Bounds;
}
export interface JobOptions {
  readonly workLimits?: Partial<Record<QueryCounter, number>>;
  readonly standingSampleSpacing?: number;
}

export type CourseQueryCode = 'QUERY_CAPABILITY_UNSUPPORTED' | 'QUERY_WORK_LIMIT' | 'QUERY_NO_STAND_POINT';
export interface CourseFieldCause { readonly field: string; readonly value: unknown }
export interface CourseWorkCause { readonly counter: QueryCounter; readonly requested: number; readonly limit: number }

/** How a course job and its checks report what they cannot do: the errors they throw. */
export interface CourseFailures {
  // Level data the engine refused, or course data that is wrong, naming the object when it is known.
  level(cause: LevelError | CourseFieldCause, objectId?: string | null): Error;
  // A query the job cannot answer: a missing capability, an exceeded work limit (cause CourseWorkCause), or no stand
  // point near an anchor.
  query(code: CourseQueryCode, cause: unknown, message: string): Error;
  // A reach model that is incomplete or invalid.
  reach(field: string, value: unknown, message: string): Error;
}

export type CourseCheckCode = 'LEVEL_DATA_INVALID' | CourseQueryCode | 'REACH_MODEL_INVALID';

/** What COURSE_FAILURES throws: the code of what a course job or its checks could not do, and its typed cause. */
export class CourseCheckError extends Error {
  readonly code: CourseCheckCode;
  readonly objectId: string | null;

  constructor(code: CourseCheckCode, message: string, cause: unknown, objectId: string | null = null) {
    super(message, { cause });
    this.name = 'CourseCheckError';
    this.code = code;
    this.objectId = objectId;
  }
}

export const COURSE_FAILURES: CourseFailures = Object.freeze({
  level: (cause: LevelError | CourseFieldCause, objectId: string | null = null) => new CourseCheckError('LEVEL_DATA_INVALID',
    `${objectId === null ? '' : `${objectId}: `}${cause instanceof Error ? cause.message : `Invalid ${cause.field}: ${String(cause.value)}.`}`,
    cause, objectId),
  query: (code: CourseQueryCode, cause: unknown, message: string) => new CourseCheckError(code, message, cause),
  reach: (field: string, value: unknown, message: string) => new CourseCheckError('REACH_MODEL_INVALID', message, { field, value }),
});

// Cumulative per job, including bounds, snapshot preparation and every subsequent check.
export const DEFAULT_WORK_LIMITS = Object.freeze({
  geometry: 20_000_000,
  spatialVisits: 10_000_000,
  cells: 500_000,
  samples: 100_000,
  reachCandidates: 4_000_000,
  graphNodes: 120_000,
  graphEdges: 1_000_000,
} satisfies Record<QueryCounter, number>);
export const DEFAULT_STANDING_SAMPLE_SPACING = 0.3;

class CourseWork {
  #counts = Object.fromEntries(Object.keys(DEFAULT_WORK_LIMITS).map((counter) => [counter, 0])) as Record<QueryCounter, number>;
  readonly #failures: CourseFailures;
  declare readonly limits: Readonly<Record<QueryCounter, number>>;

  constructor(limits: Readonly<Record<QueryCounter, number>>, failures: CourseFailures) {
    this.limits = limits;
    this.#failures = failures;
  }

  spend(counter: QueryCounter, amount = 1) {
    if (!Object.hasOwn(this.limits, counter) || typeof amount !== 'number' || Number.isNaN(amount) || amount < 0 ||
      (Number.isFinite(amount) && !Number.isInteger(amount))) {
      throw this.#failures.query('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'work.spend', detail: { counter, amount } },
        'Invalid query work counter or amount.');
    }
    const requested = this.#counts[counter] + amount;
    const limit = this.limits[counter];
    if (requested > limit) {
      throw this.#failures.query('QUERY_WORK_LIMIT', { counter, requested, limit } satisfies CourseWorkCause,
        `Course query work limit "${counter}" exceeded (${requested} > ${limit}).`);
    }
    if (!Number.isSafeInteger(requested)) {
      throw this.#failures.query('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'work.spend', detail: { counter, amount } },
        'Invalid query work amount.');
    }
    this.#counts[counter] = requested;
  }

  get usage() { return Object.freeze({ ...this.#counts }); }
}

function jobOptions(options: JobOptions, failures: CourseFailures) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some((key) => !['workLimits', 'standingSampleSpacing'].includes(key))) {
    throw failures.query('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'job.options', detail: options }, 'Unknown or invalid course job options.');
  }
  const given = options.workLimits === undefined ? {} : options.workLimits;
  if (given === null || typeof given !== 'object' || Array.isArray(given) ||
    Object.keys(given).some((key) => !Object.hasOwn(DEFAULT_WORK_LIMITS, key))) {
    throw failures.query('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'job.workLimits', detail: given }, 'Unknown or invalid work-limit counters.');
  }
  const limits = { ...DEFAULT_WORK_LIMITS, ...given };
  for (const [counter, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw failures.query('QUERY_CAPABILITY_UNSUPPORTED', { capability: `job.workLimits.${counter}`, detail: limit },
        `Work limit "${counter}" must be a positive safe integer.`);
    }
  }
  const spacing = options.standingSampleSpacing === undefined ? DEFAULT_STANDING_SAMPLE_SPACING : options.standingSampleSpacing;
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw failures.query('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'job.standingSampleSpacing', detail: spacing },
      'Standing-sample spacing must be a finite positive number of metres.');
  }
  return { limits: Object.freeze(limits), spacing };
}

export type CourseJob = ReturnType<typeof createCourseJob>;
export type CourseSnapshot = ReturnType<CourseJob['prepare']>;

/**
 * Owns normalized template caches and a cumulative work budget. Placements belong to snapshots, not the cache.
 */
export function createCourseJob(options: JobOptions = {}, failures: CourseFailures = COURSE_FAILURES) {
  const { limits, spacing } = jobOptions(options, failures);
  const work = Object.freeze(new CourseWork(limits, failures));
  const templates = new Map<string, CollisionTemplate>();
  // The engine's own errors become the caller's; its failures pass through.
  const query = <T>(action: () => T): T => {
    try {
      return action();
    } catch (cause) {
      if (cause instanceof LevelError) throw failures.level(cause);
      if (cause instanceof CollisionQueryError) throw failures.query(cause.code, cause, cause.message);
      throw cause;
    }
  };
  const template = (object: Pick<TerrainObject, 'mesh' | 'mirror'>) => query(() => {
    const key = geometryKey(object);
    let result = templates.get(key);
    if (result === undefined) result = compileCollision(object, work);
    else templates.delete(key);
    // Eviction changes only cache residency, never queried geometry or candidate completeness.
    if (templates.size >= LEVEL_LIMITS.geometryKinds) templates.delete(templates.keys().next().value!);
    templates.set(key, result);
    return result;
  });
  const validateObject = (object: unknown): LevelObject => {
    try {
      return validateLevelObject(object);
    } catch (cause) {
      if (!(cause instanceof LevelError)) throw cause;
      const id: unknown = object == null ? undefined : Reflect.get(Object(object), 'id');
      throw failures.level(cause, typeof id === 'string' ? id : null);
    }
  };
  const place = (object: TerrainObject) => {
    const validated = validateObject(object);
    if (validated.kind !== 'terrain') throw failures.level({ field: 'kind', value: validated.kind }, validated.id);
    return query(() => placeCollision(validated, template(validated), work));
  };
  const queries = Object.freeze({
    rectangle: (bounds: Bounds) => query(() => rectangleSolid(bounds, template({ mesh: shapeMesh('box'), mirror: false }), work)),
    pointLocation: (solid: Solid, point: Readonly<Point>) => query(() => pointLocation(solid, point, work)),
    intersection: (a: Solid, b: Solid) => query(() => intersection(a, b, work)),
    overlapExceeds: (a: Solid, b: Solid, allowance: number) => query(() => overlapExceeds(a, b, allowance, work)),
    overlapDepth: (a: Solid, b: Solid, radiusTolerance?: number) => query(() => overlapDepth(a, b, work, radiusTolerance)),
    separation: (a: Solid, b: Solid) => query(() => separation(a, b, work)),
    standingSurfaces: (solid: Solid, minUp: number) => query(() => standingSurfaces(solid, minUp, work)),
    segmentInteriorIntervals: (solid: Solid, from: Readonly<Point>, to: Readonly<Point>) => query(() => segmentInteriorIntervals(solid, from, to, work)),
  });
  const createIndex = <T>(items: readonly T[], bounds: (item: T) => Bounds) => {
    const index = query(() => new BoundsIndex(items, bounds, work));
    return Object.freeze({
      query: (box: Bounds) => query(() => index.query(box, work)),
    });
  };
  const job = {
    work, queries, failures, standingSampleSpacing: spacing, validateObject, createIndex,
    worldBounds(objects: readonly TerrainObject[]): Bounds | null {
      work.spend('geometry', objects.length);
      return unionBounds(objects.map((object) => place(object).solid.bounds));
    },
    prepare(rawLevel: unknown) {
      const level = query(() => validateLevel(rawLevel));
      const solids: TerrainRecord[] = [];
      const components: ComponentRecord[] = [];
      for (const object of level.objects) {
        if (object.kind !== 'terrain') continue;
        const placement = query(() => placeCollision(object, template(object), work));
        solids.push(Object.freeze({ order: solids.length, object, ...placement, bounds: placement.solid.bounds }));
        placement.components.forEach((solid, component) => components.push(Object.freeze({
          order: components.length, component, object, solid, bounds: solid.bounds,
        })));
      }
      const index = createIndex(solids, (record) => record.bounds);
      const componentIndex = createIndex(components, (record) => record.bounds);
      const snapshot = {
        level, work, queries, failures, createIndex, standingSampleSpacing: spacing,
        solids: Object.freeze(solids), components: Object.freeze(components),
        bounds: unionBounds(solids.map((record) => record.bounds)), index, componentIndex,
        candidates: (bounds: Bounds) => index.query(bounds),
        componentCandidates: (bounds: Bounds) => componentIndex.query(bounds),
        // The terrain object, other than an illusion, whose collision holds `point`, or null.
        inside(point: Point): TerrainObject | null {
          for (const record of snapshot.candidates({ left: point.x, right: point.x, bottom: point.y, top: point.y })) {
            if (!record.object.illusion && queries.pointLocation(record.solid, point) !== 'outside') return record.object;
          }
          return null;
        },
        // Whether the segment passes through the inside of terrain other than illusions.
        blocksSegment(from: Point, to: Point): boolean {
          const bounds = { left: Math.min(from.x, to.x), right: Math.max(from.x, to.x), bottom: Math.min(from.y, to.y), top: Math.max(from.y, to.y) };
          for (const record of snapshot.candidates(bounds)) {
            if (!record.object.illusion && queries.segmentInteriorIntervals(record.solid, from, to).length > 0) return true;
          }
          return false;
        },
      };
      return Object.freeze(snapshot);
    },
  };
  return Object.freeze(job);
}
