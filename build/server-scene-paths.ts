import { realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Where a Workshop's example scenes are, relative to the repository root: `scenes/<name>/`, each a project folder. Only
// the Workshop serves them.
export const SERVER_SCENES = 'scenes';

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The file system's entry at `path`, following links, with its full device and inode numbers; null when there is none.
function entry(path: string): BigIntStats | null {
  try {
    return statSync(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

// `path` with every link resolved, or, while it does not exist yet, its nearest existing folder's; null when nothing on
// the way exists.
function real(path: string): string | null {
  for (let at = path; ;) {
    try {
      return realpathSync(at);
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(at);
      if (parent === at) return null;
      at = parent;
    }
  }
}

/**
 * Throws if `path` is `root`'s scenes folder or inside it: the example scenes are the Workshop's alone, so no game is
 * built, and no project server keeps projects, from them. Folders are compared as the file system knows them, not as
 * spelled, so links and letter case cannot reach a scene another way. `variable` names where the path came from.
 */
export function refuseServerScene(root: string, path: string, variable: string): void {
  const scenes = entry(resolve(root, SERVER_SCENES));
  if (scenes === null) return;
  for (let at = real(resolve(root, path)); at !== null;) {
    const found = entry(at);
    if (found !== null && found.dev === scenes.dev && found.ino === scenes.ino) {
      throw new Error(`${variable} names ${SERVER_SCENES}/, the Workshop's example scenes, which never ship in a game. ` +
        'Open the scene in Workshop / Project and save it as a project of your own to build it.');
    }
    const parent = dirname(at);
    at = parent === at ? null : parent;
  }
}
