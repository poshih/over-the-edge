import { loadProjectContent, PROJECT_FILES, ProjectError, validateProjectManifest } from '../project';
import type { ProjectContent } from '../project';

interface PublishedFile {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
}

/** The game a Workshop was built with (GAME_PROJECT): its files, served next to the Workshop. */
export interface PublishedProject {
  readonly title: string;
  // Changes whenever any file changes, so a browser copy knows which version it started from.
  readonly version: string;
  readonly files: readonly PublishedFile[];
}

function unavailable(path: string, detail: string): ProjectError {
  return new ProjectError(`The published project's ${path} could not be downloaded (${detail}). Check the connection, then choose Reopen published project.`, { section: path });
}

function mismatch(path: string): ProjectError {
  return new ProjectError(`The published project's ${path} does not match this Workshop; reload the page to get the current deployment.`, { section: path });
}

async function download(file: PublishedFile, signal: AbortSignal, received: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  // Sizes are known from the build, so the file streams into one buffer of its exact size.
  const bytes = new Uint8Array(file.bytes);
  let length = 0;
  try {
    const response = await fetch(file.url, { signal });
    if (!response.ok || response.body === null) throw unavailable(file.path, `HTTP ${response.status}`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.byteLength) throw mismatch(file.path);
      bytes.set(value, length);
      length += value.byteLength;
      received(value.byteLength);
    }
  } catch (error) {
    if (error instanceof TypeError) throw unavailable(file.path, 'no complete response');
    throw error;
  }
  if (length !== bytes.byteLength) throw mismatch(file.path);
  return bytes;
}

// Downloads every file of the published project and validates them like an imported project file.
export async function loadPublishedProject(project: PublishedProject, options: {
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<ProjectContent> {
  const total = project.files.reduce((sum, file) => sum + file.bytes, 0);
  let received = 0;
  // One failed file stops the others.
  const downloads = new AbortController();
  const abort = (): void => downloads.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  let data: Map<string, Uint8Array<ArrayBuffer>>;
  try {
    data = new Map(await Promise.all(project.files.map(async (file) => [file.path, await download(file, downloads.signal, (bytes) => {
      received += bytes;
      options.onProgress(total === 0 ? 1 : received / total);
    })] as const)));
  } catch (error) {
    downloads.abort();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  const decoder = new TextDecoder();
  const read = (path: string): Uint8Array<ArrayBuffer> => {
    const bytes = data.get(path);
    if (bytes === undefined) throw new ProjectError(`The published project is missing ${path}.`, { section: path });
    return bytes;
  };
  const json = (path: string): unknown => {
    try {
      return JSON.parse(decoder.decode(read(path)));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${path} is not valid JSON: ${error.message}`, { section: path });
    }
  };
  return loadProjectContent(validateProjectManifest(json(PROJECT_FILES.manifest)), (ref) => ref.binary ? read(ref.path) : json(ref.path));
}
