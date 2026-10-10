// Release content: the files a game build writes beside its public shell, and the manifest that
// describes them. The shell pins the manifest; the manifest pins every other file by its path,
// which names the file's SHA-256. DOM-free, so the build and the release share one definition.
import { VISUAL_PART_IDS, SPRITE_TARGET_IDS } from './character';
import type { ArmIkSettings, VisualPartId } from './character';
import { validateAppearanceParts, validateArmIk } from './appearance-profile';
import type { VisualAlignment } from './appearance-profile';
import { ART_LIMITS, artId, artName } from './art-types';
import type { ArtResource } from './art-types';
import { usedCourseArt, validateDecorationArt } from './decoration-art';
import type { DecorationArt } from './decoration-art';
import { audioSources, validateAudio } from './audio-settings';
import type { AudioSettings } from './audio-settings';
import { validateEnemyArt } from './enemy-art-data';
import type { EnemyArtSettings } from './enemy-art-data';
import { validateGameSettings } from './game-settings';
import type { GameSettings } from './game-settings';
import { validateHud } from './hud';
import type { HudSettings } from './hud';
import { LEVEL_LIMITS, validateLevel } from './level';
import type { LevelDefinition } from './level';
import { MEDIA_LIMITS, MEDIA_TYPES, mediaExtension, mediaPath } from './media';
import { MODEL_LIMITS } from './model-data';
import { PHANTOM_LIMITS, PHANTOM_PACK_BYTES } from './phantom-limits';
import type { PhantomBounds } from './phantom-format';
import type { HammerHead } from './hammer-head';
import { exactRecord } from './project-fields';
import { SPRITE_LIMITS, validateSpriteAnchors, validateSpriteMetadata } from './sprite-data';
import type { SpriteDocument } from './sprite-data';
import { validateTheme } from './theme';
import type { GameTheme } from './theme';
import {
  CONTENT_REF_PREFIX, isContentGroup, isContentPath, isContentRef, pathExtension, pathGroup,
} from './content-ref';
import type { ContentExtension } from './content-ref';
import {
  LIBRARY_ENTRY_KEYS, libraryHammerHead, libraryModelId, MODEL_LIBRARY_LIMITS, PART_ROLES, validateAvatarSettings,
} from './model-library';
import type { LibraryAvatarSettings, PartRole } from './model-library';

export const CONTENT_FORMAT = 'over-the-edge-content';
export const CONTENT_SCHEMA_VERSION = 20;
// The group holding everything the release itself uses; other groups are granted separately.
export const GAME_GROUP = 'game';
export const CONTENT_TYPES: Readonly<Record<ContentExtension, string>> = {
  json: 'application/json', png: 'image/png', glb: 'model/gltf-binary', ...MEDIA_TYPES, phantoms: 'application/octet-stream',
};

// Largest file of each kind; a manifest listing a larger one is invalid.
const TYPE_BYTES: Readonly<Record<ContentExtension, number>> = {
  json: 0, png: SPRITE_LIMITS.imageBytes, glb: Math.max(MODEL_LIMITS.bytes, ART_LIMITS.bytes),
  webm: MEDIA_LIMITS.bytes, mp4: MEDIA_LIMITS.bytes, mp3: MEDIA_LIMITS.bytes, ogg: MEDIA_LIMITS.bytes,
  wav: MEDIA_LIMITS.bytes, m4a: MEDIA_LIMITS.bytes, phantoms: PHANTOM_PACK_BYTES,
};

export const CONTENT_LIMITS = {
  files: 2048,
  // A level, two character profiles' metadata and the release's settings.
  manifestBytes: LEVEL_LIMITS.fileBytes + 2 * SPRITE_LIMITS.documentBytes + 4 * 1024 * 1024,
  // Packs of bundled phantom recordings: enough for one per 10 m band of the phantom range.
  phantomPacks: 1024,
} as const;

export class ContentManifestError extends Error {}

export function contentGroup(value: unknown): string {
  if (!isContentGroup(value)) {
    throw new ContentManifestError('Content groups are 1-4 segments of lowercase letters, digits and inner hyphens.');
  }
  return value;
}

// A content file's path: <group>/<sha256>.<extension>, named by its bytes.
export function contentPath(value: unknown): string {
  if (!isContentPath(value)) throw new ContentManifestError('Content paths look like game/<sha256>.png.');
  return value;
}

export function contentFilePath(group: string, sha256: string, extension: ContentExtension): string {
  return contentPath(`${contentGroup(group)}/${sha256}.${extension}`);
}

export function pathType(path: string): string { return CONTENT_TYPES[pathExtension(path)]; }

export function contentRef(path: string): string {
  return CONTENT_REF_PREFIX + contentPath(path);
}

export function refPath(ref: string): string {
  if (!isContentRef(ref)) throw new ContentManifestError('Packaged sources start with content:.');
  return contentPath(ref.slice(CONTENT_REF_PREFIX.length));
}

// What the shell embeds: where content is served, the manifest's path and size, and every path of
// the game group, so one grant covers the whole group before the manifest arrives.
export interface ContentPins {
  readonly contentUrl: string;
  readonly manifest: string;
  readonly manifestBytes: number;
  readonly game: readonly string[];
}

export interface ContentAppearance {
  readonly part: VisualPartId;
  readonly name: string;
  readonly alignment: Readonly<VisualAlignment>;
  readonly source: string;
}

export interface ContentArt {
  readonly assets: readonly ArtResource[];
  // The assets that draw decoration models, in place of the built-in models of the same IDs.
  readonly decorations: DecorationArt;
}

export interface ContentLibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

export interface ContentLibraryAvatar extends ContentLibraryEntry, LibraryAvatarSettings {}

export interface ContentLibraryHammer extends ContentLibraryEntry {
  readonly head: HammerHead;
}

// The project's model library. Each entry's GLB is its own group, so a backend grants it on its own.
export interface ContentLibrary {
  readonly avatar: readonly ContentLibraryAvatar[];
  readonly hammer: readonly ContentLibraryHammer[];
  readonly pot: readonly ContentLibraryEntry[];
}

// A pack of phantom recordings the release replays without a backend, and where their characters went: the release
// loads a pack once the player comes near.
export interface ContentPhantomPack {
  readonly source: string;
  readonly bounds: PhantomBounds;
}

// The content group of one library entry.
export function libraryGroup(role: PartRole, id: string): string {
  return contentGroup(`library/${role}/${libraryModelId(id)}`);
}

export interface ContentManifest {
  readonly format: typeof CONTENT_FORMAT;
  readonly schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  readonly level: LevelDefinition;
  readonly settings: GameSettings;
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly enemies: EnemyArtSettings;
  readonly armIk: Readonly<ArmIkSettings>;
  readonly audio: AudioSettings;
  readonly characters: { readonly primary: SpriteDocument; readonly alternate: SpriteDocument | null };
  readonly appearance: readonly ContentAppearance[];
  readonly art: ContentArt;
  // Authored /media/ paths and the packaged file each one plays.
  readonly media: Readonly<Record<string, string>>;
  readonly library: ContentLibrary;
  // Recordings made on this level's play layout with these settings' physics; see docs/phantoms.md.
  readonly phantoms: readonly ContentPhantomPack[];
  // Every file the manifest references, by path, with its size in bytes.
  readonly files: Readonly<Record<string, number>>;
}

const MANIFEST_KEYS = [
  'format', 'schemaVersion', 'level', 'settings', 'theme', 'hud', 'enemies', 'armIk', 'audio', 'characters',
  'appearance', 'art', 'media', 'library', 'phantoms', 'files',
] as const;

// Sources a level's trigger events play: videos and sounds.
export function levelMediaSources(level: LevelDefinition): string[] {
  return [...new Set(level.objects.flatMap(object => object.kind !== 'trigger' ? [] : object.events.flatMap(event =>
    event.type === 'play-video' || event.type === 'play-sound' ? [event.source] : [])))];
}

// Sources the level's play-sound events play, preloaded with the audio cues.
export function levelSoundSources(level: LevelDefinition): string[] {
  return [...new Set(level.objects.flatMap(object => object.kind !== 'trigger' ? [] :
    object.events.flatMap(event => event.type === 'play-sound' ? [event.source] : [])))];
}

export function characterSources(document: SpriteDocument): string[] {
  return [...document.images.map(image => image.source), ...(document.models ?? []).map(model => model.source)];
}

export function librarySources(library: ContentLibrary): string[] {
  return PART_ROLES.flatMap(role => library[role].map(entry => entry.source));
}

// Every packaged source the manifest names, by kind.
function manifestSources(manifest: Omit<ContentManifest, 'files'>): string[] {
  return [
    ...characterSources(manifest.characters.primary),
    ...(manifest.characters.alternate === null ? [] : characterSources(manifest.characters.alternate)),
    ...manifest.appearance.map(part => part.source),
    ...manifest.art.assets.map(asset => asset.source),
    ...Object.values(manifest.media),
    ...librarySources(manifest.library),
    ...manifest.phantoms.map(pack => pack.source),
  ];
}

function packaged(source: string, label: string): string {
  if (!isContentRef(source)) throw new ContentManifestError(`${label} must be packaged content, not ${source.slice(0, 80)}.`);
  refPath(source);
  return source;
}

function validateCharacter(value: unknown, label: string): SpriteDocument {
  const document = validateSpriteMetadata(value);
  validateSpriteAnchors(document, VISUAL_PART_IDS, SPRITE_TARGET_IDS);
  for (const image of document.images) packaged(image.source, `${label} image "${image.name}"`);
  for (const model of document.models ?? []) packaged(model.source, `${label} model "${model.name}"`);
  return document;
}

function validateContentAppearance(value: unknown): readonly ContentAppearance[] {
  if (!Array.isArray(value)) throw new ContentManifestError('Appearance must be a list.');
  const parts = validateAppearanceParts(value.map((entry: unknown) => {
    const { source: _source, ...part } = exactRecord(entry, ['part', 'name', 'alignment', 'source'], 'An appearance part');
    return part;
  }));
  return Object.freeze(parts.map((part, index) => Object.freeze({
    ...part, source: packaged(String(Reflect.get(value[index] as object, 'source')), `Appearance ${part.part}`),
  })));
}

function validateContentArt(value: unknown, level: LevelDefinition): ContentArt {
  const art = exactRecord(value, ['assets', 'decorations'], 'Course artwork');
  if (!Array.isArray(art.assets) || art.assets.length > ART_LIMITS.assets) {
    throw new ContentManifestError(`Course artwork lists at most ${ART_LIMITS.assets} assets.`);
  }
  const assets = art.assets.map((entry: unknown): ArtResource => {
    const asset = exactRecord(entry, ['id', 'name', 'source'], 'A course artwork asset');
    return Object.freeze({ id: artId(asset.id), name: artName(asset.name), source: packaged(String(asset.source), 'Course artwork') });
  });
  const ids = new Set(assets.map(asset => asset.id));
  if (ids.size !== assets.length) throw new ContentManifestError('Course artwork lists an asset twice.');
  const decorations = validateDecorationArt(art.decorations, ids);
  // A release carries exactly the course artwork its level draws.
  const used = usedCourseArt(level, decorations);
  if (Object.keys(decorations).length !== Object.keys(used.decorations).length) {
    throw new ContentManifestError('Decoration artwork must map only models the level uses.');
  }
  if (used.assets.size !== ids.size || [...used.assets].some(id => !ids.has(id))) {
    throw new ContentManifestError('Course artwork must list exactly the meshes the level uses.');
  }
  return Object.freeze({ assets: Object.freeze(assets), decorations });
}

function validateMediaTable(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContentManifestError('Media must map /media/ paths to content.');
  const entries = Object.entries(value);
  if (entries.length > MEDIA_LIMITS.files) throw new ContentManifestError(`A release packages at most ${MEDIA_LIMITS.files} media files.`);
  return Object.freeze(Object.fromEntries(entries.map(([key, source]) => {
    const path = mediaPath(key);
    const ref = packaged(String(source), `Media ${path}`);
    if (pathExtension(refPath(ref)) !== mediaExtension(path)) throw new ContentManifestError(`Media ${path} must be packaged as .${mediaExtension(path)}.`);
    return [path, ref];
  })));
}

function validateLibrary(value: unknown): ContentLibrary {
  const library = exactRecord(value, PART_ROLES, 'The model library');
  const entries = <T extends ContentLibraryEntry>(role: PartRole, entry: (data: Record<string, unknown>, base: ContentLibraryEntry) => T): readonly T[] => {
    const list = library[role];
    if (!Array.isArray(list) || list.length > MODEL_LIBRARY_LIMITS.entries) throw new ContentManifestError(`The ${role} library lists at most ${MODEL_LIBRARY_LIMITS.entries} models.`);
    const ids = new Set<string>();
    return Object.freeze(list.map((item: unknown) => {
      // A content entry is the project's entry with its packaged model's source.
      const data = exactRecord(item, [...LIBRARY_ENTRY_KEYS[role], 'source'], `A library ${role}`);
      const id = libraryModelId(data.id);
      if (ids.has(id)) throw new ContentManifestError(`The ${role} library lists "${id}" twice.`);
      ids.add(id);
      const source = packaged(String(data.source), `Library ${role} "${id}"`);
      // Each entry's model is the only file in its own group.
      if (pathGroup(refPath(source)) !== libraryGroup(role, id) || pathExtension(refPath(source)) !== 'glb') {
        throw new ContentManifestError(`Library ${role} "${id}" must be a GLB in group ${libraryGroup(role, id)}.`);
      }
      if (typeof data.name !== 'string' || data.name.trim().length === 0 || data.name.length > MODEL_LIBRARY_LIMITS.name) {
        throw new ContentManifestError(`Library ${role} "${id}" needs a name of 1-${MODEL_LIBRARY_LIMITS.name} characters.`);
      }
      return entry(data, { id, name: data.name, source });
    }));
  };
  return Object.freeze({
    avatar: entries('avatar', (data, base) => Object.freeze({ ...base, ...validateAvatarSettings(data) })),
    hammer: entries('hammer', (data, base) => Object.freeze({ ...base, head: libraryHammerHead(data.head) })),
    pot: entries('pot', (_data, base) => Object.freeze(base)),
  });
}

function validatePhantomPacks(value: unknown): readonly ContentPhantomPack[] {
  if (!Array.isArray(value) || value.length > CONTENT_LIMITS.phantomPacks) {
    throw new ContentManifestError(`Phantoms are a list of at most ${CONTENT_LIMITS.phantomPacks} packs.`);
  }
  const coordinate = (data: Record<string, unknown>, key: string): number => {
    const number = data[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > PHANTOM_LIMITS.coordinate) {
      throw new ContentManifestError('A phantom pack\'s bounds must be coordinates within the phantom range.');
    }
    return number;
  };
  return Object.freeze(value.map((entry: unknown) => {
    const pack = exactRecord(entry, ['source', 'bounds'], 'A phantom pack');
    const source = packaged(String(pack.source), 'A phantom pack');
    if (pathExtension(refPath(source)) !== 'phantoms') throw new ContentManifestError('Phantom packs are packaged as .phantoms files.');
    const data = exactRecord(pack.bounds, ['minX', 'minY', 'maxX', 'maxY'], 'A phantom pack\'s bounds');
    const bounds = { minX: coordinate(data, 'minX'), minY: coordinate(data, 'minY'), maxX: coordinate(data, 'maxX'), maxY: coordinate(data, 'maxY') };
    if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) throw new ContentManifestError('A phantom pack\'s bounds are inverted.');
    return Object.freeze({ source, bounds: Object.freeze(bounds) });
  }));
}

function validateFiles(value: unknown, sources: readonly string[]): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContentManifestError('Files must map content paths to sizes.');
  const entries = Object.entries(value);
  if (entries.length > CONTENT_LIMITS.files) throw new ContentManifestError(`A release packages at most ${CONTENT_LIMITS.files} files.`);
  const files: Record<string, number> = {};
  for (const [key, bytes] of entries) {
    const path = contentPath(key);
    const extension = pathExtension(path);
    if (extension === 'json' || typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > TYPE_BYTES[extension]) {
      throw new ContentManifestError(`Content ${path} has an invalid size.`);
    }
    files[path] = bytes;
  }
  const referenced = new Set(sources.map(refPath));
  for (const path of referenced) {
    if (!Object.hasOwn(files, path)) throw new ContentManifestError(`Content ${path} is referenced but not listed.`);
  }
  for (const path of Object.keys(files)) {
    if (!referenced.has(path)) throw new ContentManifestError(`Content ${path} is listed but never used.`);
  }
  return Object.freeze(files);
}

function validateSections(data: Record<string, unknown>): Omit<ContentManifest, 'files'> {
  if (data.format !== CONTENT_FORMAT || data.schemaVersion !== CONTENT_SCHEMA_VERSION) {
    throw new ContentManifestError('This is not a supported release content manifest.');
  }
  const level = validateLevel(data.level);
  const audio = validateAudio(data.audio);
  const media = validateMediaTable(data.media);
  // Every source the release plays is packaged: nothing loads from outside the content.
  for (const source of [...levelMediaSources(level), ...audioSources(audio)]) {
    if (!Object.hasOwn(media, source)) throw new ContentManifestError(`${source} is played but not packaged.`);
  }
  const characters = exactRecord(data.characters, ['primary', 'alternate'], 'Characters');
  return {
    format: CONTENT_FORMAT, schemaVersion: CONTENT_SCHEMA_VERSION, level,
    settings: validateGameSettings(data.settings),
    theme: validateTheme(data.theme),
    hud: validateHud(data.hud),
    enemies: validateEnemyArt(data.enemies),
    armIk: Object.freeze(validateArmIk(data.armIk)),
    audio,
    characters: Object.freeze({
      primary: validateCharacter(characters.primary, 'The primary character'),
      alternate: characters.alternate === null ? null : validateCharacter(characters.alternate, 'The alternate character'),
    }),
    appearance: validateContentAppearance(data.appearance),
    art: validateContentArt(data.art, level),
    media,
    library: validateLibrary(data.library),
    phantoms: validatePhantomPacks(data.phantoms),
  };
}

export function validateContentManifest(value: unknown): ContentManifest {
  const data = exactRecord(value, MANIFEST_KEYS, 'The content manifest');
  const sections = validateSections(data);
  const files = validateFiles(data.files, manifestSources(sections));
  // Library models are in their own groups; everything else the release uses is in the game group.
  const library = new Set(librarySources(sections.library).map(refPath));
  for (const path of Object.keys(files)) {
    if (!library.has(path) && pathGroup(path) !== GAME_GROUP) throw new ContentManifestError(`Content ${path} is outside the game group.`);
  }
  return Object.freeze({ ...sections, files });
}

// Files the release needs before play: sprite images, character models, appearance models and
// course meshes. Music and video stream when they play; sounds load in the background. A profile's
// model for a part the backend's selection `replaced` is not needed, so it is never fetched.
export function bootSources(manifest: ContentManifest, replaced: ReadonlySet<PartRole> = new Set()): string[] {
  const characters = [manifest.characters.primary, manifest.characters.alternate].flatMap(document => document === null ? [] : [
    ...document.images.map(image => image.source),
    ...(document.models ?? []).filter(model => !PART_ROLES.some(role => replaced.has(role) && document[role]?.model === model.id))
      .map(model => model.source),
  ]);
  return [...new Set([...characters, ...manifest.appearance.map(part => part.source), ...manifest.art.assets.map(asset => asset.source)])];
}
