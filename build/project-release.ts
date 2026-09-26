import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { AudioSettings } from '../src/audio-settings';
import type { AppearancePart } from '../src/appearance-profile';
import type { GameSettings } from '../src/game-settings';
import type { HudSettings } from '../src/hud';
import type { LevelDefinition } from '../src/level';
import type { SpriteDocument } from '../src/sprite-data';
import type { GameTheme } from '../src/theme';
import type { EnemyArtSettings } from '../src/enemy-art-data';
import type { ArmIkSettings } from '../src/character';
import {
  appearanceFile, artAssetHashMatches, artFile, glbDataUrl, isProjectBundle, loadProjectContent, PROJECT_FILES,
  PROJECT_LIMITS, ProjectError, unpackProjectBundle, validateProjectManifest,
} from '../src/project';
import type { ProjectContent } from '../src/project';
import { mediaFile } from '../src/media';
import { checkAppearanceModel } from '../src/appearance-model';

// Everything a game-only release needs from a project, validated and ready for the build plugins.
export interface ReleaseProject {
  readonly title: string;
  // Files whose changes should reload a development server.
  readonly files: readonly string[];
  readonly level: LevelDefinition;
  // A level, or a course package when the project has terrain artwork.
  readonly course: unknown;
  readonly settings: GameSettings;
  readonly primary: SpriteDocument | null;
  readonly alternate: SpriteDocument | null;
  readonly presentation: {
    readonly theme: GameTheme; readonly hud: HudSettings; readonly enemies: EnemyArtSettings; readonly armIk: Readonly<ArmIkSettings>;
  };
  readonly audio: AudioSettings;
  readonly appearance: readonly (AppearancePart & { readonly bytes: Uint8Array })[];
  readonly media: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}

function inside(root: string, path: string, label: string): string {
  const real = realpathSync(path);
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`${label} must stay inside ${root}.`);
  return real;
}

function readProjectDirectory(directory: string): { content: ProjectContent; files: string[] } {
  const manifestPath = inside(directory, join(directory, PROJECT_FILES.manifest), 'project.json');
  if (statSync(manifestPath).size > PROJECT_LIMITS.manifestBytes) throw new ProjectError('project.json exceeds its size limit.');
  const files = [manifestPath];
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ProjectError(`project.json is not valid JSON: ${error.message}`);
  }
  const manifest = validateProjectManifest(manifestValue);
  const content = loadProjectContent(manifest, (ref) => {
    let path: string;
    try {
      path = inside(directory, join(directory, ...ref.path.split('/')), ref.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProjectError(`The project is missing ${ref.path}.`, { section: ref.path });
      throw error;
    }
    if (statSync(path).size > ref.maxBytes) throw new ProjectError(`${ref.path} exceeds ${ref.maxBytes / 1024 ** 2} MiB.`, { section: ref.path });
    files.push(path);
    if (ref.binary) return new Uint8Array(readFileSync(path));
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${ref.path} is not valid JSON: ${error.message}`, { section: ref.path });
    }
  });
  return { content, files };
}

// Loads GAME_PROJECT: a project directory, its project.json, or a single-file project bundle.
export function loadReleaseProject(root: string, requested: string): ReleaseProject {
  let target: string;
  try {
    target = inside(root, join(root, requested), 'GAME_PROJECT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`GAME_PROJECT ${requested} does not exist.`);
    throw error;
  }
  let loaded: { content: ProjectContent; files: string[] };
  try {
    if (statSync(target).isDirectory()) loaded = readProjectDirectory(target);
    else if (basename(target) === PROJECT_FILES.manifest) loaded = readProjectDirectory(dirname(target));
    else {
      if (!target.endsWith('.json') || statSync(target).size > PROJECT_LIMITS.bundleBytes) {
        throw new ProjectError('GAME_PROJECT must be a project directory, its project.json, or a project bundle JSON file.');
      }
      const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
      if (!isProjectBundle(value)) throw new ProjectError('This JSON file is not an over-the-edge project bundle.');
      loaded = { content: unpackProjectBundle(value), files: [target] };
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof SyntaxError) throw new Error(`GAME_PROJECT: ${error.message}`, { cause: error });
    throw error;
  }
  const { content, files } = loaded;
  const { manifest } = content;
  const binary = (path: string): Uint8Array => {
    const bytes = content.files.get(path);
    if (bytes === undefined) throw new Error(`GAME_PROJECT is missing ${path}.`);
    return bytes;
  };
  for (const asset of manifest.art.assets) {
    const hash = createHash('sha256').update(binary(artFile(asset.id))).digest('hex');
    if (!artAssetHashMatches(asset.id, hash)) throw new Error(`GAME_PROJECT: course artwork ${asset.id} does not match its content hash.`);
  }
  for (const part of manifest.appearance) {
    const bytes = binary(appearanceFile(part.part));
    try {
      checkAppearanceModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch (error) {
      throw new Error(`GAME_PROJECT: appearance model ${part.name} (${part.part}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const used = new Set(content.level.objects.flatMap(object => object.kind === 'terrain' && object.art ? [object.art.assetId] : []));
  const course = used.size === 0 ? content.level : {
    format: 'over-the-edge-course', schemaVersion: 1, mode: manifest.art.mode, level: content.level,
    assets: manifest.art.assets.filter(asset => used.has(asset.id))
      .map(asset => ({ id: asset.id, name: asset.name, source: glbDataUrl(binary(artFile(asset.id))) })),
  };
  return {
    title: manifest.title, files, level: content.level, course, settings: manifest.settings,
    primary: content.characters.primary, alternate: content.characters.alternate,
    presentation: { theme: manifest.theme, hud: manifest.hud, enemies: manifest.enemies, armIk: manifest.armIk },
    audio: manifest.audio,
    appearance: manifest.appearance.map(part => ({ ...part, bytes: binary(appearanceFile(part.part)) })),
    media: manifest.media.map(entry => ({ path: entry.path, bytes: binary(mediaFile(entry.path)) })),
  };
}
