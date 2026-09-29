import { LevelError, validateLevel } from '../level';
import type { LevelDefinition } from '../level';
import { PROJECT_FILES } from '../project';
import type { PublishedProject } from './published-project';

/** A level served with this Workshop, the same for everyone who opens it. */
export interface ServerLevel {
  readonly name: string;
  readonly url: string;
  // Known from the build: a file of any other size belongs to another deployment.
  readonly bytes: number;
}

/** The Workshop's server levels: the published project's level first, then the levels folder's. */
export function serverLevels(project: PublishedProject | null, folder: readonly ServerLevel[]): readonly ServerLevel[] {
  const file = project?.files.find((candidate) => candidate.path === PROJECT_FILES.level);
  return project === null || file === undefined ? folder
    : [{ name: `${project.title} (published project)`, url: file.url, bytes: file.bytes }, ...folder];
}

/** Downloads a server level and validates it like an imported level file. */
export async function downloadServerLevel(level: ServerLevel, signal: AbortSignal): Promise<LevelDefinition> {
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(level.url, { signal });
    if (!response.ok) throw new LevelError(`"${level.name}" could not be downloaded from the server (HTTP ${response.status}).`);
    bytes = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof TypeError) throw new LevelError(`"${level.name}" could not be downloaded from the server. Check the connection, then try again.`);
    throw error;
  }
  if (bytes.byteLength !== level.bytes) {
    throw new LevelError(`"${level.name}" on the server does not match this Workshop; reload the page to get the current deployment.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new LevelError(`"${level.name}" on the server is malformed.`);
  }
  return validateLevel(raw);
}
