import { audioSources, validateAudio } from '../../audio-settings';
import type { AudioSettings } from '../../audio-settings';
import type { AvatarRigRegistry } from '../../avatar-rig';
import { checkEmbeddedCharacterModels } from '../../character-model-check';
import { ART_LIMITS } from '../../art-types';
import { ENEMY_SPECIES } from '../../enemy-types';
import type { EnemySpecies } from '../../enemy-types';
import { enemyArtAssets, validateEnemyArt } from '../../enemy-art-data';
import type { EnemyArtSettings, ModelArt } from '../../enemy-art-data';
import { GameSettingsError, validateGameSettings, withRig } from '../../game-settings';
import type { GameSettings } from '../../game-settings';
import type { HammerHead } from '../../hammer-head';
import { validateHud } from '../../hud';
import type { HudSettings } from '../../hud';
import { LevelError } from '../../level';
import type { LevelDefinition } from '../../level';
import { MEDIA_LIMITS } from '../../media';
import { MODEL_LIMITS, ModelError as AppearanceError } from '../../model-data';
import { isPartRole, libraryHammerHead, libraryModelId, PART_ROLES, validateModelLibrary } from '../../model-library';
import type { LibraryAvatarEntry, LibraryEntry, LibraryHammerEntry, PartRole } from '../../model-library';
import { isPluginId, PLUGIN_DATA_LIMITS, pluginOfSection, pluginSection, validatePluginData } from '../../plugin-data';
import type { PluginData } from '../../plugin-data';
import { PluginError } from '../../plugins/kernel';
import type { PotOutline } from '../../pot-outline';
import {
  checkFileBudget, checkProjectReferences, defaultProjectManifest, inSection, isProjectDataError, ProjectError,
  projectTitle, validateMediaIndex, validateProjectArt, validateProjectCharacter,
} from '../../project';
import { exactRecord } from '../../project-fields';
import type { SpriteDocument } from '../../sprite-data';
import { SpriteError } from '../../sprite-fields';
import { validateTheme } from '../../theme';
import type { GameTheme } from '../../theme';
import type { LevelState } from '../level-state';
import type { FileHandle, FileStore } from './files';
import type { Command, History } from './history';
import type {
  DocumentArt, DocumentArtAsset, DocumentMedia, DocumentMediaFile, DocumentModel, DocumentModels, FrozenPluginData,
  ProjectDocument, SectionName, SectionValue, SectionValues, SomeSectionChange, StepInfo,
} from './project-document';
import { adapterFor, SECTION_ADAPTERS } from './sections';
import type { AppearanceCommands, CharacterCommands } from './visual-contract';

export const UNTITLED_GAME_TITLE = 'Untitled game';

export type ProjectRefusal = LevelError | GameSettingsError | ProjectError | SpriteError | PluginError | AppearanceError;

export interface ProjectPlugins {
  has(id: string): boolean;
  validate(id: string, data: PluginData): PluginError | null;
}

export interface ProjectCommandInfo extends StepInfo {
  readonly coalesce: string | null;
}

export interface ProjectCommands {
  title(value: unknown, info: ProjectCommandInfo): Command;
  settings(build: (current: GameSettings) => unknown, info: ProjectCommandInfo): Command;
  theme(build: (current: GameTheme) => unknown, info: ProjectCommandInfo): Command;
  hud(build: (current: HudSettings) => unknown, info: ProjectCommandInfo): Command;
  audio(build: (current: AudioSettings) => unknown, info: ProjectCommandInfo): Command;
  enemies(value: unknown, info: ProjectCommandInfo): Command;
  mediaAdd(value: DocumentMediaFile, info: ProjectCommandInfo): Command;
  mediaRemove(path: string, info: ProjectCommandInfo): Command;
  courseMeshAdd(value: DocumentArtAsset, info: ProjectCommandInfo): Command;
  courseMeshRemove(id: string, info: ProjectCommandInfo): Command;
  enemyModel(value: {
    readonly species: EnemySpecies;
    readonly asset: DocumentArtAsset;
    readonly model: ModelArt;
  }, info: ProjectCommandInfo): Command;
  enemyClips(species: EnemySpecies, expected: ModelArt, model: ModelArt, info: ProjectCommandInfo): Command;
  libraryAdd(value:
    | { readonly role: 'avatar'; readonly model: DocumentModel<LibraryAvatarEntry> }
    | { readonly role: 'hammer'; readonly model: DocumentModel<LibraryHammerEntry> }
    | { readonly role: 'pot'; readonly model: DocumentModel<LibraryEntry> },
  info: ProjectCommandInfo): Command;
  libraryRemove(role: PartRole, id: string, info: ProjectCommandInfo): Command;
  libraryAvatar(id: string, expected: DocumentModel<LibraryAvatarEntry>, entry: LibraryAvatarEntry, info: ProjectCommandInfo): Command;
  libraryHammerHead(id: string, before: HammerHead, after: HammerHead, info: ProjectCommandInfo): Command;
  defaultHammerHead(before: HammerHead, after: HammerHead, info: ProjectCommandInfo): Command;
  pot(before: PotOutline, after: PotOutline, info: ProjectCommandInfo): Command;
  alternate(value: SpriteDocument | null, info: ProjectCommandInfo): Command;
  // The primary character's exact profile as the alternate.
  currentAsAlternate(info: ProjectCommandInfo): Command;
  // The primary and alternate characters trade their exact profiles in one step.
  swapCharacters(info: ProjectCommandInfo): Command;
  coursePackage(value: { readonly level: LevelDefinition; readonly art: DocumentArt }, info: ProjectCommandInfo): Command;
  pluginData(id: string, value: PluginData | null, info: ProjectCommandInfo): Command;
  sections(values: Partial<SectionValues>, info: ProjectCommandInfo): Command;
}

export interface ProjectCommandsOptions {
  readonly document: ProjectDocument;
  readonly level: LevelState;
  readonly files: FileStore;
  readonly plugins: ProjectPlugins;
  readonly avatarRigs: AvatarRigRegistry;
  readonly characterCommands: CharacterCommands;
  readonly appearanceCommands: AppearanceCommands;
  readonly levelSelection: () => readonly string[];
}

// For validators' frozen copies: reuses `current`'s equal branches, matched by key or index, and `current` if equal.
export function keep<T>(next: T, current: unknown): T;
export function keep(next: unknown, current: unknown): unknown {
  if (next === current) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(current)) return next;
    const entries = next.map((value: unknown, index) => keep(value, current[index]));
    if (entries.length === current.length && entries.every((value, index) => value === current[index])) return current;
    return entries.every((value, index) => value === next[index]) ? next : Object.freeze(entries);
  }
  if (typeof next !== 'object' || next === null || typeof current !== 'object' || current === null || Array.isArray(current)) return next;
  const keys = Object.keys(next);
  let equal = keys.length === Object.keys(current).length;
  let reused = false;
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const value: unknown = Reflect.get(next, key);
    const previous: unknown = Reflect.get(current, key);
    const retained = keep(value, previous);
    entries.push([key, retained]);
    if (!Object.hasOwn(current, key) || retained !== previous) equal = false;
    if (retained !== value) reused = true;
  }
  return equal ? current : reused ? Object.freeze(Object.fromEntries(entries)) : next;
}

function keepArray<T>(next: readonly T[], current: readonly T[]): readonly T[] {
  return next.length === current.length && next.every((value, index) => value === current[index]) ? current : Object.freeze(next);
}

function whole<S extends Exclude<SectionName, 'level'>>(document: ProjectDocument, section: S, after: SectionValue<S>): SomeSectionChange[] {
  const before = document.get(section);
  return before === after ? [] : [adapterFor(section).change(before, after) as SomeSectionChange];
}

// A refusal the history returned: every section's typed refusal is one of these.
export function isProjectRefusal(error: Error): error is ProjectRefusal {
  return error instanceof LevelError || error instanceof GameSettingsError || error instanceof ProjectError ||
    error instanceof SpriteError || error instanceof PluginError || error instanceof AppearanceError;
}

export function applyProjectCommand(history: History, command: Command): ProjectRefusal | null {
  const error = history.apply(command);
  if (error === null || isProjectRefusal(error)) return error;
  throw error;
}

export function createProjectCommands(options: ProjectCommandsOptions): ProjectCommands {
  const species = new Set(ENEMY_SPECIES);
  const checkedCharacters = new WeakSet<SpriteDocument>();
  // Only art, media, enemies and audio enter the project reference validator.
  const referenceBase = defaultProjectManifest(UNTITLED_GAME_TITLE);

  function command(info: ProjectCommandInfo, build: Command['run']): Command {
    return Object.freeze({
      label: info.label, place: info.place, coalesce: info.coalesce,
      run(document: ProjectDocument): readonly SomeSectionChange[] {
        if (document !== options.document) throw new Error('Project commands belong to their document.');
        return Object.freeze(build(document));
      },
    });
  }

  function references(document: ProjectDocument, next: {
    readonly level?: LevelDefinition;
    readonly art?: DocumentArt;
    readonly media?: DocumentMedia;
    readonly enemies?: EnemyArtSettings;
    readonly audio?: AudioSettings;
  }): void {
    const art = next.art ?? document.get('art');
    const media = next.media ?? document.get('media');
    checkProjectReferences({
      ...referenceBase,
      art: { assets: art.assets.map(({ id, name }) => ({ id, name })), decorations: art.decorations },
      media: media.map(({ path }) => ({ path })),
      enemies: next.enemies ?? document.get('enemies'),
      audio: next.audio ?? document.get('audio'),
    }, next.level ?? document.get('level'));
  }

  function file(value: FileHandle, section: 'art' | 'media' | 'models', limit: number): FileHandle {
    options.files.locations(value);
    if (!Object.isFrozen(value)) throw new Error('A document file handle must be frozen.');
    if (value.bytes < 1 || value.bytes > limit) {
      throw new ProjectError(`The ${section} file holds 1 byte to ${limit / 1024 ** 2} MiB.`, { section });
    }
    return value;
  }

  function artValue(value: DocumentArt, current: DocumentArt): DocumentArt {
    const data = exactRecord(value, ['assets', 'decorations'], 'Document artwork');
    if (!Array.isArray(data.assets) || data.assets.length > ART_LIMITS.assets) {
      throw new ProjectError(`Course artwork lists at most ${ART_LIMITS.assets} GLB assets.`, { section: 'art' });
    }
    const raw = data.assets.map((asset: unknown) => exactRecord(asset, ['id', 'name', 'file'], 'Document artwork asset'));
    const art = inSection('art', () => validateProjectArt({
      assets: raw.map(({ id, name }) => ({ id, name })), decorations: data.decorations,
    }));
    const previous = new Map(current.assets.map((asset) => [asset.id, asset]));
    const assets = keepArray(art.assets.map((asset, index) => {
      const handle = file(raw[index]!.file as FileHandle, 'art', ART_LIMITS.bytes);
      const before = previous.get(asset.id);
      return before !== undefined && before.name === asset.name && before.file === handle ? before : Object.freeze({ ...asset, file: handle });
    }), current.assets);
    checkFileBudget('art', assets.reduce((sum, asset) => sum + asset.file.bytes, 0));
    const decorations = keep(art.decorations, current.decorations);
    return assets === current.assets && decorations === current.decorations ? current : Object.freeze({ assets, decorations });
  }

  function mediaValue(value: DocumentMedia, current: DocumentMedia): DocumentMedia {
    if (!Array.isArray(value) || value.length > MEDIA_LIMITS.files) {
      throw new ProjectError(`The media library lists at most ${MEDIA_LIMITS.files} files.`, { section: 'media' });
    }
    const raw = value.map((item: unknown) => exactRecord(item, ['path', 'file'], 'Document media file'));
    const entries = inSection('media', () => validateMediaIndex(raw.map(({ path }) => ({ path }))));
    const previous = new Map(current.map((item) => [item.path, item]));
    const media = keepArray(entries.map(({ path }, index) => {
      const handle = file(raw[index]!.file as FileHandle, 'media', MEDIA_LIMITS.bytes);
      const before = previous.get(path);
      return before !== undefined && before.file === handle ? before : Object.freeze({ path, file: handle });
    }), current);
    checkFileBudget('media', media.reduce((sum, item) => sum + item.file.bytes, 0));
    return media;
  }

  function modelList<E extends LibraryEntry>(raw: readonly DocumentModel<E>[], entries: readonly E[],
    current: readonly DocumentModel<E>[]): readonly DocumentModel<E>[] {
    const previous = new Map(current.map((item) => [item.entry.id, item]));
    return keepArray(entries.map((value, index) => {
      const before = previous.get(value.id);
      const entry = keep(value, before?.entry);
      const handle = file(raw[index]!.file, 'models', MODEL_LIMITS.bytes);
      return before !== undefined && before.entry === entry && before.file === handle ? before : Object.freeze({ entry, file: handle });
    }), current);
  }

  function modelsValue(value: DocumentModels, current: DocumentModels): DocumentModels {
    exactRecord(value, PART_ROLES, 'Document model library');
    const entries = inSection('models', () => validateModelLibrary(Object.fromEntries(PART_ROLES.map((role) => {
      const items = value[role];
      if (!Array.isArray(items)) throw new ProjectError(`The ${role} library must be an array.`, { section: 'models' });
      return [role, items.map((item: unknown) => exactRecord(item, ['entry', 'file'], 'Document library model').entry)];
    }))));
    const avatar = modelList(value.avatar, entries.avatar, current.avatar);
    const hammer = modelList(value.hammer, entries.hammer, current.hammer);
    const pot = modelList(value.pot, entries.pot, current.pot);
    return avatar === current.avatar && hammer === current.hammer && pot === current.pot ? current : Object.freeze({ avatar, hammer, pot });
  }

  function alternateValue(value: SpriteDocument | null, current: SpriteDocument | null): SpriteDocument | null {
    if (value === null) return null;
    try {
      const after = keep(validateProjectCharacter(value), current);
      if (!checkedCharacters.has(after)) {
        checkEmbeddedCharacterModels(after, 'alternate character', options.avatarRigs);
        checkedCharacters.add(after);
      }
      return after;
    } catch (error) {
      if (error instanceof SpriteError || !isProjectDataError(error)) throw error;
      throw new SpriteError(error.message, { cause: error });
    }
  }

  function pluginValue(id: string, value: PluginData | null, current: FrozenPluginData | null): FrozenPluginData | null {
    if (!isPluginId(id)) throw new PluginError('invalid-contribution', `Invalid plugin data ID "${id}".`, id);
    if (value === null) return null;
    let bytes = 0;
    let data: PluginData;
    try { data = validatePluginData(id, value, (size) => { bytes = size; }); } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      throw new PluginError('invalid-contribution', error.message, id, null, { cause: error });
    }
    if (options.plugins.has(id)) {
      const refusal = options.plugins.validate(id, data);
      if (refusal !== null) throw refusal;
    }
    if (data === null) throw new Error('Non-null plugin data validated as null.');
    const retained = keep(data, current?.data);
    return current !== null && retained === current.data ? current : Object.freeze({ data: retained, bytes });
  }

  function pluginCount(document: ProjectDocument, changes: readonly SomeSectionChange[]): void {
    let count = document.sections().filter((section) => pluginOfSection(section) !== null).length;
    for (const change of changes) {
      if (pluginOfSection(change.section) === null) continue;
      count += Number(change.after !== null) - Number(change.before !== null);
    }
    if (count > PLUGIN_DATA_LIMITS.plugins) {
      throw new PluginError('too-many', `A project keeps data for at most ${PLUGIN_DATA_LIMITS.plugins} plugins.`);
    }
  }

  function droppedModels(before: EnemyArtSettings, after: EnemyArtSettings, assets: readonly DocumentArtAsset[]): readonly DocumentArtAsset[] {
    const drawn = enemyArtAssets(after, species);
    const dropped = new Set([...enemyArtAssets(before, species)].filter((id) => !drawn.has(id)));
    return dropped.size === 0 ? assets : Object.freeze(assets.filter((asset) => !dropped.has(asset.id)));
  }

  function enemyChanges(document: ProjectDocument, value: unknown, added?: DocumentArtAsset, allowModel = true): SomeSectionChange[] {
    const before = document.get('enemies');
    const enemies = keep(inSection('enemies', () => validateEnemyArt(value)), before);
    if (!allowModel) {
      for (const id of ENEMY_SPECIES) {
        if (enemies[id]?.type === 'model' && enemies[id] !== before[id]) {
          throw new ProjectError(`Import the ${id}'s 3D model in Enemy art, and choose its clips there.`, { section: 'enemies' });
        }
      }
    }
    const current = document.get('art');
    let assets = droppedModels(before, enemies, current.assets);
    if (added !== undefined) {
      const existing = assets.find((asset) => asset.id === added.id);
      assets = existing === undefined ? [...assets, added] : assets.map((asset) => asset.id === added.id ? added : asset);
    }
    const art = artValue({ assets, decorations: current.decorations }, current);
    references(document, { art, enemies });
    return [...whole(document, 'art', art), ...whole(document, 'enemies', enemies)];
  }

  function levelInfo(info: ProjectCommandInfo, level: LevelDefinition | undefined): ProjectCommandInfo {
    if (level === undefined || info.place.select !== null) return info;
    const before = [...options.levelSelection()];
    const ids = new Set(level.objects.map((object) => object.id));
    return { ...info, place: { ...info.place, select: { before, after: before.filter((id) => ids.has(id)) } } };
  }

  function role(value: PartRole): PartRole {
    if (!isPartRole(value)) throw new ProjectError(`Unknown library role "${value}".`, { section: 'models' });
    return value;
  }

  const commands: ProjectCommands = {
    title(value, info) {
      return command(info, (document) => whole(document, 'title', inSection('title', () => projectTitle(value))));
    },
    settings(build, info) {
      return command(info, (document) => whole(document, 'settings', keep(validateGameSettings(build(document.get('settings'))), document.get('settings'))));
    },
    theme(build, info) {
      return command(info, (document) => whole(document, 'theme', keep(inSection('theme', () => validateTheme(build(document.get('theme')))), document.get('theme'))));
    },
    hud(build, info) {
      return command(info, (document) => whole(document, 'hud', keep(inSection('hud', () => validateHud(build(document.get('hud')))), document.get('hud'))));
    },
    audio(build, info) {
      return command(info, (document) => {
        const before = document.get('audio');
        const audio = keep(inSection('audio', () => validateAudio(build(before))), before);
        const sources = new Set(audioSources(before));
        if (audioSources(audio).some((source) => !sources.has(source))) references(document, { audio });
        return whole(document, 'audio', audio);
      });
    },
    enemies(value, info) {
      return command(info, (document) => enemyChanges(document, value, undefined, false));
    },
    mediaAdd(value, info) {
      return command(info, (document) => {
        const before = document.get('media');
        const existing = before.find((item) => item.path === value.path);
        const values = existing === undefined ? [...before, value] : before.map((item) => item === existing ? value : item);
        return whole(document, 'media', mediaValue(values, before));
      });
    },
    mediaRemove(path, info) {
      return command(info, (document) => {
        const before = document.get('media');
        if (!before.some((item) => item.path === path)) return [];
        const media = mediaValue(before.filter((item) => item.path !== path), before);
        references(document, { media });
        return whole(document, 'media', media);
      });
    },
    courseMeshAdd(value, info) {
      return command(info, (document) => {
        const before = document.get('art');
        const existing = before.assets.find((asset) => asset.id === value.id);
        const assets = existing === undefined ? [...before.assets, value] : before.assets.map((asset) => asset === existing ? value : asset);
        const art = artValue({ assets, decorations: before.decorations }, before);
        return whole(document, 'art', art);
      });
    },
    courseMeshRemove(id, info) {
      return command(info, (document) => {
        const before = document.get('art');
        if (!before.assets.some((asset) => asset.id === id)) return [];
        const drawn = ENEMY_SPECIES.filter((species) => {
          const entry = document.get('enemies')[species];
          return entry?.type === 'model' && entry.asset === id;
        });
        if (drawn.length > 0) {
          throw new ProjectError(`The mesh draws the ${drawn.join(', ')}; give ${drawn.length === 1 ? 'it' : 'them'} pixel art in Enemy art first.`, { section: 'art' });
        }
        const decorations = Object.entries(before.decorations).filter(([, asset]) => asset === id).map(([model]) => model);
        if (decorations.length > 0) {
          throw new ProjectError(`The mesh draws the decoration model ${decorations.join(', ')}; import a course package without it first.`, { section: 'art' });
        }
        const art = artValue({ assets: before.assets.filter((asset) => asset.id !== id), decorations: before.decorations }, before);
        references(document, { art });
        return whole(document, 'art', art);
      });
    },
    enemyModel(value, info) {
      return command(info, (document) => {
        if (value.model.asset !== value.asset.id) throw new ProjectError('The enemy model must use its imported artwork.', { section: 'enemies' });
        return enemyChanges(document, { ...document.get('enemies'), [value.species]: value.model }, value.asset);
      });
    },
    enemyClips(species, expected, model, info) {
      return command(info, (document) => {
        if (document.get('enemies')[species] !== expected) {
          throw new ProjectError(`The ${species}'s model changed while its clips were baked; try again.`, { section: 'enemies' });
        }
        if (model.asset !== expected.asset) throw new ProjectError('Choose clips for the current enemy model.', { section: 'enemies' });
        return enemyChanges(document, { ...document.get('enemies'), [species]: model });
      });
    },
    libraryAdd(value, info) {
      return command(info, (document) => {
        const before = document.get('models');
        const selected = role(value.role);
        const models = modelsValue({ ...before, [selected]: [...before[selected], value.model] }, before);
        return whole(document, 'models', models);
      });
    },
    libraryRemove(selected, id, info) {
      return command(info, (document) => {
        role(selected);
        libraryModelId(id);
        const before = document.get('models');
        const items = before[selected].filter((item) => item.entry.id !== id);
        if (items.length === before[selected].length) return [];
        return whole(document, 'models', modelsValue({ ...before, [selected]: items }, before));
      });
    },
    libraryAvatar(id, expected, entry, info) {
      return command(info, (document) => {
        const before = document.get('models');
        if (before.avatar.find((item) => item.entry.id === id) !== expected) {
          throw new ProjectError(`Library avatar "${id}" changed while its model was checked; try again.`, { section: 'models' });
        }
        if (entry.id !== id) throw new ProjectError('An avatar settings edit cannot rename its library ID.', { section: 'models' });
        const avatar = before.avatar.map((item) => item === expected ? { entry, file: item.file } : item);
        return whole(document, 'models', modelsValue({ ...before, avatar }, before));
      });
    },
    libraryHammerHead(id, before, after, info) {
      return command(info, (document) => {
        const current = document.get('models');
        const model = current.hammer.find((item) => item.entry.id === id);
        if (model === undefined || model.entry.head !== before) {
          throw new ProjectError(`Library hammer "${id}" changed while its head was edited.`, { section: 'models' });
        }
        const head = inSection('models', () => libraryHammerHead(after));
        const hammer = current.hammer.map((item) => item === model ? { ...item, entry: { ...item.entry, head } } : item);
        return whole(document, 'models', modelsValue({ ...current, hammer }, current));
      });
    },
    defaultHammerHead(before, after, info) {
      return commands.settings((current) => {
        if (current.rig.head !== before) throw new GameSettingsError('The default hammer head changed while it was edited.');
        return withRig(current, { ...current.rig, head: after });
      }, info);
    },
    pot(before, after, info) {
      return commands.settings((current) => {
        if (current.rig.pot !== before) throw new GameSettingsError('The jar changed while it was edited.');
        return withRig(current, { ...current.rig, pot: after });
      }, info);
    },
    alternate(value, info) {
      return command(info, (document) => whole(document, 'characters/alternate', alternateValue(value, document.get('characters/alternate'))));
    },
    currentAsAlternate(info) {
      return command(info, (document) => {
        const primary = document.get('characters/primary');
        options.characterCommands.checkStoredProfile(primary);
        return whole(document, 'characters/alternate', primary);
      });
    },
    swapCharacters(info) {
      return command(info, (document) => {
        const primary = document.get('characters/primary');
        const alternate = document.get('characters/alternate');
        if (alternate === null) throw new SpriteError('The project has no alternate character to swap with.');
        options.characterCommands.checkStoredProfile(alternate);
        options.characterCommands.checkStoredProfile(primary);
        return [...whole(document, 'characters/primary', alternate), ...whole(document, 'characters/alternate', primary)];
      });
    },
    coursePackage(value, info) {
      return command(levelInfo(info, value.level), (document) => {
        const before = document.get('art');
        const drawn = enemyArtAssets(document.get('enemies'), species);
        const ids = new Set(value.art.assets.map((asset) => asset.id));
        const assets = [...value.art.assets, ...before.assets.filter((asset) => drawn.has(asset.id) && !ids.has(asset.id))];
        const art = artValue({ assets, decorations: value.art.decorations }, before);
        const level = options.level.replace(value.level, art.decorations);
        references(document, { art, level: level?.after ?? document.get('level') });
        return [...whole(document, 'art', art), ...(level === null ? [] : [level])];
      });
    },
    pluginData(id, value, info) {
      return command(info, (document) => {
        if (!isPluginId(id)) throw new PluginError('invalid-contribution', `Invalid plugin data ID "${id}".`, id);
        const section = pluginSection(id);
        const changes = whole(document, section, pluginValue(id, value, document.get(section)));
        pluginCount(document, changes);
        return changes;
      });
    },
    sections(values, info) {
      return command(levelInfo(info, values.level), (document) => {
        const changes: SomeSectionChange[] = [];
        const art = values.art === undefined ? document.get('art') : artValue(values.art, document.get('art'));
        const media = values.media === undefined ? document.get('media') : mediaValue(values.media, document.get('media'));
        const enemies = values.enemies === undefined ? document.get('enemies')
          : keep(inSection('enemies', () => validateEnemyArt(values.enemies)), document.get('enemies'));
        const audio = values.audio === undefined ? document.get('audio')
          : keep(inSection('audio', () => validateAudio(values.audio)), document.get('audio'));
        const level = values.level === undefined ? null : options.level.replace(values.level, art.decorations);
        for (const name of Object.keys(values)) {
          const plugin = pluginOfSection(name);
          if (plugin !== null) {
            const section = pluginSection(plugin);
            const value = values[section];
            if (value === undefined) throw new ProjectError(`Missing restored section "${section}".`, { section });
            changes.push(...whole(document, section, pluginValue(plugin, value === null ? null : value.data, document.get(section))));
            continue;
          }
          if (!Object.hasOwn(SECTION_ADAPTERS.builtin, name)) throw new ProjectError(`Unknown document section "${name}".`, { section: name });
          if (Reflect.get(values, name) === undefined) throw new ProjectError(`Missing restored section "${name}".`, { section: name });
          switch (name) {
            case 'title': changes.push(...whole(document, 'title', inSection('title', () => projectTitle(values.title)))); break;
            case 'level': if (level !== null) changes.push(level); break;
            case 'settings': changes.push(...whole(document, 'settings', keep(validateGameSettings(values.settings), document.get('settings')))); break;
            case 'theme': changes.push(...whole(document, 'theme', keep(inSection('theme', () => validateTheme(values.theme)), document.get('theme')))); break;
            case 'hud': changes.push(...whole(document, 'hud', keep(inSection('hud', () => validateHud(values.hud)), document.get('hud')))); break;
            case 'audio': changes.push(...whole(document, 'audio', audio)); break;
            case 'enemies': changes.push(...whole(document, 'enemies', enemies)); break;
            case 'art': changes.push(...whole(document, 'art', art)); break;
            case 'media': changes.push(...whole(document, 'media', media)); break;
            case 'models': changes.push(...whole(document, 'models', modelsValue(values.models!, document.get('models')))); break;
            case 'characters/primary': changes.push(...whole(document, 'characters/primary',
              options.characterCommands.checkProfile(values['characters/primary'], document.get('characters/primary')))); break;
            case 'characters/alternate': changes.push(...whole(document, 'characters/alternate',
              alternateValue(values['characters/alternate']!, document.get('characters/alternate')))); break;
            case 'arm-ik': changes.push(...options.appearanceCommands.armIk(() => values['arm-ik'], info).run(document)); break;
            case 'appearance': changes.push(...whole(document, 'appearance',
              options.appearanceCommands.checkParts(values.appearance!, document.get('appearance')))); break;
          }
        }
        if (['level', 'art', 'media', 'enemies', 'audio'].some((name) => Object.hasOwn(values, name))) {
          references(document, { art, media, enemies, audio, level: level?.after ?? document.get('level') });
        }
        pluginCount(document, changes);
        return changes;
      });
    },
  };
  return Object.freeze(commands);
}
