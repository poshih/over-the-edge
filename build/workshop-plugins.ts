import { runnerImport } from 'vite';
import type { Plugin } from 'vite';
import { validateWorkshopModule, WorkshopPluginError } from '../src/editor/workshop-plugin-module';
import { projectModulePath } from './module-path';

/**
 * The Workshop's virtual module for WORKSHOP_MODULE: its default export, a WorkshopModule, or null without one. Only the
 * Workshop's config serves it; the game-only build refuses the module itself and every editor module it imports.
 */
export const WORKSHOP_PLUGINS_MODULE = 'virtual:workshop-plugins';
const RESOLVED = `\0${WORKSHOP_PLUGINS_MODULE}`;

/**
 * WORKSHOP_MODULE names the game's editor-only module inside the project, with the containment rules of
 * AVATAR_RIG_MODULE: its default export lists the Workshop plugins the game adds (src/editor/workshop-sdk.ts).
 */
export function workshopModulePath(project: string, requested: string | undefined): string | null {
  return projectModulePath(project, requested, 'WORKSHOP_MODULE');
}

/**
 * Evaluates the module in Node when the Workshop's dev server or build starts, so a wrong API version, an invalid or
 * duplicate ID or a malformed plugin stops the start with a typed WorkshopPluginError, as an invalid rig module does.
 * The module must therefore be side-effect free: it may define DOM code but not run it while it is imported. Import,
 * syntax and programmer errors keep Vite's own diagnostics. The page checks the module again whenever it changes.
 */
export async function checkWorkshopModule(modulePath: string | null, mode: string): Promise<void> {
  if (modulePath === null) return;
  const loaded = await runnerImport<{ default?: unknown }>(modulePath, { mode });
  const workshopModule = loaded.module.default;
  if (workshopModule === null || workshopModule === undefined) {
    throw new WorkshopPluginError('api-version', `WORKSHOP_MODULE ${modulePath} must default-export its API version and plugins.`);
  }
  validateWorkshopModule(workshopModule);
}

/** Serves `virtual:workshop-plugins` from the module the start checked. */
export function workshopPlugins(options: { readonly module: string | null }): Plugin {
  return {
    name: 'workshop-plugins',
    resolveId(id) {
      if (id === WORKSHOP_PLUGINS_MODULE) return RESOLVED;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      if (options.module === null) return 'export default null;';
      return `export { default } from ${JSON.stringify(options.module)};`;
    },
  };
}
