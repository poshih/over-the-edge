// The runtime half of the Workshop plugin contract (src/editor/workshop-sdk.ts): its API version, typed refusal and the
// check of a WORKSHOP_MODULE's default export, which the Workshop's start (in Node, build/workshop-plugins.ts) and its
// page (at load and on every hot update) both run. DOM-free and stylesheet-free, so the Vite config can import it.
import { isPluginId, PLUGIN_DATA_LIMITS } from '../plugin-data';
import type { WorkshopModule, WorkshopPlugin } from './workshop-sdk';

// The plugin module contract version this Workshop understands; a module of another version is refused.
export const WORKSHOP_API_VERSION = 1;

// A portable tag for a typed refusal across Vite's separate module-runner class identity.
export const WORKSHOP_PLUGIN_ERROR_KIND = 'workshop-plugin-error';

export const WORKSHOP_PLUGIN_LIMITS = Object.freeze({ plugins: 32 });

// The engine's codes; a plugin refuses its data with codes of its own.
export const WORKSHOP_PLUGIN_ERROR_CODES = ['api-version', 'invalid-plugin', 'duplicate-plugin', 'plugin-stopped'] as const;

const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A typed Workshop plugin refusal; callers branch on `code`, never the message. The engine raises its codes for module
 * and plugin faults; a plugin's `validate` refuses its own data with codes of its own (lowercase letters, digits and
 * hyphens). `plugin` is the plugin concerned, when known.
 */
export class WorkshopPluginError extends Error {
  readonly kind = WORKSHOP_PLUGIN_ERROR_KIND;
  readonly code: string;
  readonly plugin: string | null;

  constructor(code: string, message: string, plugin: string | null = null) {
    super(message);
    if (!ERROR_CODE.test(code)) throw new TypeError(`Workshop plugin error codes use lowercase letters, digits and hyphens, not "${code}".`);
    this.name = 'WorkshopPluginError';
    this.code = code;
    this.plugin = plugin;
  }
}

// A plugin's typed refusal, rebuilt as this module's class naming the plugin; null for anything else, which is a
// programmer error. A refusal may come from another copy of this module across Vite's module runner, so its portable
// tag identifies it.
export function workshopRefusal(error: unknown, plugin: string): WorkshopPluginError | null {
  if (typeof error !== 'object' || error === null || Reflect.get(error, 'kind') !== WORKSHOP_PLUGIN_ERROR_KIND) return null;
  const code = Reflect.get(error, 'code');
  const message = Reflect.get(error, 'message');
  if (typeof code !== 'string' || !ERROR_CODE.test(code) || typeof message !== 'string') return null;
  return error instanceof WorkshopPluginError && error.plugin === plugin ? error : new WorkshopPluginError(code, message, plugin);
}

function validatePlugin(value: unknown, index: number): WorkshopPlugin {
  if (typeof value !== 'object' || value === null) throw new WorkshopPluginError('invalid-plugin', `Workshop plugin ${index} must be an object.`);
  const id = Reflect.get(value, 'id');
  if (!isPluginId(id)) {
    throw new WorkshopPluginError('invalid-plugin',
      `Workshop plugin ${index} needs an ID of 1-${PLUGIN_DATA_LIMITS.id} lowercase letters, digits and hyphens, starting with a letter.`);
  }
  if (typeof Reflect.get(value, 'start') !== 'function') throw new WorkshopPluginError('invalid-plugin', `Workshop plugin "${id}" has no start() function.`, id);
  const validate = Reflect.get(value, 'validate');
  if (validate !== undefined && typeof validate !== 'function') {
    throw new WorkshopPluginError('invalid-plugin', `Workshop plugin "${id}"'s validate must be a function when given.`, id);
  }
  return value as WorkshopPlugin;
}

// The plugins of a WORKSHOP_MODULE's default export, checked: its API version, and each plugin's ID, start and optional
// validate. Throws WorkshopPluginError: `api-version`, `invalid-plugin` or `duplicate-plugin`.
export function validateWorkshopModule(value: unknown): readonly WorkshopPlugin[] {
  if (typeof value !== 'object' || value === null) {
    throw new WorkshopPluginError('api-version', 'A Workshop module must default-export its API version and plugins.');
  }
  const apiVersion = Reflect.get(value, 'apiVersion');
  if (apiVersion !== WORKSHOP_API_VERSION) {
    throw new WorkshopPluginError('api-version',
      `This Workshop supports plugin module API version ${WORKSHOP_API_VERSION}; the module declares ${String(apiVersion)}.`);
  }
  const plugins = Reflect.get(value, 'plugins');
  if (!Array.isArray(plugins)) throw new WorkshopPluginError('api-version', 'A Workshop module must list its plugins.');
  if (plugins.length > WORKSHOP_PLUGIN_LIMITS.plugins) {
    throw new WorkshopPluginError('invalid-plugin', `A Workshop module lists at most ${WORKSHOP_PLUGIN_LIMITS.plugins} plugins.`);
  }
  const ids = new Set<string>();
  return Object.freeze(plugins.map((entry: unknown, index) => {
    const plugin = validatePlugin(entry, index);
    if (ids.has(plugin.id)) throw new WorkshopPluginError('duplicate-plugin', `Two Workshop plugins share the ID "${plugin.id}".`, plugin.id);
    ids.add(plugin.id);
    return plugin;
  }));
}

export type { WorkshopModule, WorkshopPlugin };
