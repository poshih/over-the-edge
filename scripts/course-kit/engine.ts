import { loadEngineModule } from '../engine-loader.ts';
import type { EngineModules, EngineServer } from '../engine-loader.ts';
import { CourseQueryError } from './errors.ts';

export interface CourseEngine {
  level: Omit<EngineModules['/src/level.ts'], 'isSimplePolygon' | 'TRIGGER_LIMITS'>;
  queries: EngineModules['/src/collision-queries.ts'];
  mesh: EngineModules['/src/mesh-collision.ts'];
  art: EngineModules['/src/art-types.ts'];
}

/**
 * Loads one matching set of engine authorities through the caller's Vite server.
 * The caller owns starting and closing that server; the kit never starts Vite.
 */
export async function loadCourseEngine(server: EngineServer): Promise<CourseEngine> {
  if (typeof server?.ssrLoadModule !== 'function') {
    throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'server.ssrLoadModule' },
      'loadCourseEngine needs the caller\'s Vite module loader.');
  }
  const paths = ['/src/level.ts', '/src/collision-queries.ts', '/src/mesh-collision.ts', '/src/art-types.ts'] as const;
  const load = async <Path extends typeof paths[number]>(path: Path): Promise<EngineModules[Path]> => {
    try {
      return await loadEngineModule(server, path);
    } catch (cause) {
      throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: path, failure: cause }, `Cannot load course engine module ${path}.`);
    }
  };
  const [level, queries, mesh, art] = await Promise.all([load(paths[0]), load(paths[1]), load(paths[2]), load(paths[3])]);
  return Object.freeze({ level, queries, mesh, art });
}
