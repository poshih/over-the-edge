import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { PluginError } from '../src/plugins/kernel';
import type { PluginEnvironment } from '../src/plugins/kernel';

const MODULE_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.js', '.mjs'];

// Facets are trusted build inputs, relative to their manifest and physically contained in the repo.
export function pluginFacetPath(project: string, manifest: string, plugin: string, facet: PluginEnvironment, requested: string): string {
  const root = realpathSync(project);
  try {
    if (isAbsolute(requested)) throw new Error('Facet paths must be relative to the manifest.');
    const path = realpathSync(resolve(dirname(manifest), requested));
    if (!path.startsWith(root + sep) || !MODULE_EXTENSIONS.includes(extname(path)) || !statSync(path).isFile()) {
      throw new Error('Facets must name .ts, .mts, .js or .mjs files physically inside this repo.');
    }
    return path;
  } catch (error) {
    throw new PluginError('invalid-plugin',
      `Plugin manifest ${manifest}, plugin "${plugin}", ${facet} "${requested}": ${error instanceof Error ? error.message : String(error)}`,
      plugin, null, { cause: error });
  }
}
