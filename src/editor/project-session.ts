import { validateAppearanceParts } from '../appearance-profile';
import { checkAppearanceModel } from '../appearance-model';
import type { VisualAlignment } from '../appearance-profile';
import { audioSources, DEFAULT_AUDIO, validateAudio } from '../audio-settings';
import type { AudioSettings } from '../audio-settings';
import type { ArmIkSettings, VisualPartId } from '../character';
import type { AvatarBoneMap } from '../character-profile';
import { ArtError } from '../art-types';
import type { ArtMode } from '../art-types';
import { NO_DECORATION_ART } from '../decoration-art';
import type { DecorationArt } from '../decoration-art';
import { validateCoursePackage } from '../course-package';
import { DEFAULT_LEVEL } from '../default-level';
import { DEFAULT_ENEMY_ART, validateEnemyArt } from '../enemy-art-data';
import type { EnemyArtSettings } from '../enemy-art-data';
import type { GameSettings } from '../game-settings';
import { DEFAULT_HUD, validateHud } from '../hud';
import type { HudSettings } from '../hud';
import { validateLevel } from '../level';
import type { LevelDefinition } from '../level';
import { checkMediaBytes, MEDIA_LIMITS, mediaFile, mediaKind, mediaPathForFile, mediaType } from '../media';
import {
  appearanceFile, artFile, checkProjectReferences, defaultProjectManifest, inSection, isProjectDataError, loadProjectContent,
  packProjectBundle, parseProjectCharacter, PROJECT_FILES, PROJECT_FORMAT, PROJECT_LIMITS, PROJECT_SCHEMA_VERSION,
  ProjectError, projectTitle, unpackProjectBundle, validateMediaIndex, validateProjectArt, validateProjectCharacter,
  validateProjectId, validateProjectManifest,
} from '../project';
import type { ProjectBundle, ProjectContent, ProjectManifest } from '../project';
import { EMPTY_SPRITES } from '../sprite-data';
import type { SpriteDocument } from '../sprite-data';
import { decodeBase64 } from '../sprite-fields';
import { MODEL_LIMITS } from '../model-data';
import {
  checkLibraryModel, checkModelLibrary, libraryEntries, libraryIdForName, libraryModelFile, MODEL_LIBRARY_LIMITS, newAvatarEntry, PART_ROLES,
  validateAvatarSettings, validateModelLibrary,
} from '../model-library';
import type { LibraryAvatarEntry, LibraryAvatarSettings, LibraryEntry, ModelLibrary, PartRole } from '../model-library';
import { DEFAULT_THEME, validateTheme } from '../theme';
import type { GameTheme } from '../theme';
import { ProjectApiError, ProjectClient } from './project-client';
import type { PublishRecord, ServerHealth, ServerProjectSummary, ServerRevisions } from './project-client';
import { ProjectCopyStore } from './project-copy';
import type { ProjectCopy } from './project-copy';
import { loadPublishedProject } from './published-project';
import type { PublishedProject } from './published-project';
import { ServerModelError } from './server-models';

export const PROJECT_SECTIONS = [
  'title', 'level', 'settings', 'characters/primary', 'characters/alternate', 'arm-ik', 'appearance', 'models',
  'theme', 'hud', 'audio', 'enemies', 'art', 'media',
] as const;
export type ProjectSectionName = (typeof PROJECT_SECTIONS)[number];

// Server writes happen in this order, so new files exist before references and references go before removals.
const SAVE_ORDER: readonly ProjectSectionName[] = [
  'title', 'settings', 'arm-ik', 'theme', 'hud', 'enemies', 'level', 'audio',
  'characters/primary', 'characters/alternate', 'art', 'appearance', 'models', 'media',
];
const ACTIVE_KEY = 'over-the-edge:project:active:v1';
const POLL_MS = 2000;
const COPY_MS = 1000;
// A section reopened with unsaved changes: equal to no fingerprint, so it stays unsaved.
const UNSAVED = Symbol('unsaved');

export interface AppearanceFile {
  readonly part: VisualPartId;
  readonly name: string;
  readonly blob: Blob;
  readonly alignment: VisualAlignment;
}

// The Workshop's editors, adapted so a project can be captured from them and loaded into them.
export interface ProjectWorkspace {
  readonly level: {
    get(): LevelDefinition;
    load(level: LevelDefinition): void;
    // Adopts a newer version incrementally, without restarting a playtest.
    sync(level: LevelDefinition): void;
    prepare(): boolean;
    // Records `level` (default: the current level) as the saved version; null records unsaved changes.
    markSaved(level?: LevelDefinition | null): void;
  };
  readonly settings: { get(): GameSettings; load(settings: GameSettings): void };
  readonly character: {
    draft(): SpriteDocument;
    hasContent(): boolean;
    validated(): SpriteDocument | null;
    // Refuses while the character is busy, unless `wait` asks it to wait for the character instead.
    load(document: SpriteDocument, options?: { readonly wait?: boolean }): Promise<boolean>;
  };
  readonly appearance: {
    armIk(): Readonly<ArmIkSettings>;
    loadArmIk(settings: ArmIkSettings): void;
    parts(): AppearanceFile[];
    load(parts: readonly AppearanceFile[]): Promise<boolean>;
  };
  readonly ready: Promise<unknown>;
  onLook(look: ProjectLook): void;
  notice(message: string, kind: 'info' | 'error'): void;
}

export interface ProjectLook {
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly enemies: EnemyArtSettings;
  readonly audio: AudioSettings;
  readonly resolveMedia: (source: string) => string;
  // Changes whenever media files change, so caches of their contents can be dropped.
  readonly mediaVersion: number;
}

interface MediaItem {
  readonly path: string;
  // Local bytes not yet on the server, or null for a file that only the server holds.
  readonly blob: Blob | null;
  readonly url: string;
  readonly bytes: number;
  readonly uploaded: boolean;
}

interface ArtItem {
  readonly id: string;
  readonly name: string;
  readonly blob: Blob | null;
  readonly uploaded: boolean;
}

// One model in the project's library. A server project's files stay on the server until needed.
interface LibraryItem {
  readonly role: PartRole;
  readonly entry: LibraryEntry | LibraryAvatarEntry;
  // Identifies the item's GLB in this page: it changes whenever the file may have.
  readonly key: number;
  readonly blob: Blob | null;
  // The GLB's size, as the server reported it for a file only the server holds.
  readonly bytes: number;
  // Whether the bound server holds this item's file.
  readonly uploaded: boolean;
}

// A library model as the Workshop shows it.
export interface LibraryModel {
  readonly role: PartRole;
  readonly id: string;
  readonly name: string;
  readonly key: number;
  // An avatar's settings, the same object until they change; null for a hammer or pot.
  readonly avatar: LibraryAvatarSettings | null;
}

function libraryOf(items: readonly LibraryItem[]): ModelLibrary {
  return validateModelLibrary(Object.fromEntries(PART_ROLES.map((role) => [role, items.filter((item) => item.role === role).map((item) => item.entry)])));
}

interface Binding {
  readonly id: string;
  revision: number;
  readonly sections: Record<string, number>;
}

// What this browser's copy holds, or would hold: compared section by section.
interface CopyState {
  readonly fingerprints: Record<ProjectSectionName, unknown>;
  readonly origin: string | null;
  readonly dirty: readonly ProjectSectionName[];
}

function sameCopy(a: CopyState | null, b: CopyState | null): boolean {
  return a !== null && b !== null && a.origin === b.origin && a.dirty.join() === b.dirty.join() &&
    PROJECT_SECTIONS.every((name) => a.fingerprints[name] === b.fingerprints[name]);
}

export type ProjectEvent = { readonly kind: 'status' } | { readonly kind: 'content' };

export interface ProjectSnapshot {
  readonly title: string;
  readonly binding: { readonly id: string; readonly revision: number } | null;
  readonly server: ServerHealth | null;
  readonly projects: readonly ServerProjectSummary[];
  readonly busy: string | null;
  readonly dirty: readonly ProjectSectionName[];
  readonly conflicts: readonly ProjectSectionName[];
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly audio: AudioSettings;
  readonly enemies: EnemyArtSettings;
  readonly art: {
    readonly mode: ArtMode;
    readonly assets: readonly { readonly id: string; readonly name: string }[];
    readonly decorations: DecorationArt;
  };
  readonly media: readonly { readonly path: string; readonly bytes: number; readonly kind: 'video' | 'audio' }[];
  readonly library: readonly LibraryModel[];
  readonly alternate: SpriteDocument | null;
  readonly publish: PublishRecord | null;
  readonly error: string | null;
  // The project this Workshop was built with (GAME_PROJECT), and whether the page shows a version
  // of it: the current one, an older one kept with its changes, or another project.
  readonly published: { readonly title: string; readonly version: string; readonly origin: 'current' | 'outdated' | 'none' } | null;
  // This browser's copy of the open project, in a Workshop built with a project.
  readonly browserCopy: { readonly stored: boolean; readonly pending: boolean; readonly writes: number } | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpected(error: unknown): error is Error {
  return error instanceof ProjectApiError || isProjectDataError(error) || error instanceof SyntaxError || error instanceof DOMException ||
    error instanceof ServerModelError;
}

/**
 * The open game project: owns the project-only sections (title, look, HUD, audio, enemies, media,
 * alternate character, course artwork) and moves every section between the Workshop's editors,
 * project bundle files and the self-hosted project server. In a Workshop built with a project it
 * opens that published project and keeps the open project, with its changes, in this browser.
 */
export class ProjectSession {
  private readonly workspace: ProjectWorkspace;
  private readonly client: ProjectClient;
  private readonly published: PublishedProject | null;
  private readonly copy: ProjectCopyStore | null;
  private readonly lifecycle = new AbortController();
  private readonly listeners = new Set<(event: ProjectEvent) => void>();
  private readonly blobIds = new WeakMap<Blob, number>();
  private nextBlobId = 1;
  private title = 'Untitled game';
  private theme: GameTheme = DEFAULT_THEME;
  private hud: HudSettings = DEFAULT_HUD;
  private audio: AudioSettings = DEFAULT_AUDIO;
  private enemies: EnemyArtSettings = DEFAULT_ENEMY_ART;
  private art: { mode: ArtMode; assets: ArtItem[]; decorations: DecorationArt } = { mode: 'shapes', assets: [], decorations: NO_DECORATION_ART };
  private media = new Map<string, MediaItem>();
  private mediaVersion = 0;
  private library: LibraryItem[] = [];
  private nextLibraryKey = 1;
  // One settings object per avatar entry, so views can tell when an avatar's settings changed.
  private readonly avatarSettings = new WeakMap<LibraryAvatarEntry, LibraryAvatarSettings>();
  private alternate: SpriteDocument | null = null;
  private binding: Binding | null = null;
  private synced: Record<ProjectSectionName, unknown> | null = null;
  // Appearance files last saved to or loaded from the server, by part.
  private syncedModels = new Map<VisualPartId, Blob>();
  private readonly conflicts = new Set<ProjectSectionName>();
  private server: ServerHealth | null = null;
  private projects: readonly ServerProjectSummary[] = [];
  private publishRecord: PublishRecord | null = null;
  private busy: string | null = null;
  private error: string | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  // The published version the page's project was opened from; null for any other project.
  private origin: string | null = null;
  // False until a project opens in this page, so a failed start never replaces a stored copy.
  private keeping = false;
  private copyStored = false;
  private copyWrites = 0;
  // The state last written to the copy, the state seen by the previous check, and one that failed.
  private copyWritten: CopyState | null = null;
  private copySeen: CopyState | null = null;
  private copyFailed: CopyState | null = null;
  // Copy writes run one after another.
  private copyTask: Promise<void> | null = null;
  private copyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly checkedCharacters = new WeakSet<SpriteDocument>();

  constructor(options: { workspace: ProjectWorkspace; client?: ProjectClient; published?: PublishedProject | null }) {
    this.workspace = options.workspace;
    this.client = options.client ?? new ProjectClient();
    this.published = options.published ?? null;
    this.copy = this.published === null ? null : new ProjectCopyStore();
  }

  // After the editors restore their browser-local state: find the server and reopen its project.
  // Otherwise a Workshop built with a project reopens this browser's copy or the published project.
  async start(): Promise<void> {
    await this.workspace.ready;
    if (this.disposed) return;
    this.synced = this.fingerprints();
    this.applyLook();
    await this.refreshServer();
    const remembered = this.rememberedProject();
    if (remembered !== null && this.server?.authenticated === true && this.projects.some((project) => project.id === remembered)) {
      await this.open(remembered, { quiet: true });
    }
    if (this.binding === null && this.published !== null && !this.disposed) await this.openStartProject();
    if (this.disposed) return;
    this.poller = setInterval(() => { void this.poll(); }, POLL_MS);
    if (this.copy !== null) {
      this.copyTimer = setInterval(() => { void this.keepCopy(); }, COPY_MS);
      // Leaving the page stores the latest changes at once.
      const leaving = (): void => { void this.keepCopy({ now: true }); };
      const signal = this.lifecycle.signal;
      window.addEventListener('beforeunload', leaving, { signal });
      window.addEventListener('pagehide', leaving, { signal });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leaving(); }, { signal });
    }
  }

  snapshot(): ProjectSnapshot {
    return {
      title: this.title,
      binding: this.binding === null ? null : { id: this.binding.id, revision: this.binding.revision },
      server: this.server, projects: this.projects, busy: this.busy,
      dirty: this.dirtySections(), conflicts: [...this.conflicts],
      theme: this.theme, hud: this.hud, audio: this.audio, enemies: this.enemies,
      art: { mode: this.art.mode, assets: this.art.assets.map(({ id, name }) => ({ id, name })), decorations: this.art.decorations },
      media: [...this.media.values()].map((item) => ({ path: item.path, bytes: item.bytes, kind: mediaKind(item.path) })),
      library: this.library.map(({ role, entry, key }) => ({
        role, id: entry.id, name: entry.name, key, avatar: role === 'avatar' ? this.settingsOf(entry as LibraryAvatarEntry) : null,
      })),
      alternate: this.alternate, publish: this.publishRecord, error: this.error,
      published: this.published === null ? null : {
        title: this.published.title, version: this.published.version,
        origin: this.origin === this.published.version ? 'current' : this.origin === null ? 'none' : 'outdated',
      },
      browserCopy: this.copy === null ? null : { stored: this.copyStored, pending: this.hasUnsavedProjectChanges(), writes: this.copyWrites },
    };
  }

  subscribe(listener: (event: ProjectEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Sections whose current value differs from the last project opened, imported or saved.
  dirtySections(): ProjectSectionName[] {
    if (this.synced === null) return [];
    const current = this.fingerprints();
    return PROJECT_SECTIONS.filter((name) => current[name] !== this.synced![name]);
  }

  // Unsaved work that exists only in this page (the level editor warns about its own changes). A
  // Workshop built with a project warns for every section instead, and while this browser's copy
  // keeps the project only changes not stored there yet count.
  hasUnsavedProjectChanges(): boolean {
    if (this.copy !== null) {
      if (!this.keeping || this.binding !== null) return this.dirtySections().length > 0;
      const state = this.copyState();
      return this.copyWanted(state) && !sameCopy(state, this.copyWritten);
    }
    return this.dirtySections().some((name) => name !== 'level' && name !== 'characters/primary' && name !== 'settings');
  }

  resolveMedia = (source: string): string => this.media.get(source)?.url ?? source;

  setTitle(value: string): boolean {
    try {
      this.title = projectTitle(value);
      this.changed('status');
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  setTheme(value: unknown): boolean { return this.setSection(() => { this.theme = validateTheme(value); }); }
  setHud(value: unknown): boolean { return this.setSection(() => { this.hud = validateHud(value); }); }
  setEnemies(value: unknown): boolean { return this.setSection(() => { this.enemies = validateEnemyArt(value); }); }

  setAudio(value: unknown): boolean {
    return this.setSection(() => {
      const audio = validateAudio(value);
      const missing = audioSources(audio).filter((source) => source.startsWith('/') && !this.media.has(source));
      if (missing.length > 0) throw new ProjectError(`Add ${missing[0]} to the media library first.`, { section: 'audio' });
      this.audio = audio;
    });
  }

  setArtMode(mode: ArtMode): void {
    this.art = { ...this.art, mode };
    this.changed('status');
  }

  async addMedia(file: File): Promise<string | null> {
    try {
      const path = mediaPathForFile(file.name);
      if (path === null) throw new ProjectError('Choose a .webm, .mp4, .mp3, .ogg, .wav or .m4a file with a letter or digit in its name.', { section: 'media' });
      if (file.size === 0 || file.size > MEDIA_LIMITS.bytes) throw new ProjectError(`Media files hold 1 byte to ${MEDIA_LIMITS.bytes / 1024 ** 2} MiB.`, { section: 'media' });
      // The signature is at the start; the server checks the whole file again on upload.
      checkMediaBytes(path, new Uint8Array(await file.slice(0, 64).arrayBuffer()));
      validateMediaIndex([...[...this.media.keys()].filter((existing) => existing !== path).map((existing) => ({ path: existing })), { path }]);
      const total = [...this.media.values()].reduce((sum, item) => sum + (item.path === path ? 0 : item.bytes), file.size);
      if (total > MEDIA_LIMITS.totalBytes) throw new ProjectError(`The media library holds at most ${MEDIA_LIMITS.totalBytes / 1024 ** 2} MiB.`, { section: 'media' });
      this.replaceMedia(path, { path, blob: file, url: URL.createObjectURL(file), bytes: file.size, uploaded: false });
      this.changed('content');
      return path;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  removeMedia(path: string): boolean {
    try {
      const manifest = { ...this.draftManifest(), media: [...this.media.keys()].filter((existing) => existing !== path).map((existing) => ({ path: existing })) };
      checkProjectReferences(validateProjectManifest(manifest), this.workspace.level.get());
      this.replaceMedia(path, null);
      this.changed('content');
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  // Downloads a file as one of the session's operations, so the open project cannot change while it
  // arrives. Null when another operation is running or the download failed, which is reported.
  async download(label: string, source: () => Promise<File>): Promise<File | null> {
    const result: { file: File | null } = { file: null };
    await this.run(label, async () => { result.file = await source(); });
    return result.file;
  }

  // Adds a GLB to the model library for one part, checked like releases check it. A new avatar uses
  // `boneMap` or maps its joints automatically, and takes the open character's grips, arm lengths
  // and arm forward distance.
  async addLibraryModel(role: PartRole, file: File, boneMap?: AvatarBoneMap): Promise<LibraryModel | null> {
    try {
      if (file.size === 0 || file.size > MODEL_LIMITS.bytes) {
        throw new ProjectError(`Choose a GLB file no larger than ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`, { section: 'models' });
      }
      const total = this.library.reduce((sum, item) => sum + item.bytes, 0);
      if (total + file.size > MODEL_LIBRARY_LIMITS.totalBytes) {
        throw new ProjectError(`The model library holds at most ${MODEL_LIBRARY_LIMITS.totalBytes / 1024 ** 2} MiB.`, { section: 'models' });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const taken = new Set(this.library.filter((item) => item.role === role).map((item) => item.entry.id));
      const stem = libraryIdForName(file.name);
      let id = stem;
      for (let suffix = 2; taken.has(id); suffix++) id = `${stem.slice(0, MODEL_LIBRARY_LIMITS.id - String(suffix).length - 1)}-${suffix}`;
      const base = { id, name: file.name.replace(/\.glb$/i, '').trim().slice(0, MODEL_LIBRARY_LIMITS.name) || id };
      const settings = this.characterAvatarSettings();
      const entry = role !== 'avatar' ? base : boneMap === undefined
        ? inSection('models', () => newAvatarEntry(bytes, base, settings)) : { ...base, boneMap, ...settings };
      inSection('models', () => checkLibraryModel(role, entry, bytes));
      const blob = new Blob([bytes], { type: 'model/gltf-binary' });
      const items = [...this.library, { role, entry, key: this.nextLibraryKey++, blob, bytes: blob.size, uploaded: false }];
      inSection('models', () => libraryOf(items));
      this.library = items;
      this.changed('content');
      return this.snapshot().library.find((model) => model.role === role && model.id === id)!;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  removeLibraryModel(role: PartRole, id: string): void {
    this.library = this.library.filter((item) => item.role !== role || item.entry.id !== id);
    this.changed('content');
  }

  // Changes a library avatar's bone map and settings; the bone map must resolve against its model.
  async setLibraryAvatar(id: string, settings: LibraryAvatarSettings): Promise<boolean> {
    try {
      const item = this.libraryItem('avatar', id);
      const entry: LibraryAvatarEntry = Object.freeze({
        id, name: item.entry.name, ...inSection('models', () => validateAvatarSettings(settings as unknown as Record<string, unknown>)),
      });
      const bytes = new Uint8Array(await (await this.libraryBlob('avatar', id)).arrayBuffer());
      inSection('models', () => checkLibraryModel('avatar', entry, bytes));
      if (!this.library.includes(item)) return false;
      this.library = this.library.map((candidate) => candidate === item ? { ...item, entry } : candidate);
      this.changed('content');
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  // Gives a library avatar the open character's grips, arm lengths and arm forward distance.
  async useCharacterSettings(id: string): Promise<boolean> {
    const item = this.library.find((candidate) => candidate.role === 'avatar' && candidate.entry.id === id);
    if (item === undefined) return false;
    return this.setLibraryAvatar(id, { boneMap: (item.entry as LibraryAvatarEntry).boneMap, ...this.characterAvatarSettings() });
  }

  private settingsOf(entry: LibraryAvatarEntry): LibraryAvatarSettings {
    let settings = this.avatarSettings.get(entry);
    if (settings === undefined) {
      settings = Object.freeze({ boneMap: entry.boneMap, armForwardDistance: entry.armForwardDistance, grips: entry.grips, arms: entry.arms });
      this.avatarSettings.set(entry, settings);
    }
    return settings;
  }

  private characterAvatarSettings(): Omit<LibraryAvatarSettings, 'boneMap'> {
    const { armForwardDistance, grips, arms } = this.workspace.character.draft();
    return { armForwardDistance, grips, arms };
  }

  // A library model's GLB, from this page or the bound server project.
  async libraryBlob(role: PartRole, id: string): Promise<Blob> {
    const item = this.libraryItem(role, id);
    if (item.blob !== null) return item.blob;
    if (this.binding === null) throw new ProjectError(`Library ${role} "${id}" is not available in this page.`, { section: 'models' });
    return this.client.blob(this.client.libraryModelUrl(this.binding.id, role, id));
  }

  private libraryItem(role: PartRole, id: string): LibraryItem {
    const item = this.library.find((candidate) => candidate.role === role && candidate.entry.id === id);
    if (item === undefined) throw new ProjectError(`The project has no library ${role} "${id}".`, { section: 'models' });
    return item;
  }

  useCurrentAsAlternate(): boolean {
    const document = this.workspace.character.validated();
    if (document === null) return false;
    this.alternate = document;
    this.changed('content');
    return true;
  }

  async swapCharacters(): Promise<boolean> {
    const alternate = this.alternate;
    const current = this.workspace.character.validated();
    if (alternate === null || current === null) return false;
    if (!await this.workspace.character.load(alternate)) return false;
    this.alternate = current;
    this.changed('content');
    return true;
  }

  async importAlternate(file: File): Promise<boolean> {
    try {
      this.alternate = parseProjectCharacter(await file.text());
      this.changed('content');
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  removeAlternate(): void {
    this.alternate = null;
    this.changed('content');
  }

  // A course package from `npm run pack:course`: its level replaces the current one, with its GLBs.
  async importCoursePackage(file: File): Promise<boolean> {
    return this.run('Importing course package', async () => {
      if (file.size > 96 * 1024 * 1024) throw new ArtError('Course packages are limited to 96 MiB.');
      const pack = validateCoursePackage(JSON.parse(await file.text()));
      const assets = pack.assets.map((asset) => ({
        id: asset.id, name: asset.name, uploaded: false,
        blob: new Blob([decodeBase64(asset.source.slice('data:model/gltf-binary;base64,'.length))], { type: 'model/gltf-binary' }),
      }));
      checkProjectReferences(validateProjectManifest({
        ...this.draftManifest(), art: { mode: pack.mode, assets: assets.map(({ id, name }) => ({ id, name })), decorations: pack.decorations },
      }), pack.level);
      this.workspace.level.load(pack.level);
      this.art = { mode: pack.mode, assets, decorations: pack.decorations };
      this.workspace.notice(`Imported the course package: ${pack.level.objects.length} objects and ${assets.length} GLBs.`, 'info');
      this.changed('content');
    });
  }

  async refreshServer(): Promise<void> {
    this.server = await this.client.health();
    this.projects = [];
    if (this.server.available && this.server.authenticated) {
      try {
        this.projects = await this.client.list();
      } catch (error) {
        if (!isExpected(error)) throw error;
        this.error = error.message;
      }
    }
    this.changed('status');
  }

  async signIn(token: string): Promise<boolean> {
    return this.run('Signing in', async () => {
      await this.client.signIn(token.trim());
      await this.refreshServer();
    });
  }

  // Starts a new game from the built-in course and defaults, not yet saved anywhere.
  async newProject(): Promise<boolean> {
    return this.run('Starting a new project', async () => {
      await this.applyContent(loadProjectContent(defaultProjectManifest('Untitled game'), () => DEFAULT_LEVEL), null);
      await this.storeCopy();
      // A failed copy keeps its notice.
      if (this.error !== null) return;
      this.workspace.notice(`Started a new project from the built-in course. ${this.copy === null ? 'Save it to keep it.'
        : 'This browser keeps it; export the project file to take it elsewhere.'}`, 'info');
    });
  }

  async open(id: string, options: { quiet?: boolean } = {}): Promise<boolean> {
    return this.run(`Opening ${id}`, async () => {
      const project = await this.client.project(id);
      const read = async (name: string) => (await this.client.section(id, name)).value;
      const level = await read('level');
      const primary = project.manifest.characters.primary === null ? null : await read('characters/primary');
      const alternate = project.manifest.characters.alternate === null ? null : await read('characters/alternate');
      const models = await Promise.all(project.manifest.appearance.map(async (part) => this.client.blob(this.client.modelUrl(id, part.part))));
      await this.applyServerProject(project.manifest, project, { level, primary, alternate, models, sizes: fileSizes(project.files) });
      this.publishRecord = (await this.client.publishStatus(id)).release;
      if (!options.quiet) this.workspace.notice(`Opened "${project.manifest.title}" from the project server.`, 'info');
      else this.workspace.notice(`Reopened project "${project.manifest.title}" from the project server.`, 'info');
    });
  }

  async importBundle(file: File): Promise<boolean> {
    return this.run('Importing project file', async () => {
      if (file.size > PROJECT_LIMITS.bundleBytes) throw new ProjectError(`Project files are limited to ${PROJECT_LIMITS.bundleBytes / 1024 ** 2} MiB.`);
      const content = unpackProjectBundle(JSON.parse(await file.text()));
      await this.applyContent(content, null);
      await this.storeCopy();
      if (this.error !== null) return;
      this.workspace.notice(`Imported "${content.manifest.title}". ${this.copy === null ? 'Save it to the project server or export it to keep changes.'
        : 'This browser keeps it with your changes; export the project file to take it elsewhere.'}`, 'info');
    });
  }

  // Discards this browser's copy and opens the project this Workshop was built with.
  async reopenPublished(): Promise<boolean> {
    return this.published !== null && this.openPublished();
  }

  async exportBundle(): Promise<{ bundle: ProjectBundle; filename: string } | null> {
    let result: { bundle: ProjectBundle; filename: string } | null = null;
    await this.run('Exporting project file', async () => {
      const draft = this.captureDraft();
      const content = await this.captureFiles(draft, this.workspace.appearance.parts(), [...this.media.values()], [...this.art.assets], this.library);
      result = { bundle: packProjectBundle(content), filename: `${this.binding?.id ?? projectFileName(this.title)}.project.json` };
    });
    return result;
  }

  // Saves the changed sections to the bound server project.
  async save(): Promise<boolean> {
    const binding = this.binding;
    if (binding === null) {
      this.report(new ProjectError('This project is not on the project server yet; use Save as.'));
      return false;
    }
    return this.run('Saving', async () => {
      const draft = this.captureDraft();
      // Exactly what this save sends; edits made while its requests run stay unsaved.
      const baseline = this.fingerprints();
      const savedLevel = this.workspace.level.get();
      const parts = this.workspace.appearance.parts();
      const media = [...this.media.values()];
      const assets = [...this.art.assets];
      const library = this.library;
      const dirty = new Set(PROJECT_SECTIONS.filter((name) => baseline[name] !== this.synced?.[name]));
      // An alternate needs its primary stored first, even when the primary itself did not change.
      if (dirty.has('characters/alternate') && draft.alternate !== null) dirty.add('characters/primary');
      if (dirty.size === 0) {
        this.workspace.notice('The project has no unsaved changes.', 'info');
        return;
      }
      const revision = (name: ProjectSectionName): number | undefined => this.conflicts.has(name) ? undefined : binding.sections[name];
      // Only the written section's revision: other sections may have changed meanwhile, for the next poll.
      const adopt = (name: ProjectSectionName, state: ServerRevisions): void => {
        binding.sections[name] = state.sections[name]!;
      };
      // New files first, so the sections that reference them validate on the server.
      if (dirty.has('media')) {
        for (const item of media) {
          if (item.blob === null || item.uploaded) continue;
          adopt('media', await this.client.putMedia(binding.id, item.path, item.blob, revision('media')));
          if (this.media.get(item.path) === item) this.media.set(item.path, { ...item, uploaded: true });
        }
      }
      if (dirty.has('art')) {
        const uploaded = new Set<string>();
        for (const asset of assets) {
          if (asset.blob === null || asset.uploaded) continue;
          adopt('art', await this.client.postArt(binding.id, asset.blob, asset.name, revision('art')));
          uploaded.add(asset.id);
        }
        this.art = { ...this.art, assets: this.art.assets.map((asset) => uploaded.has(asset.id) ? { ...asset, uploaded: true } : asset) };
      }
      if (dirty.has('appearance')) {
        for (const part of parts) {
          if (this.syncedModels.get(part.part) === part.blob) continue;
          adopt('appearance', await this.client.putModel(binding.id, part.part, part.blob, part.name, revision('appearance')));
          this.syncedModels.set(part.part, part.blob);
        }
      }
      if (dirty.has('models')) {
        for (const item of library) {
          if (item.blob === null || item.uploaded) continue;
          adopt('models', await this.client.putLibraryModel(binding.id, item.role, item.entry, item.blob, revision('models')));
          this.library = this.library.map((candidate) => candidate === item ? { ...item, uploaded: true } : candidate);
        }
      }
      const values: Record<ProjectSectionName, unknown> = {
        title: draft.manifest.title, level: draft.level, settings: draft.manifest.settings,
        'characters/primary': draft.primary, 'characters/alternate': draft.alternate, 'arm-ik': draft.manifest.armIk,
        appearance: draft.manifest.appearance, models: draft.manifest.models, theme: draft.manifest.theme, hud: draft.manifest.hud, audio: draft.manifest.audio,
        enemies: draft.manifest.enemies, art: draft.manifest.art, media: draft.manifest.media,
      };
      // The server removes an alternate before the primary it depends on, and adds them the other way round.
      const order = draft.alternate !== null ? SAVE_ORDER : SAVE_ORDER.flatMap((name) =>
        name === 'characters/primary' ? ['characters/alternate', name] as const : name === 'characters/alternate' ? [] : [name]);
      for (const name of order) {
        if (!dirty.has(name)) continue;
        adopt(name, await this.client.putSection(binding.id, name, values[name], revision(name)));
      }
      this.syncedModels = new Map(parts.map((part) => [part.part, part.blob]));
      this.conflicts.clear();
      this.synced = baseline;
      this.workspace.level.markSaved(savedLevel);
      this.workspace.notice(`Saved ${dirty.size === 1 ? 'one section' : `${dirty.size} sections`} of "${draft.manifest.title}" to the project server.`, 'info');
    });
  }

  // Stores the whole project on the server under `id`, replacing any project with that ID.
  async saveAs(id: string): Promise<boolean> {
    return this.run('Saving to the server', async () => {
      const valid = validateProjectId(id);
      const draft = this.captureDraft();
      const baseline = this.fingerprints();
      const savedLevel = this.workspace.level.get();
      const parts = this.workspace.appearance.parts();
      const library = this.library;
      const content = await this.captureFiles(draft, parts, [...this.media.values()], [...this.art.assets], library);
      const state = await this.client.putBundle(valid, packProjectBundle(content));
      this.binding = { id: valid, revision: state.revision, sections: { ...state.sections } };
      // Files that only the previous server project held are now served by this one.
      this.media = new Map([...this.media].map(([path, item]) =>
        [path, { ...item, uploaded: true, url: item.blob === null ? this.client.mediaUrl(valid, path) : item.url }]));
      this.mediaVersion++;
      this.art = { ...this.art, assets: this.art.assets.map((asset) => ({ ...asset, uploaded: true })) };
      this.library = this.library.map((item) => library.includes(item) ? { ...item, uploaded: true } : item);
      this.syncedModels = new Map(parts.map((part) => [part.part, part.blob]));
      this.conflicts.clear();
      this.synced = baseline;
      this.remember(valid);
      this.workspace.level.markSaved(savedLevel);
      this.applyLook();
      await this.storeCopy();
      this.projects = await this.client.list();
      this.workspace.notice(`Saved the whole project as "${valid}" on the project server.`, 'info');
    });
  }

  async publish(): Promise<PublishRecord | null> {
    if (this.binding === null) {
      this.report(new ProjectError('Save the project to the project server before publishing it.'));
      return null;
    }
    if (this.dirtySections().length > 0 && !await this.save()) return null;
    const id = this.binding.id;
    let record: PublishRecord | null = null;
    await this.run('Publishing', async () => {
      record = await this.client.publish(id);
      this.publishRecord = record;
      this.workspace.notice(`Published "${this.title}": ${record.files} files, ${(record.bytes / 1024 / 1024).toFixed(1)} MiB, in ${
        (record.durationMs / 1000).toFixed(1)} s. Open ${record.url} to play it.`, 'info');
    });
    return record;
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycle.abort();
    if (this.poller !== null) clearInterval(this.poller);
    if (this.copyTimer !== null) clearInterval(this.copyTimer);
    this.copy?.dispose();
    for (const item of this.media.values()) if (item.blob !== null) URL.revokeObjectURL(item.url);
    this.media.clear();
    this.listeners.clear();
  }

  // A copy that holds changes, or another project, reopens; otherwise the published project opens.
  private async openStartProject(): Promise<void> {
    let copy: ProjectCopy | null = null;
    let failure: string | null = null;
    // Busy from the start, so no action can replace the game before the start project opens.
    this.busy = 'Opening the project';
    this.changed('status');
    try {
      copy = await this.copy!.read();
    } catch (error) {
      if (!isExpected(error)) throw error;
      failure = error.message;
    } finally {
      this.busy = null;
    }
    if (copy !== null && (copy.origin === null || copy.dirty.length > 0)) {
      if (await this.openCopy(copy)) return;
      failure = this.error;
      copy = null;
    }
    // A copy that could not be opened stays stored until the project changes.
    this.copyStored = copy !== null;
    if (await this.openPublished() && failure !== null) {
      this.workspace.notice(`This browser's copy of the project could not be opened: ${failure} Opened the published project instead; ` +
        'the copy is replaced once you change the project.', 'error');
    }
  }

  private async openCopy(copy: ProjectCopy): Promise<boolean> {
    const published = this.published!;
    return this.run('Opening this browser\'s copy', async () => {
      await this.applyContent(copy.content, null);
      this.origin = copy.origin;
      const dirty = PROJECT_SECTIONS.filter((name) => copy.dirty.includes(name));
      for (const name of dirty) this.synced![name] = UNSAVED;
      if (dirty.includes('level')) this.workspace.level.markSaved(null);
      // The page now shows exactly what the copy holds.
      const files = this.copyFiles();
      if (files !== null) {
        this.copy!.adopt(files);
        this.copyWritten = this.copyState();
      }
      this.copyStored = true;
      const title = copy.content.manifest.title;
      this.workspace.notice(copy.origin !== null && copy.origin !== published.version
        ? `"${published.title}" has a newer published version. This browser kept your unsaved changes to "${title}"; Reopen published project in Project takes the new version and discards them.`
        : `Reopened "${title}" from this browser${dirty.length > 0 ? ` with unsaved changes: ${dirty.join(', ')}` : ''}.`, 'info');
    });
  }

  // Downloads the published project and opens it as Import project file does, replacing any copy.
  private async openPublished(): Promise<boolean> {
    const published = this.published!;
    const label = 'Opening the published project';
    return this.run(label, async () => {
      let percent = -1;
      const content = await loadPublishedProject(published, {
        signal: this.lifecycle.signal,
        onProgress: (fraction) => {
          const next = Math.floor(fraction * 100);
          if (next === percent) return;
          if (Math.floor(next / 10) !== Math.floor(percent / 10)) this.workspace.notice(`Loading "${published.title}": ${next}%`, 'info');
          percent = next;
          this.busy = `${label} (${next}%)`;
          this.changed('status');
        },
      });
      await this.applyContent(content, null);
      this.origin = published.version;
      await this.storeCopy();
      if (this.error !== null) return;
      this.workspace.notice(`Opened the published project "${content.manifest.title}".`, 'info');
    });
  }

  // Whether the page holds what the published project does not: changes, or another project.
  private copyWanted(state: CopyState = this.copyState()): boolean {
    return this.binding === null && (state.origin !== this.published?.version || state.dirty.length > 0);
  }

  private copyState(): CopyState {
    const fingerprints = this.fingerprints();
    const synced = this.synced;
    return { fingerprints, origin: this.origin, dirty: synced === null ? [] : PROJECT_SECTIONS.filter((name) => fingerprints[name] !== synced[name]) };
  }

  // Runs every second: stores changes once they have held still for one check, or at once when
  // the page is being left.
  private async keepCopy(options: { now?: boolean } = {}): Promise<void> {
    if (this.copy === null || !this.keeping || this.busy !== null || this.copyTask !== null || this.disposed) return;
    const state = this.copyState();
    if (!this.copyWanted(state)) {
      if (this.copyStored) await this.storeCopy();
      return;
    }
    if (sameCopy(state, this.copyWritten) || (!options.now && sameCopy(state, this.copyFailed))) {
      this.copySeen = null;
      return;
    }
    if (!options.now && !sameCopy(state, this.copySeen)) {
      this.copySeen = state;
      return;
    }
    await this.storeCopy();
  }

  // Brings this browser's copy up to date, or removes it while the page shows the published
  // project unchanged or a server project.
  private storeCopy(): Promise<void> {
    const write = (): Promise<void> => this.writeCopy();
    const task = (this.copyTask ?? Promise.resolve()).then(write, write);
    const done = (): void => { if (this.copyTask === task) this.copyTask = null; };
    this.copyTask = task;
    task.then(done, done);
    return task;
  }

  private async writeCopy(): Promise<void> {
    const copy = this.copy;
    if (copy === null || !this.keeping || this.disposed) return;
    const state = this.copyState();
    this.copySeen = null;
    if (!this.copyWanted(state)) {
      if (!this.copyStored) return;
      try {
        await copy.clear();
        this.copyStored = false;
        this.copyWritten = null;
      } catch (error) {
        this.report(error);
      }
      this.changed('status');
      return;
    }
    if (sameCopy(state, this.copyWritten)) return;
    const files = this.copyFiles();
    // Not a complete project yet, for example while a trigger uses a sound not in the media library.
    if (files === null) return;
    try {
      await copy.write({ origin: state.origin, dirty: state.dirty }, files);
      this.copyWritten = state;
      this.copyStored = true;
      this.copyFailed = null;
      this.copyWrites++;
    } catch (error) {
      this.copyFailed = state;
      this.report(error);
    }
    this.changed('status');
  }

  // The open project's files for this browser's copy, checked like an export but without notices;
  // null while the page does not hold a valid project.
  private copyFiles(): Map<string, unknown> | null {
    const document = this.workspace.character.draft();
    const primary = this.workspace.character.hasContent() || this.alternate !== null ? document : null;
    const level = this.workspace.level.get();
    let manifest: ProjectManifest;
    try {
      manifest = validateProjectManifest({
        ...this.draftManifest(),
        characters: { primary: primary === null ? null : PROJECT_FILES.primary, alternate: this.alternate === null ? null : PROJECT_FILES.alternate },
      });
      checkProjectReferences(manifest, level);
      if (primary !== null && !this.checkedCharacters.has(primary)) {
        validateProjectCharacter(primary);
        this.checkedCharacters.add(primary);
      }
    } catch (error) {
      if (isProjectDataError(error)) return null;
      throw error;
    }
    const files = new Map<string, unknown>([[PROJECT_FILES.manifest, manifest], [PROJECT_FILES.level, level]]);
    if (primary !== null) files.set(PROJECT_FILES.primary, primary);
    if (this.alternate !== null) files.set(PROJECT_FILES.alternate, this.alternate);
    for (const part of this.workspace.appearance.parts()) files.set(appearanceFile(part.part), part.blob);
    for (const item of this.media.values()) {
      if (item.blob === null) return null;
      files.set(mediaFile(item.path), item.blob);
    }
    for (const asset of this.art.assets) {
      if (asset.blob === null) return null;
      files.set(artFile(asset.id), asset.blob);
    }
    for (const item of this.library) {
      if (item.blob === null) return null;
      files.set(libraryModelFile(item.role, item.entry.id), item.blob);
    }
    return files;
  }

  // Applies server changes to sections this page has not changed; changed ones become conflicts.
  private async poll(): Promise<void> {
    const binding = this.binding;
    if (binding === null || this.busy !== null || this.disposed || document.visibilityState !== 'visible') return;
    let state: ServerRevisions;
    try {
      state = await this.client.revisions(binding.id);
    } catch (error) {
      if (!isExpected(error)) throw error;
      return;
    }
    // binding.revision is the server revision this page has fully reconciled with.
    if (this.binding !== binding || this.busy !== null || state.revision === binding.revision) return;
    const changed = PROJECT_SECTIONS.filter((name) => state.sections[name] !== binding.sections[name]);
    const dirty = new Set(this.dirtySections());
    const conflicting = changed.filter((name) => dirty.has(name) && !this.conflicts.has(name));
    for (const name of conflicting) this.conflicts.add(name);
    if (conflicting.length > 0) {
      this.workspace.notice(`${conflicting.join(', ')} changed on the project server while you have unsaved changes. Save to overwrite, or open the project again to take the server version.`, 'error');
    }
    const incoming = changed.filter((name) => !this.conflicts.has(name));
    if (incoming.length === 0) {
      binding.revision = state.revision;
      this.changed('status');
      return;
    }
    await this.run('Updating from the server', async () => {
      const project = await this.client.project(binding.id);
      // An edit made while the revisions were in flight wins over the server's version.
      const edited = new Set(this.dirtySections());
      for (const name of incoming) if (edited.has(name)) this.conflicts.add(name);
      const applying = incoming.filter((name) => !edited.has(name));
      if (applying.length > 0) {
        const values = new Map<ProjectSectionName, unknown>();
        for (const name of applying) {
          if (name === 'characters/primary' || name === 'characters/alternate') {
            values.set(name, project.manifest.characters[name === 'characters/primary' ? 'primary' : 'alternate'] === null ? null
              : (await this.client.section(binding.id, name)).value);
          } else if (name === 'level') values.set(name, (await this.client.section(binding.id, name)).value);
        }
        const models = applying.includes('appearance')
          ? await Promise.all(project.manifest.appearance.map((part) => this.client.blob(this.client.modelUrl(binding.id, part.part)))) : [];
        try {
          await this.applySections(project.manifest, applying, values, models, binding.id, 'sync', fileSizes(project.files));
        } catch (error) {
          // Stop retrying every poll; saving overwrites the server, opening the project takes it.
          for (const name of applying) this.conflicts.add(name);
          throw error;
        }
        for (const name of applying) binding.sections[name] = project.sections[name]!;
        const synced = this.fingerprints();
        for (const name of applying) this.synced![name] = synced[name];
        this.workspace.notice(`Updated ${applying.join(', ')} from the project server.`, 'info');
      }
      // Every section that changed by this revision is now loaded or reported as a conflict.
      binding.revision = state.revision;
    });
  }

  private async applyServerProject(manifest: ProjectManifest, state: ServerRevisions & { id: string },
    files: { level: unknown; primary: unknown; alternate: unknown; models: readonly Blob[]; sizes: ReadonlyMap<string, number> }): Promise<void> {
    const values = new Map<ProjectSectionName, unknown>([
      ['level', files.level], ['characters/primary', files.primary], ['characters/alternate', files.alternate],
    ]);
    this.unbind();
    await this.applySections(manifest, PROJECT_SECTIONS, values, files.models, state.id, 'load', files.sizes);
    this.binding = { id: state.id, revision: state.revision, sections: { ...state.sections } };
    this.syncedModels = new Map(this.workspace.appearance.parts().map((part) => [part.part, part.blob]));
    this.synced = this.fingerprints();
    this.remember(state.id);
    this.workspace.level.markSaved();
    this.keeping = true;
    // The server holds the project now, so this browser's copy goes.
    await this.storeCopy();
  }

  // Validates the incoming sections completely, loads the parts that can fail, then applies the rest.
  private async applySections(manifest: ProjectManifest, names: readonly ProjectSectionName[], values: ReadonlyMap<ProjectSectionName, unknown>,
    models: readonly Blob[], serverId: string | null, mode: 'load' | 'sync' = 'load', sizes: ReadonlyMap<string, number> = new Map()): Promise<void> {
    const has = new Set(names);
    const level = has.has('level') ? validateLevel(values.get('level')) : null;
    const primary = has.has('characters/primary') ? values.get('characters/primary') === null ? EMPTY_SPRITES
      : validateProjectCharacter(values.get('characters/primary')) : null;
    const alternate = has.has('characters/alternate') ? values.get('characters/alternate') === null ? null
      : validateProjectCharacter(values.get('characters/alternate')) : undefined;
    const parts = has.has('appearance') ? validateAppearanceParts(manifest.appearance).map((part, index) => ({ ...part, blob: models[index]! })) : null;
    // Models the runtime would refuse fail here, before anything in the page changes.
    for (const part of parts ?? []) {
      const bytes = await part.blob.arrayBuffer();
      inSection('appearance', () => checkAppearanceModel(bytes));
    }
    // A project that replaces the whole character has already let go of the previous project, so it waits
    // for a character operation in progress; a sync keeps refusing, which records the conflict.
    if (primary !== null && !await this.workspace.character.load(primary, { wait: mode === 'load' })) {
      throw new ProjectError('The project character could not be loaded; see Character.', { section: 'characters/primary' });
    }
    if (parts !== null && !await this.workspace.appearance.load(parts)) {
      throw new ProjectError('Some appearance models could not be loaded; see Appearance.', { section: 'appearance' });
    }
    if (level !== null) {
      if (mode === 'sync') this.workspace.level.sync(level);
      else this.workspace.level.load(level);
    }
    if (has.has('settings')) this.workspace.settings.load(manifest.settings);
    if (alternate !== undefined) this.alternate = alternate;
    if (has.has('arm-ik')) this.workspace.appearance.loadArmIk(manifest.armIk);
    if (has.has('title')) this.title = manifest.title;
    if (has.has('theme')) this.theme = manifest.theme;
    if (has.has('hud')) this.hud = manifest.hud;
    if (has.has('enemies')) this.enemies = manifest.enemies;
    if (has.has('art')) {
      const existing = new Map(this.art.assets.map((asset) => [asset.id, asset]));
      this.art = {
        mode: manifest.art.mode, decorations: manifest.art.decorations,
        assets: manifest.art.assets.map((asset) => ({ ...asset, blob: existing.get(asset.id)?.blob ?? null, uploaded: serverId !== null })),
      };
    }
    // A server project's library files stay on the server until the Workshop needs them.
    if (has.has('models') && serverId !== null) {
      this.library = libraryEntries(manifest.models).map(({ role, entry }) => ({
        role, entry, key: this.nextLibraryKey++, blob: null, bytes: sizes.get(libraryModelFile(role, entry.id)) ?? 0, uploaded: true,
      }));
    }
    if (has.has('media') && serverId !== null) {
      const next = new Map<string, MediaItem>();
      for (const entry of manifest.media) {
        next.set(entry.path, {
          path: entry.path, blob: null, url: this.client.mediaUrl(serverId, entry.path),
          bytes: sizes.get(mediaFile(entry.path)) ?? this.media.get(entry.path)?.bytes ?? 0, uploaded: true,
        });
      }
      this.setMedia(next);
    }
    // Audio references media, so it follows the library.
    if (has.has('audio')) this.audio = manifest.audio;
    this.changed('content');
    this.applyLook();
  }

  private async applyContent(content: ProjectContent, serverId: string | null): Promise<void> {
    const { manifest } = content;
    const media = new Map(manifest.media.map((entry) => {
      const blob = new Blob([content.files.get(mediaFile(entry.path))!], { type: mediaType(entry.path) });
      return [entry.path, { path: entry.path, blob, url: URL.createObjectURL(blob), bytes: blob.size, uploaded: false }];
    }));
    const models = manifest.appearance.map((part) => new Blob([content.files.get(appearanceFile(part.part))!], { type: 'model/gltf-binary' }));
    const values = new Map<ProjectSectionName, unknown>([
      ['level', content.level], ['characters/primary', content.characters.primary], ['characters/alternate', content.characters.alternate],
    ]);
    // Library models a release would refuse fail here, before anything in the page changes.
    inSection('models', () => checkModelLibrary(manifest.models, (path) => content.files.get(path)!));
    this.unbind();
    try {
      await this.applySections(manifest, PROJECT_SECTIONS.filter((name) => name !== 'media' && name !== 'art' && name !== 'models'), values, models, serverId);
    } catch (error) {
      for (const item of media.values()) URL.revokeObjectURL(item.url);
      throw error;
    }
    this.setMedia(media);
    this.art = {
      mode: manifest.art.mode, decorations: manifest.art.decorations,
      assets: manifest.art.assets.map((asset) => ({
        ...asset, uploaded: false, blob: new Blob([content.files.get(artFile(asset.id))!], { type: 'model/gltf-binary' }),
      })),
    };
    this.library = libraryEntries(manifest.models).map(({ role, entry }) => {
      const blob = new Blob([content.files.get(libraryModelFile(role, entry.id))!], { type: 'model/gltf-binary' });
      return { role, entry, key: this.nextLibraryKey++, uploaded: false, blob, bytes: blob.size };
    });
    this.syncedModels.clear();
    this.synced = this.fingerprints();
    this.workspace.level.markSaved();
    this.keeping = true;
    this.changed('content');
    this.applyLook();
  }

  // Before a whole project replaces the page's game: a failure part way must not leave the page
  // bound to the previous server project while holding the new project's data.
  private unbind(): void {
    this.binding = null;
    this.origin = null;
    this.conflicts.clear();
    this.forget();
  }

  private setMedia(next: Map<string, MediaItem>): void {
    for (const [path, item] of this.media) if (item.blob !== null && next.get(path) !== item) URL.revokeObjectURL(item.url);
    this.media = next;
    this.mediaVersion++;
  }

  private draftManifest(): ProjectManifest {
    return validateProjectManifest({
      format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, title: this.title, level: PROJECT_FILES.level,
      art: validateProjectArt({ mode: this.art.mode, assets: this.art.assets.map(({ id, name }) => ({ id, name })), decorations: this.art.decorations }),
      settings: this.workspace.settings.get(),
      characters: { primary: null, alternate: null },
      armIk: this.workspace.appearance.armIk(),
      appearance: this.workspace.appearance.parts().map(({ part, name, alignment }) => ({ part, name, alignment })),
      models: libraryOf(this.library),
      theme: this.theme, hud: this.hud, audio: this.audio, enemies: this.enemies,
      media: [...this.media.keys()].map((path) => ({ path })),
    });
  }

  // Everything except binary files, validated together with the level's references.
  private captureDraft(): { manifest: ProjectManifest; level: LevelDefinition; primary: SpriteDocument | null; alternate: SpriteDocument | null } {
    if (!this.workspace.level.prepare()) {
      throw new ProjectError('Finish or cancel the unfinished outline, and fix any trigger events, in Level first.', { section: 'level' });
    }
    const document = this.workspace.character.validated();
    if (document === null) throw new ProjectError('The character profile cannot be saved yet; see Character.', { section: 'characters/primary' });
    const primary = this.workspace.character.hasContent() || this.alternate !== null ? document : null;
    const level = validateLevel(this.workspace.level.get());
    const manifest = validateProjectManifest({
      ...this.draftManifest(),
      characters: { primary: primary === null ? null : PROJECT_FILES.primary, alternate: this.alternate === null ? null : PROJECT_FILES.alternate },
    });
    checkProjectReferences(manifest, level);
    return { manifest, level, primary, alternate: this.alternate };
  }

  // The binary files for a captured draft, read from local blobs or the bound server project.
  private async captureFiles(draft: ReturnType<ProjectSession['captureDraft']>, parts: readonly AppearanceFile[],
    media: readonly MediaItem[], assets: readonly ArtItem[], library: readonly LibraryItem[]): Promise<ProjectContent> {
    const source = this.binding?.id ?? null;
    const files = new Map<string, Uint8Array>();
    for (const part of parts) files.set(appearanceFile(part.part), new Uint8Array(await part.blob.arrayBuffer()));
    for (const item of media) files.set(mediaFile(item.path), new Uint8Array(await (item.blob ?? await this.client.blob(item.url)).arrayBuffer()));
    for (const asset of assets) {
      const blob = asset.blob ?? (source === null ? null : await this.client.blob(this.client.artUrl(source, asset.id)));
      if (blob === null) throw new ProjectError(`Course artwork ${asset.name} is not available in this page.`, { section: 'art' });
      files.set(artFile(asset.id), new Uint8Array(await blob.arrayBuffer()));
    }
    for (const item of library) {
      const blob = item.blob ?? (source === null ? null : await this.client.blob(this.client.libraryModelUrl(source, item.role, item.entry.id)));
      if (blob === null) throw new ProjectError(`Library ${item.role} ${item.entry.name} is not available in this page.`, { section: 'models' });
      files.set(libraryModelFile(item.role, item.entry.id), new Uint8Array(await blob.arrayBuffer()));
    }
    return loadProjectContent(draft.manifest, (ref) => ref.kind === 'level' ? draft.level
      : ref.kind === 'character' ? (ref.path === PROJECT_FILES.primary ? draft.primary : draft.alternate) : files.get(ref.path));
  }

  private fingerprints(): Record<ProjectSectionName, unknown> {
    const blob = (value: Blob | null): number => {
      if (value === null) return 0;
      let id = this.blobIds.get(value);
      if (id === undefined) {
        id = this.nextBlobId++;
        this.blobIds.set(value, id);
      }
      return id;
    };
    return {
      title: this.title,
      level: this.workspace.level.get(),
      settings: JSON.stringify(this.workspace.settings.get()),
      'characters/primary': this.workspace.character.draft(),
      'characters/alternate': this.alternate,
      'arm-ik': JSON.stringify(this.workspace.appearance.armIk()),
      appearance: JSON.stringify(this.workspace.appearance.parts().map((part) => [part.part, part.name, blob(part.blob), part.alignment])),
      models: JSON.stringify(this.library.map((item) => [item.role, item.entry, blob(item.blob)])),
      theme: this.theme, hud: this.hud, audio: this.audio, enemies: this.enemies,
      art: JSON.stringify([this.art.mode, this.art.assets.map((asset) => [asset.id, asset.name]), this.art.decorations]),
      media: JSON.stringify([...this.media.values()].map((item) => [item.path, blob(item.blob)])),
    };
  }

  private replaceMedia(path: string, item: MediaItem | null): void {
    const next = new Map(this.media);
    if (item === null) next.delete(path);
    else next.set(path, item);
    this.setMedia(next);
    this.applyLook();
  }

  private setSection(update: () => void): boolean {
    try {
      update();
      this.applyLook();
      this.changed('status');
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private applyLook(): void {
    this.workspace.onLook({
      theme: this.theme, hud: this.hud, enemies: this.enemies, audio: this.audio,
      resolveMedia: this.resolveMedia, mediaVersion: this.mediaVersion,
    });
  }

  private async run(label: string, task: () => Promise<void>): Promise<boolean> {
    if (this.busy !== null) {
      this.workspace.notice(`Wait for "${this.busy}" to finish first.`, 'error');
      return false;
    }
    this.busy = label;
    this.error = null;
    this.changed('status');
    try {
      await task();
      return true;
    } catch (error) {
      if (error instanceof ProjectApiError && error.status === 412 && error.section !== null) {
        this.conflicts.add(error.section as ProjectSectionName);
        this.report(new ProjectError(`${error.message} Save again to overwrite the server's ${error.section}, or open the project again to take it.`));
      } else {
        this.report(error);
      }
      return false;
    } finally {
      this.busy = null;
      this.changed('status');
    }
  }

  private report(error: unknown): void {
    if (!isExpected(error)) throw error;
    this.error = error instanceof SyntaxError ? `The file is not valid JSON: ${error.message}` : describe(error);
    this.workspace.notice(this.error, 'error');
    this.changed('status');
  }

  private changed(kind: ProjectEvent['kind']): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener({ kind });
  }

  private rememberedProject(): string | null {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? 'null');
      const id = typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : null;
      return typeof id === 'string' ? id : null;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof DOMException) return null;
      throw error;
    }
  }

  private remember(id: string): void {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id }));
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }

  private forget(): void {
    try {
      localStorage.removeItem(ACTIVE_KEY);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }
}

function fileSizes(files: readonly { readonly path: string; readonly bytes: number }[]): Map<string, number> {
  return new Map(files.map((file) => [file.path, file.bytes]));
}

function projectFileName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

