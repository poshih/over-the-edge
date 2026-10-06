import { CourseArtError, CourseLevelError, CourseQueryError } from './errors.mjs';

/** @typedef {import('./engine.mjs').CourseEngine} CourseEngine */
/** @typedef {import('../../src/collision-queries.ts').Bounds} Bounds */
/** @typedef {import('../../src/collision-queries.ts').Solid} Solid */
/** @typedef {import('../../src/collision-queries.ts').QueryCounter} QueryCounter */
/** @typedef {import('../../src/collision-queries.ts').CollisionTemplate} CollisionTemplate */
/** @typedef {import('../../src/level.ts').TerrainObject} TerrainObject */
/** @typedef {import('../../src/level.ts').LevelObject} LevelObject */
/**
 * @typedef {object} TerrainRecord
 * @property {number} order
 * @property {TerrainObject} object
 * @property {Solid} solid
 * @property {readonly Solid[]} components
 * @property {Bounds} bounds
 *
 * @typedef {object} ComponentRecord
 * @property {number} order
 * @property {number} component
 * @property {TerrainObject} object
 * @property {Solid} solid
 * @property {Bounds} bounds
 *
 * @typedef {{workLimits?: Partial<Record<QueryCounter, number>>, standingSampleSpacing?: number}} JobOptions
 * @typedef {ReturnType<typeof createCourseJob>} CourseJob
 * @typedef {ReturnType<CourseJob['prepare']>} CourseSnapshot
 */

// Cumulative per job, including builder bounds, snapshot preparation and every subsequent check.
export const DEFAULT_WORK_LIMITS = Object.freeze({
  geometry: 20_000_000,
  spatialVisits: 10_000_000,
  cells: 500_000,
  samples: 100_000,
  reachCandidates: 4_000_000,
  graphNodes: 120_000,
  graphEdges: 1_000_000,
});
export const DEFAULT_STANDING_SAMPLE_SPACING = 0.3;

class CourseWork {
  /** @type {Record<QueryCounter, number>} */
  #counts = Object.fromEntries(Object.keys(DEFAULT_WORK_LIMITS).map((counter) => [counter, 0]));

  /** @param {Readonly<Record<QueryCounter, number>>} limits */
  constructor(limits) { this.limits = limits; }

  /** @param {QueryCounter} counter @param {number} [amount] */
  spend(counter, amount = 1) {
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

/** @param {CourseEngine} engine */
function validateEngine(engine) {
  const required = {
    level: ['geometryKey', 'terrainCollision', 'objectLoops', 'objectPointLocation', 'loopsPointLocation',
      'shapeMesh', 'validateLevel', 'validateLevelObject', 'triggerBounds', 'triggerContains', 'LevelError'],
    queries: ['compileCollision', 'placeCollision', 'rectangleSolid', 'pointLocation', 'intersection', 'overlapExceeds', 'overlapDepth',
      'separation', 'standingSurfaces', 'segmentInteriorIntervals', 'unionBounds', 'BoundsIndex', 'CollisionQueryError'],
    mesh: ['meshTerrain'],
    art: ['ArtError'],
  };
  for (const [module, names] of Object.entries(required)) {
    for (const name of names) {
      if (typeof engine?.[module]?.[name] !== 'function') {
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

/** @param {JobOptions} options */
function jobOptions(options) {
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
 * @param {CourseEngine} engine
 * @param {JobOptions} [options]
 */
export function createCourseJob(engine, options = {}) {
  validateEngine(engine);
  const { limits, spacing } = jobOptions(options);
  const work = Object.freeze(new CourseWork(limits));
  /** @type {Map<string, CollisionTemplate>} */
  const templates = new Map();
  /** @template T @param {() => T} action @returns {T} */
  const query = (action) => {
    try {
      return action();
    } catch (cause) {
      if (cause instanceof engine.level.LevelError) throw new CourseLevelError(cause);
      if (cause instanceof engine.queries.CollisionQueryError) throw new CourseQueryError(cause.code, cause, cause.message);
      throw cause;
    }
  };
  /** @param {Pick<TerrainObject, 'mesh' | 'mirror'>} object */
  const template = (object) => query(() => {
    const key = engine.level.geometryKey(object);
    let result = templates.get(key);
    if (result === undefined) result = engine.queries.compileCollision(object, work);
    else templates.delete(key);
    // Eviction changes only cache residency, never queried geometry or candidate completeness.
    if (templates.size >= engine.level.LEVEL_LIMITS.geometryKinds) templates.delete(templates.keys().next().value);
    templates.set(key, result);
    return result;
  });
  /** @param {unknown} object @returns {LevelObject} */
  const validateObject = (object) => {
    try {
      return engine.level.validateLevelObject(object);
    } catch (cause) {
      if (!(cause instanceof engine.level.LevelError)) throw cause;
      throw new CourseLevelError(cause, typeof object?.id === 'string' ? object.id : null);
    }
  };
  /** @param {TerrainObject} object */
  const place = (object) => {
    const validated = validateObject(object);
    if (validated.kind !== 'terrain') throw new CourseLevelError({ field: 'kind', value: validated.kind }, validated.id);
    return query(() => engine.queries.placeCollision(validated, template(validated), work));
  };
  const queries = Object.freeze({
    /** @param {Bounds} bounds */
    rectangle: (bounds) => query(() => engine.queries.rectangleSolid(bounds, template({ mesh: engine.level.shapeMesh('box'), mirror: false }), work)),
    /** @param {Solid} solid @param {Readonly<{x: number, y: number}>} point */
    pointLocation: (solid, point) => query(() => engine.queries.pointLocation(solid, point, work)),
    /** @param {Solid} a @param {Solid} b */
    intersection: (a, b) => query(() => engine.queries.intersection(a, b, work)),
    /** @param {Solid} a @param {Solid} b @param {number} allowance */
    overlapExceeds: (a, b, allowance) => query(() => engine.queries.overlapExceeds(a, b, allowance, work)),
    /** @param {Solid} a @param {Solid} b @param {number} [radiusTolerance] */
    overlapDepth: (a, b, radiusTolerance) => query(() => engine.queries.overlapDepth(a, b, work, radiusTolerance)),
    /** @param {Solid} a @param {Solid} b */
    separation: (a, b) => query(() => engine.queries.separation(a, b, work)),
    /** @param {Solid} solid @param {number} minUp */
    standingSurfaces: (solid, minUp) => query(() => engine.queries.standingSurfaces(solid, minUp, work)),
    /** @param {Solid} solid @param {Readonly<{x: number, y: number}>} from @param {Readonly<{x: number, y: number}>} to */
    segmentInteriorIntervals: (solid, from, to) => query(() => engine.queries.segmentInteriorIntervals(solid, from, to, work)),
  });
  /**
   * @template T
   * @param {readonly T[]} items @param {(item: T) => Bounds} bounds
   * @returns {{query(bounds: Bounds): T[]}}
   */
  const createIndex = (items, bounds) => {
    const index = query(() => new engine.queries.BoundsIndex(items, bounds, work));
    return Object.freeze({
      /** @param {Bounds} box */
      query: (box) => query(() => index.query(box, work)),
    });
  };
  const job = {
    engine, work, queries, standingSampleSpacing: spacing, validateObject, createIndex,
    /** @param {string} assetId @param {ArrayBuffer} bytes @returns {import('../../src/mesh-collision.ts').MeshTerrain} */
    readMesh(assetId, bytes) {
      try {
        return engine.mesh.meshTerrain(assetId, bytes);
      } catch (cause) {
        if (cause instanceof engine.art.ArtError) throw new CourseArtError(assetId, cause);
        if (cause instanceof engine.level.LevelError) throw new CourseLevelError(cause);
        throw cause;
      }
    },
    /** @param {readonly TerrainObject[]} objects @returns {Bounds | null} */
    worldBounds(objects) {
      work.spend('geometry', objects.length);
      return engine.queries.unionBounds(objects.map((object) => place(object).solid.bounds));
    },
    /** @param {unknown} rawLevel */
    prepare(rawLevel) {
      const level = query(() => engine.level.validateLevel(rawLevel));
      /** @type {TerrainRecord[]} */
      const solids = [];
      /** @type {ComponentRecord[]} */
      const components = [];
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
        /** @param {Bounds} bounds */
        candidates: (bounds) => index.query(bounds),
        /** @param {Bounds} bounds */
        componentCandidates: (bounds) => componentIndex.query(bounds),
        /** @param {{x: number, y: number}} point @returns {TerrainObject | null} */
        inside(point) {
          for (const record of snapshot.candidates({ left: point.x, right: point.x, bottom: point.y, top: point.y })) {
            if (!record.object.illusion && queries.pointLocation(record.solid, point) !== 'outside') return record.object;
          }
          return null;
        },
        /** @param {{x: number, y: number}} from @param {{x: number, y: number}} to */
        blocksSegment(from, to) {
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
