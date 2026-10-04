import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin, UserConfig } from 'vite';
import { avatarRigModulePath, avatarRigs, loadAvatarRigRegistry } from './build/avatar-rig-module.ts';
import { gameTitle } from './build/game-title.ts';
import { locationUrl } from './build/location-url.ts';
import { projectModulePath } from './build/module-path.ts';
import { DEFAULT_CONTENT_URL, gameRelease } from './build/release';
import { loadFileRelease, loadProjectRelease } from './build/release-input';
import { RECORDINGS_FOLDER } from './build/release-phantoms';
import { workshopModulePath } from './build/workshop-plugins';

const project = fileURLToPath(new URL('.', import.meta.url));
const FILE_INPUTS = ['GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES'] as const;

function projectJson(variable: string): string | null {
  const requested = process.env[variable];
  const path = requested === undefined ? null : realpathSync(resolve(project, requested));
  if (path !== null && (!path.startsWith(project) || !path.endsWith('.json'))) {
    throw new Error(`${variable} must name a JSON file inside this project.`);
  }
  return path;
}

// Where the shell loads its content.
function contentUrl(): string {
  return locationUrl('GAME_CONTENT_URL', process.env.GAME_CONTENT_URL ?? DEFAULT_CONTENT_URL);
}

// Where the shell sends the player's phantoms and finds other players'. Setting it turns phantoms on.
function phantomsUrl(): string | null {
  const value = process.env.GAME_PHANTOMS_URL;
  return value === undefined ? null : locationUrl('GAME_PHANTOMS_URL', value);
}

// The phantom recordings the release bundles: GAME_PHANTOM_RECORDINGS, a folder of <course>/*.phantom files, or else
// the phantoms/ folder of a GAME_PROJECT folder. Empty bundles none.
function phantomRecordings(requested: string | undefined): string | null {
  const value = process.env.GAME_PHANTOM_RECORDINGS;
  if (value !== undefined) return value === '' ? null : resolve(project, value);
  if (requested === undefined) return null;
  // GAME_PROJECT is relative to this project, as the release loader reads it.
  const target = join(project, requested);
  const folder = basename(target) === 'project.json' ? dirname(target) : target;
  return existsSync(folder) && statSync(folder).isDirectory() ? join(folder, RECORDINGS_FOLDER) : null;
}

// The game's own module, bundled into the shell and started before content loads.
function gameModule(): string | null {
  return projectModulePath(project, process.env.GAME_MODULE, 'GAME_MODULE');
}

// Editor modules, and the game's Workshop plugins (WORKSHOP_MODULE) when it names them, never reach a release.
function gameOnlyBoundary(): Plugin {
  const editor = resolve(project, 'src/editor') + sep;
  const plugins = workshopModulePath(project, process.env.WORKSHOP_MODULE);
  const enforceBoundary = (ids: Iterable<string>): void => {
    const forbidden = [...ids].filter((id) => {
      const path = id.split('?')[0];
      return path.startsWith(editor) || path === plugins;
    });
    if (forbidden.length > 0) {
      throw new Error(`Editor code/assets reached the game-only build:\n${forbidden.map((id) => id.slice(project.length)).join('\n')}`);
    }
  };
  return {
    name: 'game-only-boundary',
    enforce: 'pre',
    load(id) { enforceBoundary([id]); },
    generateBundle(_options, bundle) {
      const files = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of Object.keys(output.modules)) files.add(id);
      }
      enforceBoundary(files);
    },
  };
}

// Typed, so the returned literal keeps its narrow types (`publicDir: false`) through the Promise.
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  // GAME_PROJECT is a complete game; its parts cannot also come from the per-file inputs.
  const requested = process.env.GAME_PROJECT;
  if (requested !== undefined) {
    for (const variable of FILE_INPUTS) {
      if (process.env[variable] !== undefined) throw new Error(`${variable} cannot be combined with GAME_PROJECT; the project already contains it.`);
    }
  }
  const selectedMode = process.env.GAME_ART_MODE;
  if (selectedMode !== undefined && selectedMode !== 'shapes' && selectedMode !== 'meshes') throw new Error('GAME_ART_MODE must be shapes or meshes.');
  const files = {
    level: projectJson('GAME_LEVEL'), settings: projectJson('GAME_SETTINGS'),
    sprites: projectJson('GAME_SPRITES'), alternateSprites: projectJson('GAME_ALTERNATE_SPRITES'),
  };
  // The trusted rig module is resolved and evaluated once here, so the release's model checks and
  // the browser's registry both use the same strategies.
  const rigModule = avatarRigModulePath(project, process.env.AVATAR_RIG_MODULE);
  const rigRegistry = await loadAvatarRigRegistry(rigModule, mode);
  const release = requested === undefined ? null : loadProjectRelease(project, requested, selectedMode, rigRegistry);
  return {
    root: resolve(project, 'play'),
    envDir: project,
    // The shell carries no public files: content, including media, is packaged separately.
    publicDir: false,
    resolve: { alias: { '/src': resolve(project, 'src') } },
    plugins: [
      gameTitle({ mode, envDir: project, projectTitle: release?.title }),
      gameRelease({
        load: release === null ? () => loadFileRelease(project, files, selectedMode, rigRegistry) : () => release,
        contentUrl: contentUrl(),
        phantomsUrl: phantomsUrl(),
        recordings: phantomRecordings(requested),
        module: gameModule(),
        watch: release === null ? Object.values(files).filter((path): path is string => path !== null) : release.files,
        restartOnChange: release !== null,
      }),
      gameOnlyBoundary(),
      avatarRigs({ module: rigModule }),
    ],
    build: { outDir: resolve(project, 'dist-game'), emptyOutDir: true },
    server: { host: '0.0.0.0', port: 5182, strictPort: true, fs: { allow: [project] } },
    preview: { host: '0.0.0.0', port: 4175, strictPort: true },
  };
});
