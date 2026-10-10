import { checkAppearanceModel } from '../../appearance-model';
import { ART_LIMITS, artName } from '../../art-types';
import type { AvatarRigRegistry } from '../../avatar-rig';
import { VISUAL_PART_IDS } from '../../character';
import { inspectCharacterModel, suggestAvatarBoneMap } from '../../character-model-inspect';
import type { CharacterModelReport } from '../../character-model-inspect';
import { AVATAR_JOINT_IDS, validateAvatarBoneMap } from '../../character-profile';
import type { AvatarModelSettings, PartialAvatarBoneMap } from '../../character-profile';
import { embeddedGlb, validateCoursePackage } from '../../course-package';
import { enemyArtAssets } from '../../enemy-art-data';
import type { ModelArt } from '../../enemy-art-data';
import { validateArtAsset } from '../../enemy-model-check';
import type { ArtAssetUse, EnemyBake } from '../../enemy-model-check';
import { SPECIES_CLIP_ROLES } from '../../enemy-motion-data';
import type { EnemyClipRole } from '../../enemy-motion-data';
import { ENEMY_SPECIES } from '../../enemy-types';
import type { EnemySpecies } from '../../enemy-types';
import { GAME_SETTINGS_LIMITS, GameSettingsError, validateGameSettings } from '../../game-settings';
import { LevelError, terrainAssets } from '../../level';
import { checkMediaBytes, MEDIA_LIMITS, mediaPathForFile } from '../../media';
import type { MeshTerrain } from '../../mesh-collision';
import { MODEL_LIMITS } from '../../model-data';
import {
  checkAvatarModelSettings, isPartRole, libraryAvatarSettings, libraryIdForName, libraryModelId, mappedAvatarModel,
  MODEL_LIBRARY_LIMITS, PART_ROLES, validateAvatarSettings,
} from '../../model-library';
import type {
  LibraryAvatarEntry, LibraryAvatarSettings, LibraryEntry, LibraryHammerEntry, PartRole,
} from '../../model-library';
import { pluginOfSection } from '../../plugin-data';
import { PluginError } from '../../plugins/kernel';
import { checkFileBudget, isProjectDataError, parseProjectCharacter, ProjectError } from '../../project';
import { SPRITE_FILE_BYTES } from '../../sprite-data';
import { SpriteError } from '../../sprite-fields';
import { defaultEnemyClips } from '../enemy-clips';
import { ProjectApiError } from '../project-client';
import { ServerModelError } from '../server-models';
import type { FileHandle, FileStore } from './files';
import type { History } from './history';
import type { ImportRunner, PendingContext, PreparedImport } from './import-runner';
import type { ProjectCommandInfo, ProjectCommands, ProjectRefusal } from './project-commands';
import type {
  DocumentArtAsset, DocumentModel, SectionName, SectionValues,
} from './project-document';
import type { LibraryModel, ProjectBake, ProjectProjection } from './project-projection';
import { adapterFor, SECTION_ADAPTERS } from './sections';
import { characterHoldSettings } from './visual-values';

export type EditOutcome<T> =
  | { readonly kind: 'applied' | 'unchanged'; readonly value: T }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly error: ProjectRefusal };

export interface ImportOptions {
  readonly info: ProjectCommandInfo;
  readonly signal: AbortSignal;
}

export interface FileRead {
  readonly name: string;
  read(signal: AbortSignal): Promise<File>;
}

export type FileInput = File | FileRead;

export interface AddedCourseMesh {
  readonly id: string;
  readonly name: string;
  readonly terrain: MeshTerrain;
}

export type ConfigureAvatar = (
  report: CharacterModelReport,
  proposed: PartialAvatarBoneMap,
  signal: AbortSignal,
) => Promise<AvatarModelSettings>;

export interface ProjectImports {
  settings(input: FileInput, options: ImportOptions): Promise<EditOutcome<void>>;
  serverSettings(
    name: string,
    read: (signal: AbortSignal) => Promise<unknown>,
    options: ImportOptions,
  ): Promise<EditOutcome<void>>;
  media(input: FileInput, options: ImportOptions): Promise<EditOutcome<string>>;
  courseMesh(input: FileInput, options: ImportOptions): Promise<EditOutcome<AddedCourseMesh>>;
  enemyModel(species: EnemySpecies, input: FileInput, options: ImportOptions): Promise<EditOutcome<void>>;
  enemyClips(
    species: EnemySpecies,
    clips: Readonly<Partial<Record<EnemyClipRole, string>>>,
    options: ImportOptions,
  ): Promise<EditOutcome<void>>;
  library(
    role: PartRole,
    input: FileInput,
    options: ImportOptions & {
      readonly model?: AvatarModelSettings;
      readonly configure?: ConfigureAvatar;
    },
  ): Promise<EditOutcome<LibraryModel>>;
  libraryAvatar(id: string, settings: LibraryAvatarSettings, options: ImportOptions): Promise<EditOutcome<void>>;
  useCharacterSettings(id: string, options: ImportOptions): Promise<EditOutcome<void>>;
  alternate(input: FileInput, options: ImportOptions): Promise<EditOutcome<void>>;
  coursePackage(input: FileInput, options: ImportOptions): Promise<EditOutcome<void>>;
  sections(
    read: (signal: AbortSignal) => Promise<Partial<SectionValues>>,
    options: ImportOptions,
  ): Promise<EditOutcome<void>>;
  invalidateProject(): void;
  dispose(): void;
}

export interface ProjectImportsOptions {
  readonly history: History;
  readonly commands: ProjectCommands;
  readonly files: FileStore;
  readonly projection: ProjectProjection;
  readonly avatarRigs: AvatarRigRegistry;
  readonly prepareLevel: () => boolean;
  readonly runner: ImportRunner;
}

type ImportSection = 'settings' | 'media' | 'art' | 'enemies' | 'models' | 'characters/alternate' | 'appearance' | 'level';

const SPECIES = new Set(ENEMY_SPECIES);

function refusal(error: unknown, section: ImportSection): ProjectRefusal {
  if (error instanceof PluginError || error instanceof LevelError) return error;
  const known = isProjectDataError(error) || error instanceof ProjectApiError || error instanceof ServerModelError ||
    error instanceof DOMException || error instanceof SyntaxError;
  if (!known || !(error instanceof Error)) throw error;
  if (section === 'settings') {
    return error instanceof GameSettingsError ? error : new GameSettingsError(error.message, { cause: error });
  }
  if (section === 'characters/alternate') {
    return error instanceof SpriteError ? error : new SpriteError(error.message, { cause: error });
  }
  return error instanceof ProjectError ? error : new ProjectError(error.message, { section, cause: error });
}

function checked<T>(section: ImportSection, run: () => T): T {
  try { return run(); } catch (error) { throw refusal(error, section); }
}

function size(file: Blob, limit: number, section: ImportSection): void {
  if (file.size === 0 || file.size > limit) {
    throw new ProjectError(`Choose a file holding 1 byte to ${limit / 1024 ** 2} MiB.`, { section });
  }
}

function cheapSize(input: FileInput, limit: number, section: ImportSection): void {
  if (!('read' in input)) size(input, limit, section);
}

function species(value: EnemySpecies): void {
  if (!SPECIES.has(value)) throw new ProjectError(`Unknown enemy species "${value}".`, { section: 'enemies' });
}

function role(value: PartRole): void {
  if (!isPartRole(value)) throw new ProjectError(`Unknown library role "${value}".`, { section: 'models' });
}

function modelArt(
  species: EnemySpecies,
  asset: string,
  clips: Readonly<Partial<Record<EnemyClipRole, string>>>,
  bake: EnemyBake,
): ModelArt {
  const roles = SPECIES_CLIP_ROLES[species];
  if (Object.keys(clips).some((key) => !roles.includes(key as EnemyClipRole))) {
    throw new ProjectError(`Choose only the ${species}'s ${roles.join(', ')} clips.`, { section: 'enemies' });
  }
  const motion = Object.fromEntries(roles.map((role) => {
    const name = clips[role];
    const value = name === undefined || !Object.hasOwn(bake.motion, name) ? undefined : bake.motion[name];
    if (value === undefined) {
      throw new ProjectError(`Choose one of the model's clips for the ${species}'s ${role}.`, { section: 'enemies' });
    }
    return [role, value];
  }));
  return Object.freeze({ type: 'model', asset, clips: Object.freeze({ ...clips }), motion: Object.freeze(motion) });
}

function checkMotion(species: EnemySpecies, entry: ModelArt, bake: EnemyBake): void {
  const expected = modelArt(species, entry.asset, entry.clips, bake);
  for (const role of SPECIES_CLIP_ROLES[species]) {
    const before = entry.motion[role];
    const after = expected.motion[role];
    if (before === undefined || after === undefined || before.duration !== after.duration ||
      before.travel.length !== after.travel.length || before.travel.some((sample, index) => sample !== after.travel[index])) {
      throw new ProjectError(`The ${species} model's motion no longer matches its clips. Choose its clips again.`, { section: 'enemies' });
    }
  }
}

export function createProjectImports(options: ProjectImportsOptions): ProjectImports {
  const { history, commands, files, projection, runner } = options;
  const document = history.document;
  // Stops this service's imports; the runner, shared with the character's and the appearance's, outlives it.
  const lifecycle = new AbortController();

  function edit<T, P>(
    input: ImportOptions,
    section: ImportSection,
    start: (work: PendingContext) => P,
    build: (work: PendingContext, prepared: P) => Promise<PreparedImport<T>>,
  ): Promise<EditOutcome<T>> {
    return runner.edit({ info: input.info, signal: AbortSignal.any([input.signal, lifecycle.signal]) },
      (error) => refusal(error, section), start, build);
  }

  function prepareLevel(): void {
    if (!options.prepareLevel()) {
      throw new ProjectError('Finish or cancel the unfinished outline, and fix any trigger events, in Level first.', { section: 'level' });
    }
  }

  async function read(work: PendingContext, input: FileInput, limit: number, section: ImportSection): Promise<File> {
    work.check();
    const file = 'read' in input ? await work.wait(() => input.read(work.signal)) : input;
    work.check();
    size(file, limit, section);
    return file;
  }

  function assetId(file: FileHandle): string {
    const sha256 = files.locations(file).sha256;
    if (sha256 === null) throw new Error('A checked page file must have a digest.');
    return `asset-${sha256}`;
  }

  // The import keeps its bake leased until it ends; a stop lets it go at once.
  function bake<T>(work: PendingContext, prepare: () => ProjectBake<T>): Promise<T> {
    return work.wait(() => {
      const held = prepare();
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        work.signal.removeEventListener('abort', release);
        held.release();
      };
      work.signal.addEventListener('abort', release, { once: true });
      work.own(release);
      if (work.signal.aborted) release();
      return held.promise;
    });
  }

  function avatar(id: string): DocumentModel<LibraryAvatarEntry> {
    libraryModelId(id);
    const model = document.get('models').avatar.find((candidate) => candidate.entry.id === id);
    if (model === undefined) throw new ProjectError(`The project has no library avatar "${id}".`, { section: 'models' });
    return model;
  }

  function avatarTarget(work: PendingContext, id: string): DocumentModel<LibraryAvatarEntry> {
    const expected = avatar(id);
    work.target(`models/avatar/${id}`, ['models'],
      () => document.get('models').avatar.find((model) => model.entry.id === id) === expected);
    work.retain([expected.file]);
    return expected;
  }

  async function avatarReport(work: PendingContext, id: string): Promise<CharacterModelReport> {
    const blob = await work.wait(() => projection.libraryBlob('avatar', id, work.signal));
    const bytes = await work.wait(() => blob.arrayBuffer());
    work.check();
    return inspectCharacterModel(bytes, 'avatar');
  }

  async function libraryReport(work: PendingContext, file: File, role: PartRole): Promise<CharacterModelReport> {
    const bytes = await work.wait(() => file.arrayBuffer());
    work.check();
    return inspectCharacterModel(bytes, role);
  }

  function libraryBase(role: PartRole, name: string): LibraryEntry {
    const taken = new Set(document.get('models')[role].map((model) => model.entry.id));
    const stem = libraryIdForName(name);
    let id = stem;
    for (let suffix = 2; taken.has(id); suffix++) {
      id = `${stem.slice(0, MODEL_LIBRARY_LIMITS.id - String(suffix).length - 1)}-${suffix}`;
    }
    return Object.freeze({ id, name: name.replace(/\.glb$/i, '').trim().slice(0, MODEL_LIBRARY_LIMITS.name) || id });
  }

  // Read as the step finishes, so the avatar takes the character's hold settings at that moment.
  function withHoldSettings(model: AvatarModelSettings): LibraryAvatarSettings {
    return validateAvatarSettings({ ...model, ...characterHoldSettings(document) });
  }

  async function checkSections(work: PendingContext, values: Partial<SectionValues>): Promise<void> {
    if (values.art !== undefined) {
      if (values.art.assets.length > ART_LIMITS.assets) throw new ProjectError('The restored artwork has too many assets.', { section: 'art' });
      checkFileBudget('art', values.art.assets.reduce((sum, asset) => sum + asset.file.bytes, 0));
    }
    if (values.media !== undefined) {
      if (values.media.length > MEDIA_LIMITS.files) throw new ProjectError('The restored media library has too many files.', { section: 'media' });
      checkFileBudget('media', values.media.reduce((sum, item) => sum + item.file.bytes, 0));
    }
    if (values.appearance !== undefined) {
      if (values.appearance.length > VISUAL_PART_IDS.length) {
        throw new ProjectError('The restored appearance has too many part models.', { section: 'appearance' });
      }
      checkFileBudget('appearance', values.appearance.reduce((sum, part) => sum + part.file.bytes, 0));
    }
    for (const role of PART_ROLES) {
      if (values.models !== undefined && values.models[role].length > MODEL_LIBRARY_LIMITS.entries) {
        throw new ProjectError(`The restored ${role} library has too many models.`, { section: 'models' });
      }
    }
    const handles = new Set<FileHandle>();
    for (const name of Object.keys(values)) {
      if (!Object.hasOwn(SECTION_ADAPTERS.builtin, name) && pluginOfSection(name) === null) {
        throw new ProjectError(`Unknown document section "${name}".`, { section: name });
      }
      const section = name as SectionName;
      const value = values[section];
      if (value === undefined) throw new ProjectError(`Missing restored section "${name}".`, { section: name });
      for (const file of adapterFor(section).files(value)) handles.add(file);
    }
    work.retain([...handles]);

    for (const role of PART_ROLES) {
      for (const model of values.models?.[role] ?? []) {
        const current = document.get('models')[role].find((item) => item.entry.id === model.entry.id);
        if (current !== undefined && current.file === model.file && current.entry === model.entry) continue;
        const blob = await work.wait(() => files.blob(model.file, work.signal));
        const bytes = await work.wait(() => blob.arrayBuffer());
        work.check();
        checked('models', () => {
          const report = inspectCharacterModel(bytes, role);
          if (role === 'avatar') checkAvatarModelSettings(report, model.entry as LibraryAvatarEntry, options.avatarRigs);
        });
      }
    }
    for (const item of values.media ?? []) {
      if (document.get('media').some((current) => current.path === item.path && current.file === item.file)) continue;
      const blob = await work.wait(() => files.blob(item.file, work.signal));
      size(blob, MEDIA_LIMITS.bytes, 'media');
      const bytes = await work.wait(() => blob.slice(0, 64).arrayBuffer());
      work.check();
      checked('media', () => checkMediaBytes(item.path, new Uint8Array(bytes)));
    }
    // Only files the appearance does not hold yet are read; a part model's check reads nothing but its bytes.
    const held = new Set(document.get('appearance').map((part) => part.file));
    for (const part of values.appearance ?? []) {
      if (held.has(part.file)) continue;
      const blob = await work.wait(() => files.blob(part.file, work.signal));
      size(blob, MODEL_LIMITS.bytes, 'appearance');
      const bytes = await work.wait(() => blob.arrayBuffer());
      work.check();
      checked('appearance', () => checkAppearanceModel(bytes));
      held.add(part.file);
    }
    if (values.art === undefined && values.enemies === undefined) return;

    const currentLevel = document.get('level');
    const currentArt = document.get('art');
    const currentEnemies = document.get('enemies');
    if (values.level === undefined) work.watch(['level'], () => document.get('level') === currentLevel);
    if (values.art === undefined) work.watch(['art'], () => document.get('art') === currentArt);
    if (values.enemies === undefined) work.watch(['enemies'], () => document.get('enemies') === currentEnemies);
    const art = values.art ?? currentArt;
    const enemies = values.enemies ?? currentEnemies;
    const level = values.level ?? currentLevel;
    const courses = new Set([...terrainAssets(level), ...Object.values(art.decorations)]);
    const drawn = enemyArtAssets(enemies, SPECIES);
    const oldCourses = new Set([...terrainAssets(currentLevel), ...Object.values(currentArt.decorations)]);
    const oldDrawn = enemyArtAssets(currentEnemies, SPECIES);
    const blobs = new Map<FileHandle, Blob>();
    work.retain(art.assets.map((asset) => asset.file));
    const blobFor = async (file: FileHandle): Promise<Blob> => {
      work.check();
      const existing = blobs.get(file);
      if (existing !== undefined) return existing;
      const blob = await work.wait(() => files.blob(file, work.signal));
      work.check();
      blobs.set(file, blob);
      return blob;
    };
    const use = (id: string, courses: ReadonlySet<string>, drawn: ReadonlySet<string>): ArtAssetUse =>
      drawn.has(id) ? 'enemy' : courses.has(id) ? 'course' : 'any';
    for (const asset of art.assets) {
      const previous = currentArt.assets.find((item) => item.id === asset.id);
      if (previous?.file === asset.file && use(asset.id, courses, drawn) === use(asset.id, oldCourses, oldDrawn)) continue;
      const blob = await blobFor(asset.file);
      size(blob, ART_LIMITS.bytes, 'art');
      if (assetId(asset.file) !== asset.id) throw new ProjectError(`Artwork ${asset.id} does not match its file's digest.`, { section: 'art' });
      const bytes = await work.wait(() => blob.arrayBuffer());
      work.check();
      checked('art', () => validateArtAsset(bytes, use(asset.id, courses, drawn)));
    }
    for (const species of ENEMY_SPECIES) {
      const entry = enemies[species];
      if (entry?.type !== 'model') continue;
      const asset = art.assets.find((item) => item.id === entry.asset);
      if (asset === undefined) throw new ProjectError(`The ${species} model is missing from the course artwork.`, { section: 'enemies' });
      const previous = currentArt.assets.find((item) => item.id === entry.asset);
      if (entry === currentEnemies[species] && previous?.file === asset.file) continue;
      const blob = await blobFor(asset.file);
      const result = await bake(work, () => projection.bakeEnemy(asset.file, blob));
      work.check();
      checkMotion(species, entry, result);
    }
  }

  const imports: ProjectImports = {
    settings(input, request) {
      return edit(request, 'settings', (work) => {
        cheapSize(input, GAME_SETTINGS_LIMITS.fileBytes, 'settings');
        const expected = document.get('settings');
        work.target('settings', ['settings'], () => document.get('settings') === expected);
      }, async (work) => {
        const file = await read(work, input, GAME_SETTINGS_LIMITS.fileBytes, 'settings');
        const text = await work.wait(() => file.text());
        work.check();
        const settings = validateGameSettings(JSON.parse(text));
        return { command: () => commands.settings(() => settings, request.info), value: () => undefined };
      });
    },
    serverSettings(name, read, request) {
      return edit(request, 'settings', (work) => {
        if (name.length === 0) throw new GameSettingsError('Choose a server settings copy.');
        const expected = document.get('settings');
        work.target('settings', ['settings'], () => document.get('settings') === expected);
      }, async (work) => {
        const value = await work.wait(() => read(work.signal));
        work.check();
        const settings = validateGameSettings(value);
        return { command: () => commands.settings(() => settings, request.info), value: () => undefined };
      });
    },
    media(input, request) {
      return edit(request, 'media', (work) => {
        cheapSize(input, MEDIA_LIMITS.bytes, 'media');
        const path = mediaPathForFile(input.name);
        if (path === null) throw new ProjectError('Choose a .webm, .mp4, .mp3, .ogg, .wav or .m4a file with a letter or digit in its name.', { section: 'media' });
        const expected = document.get('media').find((item) => item.path === path);
        work.target(`media${path}`, ['media'], () => document.get('media').find((item) => item.path === path) === expected);
        return path;
      }, async (work, path) => {
        const file = await read(work, input, MEDIA_LIMITS.bytes, 'media');
        const bytes = await work.wait(() => file.slice(0, 64).arrayBuffer());
        work.check();
        checkMediaBytes(path, new Uint8Array(bytes));
        const handle = await work.stage(file);
        work.check();
        return { command: () => commands.mediaAdd(Object.freeze({ path, file: handle }), request.info), value: () => path };
      });
    },
    courseMesh(input, request) {
      return edit(request, 'art', () => cheapSize(input, ART_LIMITS.bytes, 'art'), async (work) => {
        const file = await read(work, input, ART_LIMITS.bytes, 'art');
        const handle = await work.stage(file);
        work.check();
        const id = assetId(handle);
        const baked = await bake(work, () => projection.bakeMesh(handle, 0, file));
        work.check();
        const terrain = Object.freeze({ ...baked, mesh: Object.freeze({ ...baked.mesh, assetId: id }) });
        const imported = Object.freeze({ id, name: artName(input.name.replace(/\.glb$/i, '').slice(0, 80) || 'Mesh'), file: handle });
        let asset: DocumentArtAsset | null = null;
        return {
          command: () => {
            asset = document.get('art').assets.find((asset) => asset.id === id) ?? imported;
            return commands.courseMeshAdd(asset, request.info);
          },
          value: () => {
            if (asset === null) throw new Error('The imported mesh was not applied.');
            return Object.freeze({ id, name: asset.name, terrain });
          },
        };
      });
    },
    enemyModel(speciesValue, input, request) {
      return edit(request, 'enemies', (work) => {
        species(speciesValue);
        cheapSize(input, ART_LIMITS.bytes, 'art');
        const expected = document.get('enemies')[speciesValue];
        work.stopTargets(`enemies/${speciesValue}/`);
        work.target(`enemies/${speciesValue}/model`, ['enemies'], () => document.get('enemies')[speciesValue] === expected);
      }, async (work) => {
        const file = await read(work, input, ART_LIMITS.bytes, 'art');
        const handle = await work.stage(file);
        work.check();
        const id = assetId(handle);
        const result = await bake(work, () => projection.bakeEnemy(handle, file));
        work.check();
        const clips = defaultEnemyClips(speciesValue, result.clips.map((clip) => clip.name));
        const imported = Object.freeze({ id, name: artName(input.name.replace(/\.glb$/i, '').slice(0, 80) || 'Enemy'), file: handle });
        return {
          command: () => {
            const asset = document.get('art').assets.find((asset) => asset.id === id) ?? imported;
            return commands.enemyModel({ species: speciesValue, asset, model: modelArt(speciesValue, id, clips, result) }, request.info);
          },
          value: () => undefined,
        };
      });
    },
    enemyClips(speciesValue, clips, request) {
      return edit(request, 'enemies', (work) => {
        species(speciesValue);
        const expected = document.get('enemies')[speciesValue];
        if (expected?.type !== 'model') throw new ProjectError(`The ${speciesValue} is not drawn by a model.`, { section: 'enemies' });
        const roles = Object.keys(clips);
        if (roles.some((role) => !SPECIES_CLIP_ROLES[speciesValue].includes(role as EnemyClipRole))) {
          throw new ProjectError(`Choose only the ${speciesValue}'s own clip roles.`, { section: 'enemies' });
        }
        const asset = document.get('art').assets.find((asset) => asset.id === expected.asset);
        if (asset === undefined) throw new ProjectError(`The ${speciesValue}'s model is missing from the course artwork.`, { section: 'enemies' });
        work.stopTargets(`enemies/${speciesValue}/model`);
        for (const role of roles) work.target(`enemies/${speciesValue}/clips/${role}`);
        work.watch(['enemies', 'art'], () => {
          const current = document.get('enemies')[speciesValue];
          return current?.type === 'model' && current.asset === expected.asset &&
            document.get('art').assets.find((item) => item.id === expected.asset)?.file === asset.file;
        });
        work.retain([asset.file]);
        return expected.asset;
      }, async (work, asset) => {
        const bake = await work.wait(() => projection.enemyClips(asset));
        work.check();
        if (bake instanceof ProjectError) throw bake;
        return {
          command: () => {
            // Merge the clips only after their bake, then guard that exact entry in the command.
            const current = document.get('enemies')[speciesValue];
            if (current?.type !== 'model' || current.asset !== asset) {
              throw new ProjectError(`The ${speciesValue}'s model changed while its clips were baked.`, { section: 'enemies' });
            }
            const model = modelArt(speciesValue, current.asset, { ...current.clips, ...clips }, bake);
            return commands.enemyClips(speciesValue, current, model, request.info);
          },
          value: () => undefined,
        };
      });
    },
    library(roleValue, input, request) {
      return edit(request, 'models', () => {
        role(roleValue);
        cheapSize(input, MODEL_LIMITS.bytes, 'models');
        if (document.get('models')[roleValue].length >= MODEL_LIBRARY_LIMITS.entries) {
          throw new ProjectError(`The ${roleValue} library lists at most ${MODEL_LIBRARY_LIMITS.entries} models.`, { section: 'models' });
        }
      }, async (work) => {
        const file = await read(work, input, MODEL_LIMITS.bytes, 'models');
        const report = await libraryReport(work, file, roleValue);
        work.check();
        const handle = await work.stage(file);
        work.check();
        let model = request.model;
        if (roleValue === 'avatar' && model === undefined) {
          const proposed = suggestAvatarBoneMap(report);
          const configure = request.configure;
          model = configure === undefined
            ? mappedAvatarModel(validateAvatarBoneMap(Object.fromEntries(AVATAR_JOINT_IDS.map((joint) => [joint, proposed[joint] ?? null]))))
            : await work.wait(() => configure(report, proposed, work.signal));
          work.check();
        }
        const configured = model;
        let id: string | null = null;
        return {
          command: () => {
            const base = libraryBase(roleValue, input.name);
            id = base.id;
            if (roleValue === 'avatar') {
              if (configured === undefined) throw new Error('An imported avatar must have model settings.');
              const settings = withHoldSettings(configured);
              checkAvatarModelSettings(report, settings, options.avatarRigs);
              const entry: LibraryAvatarEntry = Object.freeze({ ...base, ...settings });
              return commands.libraryAdd({ role: 'avatar', model: Object.freeze({ entry, file: handle }) }, request.info);
            }
            if (roleValue === 'hammer') {
              const entry: LibraryHammerEntry = Object.freeze({ ...base, head: document.get('settings').rig.head });
              return commands.libraryAdd({ role: 'hammer', model: Object.freeze({ entry, file: handle }) }, request.info);
            }
            return commands.libraryAdd({ role: 'pot', model: Object.freeze({ entry: base, file: handle }) }, request.info);
          },
          value: () => {
            const added = projection.libraryModels().find((value) => value.role === roleValue && value.id === id);
            if (added === undefined) throw new Error('The imported library model was not projected.');
            return added;
          },
        };
      });
    },
    libraryAvatar(id, settings, request) {
      return edit(request, 'models', (work) => {
        const value = validateAvatarSettings(settings as unknown as Record<string, unknown>);
        return { expected: avatarTarget(work, id), settings: value };
      }, async (work, { expected, settings }) => {
        const report = await avatarReport(work, id);
        work.check();
        const entry: LibraryAvatarEntry = Object.freeze({ id, name: expected.entry.name, ...settings });
        checkAvatarModelSettings(report, entry, options.avatarRigs);
        return { command: () => commands.libraryAvatar(id, expected, entry, request.info), value: () => undefined };
      });
    },
    useCharacterSettings(id, request) {
      return edit(request, 'models', (work) => avatarTarget(work, id), async (work, expected) => {
        const report = await avatarReport(work, id);
        work.check();
        return {
          command: () => {
            const current = avatar(id);
            if (current !== expected) throw new ProjectError(`Library avatar "${id}" changed while its model was checked.`, { section: 'models' });
            const settings = withHoldSettings(libraryAvatarSettings(current.entry));
            const entry: LibraryAvatarEntry = Object.freeze({ id, name: current.entry.name, ...settings });
            checkAvatarModelSettings(report, entry, options.avatarRigs);
            return commands.libraryAvatar(id, current, entry, request.info);
          },
          value: () => undefined,
        };
      });
    },
    alternate(input, request) {
      return edit(request, 'characters/alternate', (work) => {
        cheapSize(input, SPRITE_FILE_BYTES, 'characters/alternate');
        const expected = document.get('characters/alternate');
        work.target('characters/alternate', ['characters/alternate'], () => document.get('characters/alternate') === expected);
      }, async (work) => {
        const file = await read(work, input, SPRITE_FILE_BYTES, 'characters/alternate');
        const text = await work.wait(() => file.text());
        work.check();
        const alternate = parseProjectCharacter(text);
        return { command: () => commands.alternate(alternate, request.info), value: () => undefined };
      });
    },
    coursePackage(input, request) {
      return edit(request, 'art', (work) => {
        cheapSize(input, ART_LIMITS.packageBytes, 'art');
        prepareLevel();
        work.target('course-package');
      }, async (work) => {
        const file = await read(work, input, ART_LIMITS.packageBytes, 'art');
        const text = await work.wait(() => file.text());
        work.check();
        const pack = validateCoursePackage(JSON.parse(text));
        const assets: DocumentArtAsset[] = [];
        for (const asset of pack.assets) {
          work.check();
          const bytes = embeddedGlb(asset.source);
          validateArtAsset(bytes.buffer, 'course');
          const handle = await work.stage(new Blob([bytes], { type: 'model/gltf-binary' }));
          work.check();
          if (assetId(handle) !== asset.id) throw new ProjectError(`Packaged artwork ${asset.id} does not match its GLB.`, { section: 'art' });
          assets.push(Object.freeze({ id: asset.id, name: asset.name, file: handle }));
        }
        checkFileBudget('art', assets.reduce((sum, asset) => sum + asset.file.bytes, 0));
        work.check();
        prepareLevel();
        work.check();
        return {
          command: () => commands.coursePackage({ level: pack.level, art: Object.freeze({ assets: Object.freeze(assets), decorations: pack.decorations }) }, request.info),
          value: () => undefined,
        };
      });
    },
    sections(read, request) {
      return edit(request, 'level', (work) => work.target('sections'), async (work) => {
        const values = await work.wait(() => read(work.signal));
        work.check();
        await checkSections(work, values);
        work.check();
        if (values.level !== undefined) prepareLevel();
        work.check();
        return { command: () => commands.sections(values, request.info), value: () => undefined };
      });
    },
    // The runner's: every import of the project stops, the character's and the appearance's too.
    invalidateProject(): void {
      if (!lifecycle.signal.aborted) runner.invalidateProject();
    },
    dispose(): void {
      lifecycle.abort();
    },
  };
  return Object.freeze(imports);
}
