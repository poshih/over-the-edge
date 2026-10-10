import { loadProjectDocuments, PROJECT_FILES, ProjectError, projectFileRefs, validateProjectManifest } from '../project';
import type { ProjectDocuments } from '../project';
import { sha256Hex } from '../sha256';

/**
 * A file this Workshop serves, its published project's or the built-in course's: where it is served, and the size and
 * SHA-256 it was built with.
 */
export interface PublishedFile {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The game a Workshop was built with (GAME_PROJECT): its files, served next to the Workshop. */
export interface PublishedProject {
  readonly title: string;
  // Changes whenever any file changes, so a browser copy knows which version it started from.
  readonly version: string;
  readonly files: readonly PublishedFile[];
}

// A binary file of a project the Workshop opens: bytes this page holds, or a published file it downloads when it uses it.
export type OpenedFile = Blob | PublishedFile;

// A project as the Workshop opens it from a project file, this browser's copy or the published project: its validated
// documents, and its binary files by path.
export interface OpenedProject extends ProjectDocuments {
  readonly files: ReadonlyMap<string, OpenedFile>;
}

function unavailable(path: string, detail: string): ProjectError {
  return new ProjectError(`${path} could not be downloaded from this Workshop (${detail}). Check the connection, then try again.`, { section: path });
}

function mismatch(path: string): ProjectError {
  return new ProjectError(`${path} does not match this Workshop; reload the page to get the current deployment.`, { section: path });
}

/** Downloads one file this Workshop serves, checked against the size and SHA-256 it was built with. */
export async function downloadPublishedFile(file: PublishedFile, signal: AbortSignal,
  received: (bytes: number) => void = () => undefined): Promise<Uint8Array<ArrayBuffer>> {
  // Sizes are known from the build, so the file streams into one buffer of its exact size.
  const bytes = new Uint8Array(file.bytes);
  let length = 0;
  try {
    const response = await fetch(file.url, { signal });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      // Files are named by their content, so one a newer deployment changed is gone from the site.
      throw response.status === 404 ? mismatch(file.path) : unavailable(file.path, `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        if (length + next.value.byteLength > bytes.byteLength) {
          await reader.cancel();
          throw mismatch(file.path);
        }
        bytes.set(next.value, length);
        length += next.value.byteLength;
        received(next.value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof TypeError) throw unavailable(file.path, 'no complete response');
    throw error;
  }
  if (length !== bytes.byteLength || await sha256Hex(bytes) !== file.sha256) throw mismatch(file.path);
  return bytes;
}

/**
 * Opens the published project's manifest, level and characters, validating their documents and references. Every
 * binary file stays a published file, downloaded when the Workshop uses it.
 */
export async function loadPublishedProject(project: PublishedProject, options: {
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<OpenedProject> {
  const published = new Map(project.files.map((file) => [file.path, file]));
  const find = (path: string): PublishedFile => {
    const file = published.get(path);
    if (file === undefined) throw new ProjectError(`The published project is missing ${path}.`, { section: path });
    return file;
  };
  // One failed file stops the others.
  const downloads = new AbortController();
  const abort = (): void => downloads.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  const json = (path: string, bytes: Uint8Array): unknown => {
    try {
      return JSON.parse(decoder.decode(bytes));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${path} is not valid JSON: ${error.message}`, { section: path });
    }
  };
  try {
    const manifest = validateProjectManifest(json(PROJECT_FILES.manifest, await downloadPublishedFile(find(PROJECT_FILES.manifest), downloads.signal)));
    const refs = projectFileRefs(manifest);
    const opening = refs.filter((ref) => !ref.binary);
    const total = opening.reduce((sum, ref) => sum + find(ref.path).bytes, 0);
    let received = 0;
    const data = new Map(await Promise.all(opening.map(async (ref) => [ref.path, await downloadPublishedFile(find(ref.path), downloads.signal, (bytes) => {
      received += bytes;
      options.onProgress(total === 0 ? 1 : received / total);
    })] as const)));
    const documents = loadProjectDocuments(manifest, (ref) => json(ref.path, data.get(ref.path)!));
    const files = new Map<string, OpenedFile>();
    for (const ref of refs) {
      if (!ref.binary) continue;
      files.set(ref.path, find(ref.path));
    }
    return Object.freeze({ ...documents, files });
  } catch (error) {
    downloads.abort();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
