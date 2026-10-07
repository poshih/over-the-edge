import { CourseArtError, CourseLevelError, CourseQueryError } from './errors.ts';
import type { CourseEngine } from './engine.ts';
import type { Bounds, Solid, QueryCounter, CollisionTemplate } from '../../src/collision-queries.ts';
import type { Point } from '../../src/config.ts';
import type { TerrainObject, LevelObject } from '../../src/level.ts';
import type { MeshTerrain } from '../../src/mesh-collision.ts';

export interface TerrainRecord {
  order: number;
  object: TerrainObject;
  solid: Solid;
  components: readonly Solid[];
  bounds: Bounds;
}
export interface ComponentRecord {
  order: number;
  component: number;
  object: TerrainObject;
  solid: Solid;
  bounds: Bounds;
}
export interface JobOptions {
  workLimits?: Partial<Record<QueryCounter, number>>;
  standingSampleSpacing?: number;
}
export type CourseJob = ReturnType<typeof createCourseJob>;
export type CourseSnapshot = ReturnType<CourseJob['prepare']>;

// Cumulative per job, including builder bounds, snapshot preparation and every subsequent check.
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
  declare readonly limits: Readonly<Record<QueryCounter, number>>;

  constructor(limits: Readonly<Record<QueryCounter, number>>) { this.limits = limits; }

  spend(counter: QueryCounter, amount = 1) {
    if (!Object.hasOwn(this.limits, counter) || typeof amount !== 'number' || Number.isNaN(amount) || amount < 0 ||
      (Number.isFinite(amount) && !Number.isInteger(amount))) {
      throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'work.spend', detail: { counter, amount } },
        'Invalid query work counter or amount.');
    }
    const requested = this.#counts[counter] + amount;
    const limit = this.limits[counter];
    if (requested > limit) throw new CourseQueryError('QUERY_WORK_LIMIT', { counter, requested, limit },
      `Course query work limit "${counter}" exceeded (${requested} > ${limit}).`);
    if (!Number.isSafeInteger(requested)) throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED',
      { capability: 'work.spend', detail: { counter, amount } }, 'Invalid query work amount.');
    this.#counts[counter] = requested;
  }

  get usage() { return Object.freeze({ ...this.#counts }); }
}

function validateEngine(engine: CourseEngine) {
  const required = {
    level: ['geometryKey', 'terrainCollision', 'objectLoops', 'objectPointLocation', 'loopsPointLocation',
      'shapeMesh', 'validateLevel', 'validateLevelObject', 'triggerBounds', 'triggerContains', 'LevelError'],
    queries: ['compileCollision', 'placeCollision', 'rectangleSolid', 'pointLocation', 'intersection', 'overlapExceeds', 'overlapDepth',
      'separation', 'standingSurfaces', 'segmentInteriorIntervals', 'unionBounds', 'BoundsIndex', 'CollisionQueryError'],
    mesh: ['meshTerrain'],
    art: ['ArtError'],
  } as const satisfies { [Module in keyof CourseEngine]: readonly (keyof CourseEngine[Module])[] };
  for (const [module, names] of Object.entries(required)) {
    for (const name of names) {
      const authority: unknown = engine?.[module as keyof CourseEngine];
      if (typeof authority !== 'object' || authority === null || typeof Reflect.get(authority, name) !== 'function') {
        throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: `${module}.${name}` },
          `Course engine is missing ${module}.${name}.`);
      }
    }
  }
  if (!Number.isSafeInteger(engine.level.LEVEL_LIMITS?.geometryKinds) || engine.level.LEVEL_LIMITS.geometryKinds <= 0 ||
    !Number.isSafeInteger(engine.level.LEVEL_SCHEMA_VERSION)) {
    throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'level.LEVEL_LIMITS / LEVEL_SCHEMA_VERSION' },
      'Course engine needs its level limits and schema version.');
  }
}

function jobOptions(options: JobOptions) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some((key) => !['workLimits', 'standingSampleSpacing'].includes(key))) {
    throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'job.options', detail: options }, 'Unknown or invalid course job options.');
  }
  const given = options.workLimits === undefined ? {} : options.workLimits;
  if (given === null || typeof given !== 'object' || Array.isArray(given) ||
    Object.keys(given).some((key) => !Object.hasOwn(DEFAULT_WORK_LIMITS, key))) {
    throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'job.workLimits', detail: given }, 'Unknown or invalid work-limit counters.');
  }
  const limits = { ...DEFAULT_WORK_LIMITS, ...given };
  for (const [counter, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: `job.workLimits.${counter}`, detail: limit },
      `Work limit "${counter}" must be a positive safe integer.`);
  }
  const spacing = options.standingSampleSpacing === undefined ? DEFAULT_STANDING_SAMPLE_SPACING : options.standingSampleSpacing;
  if (!Number.isFinite(spacing) || spacing <= 0) throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'job.standingSampleSpacing', detail: spacing },
    'Standing-sample spacing must be a finite positive number of metres.');
  return { limits: Object.freeze(limits), spacing };
}

/**
 * Owns normalized template caches and a cumulative work budget. Placements belong to snapshots, not the cache.
 */
export function createCourseJob(engine: CourseEngine, options: JobOptions = {}) {
  validateEngine(engine);
  const { limits, spacing } = jobOptions(options);
  const work = Object.freeze(new CourseWork(limits));
  const templates = new Map<string, CollisionTemplate>();
  const query = <T>(action: () => T): T => {
    try {
      return action();
    } catch (cause) {
      if (cause instanceof engine.level.LevelError) throw new CourseLevelError(cause);
      if (cause instanceof engine.queries.CollisionQueryError) throw new CourseQueryError(cause.code, cause, cause.message);
      throw cause;
    }
  };
  const template = (object: Pick<TerrainObject, 'mesh' | 'mirror'>) => query(() => {
    const key = engine.level.geometryKey(object);
    let result = templates.get(key);
    if (result === undefined) result = engine.queries.compileCollision(object, work);
    else templates.delete(key);
    // Eviction changes only cache residency, never queried geometry or candidate completeness.
    if (templates.size >= engine.level.LEVEL_LIMITS.geometryKinds) templates.delete(templates.keys().next().value!);
    templates.set(key, result);
    return result;
  });
  const validateObject = (object: unknown): LevelObject => {
    try {
      return engine.level.validateLevelObject(object);
    } catch (cause) {
      if (!(cause instanceof engine.level.LevelError)) throw cause;
      const id: unknown = object == null ? undefined : Reflect.get(Object(object), 'id');
      throw new CourseLevelError(cause, typeof id === 'string' ? id : null);
    }
  };
  const place = (object: TerrainObject) => {
    const validated = validateObject(object);
    if (validated.kind !== 'terrain') throw new CourseLevelError({ field: 'kind', value: validated.kind }, validated.id);
    return query(() => engine.queries.placeCollision(validated, template(validated), work));
  };
  const queries = Object.freeze({
    rectangle: (bounds: Bounds) => query(() => engine.queries.rectangleSolid(bounds, template({ mesh: engine.level.shapeMesh('box'), mirror: false }), work)),
    pointLocation: (solid: Solid, point: Readonly<Point>) => query(() => engine.queries.pointLocation(solid, point, work)),
    intersection: (a: Solid, b: Solid) => query(() => engine.queries.intersection(a, b, work)),
    overlapExceeds: (a: Solid, b: Solid, allowance: number) => query(() => engine.queries.overlapExceeds(a, b, allowance, work)),
    overlapDepth: (a: Solid, b: Solid, radiusTolerance?: number) => query(() => engine.queries.overlapDepth(a, b, work, radiusTolerance)),
    separation: (a: Solid, b: Solid) => query(() => engine.queries.separation(a, b, work)),
    standingSurfaces: (solid: Solid, minUp: number) => query(() => engine.queries.standingSurfaces(solid, minUp, work)),
    segmentInteriorIntervals: (solid: Solid, from: Readonly<Point>, to: Readonly<Point>) => query(() => engine.queries.segmentInteriorIntervals(solid, from, to, work)),
  });
  const createIndex = <T>(items: readonly T[], bounds: (item: T) => Bounds) => {
    const index = query(() => new engine.queries.BoundsIndex(items, bounds, work));
    return Object.freeze({
      query: (box: Bounds) => query(() => index.query(box, work)),
    });
  };
  const job = {
    engine, work, queries, standingSampleSpacing: spacing, validateObject, createIndex,
    readMesh(assetId: string, bytes: ArrayBuffer): MeshTerrain {
      try {
        return engine.mesh.meshTerrain(assetId, bytes);
      } catch (cause) {
        if (cause instanceof engine.art.ArtError) throw new CourseArtError(assetId, cause);
        if (cause instanceof engine.level.LevelError) throw new CourseLevelError(cause);
        throw cause;
      }
    },
    worldBounds(objects: readonly TerrainObject[]): Bounds | null {
      work.spend('geometry', objects.length);
      return engine.queries.unionBounds(objects.map((object) => place(object).solid.bounds));
    },
    prepare(rawLevel: unknown) {
      const level = query(() => engine.level.validateLevel(rawLevel));
      const solids: TerrainRecord[] = [];
      const components: ComponentRecord[] = [];
      for (const object of level.objects) {
        if (object.kind !== 'terrain') continue;
        const placement = query(() => engine.queries.placeCollision(object, template(object), work));
        solids.push(Object.freeze({ order: solids.length, object, ...placement, bounds: placement.solid.bounds }));
        placement.components.forEach((solid, component) => components.push(Object.freeze({
          order: components.length, component, object, solid, bounds: solid.bounds,
        })));
      }
      const index = createIndex(solids, (record) => record.bounds);
      const componentIndex = createIndex(components, (record) => record.bounds);
      const snapshot = {
        level, engine, work, queries, createIndex, standingSampleSpacing: spacing,
        solids: Object.freeze(solids), components: Object.freeze(components),
        bounds: engine.queries.unionBounds(solids.map((record) => record.bounds)), index, componentIndex,
        candidates: (bounds: Bounds) => index.query(bounds),
        componentCandidates: (bounds: Bounds) => componentIndex.query(bounds),
        inside(point: Point): TerrainObject | null {
          for (const record of snapshot.candidates({ left: point.x, right: point.x, bottom: point.y, top: point.y })) {
            if (!record.object.illusion && queries.pointLocation(record.solid, point) !== 'outside') return record.object;
          }
          return null;
        },
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
