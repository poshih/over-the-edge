import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ArmIkSettings } from '../src/character';
import { DEFAULT_ARM_IK, SPRITE_TARGET_IDS, VISUAL_PART_IDS } from '../src/character';
import type { AppearancePart } from '../src/appearance-profile';
import { checkAppearanceModel } from '../src/appearance-model';
import { ART_LIMITS } from '../src/art-types';
import { audioSources, DEFAULT_AUDIO } from '../src/audio-settings';
import type { AudioSettings } from '../src/audio-settings';
import type { AvatarRigRegistry } from '../src/avatar-rig';
import { checkCharacterModels } from '../src/character-model-check';
import { levelMediaSources } from '../src/content';
import { embeddedGlb, isCoursePackage, validateCoursePackage } from '../src/course-package';
import { NO_DECORATION_ART, usedCourseArt } from '../src/decoration-art';
import type { DecorationArt } from '../src/decoration-art';
import { DEFAULT_COURSE_ART, DEFAULT_COURSE_MESHES, DEFAULT_LEVEL } from '../src/default-course';
import { DEFAULT_ENEMY_ART, enemyArtAssets, placedSpecies } from '../src/enemy-art-data';
import { checkEnemyModelMotion, validateArtAsset } from '../src/enemy-model-check';
import type { EnemyArtSettings } from '../src/enemy-art-data';
import { ENEMY_SPECIES } from '../src/enemy-types';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_LIMITS, validateGameSettings } from '../src/game-settings';
import type { GameSettings } from '../src/game-settings';
import { DEFAULT_HUD } from '../src/hud';
import type { HudSettings } from '../src/hud';
import { LEVEL_LIMITS, validateLevel } from '../src/level';
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

// The media library paths a release plays: its level's video and sound events, its music and its cues.
function playedMedia(level: LevelDefinition, audio: AudioSettings): ReadonlySet<string> {
  return new Set([...levelMediaSources(level), ...audioSources(audio)]);
}

/**
 * The binary files of a project that a release takes (see loadProjectRelease): every appearance model, the course
 * artwork its level draws, the media it plays and, for a game whose backend selects them (`library`), the model library.
 */
export function releaseProjectFiles(manifest: ProjectManifest, level: LevelDefinition, library: boolean): string[] {
  const art = usedCourseArt(level, manifest.art.decorations, manifest.enemies).assets;
  const played = playedMedia(level, manifest.audio);
  return [
    ...manifest.appearance.map(part => appearanceFile(part.part)),
    ...manifest.art.assets.filter(asset => art.has(asset.id)).map(asset => artFile(asset.id)),
    ...manifest.media.filter(entry => played.has(entry.path)).map(entry => mediaFile(entry.path)),
    ...(library ? libraryEntries(manifest.models).map(({ role, entry }) => libraryModelFile(role, entry.id)) : []),
  ];
}

// The GLBs a course draws, each read only when it is drawn and checked like course packages at import: its terrain's,
// those of the decoration models it uses that course artwork draws and those of its enemies' models, whose baked
// motion must still be what their clips travel.
function courseArt(level: LevelDefinition, assets: readonly { id: string; name: string; read: () => TakenFile }[],
  art: DecorationArt, enemies: EnemyArtSettings): ReleaseInput['art'] {
  const { decorations, assets: used } = usedCourseArt(level, art, enemies);
  const placed = placedSpecies(level);
  const models = enemyArtAssets(enemies, placed);
  let pixels = 0;
  const packaged = assets.filter(asset => used.has(asset.id)).map(asset => {
    const taken = asset.read();
    const { bytes } = taken;
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    pixels += validateArtAsset(data, models.has(asset.id) ? 'enemy' : 'course').pixels;
    if (pixels > ART_LIMITS.texturePixels) throw new Error('Course artwork exceeds 32 million decoded texture pixels.');
    if (asset.id !== `asset-${sha256Hex(bytes)}`) throw new Error(`Packaged asset "${asset.name}" does not match its content hash.`);
    for (const species of placed) {
      const entry = enemies[species];
      if (entry?.type === 'model' && entry.asset === asset.id) checkEnemyModelMotion(data, entry, species);
    }
    return { id: asset.id, name: asset.name, file: releaseFile(taken) };
  });
  if (packaged.length !== used.size) {
    throw new Error('The level draws GLBs this build was not given: build from its course package (npm run pack:course) or its GAME_PROJECT.');
  }
  return { assets: packaged, decorations };
}

// The art of the enemy species the level places; a species it never places keeps the built-in art, which nothing draws.
function placedEnemyArt(level: LevelDefinition, art: EnemyArtSettings): EnemyArtSettings {
  const placed = placedSpecies(level);
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
function fileCourse(path: string | null): { level: LevelDefinition; art: ReleaseInput['art'] } {
  if (path === null) {
    return {
      level: DEFAULT_LEVEL,
      art: courseArt(DEFAULT_LEVEL, DEFAULT_COURSE_MESHES.map(mesh => ({
        id: mesh.id, name: mesh.name, read: () => ({ bytes: readDefaultCourseMesh(mesh), path: defaultCourseMeshPath(mesh) }),
      })), DEFAULT_COURSE_ART.decorations, DEFAULT_ENEMY_ART),
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
    art: courseArt(level,
      (pack?.assets ?? []).map(asset => ({ id: asset.id, name: asset.name, read: () => ({ bytes: embeddedGlb(asset.source), path: null }) })),
      pack?.decorations ?? NO_DECORATION_ART, DEFAULT_ENEMY_ART),
  };
}

// A build from the per-file inputs: a level or course package, settings and up to two profiles.
// Its /media/ sources come from public/media/.
export function loadFileRelease(root: string, files: ReleaseFiles, avatarRigs: AvatarRigRegistry): ReleaseInput {
  const watched = [files.level, files.settings, files.sprites, files.alternateSprites].filter((path): path is string => path !== null);
  const { level, art } = fileCourse(files.level);
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
 * A build from GAME_PROJECT. It takes only what the game uses, each file read once and checked like every project's:
 * the course artwork its level draws, the appearance models, the media its level and audio play and the art of the
 * enemies its level places. The model library is the game's when `library` says it has a release facet that can select
 * its models (docs/release-plugins.md); without one no library model can show, so none is packaged.
 */
export function loadProjectRelease(root: string, requested: string, avatarRigs: AvatarRigRegistry,
  options: { readonly library: boolean }): ReleaseInput {
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
  const enemies = placedEnemyArt(level, manifest.enemies);
  let art;
  try {
    art = courseArt(level,
      manifest.art.assets.map(asset => ({ id: asset.id, name: asset.name, read: () => read(artFile(asset.id)) })),
      manifest.art.decorations, enemies);
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
    theme: manifest.theme, hud: manifest.hud, enemies, armIk: manifest.armIk,
    audio: manifest.audio, appearance, media, library,
  };
}
