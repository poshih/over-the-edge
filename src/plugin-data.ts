// Workshop plugins' own project data: each plugin in GAME_PLUGINS may keep one bounded
// JSON document in the open project, under its ID in the manifest's `plugins`, and the project API serves it as the
// section `plugins/<id>`. The engine stores, fingerprints, saves and conflict-checks it like any other section but
// never interprets it; a plugin validates its own. It is editor data: releases never include it.
import { boundedJson } from './bounded-json';
import type { JsonValue } from './bounded-json';
import { ProjectError } from './project-fields';
import { isPluginId, PLUGIN_ID_LIMIT } from './plugins/ids.ts';
export { isPluginId } from './plugins/ids.ts';

export type PluginData = JsonValue;

export const PLUGIN_DATA_LIMITS = Object.freeze({
  // Plugins with data in one project.
  plugins: 16,
  id: PLUGIN_ID_LIMIT,
  depth: 16,
  values: 8192,
  bytes: 64 * 1024,
});

export const NO_PLUGIN_DATA: Readonly<Record<string, PluginData>> = Object.freeze({});

const SECTION_PREFIX = 'plugins/';

// A plugin's data in `plugins`, or null without any: only the plugin's own entry, never a property every object has.
export function pluginDataIn(plugins: Readonly<Record<string, PluginData>>, id: string): PluginData | null {
  return Object.hasOwn(plugins, id) ? plugins[id]! : null;
}

// The project section holding a plugin's data.
export function pluginSection(id: string): `plugins/${string}` {
  return `${SECTION_PREFIX}${id}`;
}

// The plugin a section name belongs to, or null for any other section.
export function pluginOfSection(name: string): string | null {
  if (!name.startsWith(SECTION_PREFIX)) return null;
  const id = name.slice(SECTION_PREFIX.length);
  return isPluginId(id) ? id : null;
}

// One plugin's data within the engine's limits. The plugin's own validation runs where it is loaded.
export function validatePluginData(id: string, value: unknown): PluginData {
  const section = pluginSection(id);
  return boundedJson(value, PLUGIN_DATA_LIMITS, `Plugin "${id}" data`, (message) => new ProjectError(message, { section }));
}

// The manifest's `plugins`: each plugin's data by ID, with null data never stored.
export function validateProjectPlugins(value: unknown): Readonly<Record<string, PluginData>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProjectError('plugins must be an object of plugin data by plugin ID.', { section: 'plugins' });
  }
  const ids = Object.keys(value).sort();
  if (ids.length > PLUGIN_DATA_LIMITS.plugins) {
    throw new ProjectError(`A project keeps data for at most ${PLUGIN_DATA_LIMITS.plugins} plugins.`, { section: 'plugins' });
  }
  if (ids.length === 0) return NO_PLUGIN_DATA;
  return Object.freeze(Object.fromEntries(ids.map((id) => {
    if (!isPluginId(id)) {
      throw new ProjectError(`Plugin IDs use 1-${PLUGIN_DATA_LIMITS.id} lowercase letters, digits and hyphens, starting with a letter, not "${id}".`,
        { section: 'plugins' });
    }
    const data = (value as Record<string, unknown>)[id];
    if (data === null) throw new ProjectError(`Remove plugin "${id}" from plugins instead of storing null.`, { section: pluginSection(id) });
    return [id, validatePluginData(id, data)];
  })));
}

// `plugins` with one plugin's data, already validated, replaced, or removed with null. Every other plugin keeps its data
// object, so only the changed section's fingerprint changes.
export function withPluginData(plugins: Readonly<Record<string, PluginData>>, id: string, data: PluginData | null): Readonly<Record<string, PluginData>> {
  if (!isPluginId(id)) throw new ProjectError(`Plugin IDs use 1-${PLUGIN_DATA_LIMITS.id} lowercase letters, digits and hyphens, starting with a letter.`);
  const next: Record<string, PluginData> = { ...plugins };
  if (data === null) delete next[id];
  else next[id] = data;
  const ids = Object.keys(next).sort();
  if (ids.length > PLUGIN_DATA_LIMITS.plugins) {
    throw new ProjectError(`A project keeps data for at most ${PLUGIN_DATA_LIMITS.plugins} plugins.`, { section: pluginSection(id) });
  }
  return ids.length === 0 ? NO_PLUGIN_DATA : Object.freeze(Object.fromEntries(ids.map((key) => [key, next[key]!])));
}
