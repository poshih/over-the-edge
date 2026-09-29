import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ArmIkSettings } from '../src/character';
import { DEFAULT_ARM_IK, SPRITE_TARGET_IDS, VISUAL_PART_IDS } from '../src/character';
import type { AppearancePart } from '../src/appearance-profile';
import { ART_LIMITS } from '../src/art-types';
import type { ArtMode } from '../src/art-types';
import { DEFAULT_AUDIO } from '../src/audio-settings';
import type { AudioSettings } from '../src/audio-settings';
import { checkCharacterModels } from '../src/character-model-check';
import { levelMediaSources } from '../src/content';
import { validateCourseModel } from '../src/course-art-model';
import { embeddedGlb, isCoursePackage, validateCoursePackage } from '../src/course-package';
import { NO_DECORATION_ART, usedDecorationArt } from '../src/decoration-art';
import type { DecorationArt } from '../src/decoration-art';
import { DEFAULT_LEVEL } from '../src/default-level';
import { DEFAULT_ENEMY_ART } from '../src/enemy-art-data';
import type { EnemyArtSettings } from '../src/enemy-art-data';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_LIMITS, validateGameSettings } from '../src/game-settings';
import type { GameSettings } from '../src/game-settings';
import { DEFAULT_HUD } from '../src/hud';
import type { HudSettings } from '../src/hud';
import { LEVEL_LIMITS, validateLevel } from '../src/level';
import type { LevelDefinition } from '../src/level';
import { checkMediaBytes, isMediaLibraryPath, MEDIA_LIMITS, mediaFile, mediaPath } from '../src/media';
import { appearanceFile, artFile } from '../src/project';
import { EMPTY_MODEL_LIBRARY, libraryModelFile } from '../src/model-library';
import type { LibraryAvatarEntry, LibraryEntry, ModelLibrary } from '../src/model-library';
import { EMPTY_SPRITES, parseSpriteDocument, SPRITE_FILE_BYTES, validateSpriteAnchors } from '../src/sprite-data';
import type { SpriteDocument } from '../src/sprite-data';
import { DEFAULT_THEME } from '../src/theme';
import type { GameTheme } from '../src/theme';
import { loadProjectInput } from './project-release';

// Everything one game build packages, validated: the release's data and the bytes of its files.
export interface ReleaseInput {
  // The project's title; builds from the per-file inputs take GAME_TITLE instead.
  readonly title: string | undefined;
  // Files whose changes rebuild the content in development.
  readonly files: readonly string[];
  readonly level: LevelDefinition;
  readonly art: {
    readonly mode: ArtMode;
    readonly assets: readonly { readonly id: string; readonly name: string; readonly bytes: Uint8Array }[];
    readonly decorations: DecorationArt;
  };
  readonly settings: GameSettings;
  readonly primary: SpriteDocument;
  readonly alternate: SpriteDocument | null;
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly enemies: EnemyArtSettings;
  readonly armIk: Readonly<ArmIkSettings>;
  readonly audio: AudioSettings;
  readonly appearance: readonly (AppearancePart & { readonly bytes: Uint8Array })[];
  readonly media: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  // The project's model library, each entry with its GLB.
  readonly library: {
    readonly avatar: readonly (LibraryAvatarEntry & { readonly bytes: Uint8Array })[];
    readonly hammer: readonly (LibraryEntry & { readonly bytes: Uint8Array })[];
    readonly pot: readonly (LibraryEntry & { readonly bytes: Uint8Array })[];
  };
}

function withBytes(library: ModelLibrary, bytes: (path: string) => Uint8Array): ReleaseInput['library'] {
  return {
    avatar: library.avatar.map(entry => ({ ...entry, bytes: bytes(libraryModelFile('avatar', entry.id)) })),
    hammer: library.hammer.map(entry => ({ ...entry, bytes: bytes(libraryModelFile('hammer', entry.id)) })),
    pot: library.pot.map(entry => ({ ...entry, bytes: bytes(libraryModelFile('pot', entry.id)) })),
  };
}

// Where GAME_LEVEL, GAME_SETTINGS and the profiles come from, when the build has no GAME_PROJECT.
export interface ReleaseFiles {
  readonly level: string | null;
  readonly settings: string | null;
  readonly sprites: string | null;
  readonly alternateSprites: string | null;
}

function failure(label: string, error: unknown): Error {
  return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

// The meshes a course draws in the chosen look, each checked like course packages at import: its
// terrain's and those replacing the placeholders of the decoration models it uses.
function courseArt(level: LevelDefinition, mode: ArtMode, assets: readonly { id: string; name: string; bytes: () => Uint8Array }[],
  art: DecorationArt): ReleaseInput['art'] {
  if (mode === 'shapes') return { mode, assets: [], decorations: NO_DECORATION_ART };
  const decorations = usedDecorationArt(level, art);
  const used = new Set([
    ...level.objects.flatMap(object => object.kind === 'terrain' && object.art ? [object.art.assetId] : []),
    ...Object.values(decorations),
  ]);
  let pixels = 0;
  const packaged = assets.filter(asset => used.has(asset.id)).map(asset => {
    const bytes = asset.bytes();
    pixels += validateCourseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).pixels;
    if (pixels > ART_LIMITS.texturePixels) throw new Error('Course artwork exceeds 32 million decoded texture pixels.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (asset.id !== `asset-${hash}`) throw new Error(`Packaged asset "${asset.name}" does not match its content hash.`);
    return { id: asset.id, name: asset.name, bytes };
  });
  if (packaged.length !== used.size) throw new Error('Mesh artwork needs a self-contained course package, not level JSON containing only asset IDs.');
  return { mode, assets: packaged, decorations };
}

function artMode(selected: string | undefined, packaged: ArtMode): ArtMode {
  if (selected === undefined) return packaged;
  if (selected !== 'shapes' && selected !== 'meshes') throw new Error('GAME_ART_MODE must be shapes or meshes.');
  return selected;
}

function character(document: SpriteDocument, label: string): SpriteDocument {
  try {
    validateSpriteAnchors(document, VISUAL_PART_IDS, SPRITE_TARGET_IDS);
    checkCharacterModels(document, label);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return document;
}

function profile(path: string | null, variable: string): SpriteDocument | null {
  if (path === null) return null;
  if (statSync(path).size > SPRITE_FILE_BYTES) throw new Error(`${variable} exceeds the profile size limit.`);
  return character(parseSpriteDocument(readFileSync(path, 'utf8')), variable);
}

// A build from the per-file inputs: a level or course package, settings and up to two profiles.
// Its /media/ sources come from public/media/.
export function loadFileRelease(root: string, files: ReleaseFiles, selectedMode: string | undefined): ReleaseInput {
  const watched = [files.level, files.settings, files.sprites, files.alternateSprites].filter((path): path is string => path !== null);
  let raw: unknown = DEFAULT_LEVEL;
  let bytes = 0;
  if (files.level !== null) {
    bytes = statSync(files.level).size;
    if (bytes > ART_LIMITS.packageBytes) throw new Error('GAME_LEVEL exceeds the course package size limit.');
    raw = JSON.parse(readFileSync(files.level, 'utf8'));
  }
  const pack = isCoursePackage(raw) ? validateCoursePackage(raw) : null;
  if (pack === null && bytes > LEVEL_LIMITS.fileBytes) throw new Error('GAME_LEVEL exceeds the level JSON size limit.');
  const level = pack?.level ?? validateLevel(raw);
  const art = courseArt(level, artMode(selectedMode, pack?.mode ?? 'shapes'),
    (pack?.assets ?? []).map(asset => ({ id: asset.id, name: asset.name, bytes: () => embeddedGlb(asset.source) })),
    pack?.decorations ?? NO_DECORATION_ART);
  let settings = DEFAULT_GAME_SETTINGS;
  if (files.settings !== null) {
    if (statSync(files.settings).size > GAME_SETTINGS_LIMITS.fileBytes) throw new Error('GAME_SETTINGS exceeds the file size limit.');
    settings = validateGameSettings(JSON.parse(readFileSync(files.settings, 'utf8')));
  }
  const publicMedia = resolve(root, 'public', 'media');
  const media = levelMediaSources(level).map(source => {
    if (!isMediaLibraryPath(source)) {
      throw new Error(`The level plays ${source}. A game build packages every asset, so play a /media/ file from public/media/ instead.`);
    }
    const path = resolve(root, 'public', mediaFile(mediaPath(source)));
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new Error(`The level plays ${source}, which is not in public/media/.`);
    }
    if (!real.startsWith(publicMedia + sep) || statSync(real).size > MEDIA_LIMITS.bytes) throw new Error(`The level plays ${source}, which is not a usable public/media/ file.`);
    watched.push(real);
    const fileBytes = new Uint8Array(readFileSync(real));
    checkMediaBytes(source, fileBytes);
    return { path: source, bytes: fileBytes };
  });
  return {
    title: undefined, files: watched, level, art, settings,
    primary: profile(files.sprites, 'GAME_SPRITES') ?? EMPTY_SPRITES,
    alternate: profile(files.alternateSprites, 'GAME_ALTERNATE_SPRITES'),
    theme: DEFAULT_THEME, hud: DEFAULT_HUD, enemies: DEFAULT_ENEMY_ART, armIk: DEFAULT_ARM_IK, audio: DEFAULT_AUDIO,
    appearance: [], media, library: withBytes(EMPTY_MODEL_LIBRARY, () => new Uint8Array()),
  };
}

// A build from GAME_PROJECT: the whole game, checked like every project, with GAME_ART_MODE applied.
export function loadProjectRelease(root: string, requested: string, selectedMode: string | undefined): ReleaseInput {
  const { content, files } = loadProjectInput(root, requested);
  const { manifest } = content;
  const binary = (path: string): Uint8Array => {
    const bytes = content.files.get(path);
    if (bytes === undefined) throw new Error(`GAME_PROJECT is missing ${path}.`);
    return bytes;
  };
  let art;
  try {
    art = courseArt(content.level, artMode(selectedMode, manifest.art.mode),
      manifest.art.assets.map(asset => ({ id: asset.id, name: asset.name, bytes: () => binary(artFile(asset.id)) })),
      manifest.art.decorations);
  } catch (error) {
    throw failure('GAME_PROJECT course artwork', error);
  }
  const { primary, alternate } = content.characters;
  return {
    title: manifest.title, files, level: content.level, art, settings: manifest.settings,
    primary: primary === null ? EMPTY_SPRITES : character(primary, 'GAME_PROJECT primary character'),
    alternate: alternate === null ? null : character(alternate, 'GAME_PROJECT alternate character'),
    theme: manifest.theme, hud: manifest.hud, enemies: manifest.enemies, armIk: manifest.armIk, audio: manifest.audio,
    appearance: manifest.appearance.map(part => ({ ...part, bytes: binary(appearanceFile(part.part)) })),
    media: manifest.media.map(entry => ({ path: entry.path, bytes: binary(mediaFile(entry.path)) })),
    library: withBytes(manifest.models, binary),
  };
}
