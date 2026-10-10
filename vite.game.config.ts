import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { UserConfig } from 'vite';
import { facetBoundaryPaths, gamePlugins, loadKinds, pluginBoundary, readGamePlugins } from './build/game-plugins.ts';
import { gameTitle } from './build/game-title.ts';
import { locationUrl } from './build/location-url.ts';
import { DEFAULT_CONTENT_URL, gameRelease } from './build/release';
import { loadFileRelease, loadProjectRelease } from './build/release-input';
import { RECORDINGS_FOLDER } from './build/release-phantoms';
import { refuseServerScene } from './build/server-scene-paths';

const project = fileURLToPath(new URL('.', import.meta.url));
const FILE_INPUTS = ['GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES'] as const;

function projectJson(variable: string): string | null {
  const requested = process.env[variable];
  const path = requested === undefined ? null : realpathSync(resolve(project, requested));
  if (path !== null && (!path.startsWith(project) || !path.endsWith('.json'))) {
    throw new Error(`${variable} must name a JSON file inside this project.`);
  }
  if (path !== null) refuseServerScene(project, path, variable);
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

// Typed, so the returned literal keeps its narrow types (`publicDir: false`) through the Promise.
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  // GAME_PROJECT is a complete game; its parts cannot also come from the per-file inputs.
  const requested = process.env.GAME_PROJECT;
  if (requested !== undefined) {
    // The path the release loader opens: GAME_PROJECT joined to this project, as written.
    refuseServerScene(project, join(project, requested), 'GAME_PROJECT');
    for (const variable of FILE_INPUTS) {
      if (process.env[variable] !== undefined) throw new Error(`${variable} cannot be combined with GAME_PROJECT; the project already contains it.`);
    }
  }
  const files = {
    level: projectJson('GAME_LEVEL'), settings: projectJson('GAME_SETTINGS'),
    sprites: projectJson('GAME_SPRITES'), alternateSprites: projectJson('GAME_ALTERNATE_SPRITES'),
  };
  const manifest = readGamePlugins(project, process.env.GAME_PLUGINS);
  const kinds = await loadKinds(manifest, mode);
  const rigRegistry = kinds.avatarRigs;
  const studioPreview = process.env.GAME_STUDIO_PREVIEW === '1';
  const environments = ['kinds', 'runtime', 'release'] as const;
  const boundaryEnvironments = studioPreview ? ['kinds', 'runtime'] as const : environments;
  // Previews serve an empty release list, but the boundary still uses the complete manifest to refuse its files.
  const servedManifest = studioPreview ? Object.freeze({
    ...manifest,
    plugins: Object.freeze(manifest.plugins.map(plugin => {
      const files = { ...plugin };
      delete files.release;
      return Object.freeze(files);
    })),
  }) : manifest;
  // Only a release facet can select library models; studio previews have public access and no library.
  const library = !studioPreview && manifest.plugins.some(plugin => plugin.release !== undefined);
  const release = requested === undefined ? null
    : loadProjectRelease(project, requested, rigRegistry, { library });
  return {
    root: resolve(project, 'play'),
    envDir: project,
    // The shell carries no public files: content, including media, is packaged separately.
    publicDir: false,
    resolve: { alias: { '/src': resolve(project, 'src') } },
    plugins: [
      gameTitle({ mode, envDir: project, projectTitle: release?.title }),
      gameRelease({
        load: release === null ? () => loadFileRelease(project, files, rigRegistry) : () => release,
        contentUrl: contentUrl(),
        phantomsUrl: studioPreview ? null : phantomsUrl(),
        recordings: phantomRecordings(requested),
        watch: release === null ? Object.values(files).filter((path): path is string => path !== null) : release.files,
        restartOnChange: release !== null,
      }),
      pluginBoundary('game-only-boundary', facetBoundaryPaths(manifest, boundaryEnvironments), resolve(project, 'src/editor')),
      gamePlugins({ manifest: servedManifest, environments }),
    ],
    build: { outDir: resolve(project, 'dist-game'), emptyOutDir: true },
    server: { host: '127.0.0.1', port: 5182, strictPort: true, fs: { allow: [project] } },
    preview: { host: '127.0.0.1', port: 4175, strictPort: true },
  };
});
