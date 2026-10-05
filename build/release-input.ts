import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ArmIkSettings } from '../src/character';
import { DEFAULT_ARM_IK, SPRITE_TARGET_IDS, VISUAL_PART_IDS } from '../src/character';
import type { AppearancePart } from '../src/appearance-profile';
import { checkAppearanceModel } from '../src/appearance-model';
import { ART_LIMITS } from '../src/art-types';
import type { ArtMode } from '../src/art-types';
import { audioSources, DEFAULT_AUDIO } from '../src/audio-settings';
import type { AudioSettings } from '../src/audio-settings';
import type { AvatarRigRegistry } from '../src/avatar-rig';
import { checkCharacterModels } from '../src/character-model-check';
import { levelMediaSources } from '../src/content';
import { validateCourseModel } from '../src/course-art-model';
import { embeddedGlb, isCoursePackage, validateCoursePackage } from '../src/course-package';
import { NO_DECORATION_ART, usedDecorationArt } from '../src/decoration-art';
import type { DecorationArt } from '../src/decoration-art';
import { DEFAULT_COURSE_ART, DEFAULT_COURSE_MESHES, DEFAULT_LEVEL } from '../src/default-course';
import { DEFAULT_ENEMY_ART } from '../src/enemy-art-data';
import type { EnemyArtSettings } from '../src/enemy-art-data';
import { ENEMY_SPECIES } from '../src/enemy-types';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_LIMITS, validateGameSettings } from '../src/game-settings';
import type { GameSettings } from '../src/game-settings';
import { DEFAULT_HUD } from '../src/hud';
import type { HudSettings } from '../src/hud';
import { LEVEL_LIMITS, terrainAssets, validateLevel } from '../src/level';
import type { LevelDefinition } from '../src/level';
import { checkMediaBytes, isMediaLibraryPath, MEDIA_LIMITS, mediaFile, mediaPath } from '../src/media';
import { appearanceFile, artFile, checkFileBudget, projectFileRefs } from '../src/project';
import type { ProjectFileKind, ProjectManifest } from '../src/project';
import { checkLibraryModel, libraryEntries, libraryModelFile } from '../src/model-library';
import type { LibraryAvatarEntry, LibraryEntry, LibraryHammerEntry, PartRole } from '../src/model-library';
import { EMPTY_SPRITES, parseSpriteDocument, SPRITE_FILE_BYTES, validateSpriteAnchors } from '../src/sprite-data';
import type { SpriteDocument } from '../src/sprite-data';
import { DEFAULT_THEME } from '../src/theme';
import type { GameTheme } from '../src/theme';
import { defaultCourseMeshPath, readDefaultCourseMesh } from './default-course';
import { openProjectSource } from './project-release';
import type { TakenFile } from './project-release';
import { releaseFile, sha256Hex } from './release-file';
import type { ReleaseFile } from './release-file';

// Everything one game build packages, validated: the release's data and its files, only those the game uses.
export interface ReleaseInput {
  // The project's title; builds from the per-file inputs take GAME_TITLE instead.
  readonly title: string | undefined;
  // Files whose changes rebuild the content in development.
  readonly files: readonly string[];
  readonly level: LevelDefinition;
  readonly art: {
    readonly mode: ArtMode;
    readonly assets: readonly { readonly id: string; readonly name: string; readonly file: ReleaseFile }[];
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
  readonly appearance: readonly (AppearancePart & { readonly file: ReleaseFile })[];
  readonly media: readonly { readonly path: string; readonly file: ReleaseFile }[];
  // The model library the game's backend can select from, each entry with its GLB; empty for a game without one.
  readonly library: {
    readonly avatar: readonly (LibraryAvatarEntry & { readonly file: ReleaseFile })[];
    readonly hammer: readonly (LibraryHammerEntry & { readonly file: ReleaseFile })[];
    readonly pot: readonly (LibraryEntry & { readonly file: ReleaseFile })[];
  };
}

const NO_LIBRARY: ReleaseInput['library'] = { avatar: [], hammer: [], pot: [] };

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

// The course artwork a release draws in `mode`: the decoration models it maps for the level, and the assets that the
// level's terrain and those models use. The shapes look draws none.
function drawnArt(level: LevelDefinition, mode: ArtMode, art: DecorationArt): { decorations: DecorationArt; assets: ReadonlySet<string> } {
  if (mode === 'shapes') return { decorations: NO_DECORATION_ART, assets: new Set() };
  const decorations = usedDecorationArt(level, art);
  return {
    decorations,
    assets: new Set([...terrainAssets(level), ...Object.values(decorations)]),
  };
}

// The media library paths a release plays: its level's video and sound events, its music and its cues.
function playedMedia(level: LevelDefinition, audio: AudioSettings): ReadonlySet<string> {
  return new Set([...levelMediaSources(level), ...audioSources(audio)]);
}

/**
 * The binary files of a project that a release takes (see loadProjectRelease): every appearance model, the course
 * artwork it draws in `mode`, the media it plays and, for a game whose backend selects them (`library`), the model
 * library.
 */
export function releaseProjectFiles(manifest: ProjectManifest, level: LevelDefinition, mode: ArtMode, library: boolean): string[] {
  const art = drawnArt(level, mode, manifest.art.decorations).assets;
  const played = playedMedia(level, manifest.audio);
  return [
    ...manifest.appearance.map(part => appearanceFile(part.part)),
    ...manifest.art.assets.filter(asset => art.has(asset.id)).map(asset => artFile(asset.id)),
    ...manifest.media.filter(entry => played.has(entry.path)).map(entry => mediaFile(entry.path)),
    ...(library ? libraryEntries(manifest.models).map(({ role, entry }) => libraryModelFile(role, entry.id)) : []),
  ];
}

// The meshes a course draws in the chosen look, each read only when it is drawn and checked like course packages at
// import: its terrain's and those replacing the placeholders of the decoration models it uses.
function courseArt(level: LevelDefinition, mode: ArtMode, assets: readonly { id: string; name: string; read: () => TakenFile }[],
  art: DecorationArt): ReleaseInput['art'] {
  const { decorations, assets: used } = drawnArt(level, mode, art);
  let pixels = 0;
  const packaged = assets.filter(asset => used.has(asset.id)).map(asset => {
    const taken = asset.read();
    const { bytes } = taken;
    pixels += validateCourseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).pixels;
    if (pixels > ART_LIMITS.texturePixels) throw new Error('Course artwork exceeds 32 million decoded texture pixels.');
    if (asset.id !== `asset-${sha256Hex(bytes)}`) throw new Error(`Packaged asset "${asset.name}" does not match its content hash.`);
    return { id: asset.id, name: asset.name, file: releaseFile(taken) };
  });
  if (packaged.length !== used.size) throw new Error('Mesh artwork needs a self-contained course package, not level JSON containing only asset IDs.');
  return { mode, assets: packaged, decorations };
}

function artMode(selected: string | undefined, packaged: ArtMode): ArtMode {
  if (selected === undefined) return packaged;
  if (selected !== 'shapes' && selected !== 'meshes') throw new Error('GAME_ART_MODE must be shapes or meshes.');
  return selected;
}

// The art of the enemy species the level places; a species it never places keeps the built-in art, which nothing draws.
function placedEnemyArt(level: LevelDefinition, art: EnemyArtSettings): EnemyArtSettings {
  const placed = new Set(level.objects.flatMap(object => object.kind === 'enemy' ? [object.species] : []));
  return Object.freeze(Object.fromEntries(ENEMY_SPECIES.map(species => [species, placed.has(species) ? art[species] : null]))) as EnemyArtSettings;
}

function character(document: SpriteDocument, label: string, registry: AvatarRigRegistry): SpriteDocument {
  try {
    validateSpriteAnchors(document, VISUAL_PART_IDS, SPRITE_TARGET_IDS);
    checkCharacterModels(document, label, registry);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return document;
}

function profile(path: string | null, variable: string, registry: AvatarRigRegistry): SpriteDocument | null {
  if (path === null) return null;
  if (statSync(path).size > SPRITE_FILE_BYTES) throw new Error(`${variable} exceeds the profile size limit.`);
  return character(parseSpriteDocument(readFileSync(path, 'utf8')), variable, registry);
}

// The level and course artwork of GAME_LEVEL, a level or course package, or else of the built-in course with its meshes.
function fileCourse(path: string | null, selectedMode: string | undefined): { level: LevelDefinition; art: ReleaseInput['art'] } {
  if (path === null) {
    return {
      level: DEFAULT_LEVEL,
      art: courseArt(DEFAULT_LEVEL, artMode(selectedMode, DEFAULT_COURSE_ART.mode), DEFAULT_COURSE_MESHES.map(mesh => ({
        id: mesh.id, name: mesh.name, read: () => ({ bytes: readDefaultCourseMesh(mesh), path: defaultCourseMeshPath(mesh) }),
      })), DEFAULT_COURSE_ART.decorations),
    };
  }
  const bytes = statSync(path).size;
  if (bytes > ART_LIMITS.packageBytes) throw new Error('GAME_LEVEL exceeds the course package size limit.');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const pack = isCoursePackage(raw) ? validateCoursePackage(raw) : null;
  if (pack === null && bytes > LEVEL_LIMITS.fileBytes) throw new Error('GAME_LEVEL exceeds the level JSON size limit.');
  const level = pack?.level ?? validateLevel(raw);
  return {
    level,
    art: courseArt(level, artMode(selectedMode, pack?.mode ?? 'shapes'),
      (pack?.assets ?? []).map(asset => ({ id: asset.id, name: asset.name, read: () => ({ bytes: embeddedGlb(asset.source), path: null }) })),
      pack?.decorations ?? NO_DECORATION_ART),
  };
}

// A build from the per-file inputs: a level or course package, settings and up to two profiles.
// Its /media/ sources come from public/media/.
export function loadFileRelease(root: string, files: ReleaseFiles, selectedMode: string | undefined,
  avatarRigs: AvatarRigRegistry): ReleaseInput {
  const watched = [files.level, files.settings, files.sprites, files.alternateSprites].filter((path): path is string => path !== null);
  const { level, art } = fileCourse(files.level, selectedMode);
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
    return { path: source, file: releaseFile({ bytes: fileBytes, path: real }) };
  });
  return {
    title: undefined, files: watched, level, art, settings,
    primary: profile(files.sprites, 'GAME_SPRITES', avatarRigs) ?? EMPTY_SPRITES,
    alternate: profile(files.alternateSprites, 'GAME_ALTERNATE_SPRITES', avatarRigs),
    theme: DEFAULT_THEME, hud: DEFAULT_HUD, enemies: DEFAULT_ENEMY_ART, armIk: DEFAULT_ARM_IK, audio: DEFAULT_AUDIO,
    appearance: [], media, library: NO_LIBRARY,
  };
}

/**
 * A build from GAME_PROJECT, with GAME_ART_MODE applied. It takes only what the game uses, each file read once and
 * checked like every project's: the course artwork its level draws in the release's look, the appearance models, the
 * media its level and audio play and the art of the enemies its level places. The model library is the game's when
 * `library` says it has a backend that can select its models (GAME_MODULE); without one no library model can show, so
 * none is packaged.
 */
export function loadProjectRelease(root: string, requested: string, selectedMode: string | undefined,
  avatarRigs: AvatarRigRegistry, options: { readonly library: boolean }): ReleaseInput {
  const source = openProjectSource(root, requested);
  const { manifest, level } = source;
  const files = [...source.files];
  const refs = new Map(projectFileRefs(manifest).map(ref => [ref.path, ref]));
  // Each kind's files the release takes keep within the kind's total, as the release loads them together.
  const totals = new Map<ProjectFileKind, number>();
  const read = (path: string): TakenFile => {
    const ref = refs.get(path)!;
    const taken = source.take(ref);
    if (taken.path !== null) files.push(taken.path);
    const total = (totals.get(ref.kind) ?? 0) + taken.bytes.byteLength;
    totals.set(ref.kind, total);
    checkFileBudget(ref.kind, total);
    return taken;
  };
  // A file the release packages, read and checked by `check`; a failure names `label`.
  const take = (path: string, label: string, check: (bytes: Uint8Array) => void): ReleaseFile => {
    try {
      const taken = read(path);
      check(taken.bytes);
      return releaseFile(taken);
    } catch (error) {
      throw failure(label, error);
    }
  };
  let art;
  try {
    art = courseArt(level, artMode(selectedMode, manifest.art.mode),
      manifest.art.assets.map(asset => ({ id: asset.id, name: asset.name, read: () => read(artFile(asset.id)) })),
      manifest.art.decorations);
  } catch (error) {
    throw failure('GAME_PROJECT course artwork', error);
  }
  const appearance = manifest.appearance.map(part => ({
    ...part,
    file: take(appearanceFile(part.part), `GAME_PROJECT appearance model ${part.name} (${part.part})`,
      (bytes) => checkAppearanceModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)),
  }));
  const played = playedMedia(level, manifest.audio);
  const media = manifest.media.filter(entry => played.has(entry.path)).map(entry => ({
    path: entry.path, file: take(mediaFile(entry.path), `GAME_PROJECT media ${entry.path}`, (bytes) => checkMediaBytes(entry.path, bytes)),
  }));
  // Checked one at a time, each against its part's conventions and an avatar against its settings.
  const libraryFile = (role: PartRole, entry: LibraryEntry): ReleaseFile =>
    take(libraryModelFile(role, entry.id), 'GAME_PROJECT', (bytes) => checkLibraryModel(role, entry, bytes, avatarRigs));
  const library: ReleaseInput['library'] = !options.library ? NO_LIBRARY : {
    avatar: manifest.models.avatar.map(entry => ({ ...entry, file: libraryFile('avatar', entry) })),
    hammer: manifest.models.hammer.map(entry => ({ ...entry, file: libraryFile('hammer', entry) })),
    pot: manifest.models.pot.map(entry => ({ ...entry, file: libraryFile('pot', entry) })),
  };
  const { primary, alternate } = source.characters;
  return {
    title: manifest.title, files, level, art, settings: manifest.settings,
    primary: primary === null ? EMPTY_SPRITES : character(primary, 'GAME_PROJECT primary character', avatarRigs),
    alternate: alternate === null ? null : character(alternate, 'GAME_PROJECT alternate character', avatarRigs),
    theme: manifest.theme, hud: manifest.hud, enemies: placedEnemyArt(level, manifest.enemies), armIk: manifest.armIk,
    audio: manifest.audio, appearance, media, library,
  };
}
