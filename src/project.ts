// A game project: every authored input of one complete, standalone game. On disk it is a directory
// with a project.json manifest plus JSON and binary files at fixed paths; a bundle is the same file
// tree serialized into one JSON document for moving projects between machines and browsers.
import { ART_LIMITS, ArtError, artId, artName } from './art-types';
import type { ArtMode } from './art-types';
import { DEFAULT_GAME_SETTINGS, GameSettingsError, validateGameSettings } from './game-settings';
import type { GameSettings } from './game-settings';
import { DEFAULT_ARM_IK, SPRITE_TARGET_IDS, VISUAL_PART_IDS } from './character';
import type { ArmIkSettings, VisualPartId } from './character';
import { validateAppearanceParts, validateArmIk } from './appearance-profile';
import type { AppearancePart } from './appearance-profile';
import { DEFAULT_THEME, validateTheme } from './theme';
import type { GameTheme } from './theme';
import { DEFAULT_HUD, validateHud } from './hud';
import type { HudSettings } from './hud';
import { audioSources, DEFAULT_AUDIO, validateAudio } from './audio-settings';
import type { AudioSettings } from './audio-settings';
import { DEFAULT_ENEMY_ART, validateEnemyArt } from './enemy-art-data';
import type { EnemyArtSettings } from './enemy-art-data';
import { checkMediaBytes, isMediaLibraryPath, MEDIA_LIMITS, mediaFile, mediaPath, mediaType } from './media';
import type { MediaEntry } from './media';
import { LEVEL_LIMITS, LevelError, validateLevel } from './level';
import type { LevelDefinition } from './level';
import { parseSpriteDocument, SPRITE_FILE_BYTES, validateSpriteAnchors, validateSpriteDocument } from './sprite-data';
import type { SpriteDocument } from './sprite-data';
import { MODEL_LIMITS, ModelError } from './model-data';
import { decodeBase64, encodeBase64, SpriteError } from './sprite-fields';
import { SkeletonError } from './skeleton-data';
import { DirectionalError } from './directional-data';
import { exactRecord, ProjectError, textValue } from './project-fields';

export { ProjectError } from './project-fields';

export const PROJECT_FORMAT = 'over-the-edge-project';
export const PROJECT_BUNDLE_FORMAT = 'over-the-edge-project-bundle';
export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_FILES = {
  manifest: 'project.json',
  level: 'level.json',
  primary: 'characters/primary.json',
  alternate: 'characters/alternate.json',
} as const;
export const PROJECT_LIMITS = {
  title: 80,
  id: 64,
  manifestBytes: 2 * 1024 * 1024,
  appearanceBytes: 64 * 1024 * 1024,
  bundleBytes: 384 * 1024 * 1024,
} as const;
const GLB_DATA = 'data:model/gltf-binary;base64,';

export interface ProjectArt {
  readonly mode: ArtMode;
  readonly assets: readonly { readonly id: string; readonly name: string }[];
}

export interface ProjectCharacters {
  readonly primary: typeof PROJECT_FILES.primary | null;
  readonly alternate: typeof PROJECT_FILES.alternate | null;
}

export interface ProjectManifest {
  readonly format: typeof PROJECT_FORMAT;
  readonly schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  readonly title: string;
  readonly level: typeof PROJECT_FILES.level;
  readonly art: ProjectArt;
  readonly settings: GameSettings;
  readonly characters: ProjectCharacters;
  readonly armIk: Readonly<ArmIkSettings>;
  readonly appearance: readonly AppearancePart[];
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly audio: AudioSettings;
  readonly enemies: EnemyArtSettings;
  readonly media: readonly MediaEntry[];
}

const MANIFEST_KEYS = [
  'format', 'schemaVersion', 'title', 'level', 'art', 'settings', 'characters', 'armIk', 'appearance',
  'theme', 'hud', 'audio', 'enemies', 'media',
] as const;

export function artFile(id: string): string { return `art/${artId(id)}.glb`; }
export function appearanceFile(part: VisualPartId): string { return `appearance/${part}.glb`; }

export function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new ProjectError(`Project IDs use 1-${PROJECT_LIMITS.id} lowercase letters, digits and inner hyphens, for example my-game.`);
  }
  return value;
}

// A readable ID suggestion for a title, e.g. "Lantern Cavern" -> "lantern-cavern".
export function projectIdForTitle(title: string): string {
  const id = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, PROJECT_LIMITS.id)
    .replace(/-+$/, '');
  return id.length === 0 ? 'game' : id;
}

export function projectTitle(value: unknown): string {
  return textValue(value, 1, PROJECT_LIMITS.title, 'Project title');
}

export function validateProjectArt(value: unknown): ProjectArt {
  const art = exactRecord(value, ['mode', 'assets'], 'Course artwork');
  if (art.mode !== 'shapes' && art.mode !== 'meshes') throw new ProjectError('Course artwork mode must be shapes or meshes.');
  if (!Array.isArray(art.assets) || art.assets.length > ART_LIMITS.assets) {
    throw new ProjectError(`Course artwork lists at most ${ART_LIMITS.assets} GLB assets.`);
  }
  const ids = new Set<string>();
  const assets = art.assets.map((entry: unknown) => {
    const asset = exactRecord(entry, ['id', 'name'], 'Course artwork asset');
    const id = artId(asset.id);
    if (ids.has(id)) throw new ProjectError(`Course artwork asset ${id} is listed twice.`);
    ids.add(id);
    return Object.freeze({ id, name: artName(asset.name) });
  });
  return Object.freeze({ mode: art.mode, assets: Object.freeze(assets) });
}

export function validateMediaIndex(value: unknown): readonly MediaEntry[] {
  if (!Array.isArray(value) || value.length > MEDIA_LIMITS.files) throw new ProjectError(`The media library lists at most ${MEDIA_LIMITS.files} files.`);
  const paths = new Set<string>();
  return Object.freeze(value.map((entry: unknown) => {
    const path = mediaPath(exactRecord(entry, ['path'], 'Media entry').path);
    if (paths.has(path)) throw new ProjectError(`Media file ${path} is listed twice.`);
    paths.add(path);
    return Object.freeze({ path });
  }));
}

export function validateProjectCharacter(value: unknown): SpriteDocument {
  const document = validateSpriteDocument(value);
  validateSpriteAnchors(document, VISUAL_PART_IDS, SPRITE_TARGET_IDS);
  return document;
}

export function parseProjectCharacter(text: string): SpriteDocument {
  const document = parseSpriteDocument(text);
  validateSpriteAnchors(document, VISUAL_PART_IDS, SPRITE_TARGET_IDS);
  return document;
}

function characterPaths(value: unknown): ProjectCharacters {
  const characters = exactRecord(value, ['primary', 'alternate'], 'Characters');
  if (characters.primary !== null && characters.primary !== PROJECT_FILES.primary) {
    throw new ProjectError(`characters.primary must be null or "${PROJECT_FILES.primary}".`);
  }
  if (characters.alternate !== null && characters.alternate !== PROJECT_FILES.alternate) {
    throw new ProjectError(`characters.alternate must be null or "${PROJECT_FILES.alternate}".`);
  }
  if (characters.alternate !== null && characters.primary === null) {
    throw new ProjectError('An alternate character needs a primary character profile.');
  }
  return Object.freeze({ primary: characters.primary, alternate: characters.alternate });
}

// Runs a section validator, reporting its failure against that section.
export function inSection<T>(section: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (!isProjectDataError(error)) throw error;
    throw new ProjectError(`${section}: ${error.message}`, { section, cause: error });
  }
}

// Every validator this module composes throws one of these for bad data, never for bugs.
export function isProjectDataError(error: unknown): error is Error {
  return error instanceof ProjectError || error instanceof LevelError || error instanceof SpriteError ||
    error instanceof SkeletonError || error instanceof DirectionalError || error instanceof GameSettingsError ||
    error instanceof ModelError || error instanceof ArtError;
}

export function validateProjectManifest(value: unknown): ProjectManifest {
  const data = exactRecord(value, MANIFEST_KEYS, 'Project manifest');
  if (data.format !== PROJECT_FORMAT) throw new ProjectError(`This is not an ${PROJECT_FORMAT} manifest.`);
  if (data.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new ProjectError('This project schema version is not supported.');
  if (data.level !== PROJECT_FILES.level) throw new ProjectError(`The project level must be "${PROJECT_FILES.level}".`);
  return Object.freeze({
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    title: inSection('title', () => projectTitle(data.title)),
    level: PROJECT_FILES.level,
    art: inSection('art', () => validateProjectArt(data.art)),
    settings: inSection('settings', () => validateGameSettings(data.settings)),
    characters: inSection('characters', () => characterPaths(data.characters)),
    armIk: inSection('arm-ik', () => Object.freeze(validateArmIk(data.armIk))),
    appearance: inSection('appearance', () => validateAppearanceParts(data.appearance)),
    theme: inSection('theme', () => validateTheme(data.theme)),
    hud: inSection('hud', () => validateHud(data.hud)),
    audio: inSection('audio', () => validateAudio(data.audio)),
    enemies: inSection('enemies', () => validateEnemyArt(data.enemies)),
    media: inSection('media', () => validateMediaIndex(data.media)),
  });
}

export function defaultProjectManifest(title: string): ProjectManifest {
  return validateProjectManifest({
    format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, title, level: PROJECT_FILES.level,
    art: { mode: 'shapes', assets: [] }, settings: DEFAULT_GAME_SETTINGS,
    characters: { primary: null, alternate: null }, armIk: DEFAULT_ARM_IK, appearance: [],
    theme: DEFAULT_THEME, hud: DEFAULT_HUD, audio: DEFAULT_AUDIO, enemies: DEFAULT_ENEMY_ART, media: [],
  });
}

export type ProjectFileKind = 'level' | 'character' | 'art' | 'appearance' | 'media';

export interface ProjectFileRef {
  readonly path: string;
  readonly kind: ProjectFileKind;
  readonly binary: boolean;
  readonly maxBytes: number;
}

// Every file the manifest references, at its fixed path.
export function projectFileRefs(manifest: ProjectManifest): ProjectFileRef[] {
  const refs: ProjectFileRef[] = [{ path: PROJECT_FILES.level, kind: 'level', binary: false, maxBytes: LEVEL_LIMITS.fileBytes }];
  for (const path of [manifest.characters.primary, manifest.characters.alternate]) {
    if (path !== null) refs.push({ path, kind: 'character', binary: false, maxBytes: SPRITE_FILE_BYTES });
  }
  for (const asset of manifest.art.assets) refs.push({ path: artFile(asset.id), kind: 'art', binary: true, maxBytes: ART_LIMITS.bytes });
  for (const part of manifest.appearance) {
    refs.push({ path: appearanceFile(part.part), kind: 'appearance', binary: true, maxBytes: MODEL_LIMITS.bytes });
  }
  for (const entry of manifest.media) refs.push({ path: mediaFile(entry.path), kind: 'media', binary: true, maxBytes: MEDIA_LIMITS.bytes });
  return refs;
}

export function projectFileType(ref: ProjectFileRef, manifest: ProjectManifest): string {
  if (!ref.binary) return 'application/json';
  if (ref.kind !== 'media') return 'model/gltf-binary';
  const entry = manifest.media.find(candidate => mediaFile(candidate.path) === ref.path);
  if (entry === undefined) throw new ProjectError(`Unknown media file ${ref.path}.`);
  return mediaType(entry.path);
}

// Level, trigger and audio references a standalone release must be able to resolve from the project.
export function checkProjectReferences(manifest: ProjectManifest, level: LevelDefinition): void {
  const assets = new Set(manifest.art.assets.map(asset => asset.id));
  const media = new Set(manifest.media.map(entry => entry.path));
  const problems: string[] = [];
  const checkSource = (source: string, owner: string): void => {
    if (!source.startsWith('/') || source.startsWith('//')) return;
    if (!isMediaLibraryPath(source)) problems.push(`${owner} uses ${source}; site-relative sources in a project must be /media/ files.`);
    else if (!media.has(source)) problems.push(`${owner} uses ${source}, which is not in the media library.`);
  };
  for (const object of level.objects) {
    if (object.kind === 'terrain' && object.art !== undefined && !assets.has(object.art.assetId)) {
      problems.push(`Terrain "${object.id}" uses artwork ${object.art.assetId}, which is not in the course artwork.`);
    }
    if (object.kind === 'trigger') {
      object.events.forEach((event, index) => {
        if (event.type === 'play-video' || event.type === 'play-sound') checkSource(event.source, `Trigger "${object.id}" event ${index + 1}`);
      });
    }
  }
  for (const source of audioSources(manifest.audio)) checkSource(source, 'Audio');
  if (problems.length > 0) throw new ProjectError(problems.slice(0, 8).join(' ') + (problems.length > 8 ? ` (${problems.length - 8} more)` : ''), { section: 'level' });
}

export interface ProjectContent {
  readonly manifest: ProjectManifest;
  readonly level: LevelDefinition;
  readonly characters: { readonly primary: SpriteDocument | null; readonly alternate: SpriteDocument | null };
  readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

// Reads a project through `read` and validates every file and cross-reference. `read` returns the
// parsed value of JSON files and bytes of binary files, and must enforce each ref's maxBytes.
export function loadProjectContent(manifest: ProjectManifest, read: (ref: ProjectFileRef) => unknown): ProjectContent {
  const refs = projectFileRefs(manifest);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let level: LevelDefinition | null = null;
  const characters: { primary: SpriteDocument | null; alternate: SpriteDocument | null } = { primary: null, alternate: null };
  const totals: Record<'art' | 'appearance' | 'media', number> = { art: 0, appearance: 0, media: 0 };
  const budgets = { art: ART_LIMITS.totalBytes, appearance: PROJECT_LIMITS.appearanceBytes, media: MEDIA_LIMITS.totalBytes };
  for (const ref of refs) {
    const value = read(ref);
    if (ref.kind === 'level') level = inSection('level', () => validateLevel(value));
    else if (ref.kind === 'character') {
      const document = inSection(ref.path, () => validateProjectCharacter(value));
      if (ref.path === PROJECT_FILES.primary) characters.primary = document;
      else characters.alternate = document;
    } else {
      if (!(value instanceof Uint8Array)) throw new ProjectError(`${ref.path} must be a binary file.`, { section: ref.path });
      if (value.byteLength === 0 || value.byteLength > ref.maxBytes) {
        throw new ProjectError(`${ref.path} must contain 1 byte to ${ref.maxBytes / 1024 ** 2} MiB.`, { section: ref.path });
      }
      totals[ref.kind] += value.byteLength;
      if (totals[ref.kind] > budgets[ref.kind]) {
        throw new ProjectError(`The project's ${ref.kind} files exceed ${budgets[ref.kind] / 1024 ** 2} MiB.`, { section: ref.kind });
      }
      if (ref.kind === 'media') {
        const entry = manifest.media.find(candidate => mediaFile(candidate.path) === ref.path)!;
        inSection('media', () => checkMediaBytes(entry.path, value));
      }
      // Views over shared memory are copied, so every file owns a plain ArrayBuffer.
      files.set(ref.path, value.buffer instanceof ArrayBuffer ? value as Uint8Array<ArrayBuffer> : new Uint8Array(value));
    }
  }
  if (level === null) throw new ProjectError('The project has no level.', { section: 'level' });
  checkProjectReferences(manifest, level);
  return Object.freeze({ manifest, level, characters: Object.freeze(characters), files });
}

export interface ProjectBundle {
  readonly format: typeof PROJECT_BUNDLE_FORMAT;
  readonly schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  readonly files: Readonly<Record<string, unknown>>;
}

export function isProjectBundle(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'format') === PROJECT_BUNDLE_FORMAT;
}

function decodeData(source: unknown, ref: ProjectFileRef, manifest: ProjectManifest): Uint8Array<ArrayBuffer> {
  const prefix = `data:${projectFileType(ref, manifest)};base64,`;
  if (typeof source !== 'string' || !source.startsWith(prefix)) {
    throw new ProjectError(`${ref.path} must be a ${prefix}... data URL in a bundle.`, { section: ref.path });
  }
  const data = source.slice(prefix.length);
  if (data.length === 0 || data.length % 4 !== 0 || data.length > Math.ceil(ref.maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new ProjectError(`${ref.path} has invalid or oversized base64 data.`, { section: ref.path });
  }
  return decodeBase64(data);
}

// Validates a bundle's file tree and returns its parsed, checked content.
export function unpackProjectBundle(value: unknown): ProjectContent {
  const bundle = exactRecord(value, ['format', 'schemaVersion', 'files'], 'Project bundle');
  if (bundle.format !== PROJECT_BUNDLE_FORMAT || bundle.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectError('This project bundle format or version is not supported.');
  }
  const files = bundle.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new ProjectError('A project bundle needs a files object.');
  const manifest = validateProjectManifest(Reflect.get(files, PROJECT_FILES.manifest));
  const refs = projectFileRefs(manifest);
  const expected = new Set([PROJECT_FILES.manifest, ...refs.map(ref => ref.path)]);
  const unknown = Object.keys(files).filter(path => !expected.has(path));
  if (unknown.length > 0) throw new ProjectError(`The bundle contains files the manifest does not use: ${unknown.slice(0, 5).join(', ')}.`);
  return loadProjectContent(manifest, (ref) => {
    if (!Object.hasOwn(files, ref.path)) throw new ProjectError(`The bundle is missing ${ref.path}.`, { section: ref.path });
    const entry: unknown = Reflect.get(files, ref.path);
    if (ref.binary) return decodeData(entry, ref, manifest);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProjectError(`${ref.path} must be a JSON object in a bundle.`, { section: ref.path });
    }
    return entry;
  });
}

export function packProjectBundle(content: Pick<ProjectContent, 'manifest' | 'level' | 'characters' | 'files'>): ProjectBundle {
  const files: Record<string, unknown> = { [PROJECT_FILES.manifest]: content.manifest };
  for (const ref of projectFileRefs(content.manifest)) {
    if (ref.kind === 'level') files[ref.path] = content.level;
    else if (ref.kind === 'character') {
      files[ref.path] = ref.path === PROJECT_FILES.primary ? content.characters.primary : content.characters.alternate;
    } else {
      const bytes = content.files.get(ref.path);
      if (bytes === undefined) throw new ProjectError(`The project is missing ${ref.path}.`, { section: ref.path });
      files[ref.path] = `data:${projectFileType(ref, content.manifest)};base64,${encodeBase64(bytes)}`;
    }
  }
  return { format: PROJECT_BUNDLE_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, files };
}

export function artAssetHashMatches(id: string, sha256Hex: string): boolean {
  return id === `asset-${sha256Hex}`;
}

export function glbDataUrl(bytes: Uint8Array): string {
  return `${GLB_DATA}${encodeBase64(bytes)}`;
}
