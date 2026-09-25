import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_LIMITS, validateGameSettings } from './src/game-settings';
import { SPRITE_TARGET_IDS, VISUAL_PART_IDS } from './src/character';
import { spriteBundle } from './build/sprite-bundle';
import { gameTitle } from './build/game-title.ts';
import { courseBundle } from './build/course-bundle';

const project = fileURLToPath(new URL('.', import.meta.url));

function projectJson(variable: string): string | null {
  const requested = process.env[variable];
  const path = requested === undefined ? null : realpathSync(resolve(project, requested));
  if (path !== null && (!path.startsWith(project) || !path.endsWith('.json'))) {
    throw new Error(`${variable} must name a JSON file inside this project.`);
  }
  return path;
}

function gameJson<T>(options: {
  variable: string;
  moduleId: string;
  defaults: T;
  fileBytes: number;
  validate: (value: unknown) => T;
}): Plugin {
  const path = projectJson(options.variable);
  const resolvedModule = `\0${options.moduleId}`;
  return {
    name: `${options.moduleId.slice('virtual:'.length)}-data`,
    resolveId(id) { if (id === options.moduleId) return resolvedModule; },
    load(id) {
      if (id !== resolvedModule) return;
      let data = options.defaults;
      if (path !== null) {
        if (statSync(path).size > options.fileBytes) throw new Error(`${options.variable} exceeds the file size limit.`);
        this.addWatchFile(path);
        data = options.validate(JSON.parse(readFileSync(path, 'utf8')));
      }
      return `export default ${JSON.stringify(data)};`;
    },
    handleHotUpdate(context) {
      if (context.file === path) {
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

export default defineConfig(({ mode }) => ({
  root: resolve(project, 'play'),
  envDir: project,
  publicDir: resolve(project, 'public'),
  resolve: { alias: { '/src': resolve(project, 'src') } },
  plugins: [
    gameTitle({ mode, envDir: project }),
    courseBundle(projectJson('GAME_LEVEL'), process.env.GAME_ART_MODE),
    gameJson({
      variable: 'GAME_SETTINGS', moduleId: 'virtual:game-settings', defaults: DEFAULT_GAME_SETTINGS,
      fileBytes: GAME_SETTINGS_LIMITS.fileBytes, validate: validateGameSettings,
    }),
    spriteBundle({ path: projectJson('GAME_SPRITES'), anchors: VISUAL_PART_IDS, targets: SPRITE_TARGET_IDS }),
    gameOnlyBoundary(),
  ],
  build: { outDir: resolve(project, 'dist-game'), emptyOutDir: true },
  server: { host: '0.0.0.0', port: 5182, strictPort: true, fs: { allow: [project] } },
  preview: { host: '0.0.0.0', port: 4175, strictPort: true },
}));
