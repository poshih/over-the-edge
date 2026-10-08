import { createServer } from 'vite';
import { CourseQueryError } from './course-kit/errors.ts';

export interface EngineModules {
  '/src/level.ts': Pick<typeof import('../src/level.ts'),
    'geometryKey' | 'terrainCollision' | 'objectLoops' | 'objectPointLocation' | 'loopsPointLocation' |
    'shapeMesh' | 'validateLevel' | 'validateLevelObject' | 'triggerBounds' | 'triggerContains' |
    'isSimplePolygon' | 'LevelError' | 'LEVEL_LIMITS' | 'LEVEL_SCHEMA_VERSION' | 'TRIGGER_LIMITS' | 'DECORATION_LIMITS'>;
  '/src/collision-queries.ts': Pick<typeof import('../src/collision-queries.ts'),
    'compileCollision' | 'placeCollision' | 'rectangleSolid' | 'pointLocation' | 'intersection' |
    'overlapExceeds' | 'overlapDepth' | 'separation' | 'standingSurfaces' | 'segmentInteriorIntervals' |
    'unionBounds' | 'BoundsIndex' | 'CollisionQueryError'>;
  '/src/mesh-collision.ts': Pick<typeof import('../src/mesh-collision.ts'), 'meshTerrain'>;
  '/src/art-types.ts': Pick<typeof import('../src/art-types.ts'), 'ArtError' | 'ART_LIMITS' | 'artRecord'>;
  '/src/course-art-model.ts': Pick<typeof import('../src/course-art-model.ts'), 'validateCourseModel'>;
  '/src/editor/set-pieces.ts': Pick<typeof import('../src/editor/set-pieces.ts'), 'SET_PIECES' | 'setPieceById' | 'placeSetPiece'>;
  '/src/project.ts': Pick<typeof import('../src/project.ts'),
    'validateProjectManifest' | 'defaultProjectManifest' | 'checkProjectReferences' | 'loadProjectContent' | 'PROJECT_LIMITS'>;
  '/src/trigger-events.ts': Pick<typeof import('../src/trigger-events.ts'), 'ENDING_EVENTS'>;
  '/src/surfaces.ts': Pick<typeof import('../src/surfaces.ts'), 'DEFAULT_SURFACE'>;
  '/src/course-checks.ts': Pick<typeof import('../src/course-checks.ts'),
    'createCourseJob' | 'DEFAULT_WORK_LIMITS' | 'DEFAULT_STANDING_SAMPLE_SPACING' | 'CourseCheckError' |
    'ENGINE_DEFAULT_REACH' | 'POLICY_ALLOWANCES' | 'CRAMPED' | 'overlaps' | 'enemyStarts' | 'keepOut' | 'ventShafts' |
    'crampedColliders' | 'standPoints' | 'reachGraph' | 'reachSuggestions' | 'piecesNeverReached' | 'budget' |
    'checkReachModel' | 'reachForSettings' | 'levelGoal' | 'levelGroups' | 'checkLevel'>;
}

export interface EngineServer {
  ssrLoadModule(path: string): Promise<unknown>;
}

interface OwnedEngineServer extends EngineServer { close(): Promise<void> }
type ExportKind<Value> =
  Value extends (...args: never[]) => unknown ? 'function' :
  Value extends abstract new (...args: never[]) => unknown ? 'function' :
  Value extends readonly unknown[] ? 'array' :
  Value extends number ? 'number' :
  Value extends string ? 'string' : 'object';

const EXPORTS = {
  '/src/level.ts': {
    geometryKey: 'function', terrainCollision: 'function', objectLoops: 'function', objectPointLocation: 'function',
    loopsPointLocation: 'function', shapeMesh: 'function', validateLevel: 'function', validateLevelObject: 'function',
    triggerBounds: 'function', triggerContains: 'function', isSimplePolygon: 'function', LevelError: 'function',
    LEVEL_LIMITS: 'object', LEVEL_SCHEMA_VERSION: 'number', TRIGGER_LIMITS: 'object', DECORATION_LIMITS: 'object',
  },
  '/src/collision-queries.ts': {
    compileCollision: 'function', placeCollision: 'function', rectangleSolid: 'function', pointLocation: 'function',
    intersection: 'function', overlapExceeds: 'function', overlapDepth: 'function', separation: 'function',
    standingSurfaces: 'function', segmentInteriorIntervals: 'function', unionBounds: 'function',
    BoundsIndex: 'function', CollisionQueryError: 'function',
  },
  '/src/mesh-collision.ts': { meshTerrain: 'function' },
  '/src/art-types.ts': { ArtError: 'function', ART_LIMITS: 'object', artRecord: 'function' },
  '/src/course-art-model.ts': { validateCourseModel: 'function' },
  '/src/editor/set-pieces.ts': { SET_PIECES: 'array', setPieceById: 'function', placeSetPiece: 'function' },
  '/src/project.ts': {
    validateProjectManifest: 'function', defaultProjectManifest: 'function', checkProjectReferences: 'function', loadProjectContent: 'function',
    PROJECT_LIMITS: 'object',
  },
  '/src/trigger-events.ts': { ENDING_EVENTS: 'array' },
  '/src/surfaces.ts': { DEFAULT_SURFACE: 'string' },
  '/src/course-checks.ts': {
    createCourseJob: 'function', DEFAULT_WORK_LIMITS: 'object', DEFAULT_STANDING_SAMPLE_SPACING: 'number', CourseCheckError: 'function',
    ENGINE_DEFAULT_REACH: 'object', POLICY_ALLOWANCES: 'object', CRAMPED: 'object', overlaps: 'function', enemyStarts: 'function',
    keepOut: 'function', ventShafts: 'function', crampedColliders: 'function', standPoints: 'function', reachGraph: 'function',
    reachSuggestions: 'function', piecesNeverReached: 'function', budget: 'function', checkReachModel: 'function',
    reachForSettings: 'function', levelGoal: 'function', levelGroups: 'function', checkLevel: 'function',
  },
} as const satisfies { [Path in keyof EngineModules]: { [Name in keyof EngineModules[Path]]: ExportKind<EngineModules[Path][Name]> } };

function moduleExports<Path extends keyof EngineModules>(path: Path, value: unknown): value is EngineModules[Path] {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(EXPORTS[path]).every(([name, type]) => {
    const member: unknown = Reflect.get(value, name);
    return type === 'array' ? Array.isArray(member) : typeof member === type && (type !== 'object' || member !== null);
  });
}

// Keep a shared Vite module graph: independent runnerImport calls would duplicate engine error classes.
export function createEngineServer(root: string): Promise<OwnedEngineServer> {
  return createServer({ configFile: false, root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
}

export async function loadEngineModule<Path extends keyof EngineModules>(server: EngineServer, path: Path): Promise<EngineModules[Path]> {
  // Vite's untyped module namespace is checked once at this boundary, never cast by callers.
  const loaded: unknown = await server.ssrLoadModule(path);
  if (!moduleExports(path, loaded)) {
    throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: path, detail: loaded },
      `Course engine module ${path} is missing required exports.`);
  }
  return loaded;
}
