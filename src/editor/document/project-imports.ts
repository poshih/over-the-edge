import { ART_LIMITS, artName } from '../../art-types';
import type { AvatarRigRegistry } from '../../avatar-rig';
import { inspectCharacterModel, suggestAvatarBoneMap } from '../../character-model-inspect';
import type { CharacterModelReport } from '../../character-model-inspect';
import { AVATAR_JOINT_IDS, validateAvatarBoneMap } from '../../character-profile';
import type { AvatarModelSettings, PartialAvatarBoneMap } from '../../character-profile';
import { embeddedGlb, validateCoursePackage } from '../../course-package';
import { Disposal } from '../../disposal';
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
  AvatarHoldSettings, LibraryAvatarEntry, LibraryAvatarSettings, LibraryEntry, LibraryHammerEntry, PartRole,
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
import type { Command, History, PendingEdit } from './history';
import type { ProjectCommandInfo, ProjectCommands, ProjectRefusal } from './project-commands';
import type {
  DocumentArtAsset, DocumentModel, SectionName, SectionValues,
} from './project-document';
import type { LibraryModel, ProjectBake, ProjectProjection } from './project-projection';
import { adapterFor, SECTION_ADAPTERS } from './sections';

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

type ImportSection = 'settings' | 'media' | 'art' | 'enemies' | 'models' | 'characters/alternate' | 'level';

interface TargetGuard {
  readonly job: ImportJob;
  readonly sections: readonly SectionName[];
  readonly unchanged: () => boolean;
}

interface ImportJob {
  readonly controller: AbortController;
  readonly generation: number;
  readonly releases: Set<() => void>;
  readonly keys: Set<string>;
  readonly guards: Set<TargetGuard>;
  pending: PendingEdit | null;
  finishing: boolean;
  ended: boolean;
  cancellationQueued: boolean;
}

interface Ready<T> {
  readonly command: () => Command;
  readonly value: () => T;
}

class CancelledImport extends Error {}

const CANCELLED = Object.freeze({ kind: 'cancelled' } as const);
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

function commandRefusal(error: Error): ProjectRefusal {
  if (error instanceof LevelError || error instanceof GameSettingsError || error instanceof ProjectError ||
    error instanceof SpriteError || error instanceof PluginError) return error;
  throw error;
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

export function createProjectImports(options: {
  readonly history: History;
  readonly commands: ProjectCommands;
  readonly files: FileStore;
  readonly projection: ProjectProjection;
  readonly avatarRigs: AvatarRigRegistry;
  readonly prepareLevel: () => boolean;
  readonly holdSettings: () => AvatarHoldSettings;
}): ProjectImports {
  const { history, commands, files, projection } = options;
  const document = history.document;
  const jobs = new Set<ImportJob>();
  const targets = new Map<string, ImportJob>();
  const watched = new Map<SectionName, Set<TargetGuard>>();
  const leases = new Set<() => void>();
  let generation = 0;
  let disposed = false;

  function owned(release: () => void): () => void {
    let released = false;
    const done = (): void => {
      if (released) return;
      released = true;
      leases.delete(done);
      release();
    };
    leases.add(done);
    return done;
  }

  function retain(job: ImportJob, handles: readonly FileHandle[]): void {
    job.releases.add(owned(files.retain(handles, 'work')));
  }

  function cancelPending(job: ImportJob): void {
    if (!job.finishing && job.pending !== null && !job.pending.done) job.pending.cancel();
  }

  function stop(job: ImportJob): void {
    if (!job.controller.signal.aborted) job.controller.abort();
  }

  function live(job: ImportJob): void {
    if (disposed || job.ended || job.generation !== generation || job.controller.signal.aborted ||
      (job.pending !== null && job.pending.done && !job.finishing)) throw new CancelledImport();
    for (const guard of job.guards) {
      if (guard.unchanged()) continue;
      stop(job);
      throw new CancelledImport();
    }
  }

  function watch(job: ImportJob, sections: readonly SectionName[], unchanged: () => boolean): void {
    const guard: TargetGuard = { job, sections, unchanged };
    job.guards.add(guard);
    for (const section of sections) {
      let guards = watched.get(section);
      if (guards === undefined) { guards = new Set(); watched.set(section, guards); }
      guards.add(guard);
    }
  }

  function target(job: ImportJob, key: string, sections: readonly SectionName[] = [], unchanged?: () => boolean): void {
    const previous = targets.get(key);
    if (previous !== undefined && previous !== job) stop(previous);
    targets.set(key, job);
    job.keys.add(key);
    if (unchanged !== undefined) watch(job, sections, unchanged);
  }

  function stopTargets(prefix: string): void {
    const previous = new Set<ImportJob>();
    for (const [key, job] of targets) if (key.startsWith(prefix)) previous.add(job);
    for (const job of previous) stop(job);
  }

  // Native blob reads and shared bakes can settle late; cancellation never resumes their edit.
  function wait<T>(job: ImportJob, run: () => Promise<T>): Promise<T> {
    live(job);
    const task = run();
    const signal = job.controller.signal;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        run();
      };
      const aborted = (): void => finish(() => reject(new CancelledImport()));
      signal.addEventListener('abort', aborted, { once: true });
      task.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
      if (signal.aborted) aborted();
    });
  }

  function prepareLevel(): void {
    if (!options.prepareLevel()) {
      throw new ProjectError('Finish or cancel the unfinished outline, and fix any trigger events, in Level first.', { section: 'level' });
    }
  }

  function close(job: ImportJob, owner: AbortSignal, ownerAborted: () => void, aborted: () => void): void {
    job.ended = true;
    jobs.delete(job);
    for (const key of job.keys) if (targets.get(key) === job) targets.delete(key);
    for (const guard of job.guards) {
      for (const section of guard.sections) {
        const guards = watched.get(section);
        guards?.delete(guard);
        if (guards?.size === 0) watched.delete(section);
      }
    }
    const disposal = new Disposal();
    disposal.run(() => cancelPending(job));
    disposal.run(() => owner.removeEventListener('abort', ownerAborted));
    disposal.run(() => job.controller.signal.removeEventListener('abort', aborted));
    for (const release of job.releases) disposal.run(release);
    job.releases.clear();
    disposal.finish();
  }

  async function edit<T, P>(
    input: ImportOptions,
    section: ImportSection,
    start: (job: ImportJob) => P,
    build: (job: ImportJob, prepared: P) => Promise<Ready<T>>,
  ): Promise<EditOutcome<T>> {
    if (disposed || input.signal.aborted) return CANCELLED;
    const job: ImportJob = {
      controller: new AbortController(), generation, releases: new Set(), keys: new Set(), guards: new Set(),
      pending: null, finishing: false, ended: false, cancellationQueued: false,
    };
    const ownerAborted = (): void => stop(job);
    const aborted = (): void => {
      if (job.ended || job.cancellationQueued) return;
      job.cancellationQueued = true;
      queueMicrotask(() => {
        job.cancellationQueued = false;
        if (!job.ended) cancelPending(job);
      });
    };
    jobs.add(job);
    input.signal.addEventListener('abort', ownerAborted, { once: true });
    job.controller.signal.addEventListener('abort', aborted, { once: true });
    let outcome: EditOutcome<T> | null = null;
    let failure: { readonly error: unknown } | null = null;
    try {
      const prepared = start(job);
      live(job);
      job.pending = history.prepare({
        ...input.info,
        cancelled: () => { if (!job.finishing) stop(job); },
      });
      live(job);
      const ready = await build(job, prepared);
      live(job);
      let changed = false;
      let command: Command | null = null;
      const preparedCommand = (): Command => {
        live(job);
        if (command === null) command = ready.command();
        return command;
      };
      job.finishing = true;
      let error: Error | null;
      try {
        error = job.pending.finish({
          // The factory reads after finish commits any transaction, with no async gap before run.
          get label() { return preparedCommand().label; },
          get place() { return preparedCommand().place; },
          get coalesce() { return preparedCommand().coalesce; },
          run(current) {
            live(job);
            const changes = preparedCommand().run(current);
            live(job);
            changed = changes.some((change) => change.before !== change.after);
            return changes;
          },
        });
      } finally {
        job.finishing = false;
      }
      outcome = error === null
        ? Object.freeze({ kind: changed ? 'applied' : 'unchanged', value: ready.value() })
        : Object.freeze({ kind: 'refused', error: commandRefusal(error) });
      return outcome;
    } catch (error) {
      if (error instanceof CancelledImport || (!(error instanceof PluginError) &&
        (job.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')))) {
        outcome = CANCELLED;
      } else {
        try {
          outcome = Object.freeze({ kind: 'refused', error: refusal(error, section) });
        } catch (unexpected) {
          failure = { error: unexpected };
          throw unexpected;
        }
      }
      return outcome;
    } finally {
      const disposal = new Disposal();
      const failed = failure;
      if (failed !== null) disposal.run(() => { throw failed.error; });
      if (outcome === null || outcome.kind === 'cancelled' || outcome.kind === 'refused') disposal.run(() => stop(job));
      disposal.run(() => close(job, input.signal, ownerAborted, aborted));
      disposal.finish();
    }
  }

  async function read(job: ImportJob, input: FileInput, limit: number, section: ImportSection): Promise<File> {
    live(job);
    const file = 'read' in input ? await wait(job, () => input.read(job.controller.signal)) : input;
    live(job);
    size(file, limit, section);
    return file;
  }

  async function stage(job: ImportJob, blob: Blob): Promise<FileHandle> {
    live(job);
    return wait(job, () => files.stagePage(blob, job.controller.signal).then((staged) => {
      if (job.ended || job.controller.signal.aborted || disposed) {
        staged.release();
        throw new CancelledImport();
      }
      job.releases.add(owned(() => staged.release()));
      return staged.handle;
    }));
  }

  function assetId(file: FileHandle): string {
    const sha256 = files.locations(file).sha256;
    if (sha256 === null) throw new Error('A checked page file must have a digest.');
    return `asset-${sha256}`;
  }

  function bake<T>(job: ImportJob, prepare: () => ProjectBake<T>): Promise<T> {
    return wait(job, () => {
      const held = prepare();
      const release = owned(() => held.release());
      const signal = job.controller.signal;
      signal.addEventListener('abort', release, { once: true });
      job.releases.add(owned(() => {
        signal.removeEventListener('abort', release);
        release();
      }));
      if (signal.aborted) release();
      return held.promise;
    });
  }

  function avatar(id: string): DocumentModel<LibraryAvatarEntry> {
    libraryModelId(id);
    const model = document.get('models').avatar.find((candidate) => candidate.entry.id === id);
    if (model === undefined) throw new ProjectError(`The project has no library avatar "${id}".`, { section: 'models' });
    return model;
  }

  function avatarTarget(job: ImportJob, id: string): DocumentModel<LibraryAvatarEntry> {
    const expected = avatar(id);
    target(job, `models/avatar/${id}`, ['models'],
      () => document.get('models').avatar.find((model) => model.entry.id === id) === expected);
    retain(job, [expected.file]);
    return expected;
  }

  async function avatarReport(job: ImportJob, id: string): Promise<CharacterModelReport> {
    const blob = await wait(job, () => projection.libraryBlob('avatar', id, job.controller.signal));
    const bytes = await wait(job, () => blob.arrayBuffer());
    live(job);
    return inspectCharacterModel(bytes, 'avatar');
  }

  async function libraryReport(job: ImportJob, file: File, role: PartRole): Promise<CharacterModelReport> {
    const bytes = await wait(job, () => file.arrayBuffer());
    live(job);
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

  function characterHoldSettings(model: AvatarModelSettings): LibraryAvatarSettings {
    return validateAvatarSettings({ ...model, ...options.holdSettings() });
  }

  async function checkSections(job: ImportJob, values: Partial<SectionValues>): Promise<void> {
    if (values.art !== undefined) {
      if (values.art.assets.length > ART_LIMITS.assets) throw new ProjectError('The restored artwork has too many assets.', { section: 'art' });
      checkFileBudget('art', values.art.assets.reduce((sum, asset) => sum + asset.file.bytes, 0));
    }
    if (values.media !== undefined) {
      if (values.media.length > MEDIA_LIMITS.files) throw new ProjectError('The restored media library has too many files.', { section: 'media' });
      checkFileBudget('media', values.media.reduce((sum, item) => sum + item.file.bytes, 0));
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
    retain(job, [...handles]);

    for (const role of PART_ROLES) {
      for (const model of values.models?.[role] ?? []) {
        const current = document.get('models')[role].find((item) => item.entry.id === model.entry.id);
        if (current !== undefined && current.file === model.file && current.entry === model.entry) continue;
        const blob = await wait(job, () => files.blob(model.file, job.controller.signal));
        const bytes = await wait(job, () => blob.arrayBuffer());
        live(job);
        checked('models', () => {
          const report = inspectCharacterModel(bytes, role);
          if (role === 'avatar') checkAvatarModelSettings(report, model.entry as LibraryAvatarEntry, options.avatarRigs);
        });
      }
    }
    for (const item of values.media ?? []) {
      if (document.get('media').some((current) => current.path === item.path && current.file === item.file)) continue;
      const blob = await wait(job, () => files.blob(item.file, job.controller.signal));
      size(blob, MEDIA_LIMITS.bytes, 'media');
      const bytes = await wait(job, () => blob.slice(0, 64).arrayBuffer());
      live(job);
      checked('media', () => checkMediaBytes(item.path, new Uint8Array(bytes)));
    }
    if (values.art === undefined && values.enemies === undefined) return;

    const currentLevel = document.get('level');
    const currentArt = document.get('art');
    const currentEnemies = document.get('enemies');
    if (values.level === undefined) watch(job, ['level'], () => document.get('level') === currentLevel);
    if (values.art === undefined) watch(job, ['art'], () => document.get('art') === currentArt);
    if (values.enemies === undefined) watch(job, ['enemies'], () => document.get('enemies') === currentEnemies);
    const art = values.art ?? currentArt;
    const enemies = values.enemies ?? currentEnemies;
    const level = values.level ?? currentLevel;
    const courses = new Set([...terrainAssets(level), ...Object.values(art.decorations)]);
    const drawn = enemyArtAssets(enemies, SPECIES);
    const oldCourses = new Set([...terrainAssets(currentLevel), ...Object.values(currentArt.decorations)]);
    const oldDrawn = enemyArtAssets(currentEnemies, SPECIES);
    const blobs = new Map<FileHandle, Blob>();
    retain(job, art.assets.map((asset) => asset.file));
    const blobFor = async (file: FileHandle): Promise<Blob> => {
      live(job);
      const existing = blobs.get(file);
      if (existing !== undefined) return existing;
      const blob = await wait(job, () => files.blob(file, job.controller.signal));
      live(job);
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
      const bytes = await wait(job, () => blob.arrayBuffer());
      live(job);
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
      const result = await bake(job, () => projection.bakeEnemy(asset.file, blob));
      live(job);
      checkMotion(species, entry, result);
    }
  }

  const unsubscribe = document.subscribeAll((changes) => {
    const guards = new Set<TargetGuard>();
    for (const change of changes) for (const guard of watched.get(change.section) ?? []) guards.add(guard);
    for (const guard of guards) {
      if (guard.job.ended || guard.job.finishing || guard.job.pending?.done) continue;
      if (!guard.unchanged()) stop(guard.job);
    }
  });

  function invalidate(): void {
    generation++;
    const disposal = new Disposal();
    for (const job of jobs) {
      disposal.run(() => stop(job));
      disposal.run(() => cancelPending(job));
    }
    disposal.finish();
  }

  const imports: ProjectImports = {
    settings(input, request) {
      return edit(request, 'settings', (job) => {
        cheapSize(input, GAME_SETTINGS_LIMITS.fileBytes, 'settings');
        const expected = document.get('settings');
        target(job, 'settings', ['settings'], () => document.get('settings') === expected);
      }, async (job) => {
        const file = await read(job, input, GAME_SETTINGS_LIMITS.fileBytes, 'settings');
        const text = await wait(job, () => file.text());
        live(job);
        const settings = validateGameSettings(JSON.parse(text));
        return { command: () => commands.settings(() => settings, request.info), value: () => undefined };
      });
    },
    serverSettings(name, read, request) {
      return edit(request, 'settings', (job) => {
        if (name.length === 0) throw new GameSettingsError('Choose a server settings copy.');
        const expected = document.get('settings');
        target(job, 'settings', ['settings'], () => document.get('settings') === expected);
      }, async (job) => {
        const value = await wait(job, () => read(job.controller.signal));
        live(job);
        const settings = validateGameSettings(value);
        return { command: () => commands.settings(() => settings, request.info), value: () => undefined };
      });
    },
    media(input, request) {
      return edit(request, 'media', (job) => {
        cheapSize(input, MEDIA_LIMITS.bytes, 'media');
        const path = mediaPathForFile(input.name);
        if (path === null) throw new ProjectError('Choose a .webm, .mp4, .mp3, .ogg, .wav or .m4a file with a letter or digit in its name.', { section: 'media' });
        const expected = document.get('media').find((item) => item.path === path);
        target(job, `media${path}`, ['media'], () => document.get('media').find((item) => item.path === path) === expected);
        return path;
      }, async (job, path) => {
        const file = await read(job, input, MEDIA_LIMITS.bytes, 'media');
        const bytes = await wait(job, () => file.slice(0, 64).arrayBuffer());
        live(job);
        checkMediaBytes(path, new Uint8Array(bytes));
        const handle = await stage(job, file);
        live(job);
        return { command: () => commands.mediaAdd(Object.freeze({ path, file: handle }), request.info), value: () => path };
      });
    },
    courseMesh(input, request) {
      return edit(request, 'art', () => cheapSize(input, ART_LIMITS.bytes, 'art'), async (job) => {
        const file = await read(job, input, ART_LIMITS.bytes, 'art');
        const handle = await stage(job, file);
        live(job);
        const id = assetId(handle);
        const baked = await bake(job, () => projection.bakeMesh(handle, 0, file));
        live(job);
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
      return edit(request, 'enemies', (job) => {
        species(speciesValue);
        cheapSize(input, ART_LIMITS.bytes, 'art');
        const expected = document.get('enemies')[speciesValue];
        stopTargets(`enemies/${speciesValue}/`);
        target(job, `enemies/${speciesValue}/model`, ['enemies'], () => document.get('enemies')[speciesValue] === expected);
      }, async (job) => {
        const file = await read(job, input, ART_LIMITS.bytes, 'art');
        const handle = await stage(job, file);
        live(job);
        const id = assetId(handle);
        const result = await bake(job, () => projection.bakeEnemy(handle, file));
        live(job);
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
      return edit(request, 'enemies', (job) => {
        species(speciesValue);
        const expected = document.get('enemies')[speciesValue];
        if (expected?.type !== 'model') throw new ProjectError(`The ${speciesValue} is not drawn by a model.`, { section: 'enemies' });
        const roles = Object.keys(clips);
        if (roles.some((role) => !SPECIES_CLIP_ROLES[speciesValue].includes(role as EnemyClipRole))) {
          throw new ProjectError(`Choose only the ${speciesValue}'s own clip roles.`, { section: 'enemies' });
        }
        const asset = document.get('art').assets.find((asset) => asset.id === expected.asset);
        if (asset === undefined) throw new ProjectError(`The ${speciesValue}'s model is missing from the course artwork.`, { section: 'enemies' });
        const modelImport = targets.get(`enemies/${speciesValue}/model`);
        if (modelImport !== undefined) stop(modelImport);
        for (const role of roles) target(job, `enemies/${speciesValue}/clips/${role}`);
        watch(job, ['enemies', 'art'], () => {
          const current = document.get('enemies')[speciesValue];
          return current?.type === 'model' && current.asset === expected.asset &&
            document.get('art').assets.find((item) => item.id === expected.asset)?.file === asset.file;
        });
        retain(job, [asset.file]);
        return expected.asset;
      }, async (job, asset) => {
        const bake = await wait(job, () => projection.enemyClips(asset));
        live(job);
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
      }, async (job) => {
        const file = await read(job, input, MODEL_LIMITS.bytes, 'models');
        const report = await libraryReport(job, file, roleValue);
        live(job);
        const handle = await stage(job, file);
        live(job);
        let model = request.model;
        if (roleValue === 'avatar' && model === undefined) {
          const proposed = suggestAvatarBoneMap(report);
          const configure = request.configure;
          model = configure === undefined
            ? mappedAvatarModel(validateAvatarBoneMap(Object.fromEntries(AVATAR_JOINT_IDS.map((joint) => [joint, proposed[joint] ?? null]))))
            : await wait(job, () => configure(report, proposed, job.controller.signal));
          live(job);
        }
        const configured = model;
        let id: string | null = null;
        return {
          command: () => {
            const base = libraryBase(roleValue, input.name);
            id = base.id;
            if (roleValue === 'avatar') {
              if (configured === undefined) throw new Error('An imported avatar must have model settings.');
              const settings = characterHoldSettings(configured);
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
      return edit(request, 'models', (job) => {
        const value = validateAvatarSettings(settings as unknown as Record<string, unknown>);
        return { expected: avatarTarget(job, id), settings: value };
      }, async (job, { expected, settings }) => {
        const report = await avatarReport(job, id);
        live(job);
        const entry: LibraryAvatarEntry = Object.freeze({ id, name: expected.entry.name, ...settings });
        checkAvatarModelSettings(report, entry, options.avatarRigs);
        return { command: () => commands.libraryAvatar(id, expected, entry, request.info), value: () => undefined };
      });
    },
    useCharacterSettings(id, request) {
      return edit(request, 'models', (job) => avatarTarget(job, id), async (job, expected) => {
        const report = await avatarReport(job, id);
        live(job);
        return {
          command: () => {
            const current = avatar(id);
            if (current !== expected) throw new ProjectError(`Library avatar "${id}" changed while its model was checked.`, { section: 'models' });
            const settings = characterHoldSettings(libraryAvatarSettings(current.entry));
            const entry: LibraryAvatarEntry = Object.freeze({ id, name: current.entry.name, ...settings });
            checkAvatarModelSettings(report, entry, options.avatarRigs);
            return commands.libraryAvatar(id, current, entry, request.info);
          },
          value: () => undefined,
        };
      });
    },
    alternate(input, request) {
      return edit(request, 'characters/alternate', (job) => {
        cheapSize(input, SPRITE_FILE_BYTES, 'characters/alternate');
        const expected = document.get('characters/alternate');
        target(job, 'characters/alternate', ['characters/alternate'], () => document.get('characters/alternate') === expected);
      }, async (job) => {
        const file = await read(job, input, SPRITE_FILE_BYTES, 'characters/alternate');
        const text = await wait(job, () => file.text());
        live(job);
        const alternate = parseProjectCharacter(text);
        return { command: () => commands.alternate(alternate, request.info), value: () => undefined };
      });
    },
    coursePackage(input, request) {
      return edit(request, 'art', (job) => {
        cheapSize(input, ART_LIMITS.packageBytes, 'art');
        prepareLevel();
        target(job, 'course-package');
      }, async (job) => {
        const file = await read(job, input, ART_LIMITS.packageBytes, 'art');
        const text = await wait(job, () => file.text());
        live(job);
        const pack = validateCoursePackage(JSON.parse(text));
        const assets: DocumentArtAsset[] = [];
        for (const asset of pack.assets) {
          live(job);
          const bytes = embeddedGlb(asset.source);
          validateArtAsset(bytes.buffer, 'course');
          const handle = await stage(job, new Blob([bytes], { type: 'model/gltf-binary' }));
          live(job);
          if (assetId(handle) !== asset.id) throw new ProjectError(`Packaged artwork ${asset.id} does not match its GLB.`, { section: 'art' });
          assets.push(Object.freeze({ id: asset.id, name: asset.name, file: handle }));
        }
        checkFileBudget('art', assets.reduce((sum, asset) => sum + asset.file.bytes, 0));
        live(job);
        prepareLevel();
        live(job);
        return {
          command: () => commands.coursePackage({ level: pack.level, art: Object.freeze({ assets: Object.freeze(assets), decorations: pack.decorations }) }, request.info),
          value: () => undefined,
        };
      });
    },
    sections(read, request) {
      return edit(request, 'level', (job) => target(job, 'sections'), async (job) => {
        const values = await wait(job, () => read(job.controller.signal));
        live(job);
        await checkSections(job, values);
        live(job);
        if (values.level !== undefined) prepareLevel();
        live(job);
        return { command: () => commands.sections(values, request.info), value: () => undefined };
      });
    },
    invalidateProject(): void {
      if (!disposed) invalidate();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const disposal = new Disposal();
      disposal.run(unsubscribe);
      disposal.run(invalidate);
      for (const release of leases) disposal.run(release);
      disposal.finish();
    },
  };
  return Object.freeze(imports);
}
