// The built-in course, which every new game starts from: rock meshes from the engine's own course artwork in
// src/default-course/ and one of each hazard, placed and sliced by scripts/default-course/generate.ts, which writes
// course.json. The ground
// declares a box; the cliff, the boulder and the crags, one of them mirrored, collide as their slices on the obstacle line.
import COURSE from './default-course/course.json' with { type: 'json' };
import { artId, artName } from './art-types';
import type { PlayerSpawn } from './config';
import { NO_DECORATION_ART } from './decoration-art';
import { isTerrainObject, LEVEL_SCHEMA_VERSION, levelSpawn, levelStart, shapeMesh, validateLevel } from './level';
import type { LevelDefinition } from './level';
import { defaultProjectManifest, validateProjectArt, validateProjectManifest } from './project';
import type { ProjectArt, ProjectManifest } from './project';

/** One of the built-in course's GLBs: its asset ID and name, and its file in src/default-course/meshes/ with its size. */
export interface DefaultCourseMesh {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly bytes: number;
}

export const DEFAULT_COURSE_MESHES: readonly DefaultCourseMesh[] = Object.freeze(COURSE.meshes.map((mesh) => {
  if (!/^[a-z0-9-]+\.glb$/.test(mesh.file) || !Number.isSafeInteger(mesh.bytes) || mesh.bytes <= 0) {
    throw new Error(`The built-in course lists an invalid mesh file, ${mesh.file}.`);
  }
  return Object.freeze({ id: artId(mesh.id), name: artName(mesh.name), file: mesh.file, bytes: mesh.bytes });
}));

export const DEFAULT_LEVEL: LevelDefinition = validateLevel(COURSE.level);

// The built-in course's artwork: its meshes.
export const DEFAULT_COURSE_ART: ProjectArt = validateProjectArt({
  assets: DEFAULT_COURSE_MESHES.map(({ id, name }) => ({ id, name })), decorations: NO_DECORATION_ART,
});

/** A new game: the default settings and look, with the built-in course's artwork for DEFAULT_LEVEL. */
export function defaultCourseManifest(title: string): ProjectManifest {
  return validateProjectManifest({ ...defaultProjectManifest(title), art: DEFAULT_COURSE_ART });
}

// Where the built-in course starts.
export const DEFAULT_START: Readonly<PlayerSpawn> = levelSpawn(DEFAULT_LEVEL);

const ground = DEFAULT_LEVEL.objects.filter(isTerrainObject).find((object) => object.id === 'ground');
if (ground === undefined) throw new Error('The built-in course needs its ground.');

/**
 * A level to start over from: a built-in block as wide as the built-in course's ground, which needs no artwork, and the
 * built-in course's start.
 */
export const STARTER_LEVEL: LevelDefinition = validateLevel({
  schemaVersion: LEVEL_SCHEMA_VERSION, name: null, labels: [],
  objects: [{ ...ground, mesh: shapeMesh('box'), mirror: false }, levelStart(DEFAULT_LEVEL)],
});
