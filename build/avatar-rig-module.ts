import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import type { Plugin } from 'vite';
import { AvatarRigError, createAvatarRigRegistry, DEFAULT_AVATAR_RIGS } from '../src/avatar-rig';
import type { AvatarMotionControls, AvatarRigModule, AvatarRigRegistry } from '../src/avatar-rig';
import { NO_AVATAR_MOTION_CONTROLS, validateAvatarMotionControls } from '../src/avatar-motion-controls';
import { projectModulePath } from './module-path';

/**
 * The public virtual module the game shell and the Workshop both import. It default-exports the
 * trusted registry, built from AVATAR_RIG_MODULE when one is configured, or the standard rigs.
 */
export const AVATAR_RIG_MODULE = 'virtual:avatar-rigs';
const RESOLVED = `\0${AVATAR_RIG_MODULE}`;
const RUNTIME = fileURLToPath(new URL('../src/avatar-rig.ts', import.meta.url));

/**
 * The Workshop's virtual module for the module's editor-only `controls` export: the motion kinds'
 * controls, validated against the registry, or none. Only the Workshop serves it, so releases never
 * contain it.
 */
export const AVATAR_MOTION_CONTROLS_MODULE = 'virtual:avatar-motion-controls';
const RESOLVED_CONTROLS = `\0${AVATAR_MOTION_CONTROLS_MODULE}`;
const CONTROLS = fileURLToPath(new URL('../src/avatar-motion-controls.ts', import.meta.url));

/**
 * AVATAR_RIG_MODULE names a side-effect-free module inside the project whose default export is an
 * AvatarRigModule. Without one, only the standard registry exists, and content that selects an
 * unknown driver or motion kind fails to load rather than falling back to another rig or skipping it.
 */
export function avatarRigModulePath(project: string, requested: string | undefined): string | null {
  return projectModulePath(project, requested, 'AVATAR_RIG_MODULE');
}

// Evaluates the trusted module in Node through Vite's own resolver. Import, syntax and programmer
// errors retain Vite's original diagnostics; only the module-contract boundary throws AvatarRigError.
async function importRigModule(modulePath: string, mode: string): Promise<Record<string, unknown>> {
  const loaded = await runnerImport<Record<string, unknown>>(modulePath, { mode });
  return loaded.module;
}

function registryOf(module: Record<string, unknown>, modulePath: string): AvatarRigRegistry {
  const rigModule = module.default;
  // A configured module that default-exports null must fail, not silently mean "no module".
  if (rigModule === null || rigModule === undefined) {
    throw new AvatarRigError('api-version',
      `AVATAR_RIG_MODULE ${modulePath} must default-export its API version, strategies and motions.`);
  }
  return createAvatarRigRegistry(rigModule as AvatarRigModule);
}

/**
 * Builds the registry in Node from the module, so the build and project-server validators check
 * exactly the strategies and motion kinds the browser runs. Importing it (rather than treating it as
 * a Vite config) means a default export that is not an AvatarRigModule reaches createAvatarRigRegistry
 * and fails as a typed error, not a plain "config must export an object" error. The registry is a
 * startup snapshot: every validator checks the same one, built once when the dev server, build or
 * project server starts, so changing the module requires a restart.
 */
export async function loadAvatarRigRegistry(modulePath: string | null, mode: string): Promise<AvatarRigRegistry> {
  if (modulePath === null) return DEFAULT_AVATAR_RIGS;
  return registryOf(await importRigModule(modulePath, mode), modulePath);
}

/**
 * The Workshop's registry and its motion kinds' controls, from one evaluation of the module. Invalid
 * controls fail the Workshop's start with a typed AvatarMotionError, as an invalid module does.
 */
export async function loadWorkshopAvatarRigs(modulePath: string | null, mode: string):
  Promise<{ readonly registry: AvatarRigRegistry; readonly controls: AvatarMotionControls }> {
  if (modulePath === null) return { registry: DEFAULT_AVATAR_RIGS, controls: NO_AVATAR_MOTION_CONTROLS };
  const module = await importRigModule(modulePath, mode);
  const registry = registryOf(module, modulePath);
  return { registry, controls: validateAvatarMotionControls(module.controls, registry.motionIds) };
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

/** Serves the Workshop's `virtual:avatar-motion-controls` from the same module. */
export function avatarMotionControls(options: { readonly module: string | null }): Plugin {
  return {
    name: 'avatar-motion-controls',
    resolveId(id) {
      if (id === AVATAR_MOTION_CONTROLS_MODULE) return RESOLVED_CONTROLS;
    },
    load(id) {
      if (id !== RESOLVED_CONTROLS) return undefined;
      if (options.module === null) return `export { NO_AVATAR_MOTION_CONTROLS as default } from ${JSON.stringify(CONTROLS)};`;
      return `import { validateAvatarMotionControls } from ${JSON.stringify(CONTROLS)};\n`
        + `import * as rigModule from ${JSON.stringify(options.module)};\n`
        + `import registry from ${JSON.stringify(AVATAR_RIG_MODULE)};\n`
        + 'export default validateAvatarMotionControls(rigModule.controls, registry.motionIds);';
    },
  };
}
