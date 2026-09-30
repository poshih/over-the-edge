import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import type { Plugin } from 'vite';
import { AvatarRigError, createAvatarRigRegistry, DEFAULT_AVATAR_RIGS } from '../src/avatar-rig';
import type { AvatarRigModule, AvatarRigRegistry } from '../src/avatar-rig';
import { projectModulePath } from './module-path';

/**
 * The public virtual module the game shell and the Workshop both import. It default-exports the
 * trusted registry, built from AVATAR_RIG_MODULE when one is configured, or the standard rigs.
 */
export const AVATAR_RIG_MODULE = 'virtual:avatar-rigs';
const RESOLVED = `\0${AVATAR_RIG_MODULE}`;
const RUNTIME = fileURLToPath(new URL('../src/avatar-rig.ts', import.meta.url));

/**
 * AVATAR_RIG_MODULE names a side-effect-free module inside the project whose default export is an
 * AvatarRigModule. Without one, only the standard registry exists, and content that selects an
 * unknown driver fails to load rather than falling back to another rig.
 */
export function avatarRigModulePath(project: string, requested: string | undefined): string | null {
  return projectModulePath(project, requested, 'AVATAR_RIG_MODULE');
}

/**
 * Evaluates the trusted module in Node through Vite's own resolver, so the build and project-server
 * validators check exactly the strategies the browser runs. Importing it (rather than treating it as
 * a Vite config) means a default export that is not an AvatarRigModule reaches createAvatarRigRegistry
 * and fails as a typed AvatarRigError, not a plain "config must export an object" error. The registry
 * is a startup snapshot: every validator checks the same one, built once when the dev server, build or
 * project server starts, so changing the module requires a restart.
 */
export async function loadAvatarRigRegistry(modulePath: string | null, mode: string): Promise<AvatarRigRegistry> {
  if (modulePath === null) return DEFAULT_AVATAR_RIGS;
  // Import/syntax/programmer errors retain Vite's original diagnostics; do not relabel every error
  // as a configuration refusal. Only the module-contract boundary below throws AvatarRigError.
  const loaded = await runnerImport<{ default?: unknown }>(modulePath, { mode });
  const rigModule = loaded.module.default;
  // A configured module that default-exports null must fail, not silently mean "no module".
  if (rigModule === null || rigModule === undefined) {
    throw new AvatarRigError('api-version', `AVATAR_RIG_MODULE ${modulePath} must default-export its API version and strategies.`);
  }
  return createAvatarRigRegistry(rigModule as AvatarRigModule);
}

/** Serves `virtual:avatar-rigs`, built from the same resolved module the Node validators used. */
export function avatarRigs(options: { readonly module: string | null }): Plugin {
  return {
    name: 'avatar-rigs',
    resolveId(id) {
      if (id === AVATAR_RIG_MODULE) return RESOLVED;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      if (options.module === null) return `export { DEFAULT_AVATAR_RIGS as default } from ${JSON.stringify(RUNTIME)};`;
      return `import { createAvatarRigRegistry } from ${JSON.stringify(RUNTIME)};\n`
        + `import rigModule from ${JSON.stringify(options.module)};\n`
        + 'export default createAvatarRigRegistry(rigModule);';
    },
  };
}
