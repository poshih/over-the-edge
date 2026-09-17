import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { DEFAULT_LEVEL } from './src/default-level';
import { LEVEL_LIMITS, validateLevel } from './src/level';
import { VISUAL_PART_IDS } from './src/character';
import { spriteBundle } from './build/sprite-bundle';

const project = fileURLToPath(new URL('.', import.meta.url));
const moduleId = 'virtual:game-level';
const resolvedModule = `\0${moduleId}`;

function projectJson(variable: string): string | null {
  const requested = process.env[variable];
  const path = requested === undefined ? null : realpathSync(resolve(project, requested));
  if (path !== null && (!path.startsWith(project) || !path.endsWith('.json'))) {
    throw new Error(`${variable} must name a JSON file inside this project.`);
  }
  return path;
}

function gameLevel(): Plugin {
  const levelPath = projectJson('GAME_LEVEL');
  return {
    name: 'game-level-data',
    resolveId(id) { if (id === moduleId) return resolvedModule; },
    load(id) {
      if (id !== resolvedModule) return;
      let level = DEFAULT_LEVEL;
      if (levelPath !== null) {
        if (statSync(levelPath).size > LEVEL_LIMITS.fileBytes) throw new Error('GAME_LEVEL exceeds the level file size limit.');
        this.addWatchFile(levelPath);
        level = validateLevel(JSON.parse(readFileSync(levelPath, 'utf8')));
      }
      return `export default ${JSON.stringify(level)};`;
    },
    handleHotUpdate(context) {
      if (context.file === levelPath) {
        const module = context.server.moduleGraph.getModuleById(resolvedModule);
        if (module) context.server.moduleGraph.invalidateModule(module);
        context.server.ws.send({ type: 'full-reload' });
        return [];
      }
    },
  };
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

export default defineConfig({
  root: resolve(project, 'play'),
  publicDir: resolve(project, 'public'),
  resolve: { alias: { '/src': resolve(project, 'src') } },
  plugins: [
    gameLevel(),
    spriteBundle({ path: projectJson('GAME_SPRITES'), anchors: VISUAL_PART_IDS }),
    gameOnlyBoundary(),
  ],
  build: { outDir: resolve(project, 'dist-game'), emptyOutDir: true },
  server: { host: '0.0.0.0', port: 5182, strictPort: true, fs: { allow: [project] } },
  preview: { host: '0.0.0.0', port: 4175, strictPort: true },
});
