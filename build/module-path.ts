import { realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const MODULE_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.js', '.mjs'];

export class ProjectModuleError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectModuleError'; }
}

// GAME_MODULE and AVATAR_RIG_MODULE share one physical-path containment rule.
export function projectModulePath(project: string, requested: string | undefined, variable: string): string | null {
  if (requested === undefined) return null;
  const root = realpathSync(project);
  try {
    const path = realpathSync(resolve(root, requested));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) ||
      !MODULE_EXTENSIONS.includes(extname(path)) || !statSync(path).isFile()) {
      throw new ProjectModuleError(`${variable} must name a .ts, .mts, .js or .mjs module inside this project.`);
    }
    return path;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new ProjectModuleError(`${variable} ${requested} does not exist.`);
    }
    throw error;
  }
}
