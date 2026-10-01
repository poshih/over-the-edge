import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { LEVEL_LIMITS, LevelError, validateLevel } from '../src/level';
import { ProjectError } from '../src/project';
import { SHARED_EXTENSION, validateSharedName } from '../src/shared-copies';
import type { SharedKind } from '../src/shared-copies';
import { workshopFiles } from './workshop-files';
import type { WorkshopFile } from './workshop-files';

/** The shared folder, relative to the repository root, whose level JSON files a Workshop serves. */
export const SERVER_LEVELS: SharedKind = 'levels';

/**
 * The server levels: every `.json` file in the levels folder, in name order, named like a shared copy and
 * validated like an imported level file, minified. None without the folder.
 */
export function loadServerLevels(root: string): WorkshopFile[] {
  const directory = join(root, SERVER_LEVELS);
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(SHARED_EXTENSION)).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const encoder = new TextEncoder();
  return names.map((name) => {
    const path = join(directory, name);
    if (statSync(path).size > LEVEL_LIMITS.fileBytes) throw new Error(`${SERVER_LEVELS}/${name} exceeds the level JSON size limit.`);
    try {
      validateSharedName(name.slice(0, -SHARED_EXTENSION.length));
      return { path: name, type: 'application/json', bytes: encoder.encode(JSON.stringify(validateLevel(JSON.parse(readFileSync(path, 'utf8'))))) };
    } catch (error) {
      if (error instanceof LevelError || error instanceof ProjectError || error instanceof SyntaxError) {
        throw new Error(`${SERVER_LEVELS}/${name}: ${error.message}`, { cause: error });
      }
      throw error;
    }
  });
}

/** Serves the server levels with the Workshop; `virtual:workshop-levels` lists them by file name. */
export function workshopLevels(files: readonly WorkshopFile[]): Plugin {
  return workshopFiles({
    name: 'workshop-levels', files,
    code: (urls) => `export default [${files.map((file, index) =>
      `{name:${JSON.stringify(file.path.slice(0, -SHARED_EXTENSION.length))},url:${urls[index]},bytes:${file.bytes.byteLength}}`).join(',')}];`,
  });
}
