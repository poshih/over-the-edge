import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import type { Plugin } from 'vite';
import { composeKinds } from '../src/plugins/kinds';
import type { Kinds } from '../src/plugins/kinds';
import { isPluginId, PLUGIN_API_VERSION, PLUGIN_LIMITS, PluginError } from '../src/plugins/kernel';
import type { PluginEnvironment } from '../src/plugins/kernel';
import { pluginFacetPath } from './module-path';

const ENVIRONMENTS = ['kinds', 'runtime', 'release', 'workshop'] as const;
export const GAME_PLUGIN_MODULES = Object.freeze({
  kinds: 'virtual:game-plugins/kinds',
  runtime: 'virtual:game-plugins/runtime',
  release: 'virtual:game-plugins/release',
  workshop: 'virtual:game-plugins/workshop',
});
const KINDS = fileURLToPath(new URL('../src/plugins/kinds.ts', import.meta.url));

export type PluginFiles = Readonly<{ id: string } & Partial<Record<PluginEnvironment, string>>>;
export interface GamePluginManifest {
  readonly path: string | null;
  readonly plugins: readonly PluginFiles[];
}
export interface FacetPath {
  readonly plugin: string;
  readonly environment: PluginEnvironment;
  readonly path: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read GAME_PLUGINS once. Identity, ordering and code paths belong only to this build input. */
export function readGamePlugins(project: string, requested: string | undefined): GamePluginManifest {
  if (requested === undefined) return Object.freeze({ path: null, plugins: Object.freeze([]) });
  const root = realpathSync(project);
  let manifest = resolve(root, requested);
  let value: unknown;
  try {
    manifest = realpathSync(manifest);
    if (!manifest.startsWith(root + sep) || extname(manifest) !== '.json' || !statSync(manifest).isFile()) {
      throw new Error('GAME_PLUGINS must name a JSON file physically inside this repo.');
    }
    value = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
  } catch (error) {
    throw new PluginError('invalid-manifest', `Plugin manifest ${manifest}: ${error instanceof Error ? error.message : String(error)}`, null, null, { cause: error });
  }
  const fail: (code: string, message: string, plugin?: string | null) => never = (code, message, plugin = null) => {
    throw new PluginError(code, `Plugin manifest ${manifest}${plugin === null ? '' : `, plugin "${plugin}"`}: ${message}`, plugin);
  };
  if (!record(value) || Object.keys(value).some(key => key !== 'apiVersion' && key !== 'plugins')) {
    fail('invalid-manifest', 'Expected only apiVersion and plugins.');
  }
  if (value.apiVersion !== PLUGIN_API_VERSION) fail('api-version', `Expected API version ${PLUGIN_API_VERSION}, got ${String(value.apiVersion)}.`);
  if (!Array.isArray(value.plugins) || value.plugins.length < 1 || value.plugins.length > PLUGIN_LIMITS.plugins) {
    fail('invalid-manifest', `List 1-${PLUGIN_LIMITS.plugins} plugins in composition order.`);
  }
  const ids = new Set<string>();
  const files = new Map<string, { plugin: string; facet: PluginEnvironment }>();
  const plugins = (value.plugins as unknown[]).map((entry, index): PluginFiles => {
    if (!record(entry)) return fail('invalid-plugin', `Plugin ${index + 1} must be an object.`);
    const id = entry.id;
    if (!isPluginId(id)) return fail('invalid-plugin', `Plugin ${index + 1} needs a 1-64 lowercase letter, digit and hyphen ID starting with a letter.`, typeof id === 'string' ? id : null);
    if (id === 'engine') fail('reserved-plugin', 'The ID "engine" is reserved.', id);
    if (ids.has(id)) fail('duplicate-plugin', 'The ID is already listed.', id);
    ids.add(id);
    if (Object.keys(entry).some(key => key !== 'id' && !(ENVIRONMENTS as readonly string[]).includes(key))) {
      fail('invalid-plugin', 'Expected only id, kinds, runtime, release and workshop.', id);
    }
    const facets: Partial<Record<PluginEnvironment, string>> = {};
    for (const facet of ENVIRONMENTS) {
      if (!Object.hasOwn(entry, facet)) continue;
      const path = entry[facet];
      if (typeof path !== 'string' || path.length === 0) fail('invalid-plugin', `${facet} must be a relative file path.`, id);
      const file = pluginFacetPath(root, manifest, id, facet, path as string);
      const previous = files.get(file);
      if (previous !== undefined) {
        fail('invalid-manifest', `${facet} names ${file} again, already used by plugin "${previous.plugin}" (${previous.facet}).`, id);
      }
      files.set(file, { plugin: id, facet });
      facets[facet] = file;
    }
    if (Object.keys(facets).length === 0) fail('invalid-plugin', 'A plugin needs at least one facet.', id);
    return Object.freeze({ id, ...facets });
  });
  return Object.freeze({ path: manifest, plugins: Object.freeze(plugins) });
}

/** Node validators use the exact same composition as virtual:game-plugins/kinds. Startup snapshot. */
export async function loadKinds(manifest: GamePluginManifest, mode: string): Promise<Kinds> {
  const entries: { id: string; facet: unknown }[] = [];
  // A kinds dependency must not cause a browser-only facet or editor module to be evaluated by a Node validator.
  const boundary = pluginBoundary('kinds-boundary', facetBoundaryPaths(manifest, ['kinds']),
    fileURLToPath(new URL('../src/editor', import.meta.url)));
  for (const plugin of manifest.plugins) {
    if (plugin.kinds === undefined) continue;
    const loaded = await runnerImport<{ default?: unknown }>(plugin.kinds, { mode, plugins: [boundary] });
    entries.push({ id: plugin.id, facet: loaded.module.default });
  }
  return composeKinds(entries);
}

export function facetBoundaryPaths(manifest: GamePluginManifest, environments: readonly PluginEnvironment[]): readonly FacetPath[] {
  return Object.freeze(manifest.plugins.flatMap(plugin => ENVIRONMENTS.flatMap(environment => {
    const path = plugin[environment];
    return path === undefined || environments.includes(environment) ? [] : [{ plugin: plugin.id, environment, path }];
  })));
}

// Check both dev loads and emitted chunks, including symlinked paths and asset query strings.
export function pluginBoundary(name: string, files: readonly FacetPath[], editor?: string): Plugin {
  const forbidden = new Map(files.map(file => [file.path, file]));
  const editorRoot = editor === undefined ? null : realpathSync(editor) + sep;
  const check = (id: string): void => {
    let path = id.split('?')[0]!;
    if (!path.startsWith('/')) return;
    if (editorRoot !== null && path.startsWith(editorRoot)) throw new Error(`The ${name} refuses editor code/assets: ${path}.`);
    try { path = realpathSync(path); } catch (error) {
      // Some generated IDs look like paths. Missing files will also be refused by Vite's file loader; other
      // filesystem failures must not silently bypass a physical-path boundary.
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') as unknown : null;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new PluginError('invalid-facet', `The ${name} could not check ${path}.`, null, null, { cause: error });
      }
    }
    const facet = forbidden.get(path);
    if (facet !== undefined) {
      throw new PluginError('invalid-facet', `The ${name} refuses plugin "${facet.plugin}"'s ${facet.environment} facet: ${path}.`, facet.plugin);
    }
    if (editorRoot !== null && path.startsWith(editorRoot)) throw new Error(`The ${name} refuses editor code/assets: ${path}.`);
  };
  return {
    name,
    enforce: 'pre',
    load(id) { check(id); },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of Object.keys(output.modules)) check(id);
      }
    },
  };
}

/** Serve only this config's environments. A forbidden virtual module is an explicit build error. */
export function gamePlugins(options: { manifest: GamePluginManifest; environments: readonly PluginEnvironment[] }): Plugin {
  const environmentOf = (id: string): PluginEnvironment | null =>
    ENVIRONMENTS.find(environment => GAME_PLUGIN_MODULES[environment] === id) ?? null;
  return {
    name: 'game-plugins',
    configureServer(server) {
      const path = options.manifest.path;
      if (path === null) return;
      // Manifest edits change identity/order/boundaries and require a new Node snapshot, not a partial hot update.
      server.watcher.add(path);
      server.watcher.on('change', file => { if (file === path) void server.restart(); });
    },
    resolveId(id) {
      const environment = environmentOf(id);
      if (environment === null) return;
      if (!options.environments.includes(environment)) {
        throw new PluginError('invalid-facet', `This build does not serve ${id}; allowed facets: ${options.environments.join(', ')}.`);
      }
      return `\0${id}`;
    },
    load(id) {
      if (!id.startsWith('\0')) return;
      const environment = environmentOf(id.slice(1));
      if (environment === null) return;
      if (!options.environments.includes(environment)) throw new PluginError('invalid-facet', `This build does not serve ${id.slice(1)}.`);
      const entries = options.manifest.plugins.filter(plugin => plugin[environment] !== undefined);
      const imports = entries.map((plugin, index) => `import facet${index} from ${JSON.stringify(plugin[environment])};`).join('\n');
      const values = `[${entries.map((plugin, index) => `{ id: ${JSON.stringify(plugin.id)}, facet: facet${index} }`).join(', ')}]`;
      if (environment === 'kinds') {
        // The manifest summary is code-free and also powers Workshop diagnostics for plugins without a Workshop facet.
        const summary = options.manifest.plugins.map(plugin => ({ id: plugin.id, facets: ENVIRONMENTS.filter(facet => plugin[facet] !== undefined) }));
        return `${imports}\nimport { composeKinds } from ${JSON.stringify(KINDS)};\nexport const plugins = ${JSON.stringify(summary)};\nexport default composeKinds(${values});`;
      }
      return `${imports}\nexport default Object.freeze(${values});`;
    },
  };
}
