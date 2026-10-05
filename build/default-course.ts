import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COURSE_MESHES } from '../src/default-course';
import type { DefaultCourseMesh } from '../src/default-course';
import { artFile } from '../src/project';
import { sha256Hex } from './release-file';

// The built-in course's GLBs in this repository.
const MESHES = new URL('../src/default-course/meshes/', import.meta.url);

/** Where a built-in course mesh's GLB is. */
export function defaultCourseMeshPath(mesh: DefaultCourseMesh): string {
  return fileURLToPath(new URL(mesh.file, MESHES));
}

/** A built-in course mesh's GLB, checked against the size and asset ID course.json lists. */
export function readDefaultCourseMesh(mesh: DefaultCourseMesh): Uint8Array {
  const bytes = new Uint8Array(readFileSync(defaultCourseMeshPath(mesh)));
  if (bytes.byteLength !== mesh.bytes || `asset-${sha256Hex(bytes)}` !== mesh.id) {
    throw new Error(`src/default-course/meshes/${mesh.file} does not match course.json; run node scripts/default-course/generate.mjs.`);
  }
  return bytes;
}

/** The built-in course's file at a project path, art/<assetId>.glb. */
export function defaultCourseFile(path: string): Uint8Array {
  const mesh = DEFAULT_COURSE_MESHES.find((candidate) => artFile(candidate.id) === path);
  if (mesh === undefined) throw new Error(`The built-in course has no file ${path}.`);
  return readDefaultCourseMesh(mesh);
}
