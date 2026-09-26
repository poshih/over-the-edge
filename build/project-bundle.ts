import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { hasAudio } from '../src/audio-settings';
import { DEFAULT_AUDIO } from '../src/audio-settings';
import { DEFAULT_ARM_IK } from '../src/character';
import { isCoursePackage, validateCoursePackage } from '../src/course-package';
import { DEFAULT_ENEMY_ART } from '../src/enemy-art-data';
import { DEFAULT_HUD } from '../src/hud';
import { validateLevel } from '../src/level';
import type { LevelDefinition } from '../src/level';
import { mediaType } from '../src/media';
import { encodeBase64 } from '../src/sprite-fields';
import { DEFAULT_THEME } from '../src/theme';
import type { ReleaseProject } from './project-release';

const MODULES = {
  presentation: 'virtual:game-presentation',
  appearance: 'virtual:game-appearance',
  audio: 'virtual:game-audio',
  media: 'virtual:game-media',
} as const;
const RESOLVED = Object.fromEntries(Object.entries(MODULES).map(([key, id]) => [key, `\0${id}`])) as Record<keyof typeof MODULES, string>;
const AUDIO = fileURLToPath(new URL('../src/audio.ts', import.meta.url));
const APPEARANCE = fileURLToPath(new URL('../src/appearance-loader.ts', import.meta.url));
const FAVICON = fileURLToPath(new URL('../public/favicon.svg', import.meta.url));

function soundSources(level: LevelDefinition): string[] {
  return [...new Set(level.objects.flatMap(object => object.kind !== 'trigger' ? [] :
    object.events.flatMap(event => event.type === 'play-sound' ? [event.source] : [])))];
}

/**
 * Serves a release's project presentation (theme, HUD, enemy art, arm IK), appearance models, audio
 * and media. Without a project it serves the built-in look. Loaders for GLB parts and audio enter the
 * release only when it uses them.
 */
export function gameProject(options: { release: ReleaseProject | null; levelPath: string | null }): Plugin {
  const { release } = options;
  let building = false;
  let levelSounds: string[] | null = null;
  const sounds = (): string[] => {
    if (release !== null) return soundSources(release.level);
    if (levelSounds === null) {
      if (options.levelPath === null) levelSounds = [];
      else {
        const raw: unknown = JSON.parse(readFileSync(options.levelPath, 'utf8'));
        levelSounds = soundSources(isCoursePackage(raw) ? validateCoursePackage(raw).level : validateLevel(raw));
      }
    }
    return levelSounds;
  };
  return {
    name: 'game-project-data',
    configResolved(config) { building = config.command === 'build'; },
    resolveId(id) {
      for (const [key, module] of Object.entries(MODULES)) if (id === module) return RESOLVED[key as keyof typeof MODULES];
    },
    load(id) {
      if (!Object.values(RESOLVED).includes(id)) return;
      const asset = (bytes: Uint8Array, name: string, type: string): string => {
        if (!building) return JSON.stringify(`data:${type};base64,${encodeBase64(bytes)}`);
        const reference = this.emitFile({ type: 'asset', name, source: bytes });
        return `import.meta.ROLLUP_FILE_URL_${reference}`;
      };
      if (id === RESOLVED.presentation) {
        return `export default ${JSON.stringify(release?.presentation ?? {
          theme: DEFAULT_THEME, hud: DEFAULT_HUD, enemies: DEFAULT_ENEMY_ART, armIk: DEFAULT_ARM_IK,
        })};`;
      }
      if (id === RESOLVED.appearance) {
        if (release === null || release.appearance.length === 0) return 'export default null;';
        const parts = release.appearance.map(part => `{part:${JSON.stringify(part.part)},name:${JSON.stringify(part.name)},source:${
          asset(part.bytes, `${part.part}.glb`, 'model/gltf-binary')},alignment:${JSON.stringify(part.alignment)}}`);
        return `import {loadAppearance} from ${JSON.stringify(APPEARANCE)};
          export default (visuals, signal) => loadAppearance(visuals, [${parts.join(',')}], signal);`;
      }
      if (id === RESOLVED.audio) {
        const audio = release?.audio ?? DEFAULT_AUDIO;
        const preload = sounds();
        if (!hasAudio(audio) && preload.length === 0) return 'export default null;';
        return `import {AudioDirector} from ${JSON.stringify(AUDIO)};
          export default (options) => new AudioDirector({...options, settings: ${JSON.stringify(audio)}, sounds: ${JSON.stringify(preload)}});`;
      }
      const media = (release?.media ?? []).map(entry =>
        `${JSON.stringify(entry.path)}:${asset(entry.bytes, basename(entry.path), mediaType(entry.path))}`);
      return `export default {${media.join(',')}};`;
    },
    generateBundle() {
      // Project releases skip public/, so they carry only their own media plus the icon.
      if (release !== null) this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: readFileSync(FAVICON) });
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => release === null ? html : html.replace('href="/favicon.svg"', 'href="favicon.svg"'),
    },
    configureServer(server) {
      if (release === null) return;
      server.middlewares.use('/favicon.svg', (_request, response) => {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(readFileSync(FAVICON));
      });
      // A project change can touch any release input, so reload the whole configuration.
      server.watcher.add([...release.files]);
      server.watcher.on('change', (file) => {
        if (release.files.includes(file)) void server.restart();
      });
    },
  };
}
