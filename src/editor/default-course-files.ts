import { DEFAULT_COURSE_MESHES, DEFAULT_LEVEL, defaultCourseManifest } from '../default-course';
import { artFile, loadProjectDocuments } from '../project';
import type { OpenedFile, OpenedProject, PublishedFile } from './published-project';

// The built-in course's GLBs, served with the Workshop.
const URLS = import.meta.glob<string>('../default-course/meshes/*.glb', { query: '?url', import: 'default', eager: true });

/** The built-in course's GLBs as files this Workshop serves, each downloaded and checked when the page uses it. */
export const DEFAULT_COURSE_FILES: readonly PublishedFile[] = Object.freeze(DEFAULT_COURSE_MESHES.map((mesh) => {
  const url = URLS[`../default-course/meshes/${mesh.file}`];
  if (url === undefined) throw new Error(`This Workshop is missing the built-in course mesh ${mesh.file}.`);
  return Object.freeze({ path: artFile(mesh.id), url, bytes: mesh.bytes, sha256: mesh.id.slice('asset-'.length) });
}));

/** A new game on the built-in course, as the Workshop opens it: its GLBs stay on the site until it draws them. */
export function openDefaultCourse(title: string): OpenedProject {
  const documents = loadProjectDocuments(defaultCourseManifest(title), () => DEFAULT_LEVEL);
  return Object.freeze({ ...documents, files: new Map<string, OpenedFile>(DEFAULT_COURSE_FILES.map((file) => [file.path, file])) });
}
