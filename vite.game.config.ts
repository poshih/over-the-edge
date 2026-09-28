import { realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { gameTitle } from './build/game-title.ts';
import { DEFAULT_CONTENT_URL, gameRelease } from './build/release';
import { loadFileRelease, loadProjectRelease } from './build/release-input';

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

// Where the shell loads its content: an HTTP(S) URL or a path relative to the page, ending in /.
function contentUrl(): string {
  const value = process.env.GAME_CONTENT_URL ?? DEFAULT_CONTENT_URL;
  let url: URL | null = null;
  try { url = new URL(value, 'https://shell.invalid/game/'); } catch { url = null; }
  if (url === null || !value.endsWith('/') || /[\s\\]/.test(value) || !['https:', 'http:'].includes(url.protocol) ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('GAME_CONTENT_URL must be an HTTP(S) URL or a relative path ending in /, without credentials, query or fragment.');
  }
  return value;
}

// The game's own module, bundled into the shell and started before content loads.
function gameModule(): string | null {
  const requested = process.env.GAME_MODULE;
  if (requested === undefined) return null;
  let path: string;
  try {
    path = realpathSync(resolve(project, requested));
  } catch {
    throw new Error(`GAME_MODULE ${requested} does not exist.`);
  }
  if (!path.startsWith(project) || !['.ts', '.mts', '.js', '.mjs'].includes(extname(path)) || !statSync(path).isFile()) {
    throw new Error('GAME_MODULE must name a .ts or .js module inside this project.');
  }
  return path;
}

function gameOnlyBoundary(): Plugin {
  const editor = resolve(project, 'src/editor') + sep;
  const enforceBoundary = (ids: Iterable<string>): void => {
    const forbidden = [...ids].filter((id) => id.split('?')[0].startsWith(editor));
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

export default defineConfig(({ mode }) => {
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
  const release = requested === undefined ? null : loadProjectRelease(project, requested, selectedMode);
  return {
    root: resolve(project, 'play'),
    envDir: project,
    // The shell carries no public files: content, including media, is packaged separately.
    publicDir: false,
    resolve: { alias: { '/src': resolve(project, 'src') } },
    plugins: [
      gameTitle({ mode, envDir: project, projectTitle: release?.title }),
      gameRelease({
        load: release === null ? () => loadFileRelease(project, files, selectedMode) : () => release,
        contentUrl: contentUrl(),
        module: gameModule(),
        watch: release === null ? Object.values(files).filter((path): path is string => path !== null) : release.files,
        restartOnChange: release !== null,
      }),
      gameOnlyBoundary(),
    ],
    build: { outDir: resolve(project, 'dist-game'), emptyOutDir: true },
    server: { host: '0.0.0.0', port: 5182, strictPort: true, fs: { allow: [project] } },
    preview: { host: '0.0.0.0', port: 4175, strictPort: true },
  };
});
