// The course kit's job: the engine's own (src/course-snapshot.ts, loaded with the checks through the caller's Vite
// server), which throws the kit's typed errors, with the engine attached and GLB reading added.
import { CourseArtError, CourseLevelError, CourseQueryError, ReachModelError } from './errors.ts';
import type { QueryCause } from './errors.ts';
import type { CourseEngine } from './engine.ts';
import type { CourseFailures, JobOptions } from '../../src/course-checks.ts';
import type { MeshTerrain } from '../../src/mesh-collision.ts';
export type { ComponentRecord, JobOptions, TerrainRecord } from '../../src/course-checks.ts';

export type CourseJob = ReturnType<typeof createCourseJob>;
export type CourseSnapshot = ReturnType<CourseJob['prepare']>;

/** What the engine's course job and checks cannot do, as the kit's typed errors. */
export const KIT_FAILURES: CourseFailures = Object.freeze({
  level: (cause: Parameters<CourseFailures['level']>[0], objectId: string | null = null) => new CourseLevelError(cause, objectId),
  // The engine passes its cause as is: a work-limit record, a capability or stand-point record, or its query error.
  query: (code: Parameters<CourseFailures['query']>[0], cause: unknown, message: string) => new CourseQueryError(code, cause as QueryCause, message),
  reach: (field: string, value: unknown, message: string) => new ReachModelError(field, value, message),
});

function validateEngine(engine: CourseEngine) {
  const required = {
    level: ['geometryKey', 'terrainCollision', 'objectLoops', 'objectPointLocation', 'loopsPointLocation',
      'shapeMesh', 'validateLevel', 'validateLevelObject', 'triggerBounds', 'triggerContains', 'LevelError'],
    queries: ['compileCollision', 'placeCollision', 'rectangleSolid', 'pointLocation', 'intersection', 'overlapExceeds', 'overlapDepth',
      'separation', 'standingSurfaces', 'segmentInteriorIntervals', 'unionBounds', 'BoundsIndex', 'CollisionQueryError'],
    mesh: ['meshTerrain'],
    art: ['ArtError'],
    checks: ['createCourseJob', 'overlaps', 'enemyStarts', 'keepOut', 'ventShafts', 'crampedColliders', 'standPoints', 'reachGraph',
      'reachSuggestions', 'piecesNeverReached', 'budget', 'checkReachModel', 'reachForSettings', 'levelGoal', 'levelGroups', 'checkLevel'],
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

/**
 * Owns normalized template caches and a cumulative work budget. Placements belong to snapshots, not the cache.
 * The job and its snapshots carry the engine; every check takes a snapshot of this job.
 */
export function createCourseJob(engine: CourseEngine, options: JobOptions = {}) {
  validateEngine(engine);
  const job = engine.checks.createCourseJob(options, KIT_FAILURES);
  return Object.freeze({
    ...job, engine,
    readMesh(assetId: string, bytes: ArrayBuffer, turn = 0): MeshTerrain {
      try {
        return engine.mesh.meshTerrain(assetId, bytes, turn);
      } catch (cause) {
        if (cause instanceof engine.art.ArtError) throw new CourseArtError(assetId, cause);
        if (cause instanceof engine.level.LevelError) throw new CourseLevelError(cause);
        throw cause;
      }
    },
    prepare: (rawLevel: unknown) => Object.freeze({ ...job.prepare(rawLevel), engine }),
  });
}
