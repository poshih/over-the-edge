import { CourseQueryError } from './errors.mjs';

/**
 * @typedef {object} CourseEngine
 * @property {Pick<typeof import('../../src/level.ts'), 'geometryKey' | 'terrainCollision' | 'objectLoops' |
 * 'objectPointLocation' | 'loopsPointLocation' | 'shapeMesh' | 'validateLevel' | 'validateLevelObject' |
 * 'triggerBounds' | 'triggerContains' | 'LevelError' | 'LEVEL_LIMITS' | 'LEVEL_SCHEMA_VERSION'>} level
 * @property {Pick<typeof import('../../src/collision-queries.ts'), 'compileCollision' | 'placeCollision' |
 * 'rectangleSolid' | 'pointLocation' | 'intersection' | 'overlapExceeds' | 'overlapDepth' | 'separation' | 'standingSurfaces' |
 * 'segmentInteriorIntervals' | 'unionBounds' | 'BoundsIndex' | 'CollisionQueryError'>} queries
 * @property {Pick<typeof import('../../src/mesh-collision.ts'), 'meshTerrain'>} mesh
 * @property {Pick<typeof import('../../src/art-types.ts'), 'ArtError'>} art
 */

/**
 * Loads one matching set of engine authorities through the caller's Vite server.
 * The caller owns starting and closing that server; the kit never starts Vite.
 * @param {{ssrLoadModule(path: string): Promise<unknown>}} server
 * @returns {Promise<CourseEngine>}
 */
export async function loadCourseEngine(server) {
  if (typeof server?.ssrLoadModule !== 'function') {
    throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'server.ssrLoadModule' },
      'loadCourseEngine needs the caller\'s Vite module loader.');
  }
  const paths = ['/src/level.ts', '/src/collision-queries.ts', '/src/mesh-collision.ts', '/src/art-types.ts'];
  const modules = await Promise.all(paths.map(async (path) => {
    try {
      return await server.ssrLoadModule(path);
    } catch (cause) {
      throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: path, failure: cause }, `Cannot load course engine module ${path}.`);
    }
  }));
  return /** @type {CourseEngine} */ (Object.freeze({ level: modules[0], queries: modules[1], mesh: modules[2], art: modules[3] }));
}
