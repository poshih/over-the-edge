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
import { gameProject } from './build/project-bundle';
import { loadReleaseProject } from './build/project-release';

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
  // An already-validated value from GAME_PROJECT, used instead of the variable's file.
  value?: T;
}): Plugin {
  const path = options.value === undefined ? projectJson(options.variable) : null;
  const resolvedModule = `\0${options.moduleId}`;
  return {
    name: `${options.moduleId.slice('virtual:'.length)}-data`,
    resolveId(id) { if (id === options.moduleId) return resolvedModule; },
    load(id) {
      if (id !== resolvedModule) return;
      let data = options.value ?? options.defaults;
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

// GAME_PROJECT is a complete game; its parts cannot also come from the per-file inputs.
function releaseProject() {
  const requested = process.env.GAME_PROJECT;
  if (requested === undefined) return null;
  for (const variable of ['GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES']) {
    if (process.env[variable] !== undefined) throw new Error(`${variable} cannot be combined with GAME_PROJECT; the project already contains it.`);
  }
  return loadReleaseProject(project, requested);
}

export default defineConfig(({ mode }) => {
  const release = releaseProject();
  const levelPath = projectJson('GAME_LEVEL');
  return {
    root: resolve(project, 'play'),
    envDir: project,
    publicDir: release === null ? resolve(project, 'public') : false,
    resolve: { alias: { '/src': resolve(project, 'src') } },
    plugins: [
      gameTitle({ mode, envDir: project, projectTitle: release?.title }),
      courseBundle(release === null ? levelPath : { value: release.course }, process.env.GAME_ART_MODE),
      gameJson({
        variable: 'GAME_SETTINGS', moduleId: 'virtual:game-settings', defaults: DEFAULT_GAME_SETTINGS,
        fileBytes: GAME_SETTINGS_LIMITS.fileBytes, validate: validateGameSettings, value: release?.settings,
      }),
      spriteBundle({
        path: projectJson('GAME_SPRITES'), alternatePath: projectJson('GAME_ALTERNATE_SPRITES'),
        documents: release === null ? undefined : { primary: release.primary, alternate: release.alternate },
        anchors: VISUAL_PART_IDS, targets: SPRITE_TARGET_IDS,
      }),
      gameProject({ release, levelPath }),
      gameOnlyBoundary(),
    ],
    build: { outDir: resolve(project, 'dist-game'), emptyOutDir: true },
    server: { host: '0.0.0.0', port: 5182, strictPort: true, fs: { allow: [project] } },
    preview: { host: '0.0.0.0', port: 4175, strictPort: true },
  };
});
