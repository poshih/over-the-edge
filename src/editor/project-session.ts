import { validateAppearanceParts } from '../appearance-profile';
import { checkAppearanceModel } from '../appearance-model';
import type { VisualAlignment } from '../appearance-profile';
import { audioSources, DEFAULT_AUDIO, validateAudio } from '../audio-settings';
import type { AudioSettings } from '../audio-settings';
import type { ArmIkSettings, VisualPartId } from '../character';
import type { AvatarModelSettings } from '../character-profile';
import { embeddedModel } from '../character-profile';
import { checkCharacterModels } from '../character-model-check';
import { ART_LIMITS, ArtError, artName } from '../art-types';
import type { DecorationArt } from '../decoration-art';
import { unknownDecorationModels } from '../decoration-models';
import { validateCoursePackage } from '../course-package';
import { STARTER_LEVEL } from '../default-course';
import { DEFAULT_ENEMY_ART, validateEnemyArt } from '../enemy-art-data';
import type { EnemyArtSettings } from '../enemy-art-data';
import type { GameSettings } from '../game-settings';
import { DEFAULT_HUD, validateHud } from '../hud';
import type { HudSettings } from '../hud';
import { validateLevel } from '../level';
import type { LevelDefinition } from '../level';
import { checkMediaBytes, MEDIA_LIMITS, mediaFile, mediaKind, mediaPathForFile, mediaType } from '../media';
import { meshTerrain } from '../mesh-collision';
import type { MeshTerrain } from '../mesh-collision';
import { MeshBaker } from './mesh-baker';
import {
  appearanceFile, artFile, checkBundleSize, checkFileBudget, checkProjectReferences, defaultProjectManifest, inSection, isProjectDataError,
  loadProjectContent, packProjectBundle, parseProjectCharacter, PROJECT_FILES, PROJECT_FORMAT, PROJECT_LIMITS,
  PROJECT_SCHEMA_VERSION, projectFileRefs, projectFileType, ProjectError, projectTitle, unpackProjectBundle, validateMediaIndex,
  validateProjectArt, validateProjectCharacter, validateProjectId, validateProjectManifest,
} from '../project';
import type { ProjectArt, ProjectBundle, ProjectContent, ProjectManifest } from '../project';
import { EMPTY_SPRITES } from '../sprite-data';
import type { SpriteDocument } from '../sprite-data';
import { decodeBase64 } from '../sprite-fields';
import { MODEL_LIMITS } from '../model-data';
import {
  checkLibraryModel, checkModelLibrary, libraryAvatarSettings, libraryEntries, libraryHammerHead, libraryIdForName, libraryModelFile,
  MODEL_LIBRARY_LIMITS, newAvatarEntry, PART_ROLES, validateAvatarSettings, validateModelLibrary,
} from '../model-library';
import type {
  AvatarHoldSettings, LibraryAvatarEntry, LibraryAvatarSettings, LibraryEntry, LibraryHammerEntry, ModelLibrary, PartRole,
} from '../model-library';
import type { HammerHead } from '../hammer-head';
import type { AvatarRigRegistry } from '../avatar-rig';
import { DEFAULT_THEME, validateTheme } from '../theme';
import type { GameTheme } from '../theme';
import { DEFAULT_LOOK, NO_COURSE_ARTWORK } from '../game-look';
import type { CourseArtwork, GameLook } from '../game-look';
import { NO_PLUGIN_DATA, pluginDataIn, pluginOfSection, pluginSection, validatePluginData, withPluginData } from '../plugin-data';
import type { PluginData } from '../plugin-data';
import { sameJson } from '../bounded-json';
import { sha256Hex } from '../sha256';
import { ProjectApiError, ProjectClient } from './project-client';
import type { PublishRecord, ServerHealth, ServerProjectSummary, ServerRevisions } from './project-client';
import { ProjectCopyStore } from './project-copy';
import type { ProjectCopy } from './project-copy';
import { DEFAULT_COURSE_FILES, openDefaultCourse } from './default-course-files';
import { downloadPublishedFile, loadPublishedProject } from './published-project';
import type { OpenedFile, OpenedProject, PublishedFile, PublishedProject } from './published-project';
import { ServerModelError } from './server-models';

// The engine's sections. Besides them, each Workshop plugin's data is a section of its own, `plugins/<id>`.
export const PROJECT_SECTIONS = [
  'title', 'level', 'settings', 'characters/primary', 'characters/alternate', 'arm-ik', 'appearance', 'models',
  'theme', 'hud', 'audio', 'enemies', 'art', 'media',
] as const;
export type BuiltinSectionName = (typeof PROJECT_SECTIONS)[number];
export type ProjectSectionName = BuiltinSectionName | `plugins/${string}`;

// Each section's state, by name: a plugin section without data has none.
type SectionRecord<T> = Partial<Record<ProjectSectionName, T>>;

export function isProjectSection(name: string): name is ProjectSectionName {
  return (PROJECT_SECTIONS as readonly string[]).includes(name) || pluginOfSection(name) !== null;
}

// The Workshop's plugins, as the project needs them: which it has, and each one's own check of its data, which returns
// the plugin's typed refusal or null.
export interface ProjectPlugins {
  has(id: string): boolean;
  validate(id: string, data: PluginData): Error | null;
}

const NO_PLUGINS: ProjectPlugins = Object.freeze({ has: () => false, validate: () => null });

// Server writes happen in this order, so new files exist before references and references go before removals. Plugin
// sections reference nothing, so they go last.
const SAVE_ORDER: readonly BuiltinSectionName[] = [
  'title', 'settings', 'arm-ik', 'theme', 'hud', 'enemies', 'level', 'audio',
  'characters/primary', 'characters/alternate', 'art', 'appearance', 'models', 'media',
];
const ACTIVE_KEY = 'over-the-edge:project:active:v1';
const POLL_MS = 2000;
const COPY_MS = 1000;
// A server project saves itself: changes are written once they have held still for one check. A write that failed to
// reach the server is retried after SAVE_RETRY_MS; one the server refused waits for the sections to change.
const SAVE_MS = 1000;
const SAVE_RETRY_MS = 5000;
// Sections whose files a server project keeps on the server; a project opened from anywhere else lists them from its own
// files (openedMedia, openedArt and openedLibrary).
const LOCAL_FILES: ReadonlySet<ProjectSectionName> = new Set(['media', 'art', 'models']);
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
  // How the game looks, as the project stands, saved or not.
  readonly game: GameLook;
  readonly audio: AudioSettings;
  readonly resolveMedia: (source: string) => string;
  // Changes whenever media files change, so caches of their contents can be dropped.
  readonly mediaVersion: number;
}

// Where a binary file's bytes are. The page reads them only when it uses the file: to preview, upload or export it.
interface FileSource {
  // Bytes in this page (picked, imported or kept in this browser's copy), or null for a file only held elsewhere.
  readonly blob: Blob | null;
  // The server project that holds the file, or null; the bound project holds it when this is its ID.
  readonly server: string | null;
  // The published project's file with these bytes, or null.
  readonly published: PublishedFile | null;
}

interface MediaItem extends FileSource {
  readonly path: string;
  // What media elements play: an object URL of the page's bytes, or the server project's or published project's URL.
  readonly url: string;
  readonly bytes: number;
}

interface ArtItem extends FileSource {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
}

// The course artwork: the GLBs and the decoration models they draw.
interface CourseArt {
  assets: ArtItem[];
  decorations: DecorationArt;
}

// One model in the project's library. A file the page does not hold stays on the server or the site until needed.
interface LibraryItem extends FileSource {
  readonly role: PartRole;
  readonly entry: LibraryEntry | LibraryAvatarEntry;
  // Identifies the item's GLB in this page: it changes whenever the file may have.
  readonly key: number;
  // The GLB's size, as its holder reported it.
  readonly bytes: number;
}

// A library model as the Workshop shows it.
export interface LibraryModel {
  readonly role: PartRole;
  readonly id: string;
  readonly name: string;
  readonly key: number;
  // An avatar's settings, the same object until they change; null for a hammer or pot.
  readonly avatar: LibraryAvatarSettings | null;
  // A hammer's head outline, the same object until it changes; null for an avatar or pot.
  readonly head: HammerHead | null;
}

function libraryOf(items: readonly LibraryItem[]): ModelLibrary {
  return validateModelLibrary(Object.fromEntries(PART_ROLES.map((role) => [role, items.filter((item) => item.role === role).map((item) => item.entry)])));
}

interface Binding {
  readonly id: string;
  revision: number;
  // The server's revision of each section this page reconciled with; a plugin section absent here is at revision 0.
  readonly sections: Record<string, number>;
  // The level version of the level and game settings this page last saved or loaded, once the project said which.
  version: BoundVersion | null;
}

// A saved level version of the open server project, a level with its game settings, which the page plays, and the
// phantom course of its recordings.
export interface PlayedVersion {
  readonly project: string;
  readonly version: number;
  readonly course: string;
}

// The page plays the version while its level is still this object and its settings this text: their synced fingerprints
// when the project said which version they are.
interface BoundVersion extends PlayedVersion {
  readonly level: unknown;
  readonly settings: unknown;
}

// The sections a level version holds.
const VERSIONED = ['level', 'settings'] as const;

// What this browser's copy holds, or would hold: compared section by section.
interface CopyState {
  readonly fingerprints: SectionRecord<unknown>;
  readonly origin: string | null;
  readonly dirty: readonly ProjectSectionName[];
}

// A save that left changed sections unsaved: what they were, why, and when to try them again unchanged (null: only
// once they change).
interface SaveFailure {
  readonly fingerprints: SectionRecord<unknown>;
  readonly message: string;
  readonly retryAt: number | null;
}

// Unsaved changes this browser kept to a server project's published version, found when that project opened.
interface KeptChanges {
  readonly copy: ProjectCopy;
  readonly project: string;
  readonly sections: readonly ProjectSectionName[];
}

function sameCopy(a: CopyState | null, b: CopyState | null): boolean {
  return a !== null && b !== null && a.origin === b.origin && a.dirty.join() === b.dirty.join() &&
    sameSections(a.fingerprints, b.fingerprints);
}

// Whether two sets of fingerprints hold the same sections, a plugin section without data in either included.
function sameSections(a: SectionRecord<unknown>, b: SectionRecord<unknown>): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)] as ProjectSectionName[]);
  return [...names].every((name) => a[name] === b[name]);
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
    readonly assets: readonly { readonly id: string; readonly name: string }[];
    readonly decorations: DecorationArt;
  };
  readonly media: readonly { readonly path: string; readonly bytes: number; readonly kind: 'video' | 'audio' }[];
  readonly library: readonly LibraryModel[];
  readonly alternate: SpriteDocument | null;
  // The plugins this project keeps data for.
  readonly plugins: readonly string[];
  readonly publish: PublishRecord | null;
  readonly error: string | null;
  // The project this Workshop was built with (GAME_PROJECT), and whether the page shows a version
  // of it: the current one, an older one kept with its changes, or another project.
  readonly published: { readonly title: string; readonly version: string; readonly origin: 'current' | 'outdated' | 'none' } | null;
  // This browser's copy of the open project, in a Workshop built with a project.
  readonly browserCopy: { readonly stored: boolean; readonly pending: boolean; readonly writes: number } | null;
  // Automatic saving to the open server project, null without one: whether a save is running, and why changes are not
  // saved yet.
  readonly autosave: { readonly saving: boolean; readonly problem: string | null } | null;
  // Sections with unsaved changes this browser kept from an earlier session, waiting to be restored into the open server
  // project or discarded; null when there are none.
  readonly kept: readonly ProjectSectionName[] | null;
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
  // The avatar drivers this Workshop accepts; the composed Kinds registry reaches every validator.
  private readonly avatarRigs: AvatarRigRegistry;
  private readonly plugins: ProjectPlugins;
  private readonly client: ProjectClient;
  private readonly published: PublishedProject | null;
  private readonly copy: ProjectCopyStore | null;
  private readonly lifecycle = new AbortController();
  private readonly listeners = new Set<(event: ProjectEvent) => void>();
  private readonly blobIds = new WeakMap<Blob, number>();
  // Each course mesh's collision by turn, `${id}:${turn}`, each baked once: an asset ID names its GLB's bytes, so it never
  // goes stale.
  private readonly meshTerrains = new Map<string, Promise<MeshTerrain>>();
  // Bakes them off the page's thread.
  private readonly baker = new MeshBaker();
  private nextBlobId = 1;
  private title = 'Untitled game';
  private theme: GameTheme = DEFAULT_THEME;
  private hud: HudSettings = DEFAULT_HUD;
  private audio: AudioSettings = DEFAULT_AUDIO;
  private enemies: EnemyArtSettings = DEFAULT_ENEMY_ART;
  // The page starts on the built-in course, which DEFAULT_LEVEL draws with these meshes.
  private art: CourseArt = openedArt(openDefaultCourse(this.title));
  // The look last given to the game, and its course artwork, kept while they stay the same so the game redraws nothing.
  private gameLook: GameLook = DEFAULT_LOOK;
  private artwork: CourseArtwork = NO_COURSE_ARTWORK;
  // Whether the project the page edits has opened; until then the game draws no course artwork, so the meshes of a
  // course replaced at start never load.
  private courseShown = false;
  private media = new Map<string, MediaItem>();
  private mediaVersion = 0;
  private library: LibraryItem[] = [];
  private nextLibraryKey = 1;
  // One settings object per avatar entry, so views can tell when an avatar's settings changed.
  private readonly avatarSettings = new WeakMap<LibraryAvatarEntry, LibraryAvatarSettings>();
  private alternate: SpriteDocument | null = null;
  // Each plugin's data, the same object until it changes; data for a plugin this Workshop lacks stays as it came.
  private pluginData: Readonly<Record<string, PluginData>> = NO_PLUGIN_DATA;
  private binding: Binding | null = null;
  // The project a Save as moves the page to, while that project lacks some of its sections: the page is bound to it, but
  // remembers the project it came from and keeps this browser's copy until the move completes.
  private moving: string | null = null;
  private synced: SectionRecord<unknown> | null = null;
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
  // Automatic saving (autosave): its check timer, the save running, the fingerprints the previous check saw, and the
  // last save that left changes unsaved.
  private saver: ReturnType<typeof setInterval> | null = null;
  private saving: Promise<void> | null = null;
  private saveSeen: SectionRecord<unknown> | null = null;
  private saveFailure: SaveFailure | null = null;
  // Changes this browser kept to the Workshop's own project, found when it opened from the server at start.
  private kept: KeptChanges | null = null;
  private readonly checkedCharacters = new WeakSet<SpriteDocument>();
  // The settings' JSON, worked out once per settings object.
  private settingsJson: { readonly settings: GameSettings; readonly text: string } | null = null;
  // Each character draft validated once, so repeated saves do not report the same problem again.
  private readonly validatedDrafts = new WeakMap<SpriteDocument, SpriteDocument | null>();

  constructor(options: {
    workspace: ProjectWorkspace; avatarRigs: AvatarRigRegistry; plugins?: ProjectPlugins; client?: ProjectClient; published?: PublishedProject | null;
  }) {
    this.workspace = options.workspace;
    this.avatarRigs = options.avatarRigs;
    this.plugins = options.plugins ?? NO_PLUGINS;
    this.client = options.client ?? new ProjectClient();
    this.published = options.published ?? null;
    this.copy = this.published === null ? null : new ProjectCopyStore([...this.published.files, ...DEFAULT_COURSE_FILES]);
  }

  // After the editors restore their browser-local state: find the server and open its project, the one this page
  // opened last or else the one this Workshop was started with; every change then saves to it. Otherwise a Workshop
  // built with a project reopens this browser's copy or the published project.
  async start(): Promise<void> {
    await this.workspace.ready;
    if (this.disposed) return;
    this.synced = this.fingerprints();
    this.applyLook();
    await this.refreshServer();
    const server = this.server;
    const signedIn = server !== null && server.available && server.authenticated;
    const listed = (id: string | null): string | null => id !== null && this.projects.some((project) => project.id === id) ? id : null;
    const remembered = signedIn ? listed(this.rememberedProject()) : null;
    const own = signedIn ? listed(server.project) : null;
    // This browser's copy of the Workshop's own project, which may hold changes from an earlier session.
    const copy = own === null ? null : await this.readCopy();
    // A copy holding another project (imported or new) reopens instead, as without a server.
    const opening = remembered ?? (copy?.origin === null ? null : own);
    if (opening !== null && !this.disposed) await this.open(opening);
    if (own !== null && this.binding?.id === own && !this.disposed) await this.keepChanges(own, copy);
    if (this.binding === null && this.published !== null && !this.disposed) await this.openStartProject();
    if (this.disposed) return;
    this.courseShown = true;
    this.applyLook();
    this.poller = setInterval(() => { void this.poll(); }, POLL_MS);
    this.saver = setInterval(() => { void this.autosave(); }, SAVE_MS);
    // Leaving the page saves, or stores in this browser, the latest changes at once.
    const leaving = (): void => {
      void this.autosave({ now: true });
      void this.keepCopy({ now: true });
    };
    const signal = this.lifecycle.signal;
    window.addEventListener('beforeunload', leaving, { signal });
    window.addEventListener('pagehide', leaving, { signal });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leaving(); }, { signal });
    if (this.copy !== null) this.copyTimer = setInterval(() => { void this.keepCopy(); }, COPY_MS);
  }

  snapshot(): ProjectSnapshot {
    return {
      title: this.title,
      binding: this.binding === null ? null : { id: this.binding.id, revision: this.binding.revision },
      server: this.server, projects: this.projects, busy: this.busy,
      dirty: this.dirtySections(), conflicts: [...this.conflicts],
      theme: this.theme, hud: this.hud, audio: this.audio, enemies: this.enemies,
      art: { assets: this.art.assets.map(({ id, name }) => ({ id, name })), decorations: this.art.decorations },
      media: [...this.media.values()].map((item) => ({ path: item.path, bytes: item.bytes, kind: mediaKind(item.path) })),
      library: this.library.map(({ role, entry, key }) => ({
        role, id: entry.id, name: entry.name, key, avatar: role === 'avatar' ? this.settingsOf(entry as LibraryAvatarEntry) : null,
        head: role === 'hammer' ? (entry as LibraryHammerEntry).head : null,
      })),
      alternate: this.alternate, plugins: Object.keys(this.pluginData), publish: this.publishRecord, error: this.error,
      published: this.published === null ? null : {
        title: this.published.title, version: this.published.version,
        origin: this.origin === this.published.version ? 'current' : this.origin === null ? 'none' : 'outdated',
      },
      browserCopy: this.copy === null ? null : { stored: this.copyStored, pending: this.hasUnsavedProjectChanges(), writes: this.copyWrites },
      autosave: this.binding === null ? null : { saving: this.saving !== null, problem: this.saveFailure?.message ?? null },
      kept: this.kept?.sections ?? null,
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
    return this.sectionNames().filter((name) => current[name] !== this.synced![name]);
  }

  // The open project's manifest as it would save now, unsaved changes included.
  manifest(): ProjectManifest {
    return this.manifestDraft();
  }

  // A plugin's data in the open project, or null without any.
  pluginDataOf(id: string): PluginData | null {
    return pluginDataIn(this.pluginData, id);
  }

  // Replaces a plugin's data, or removes it with null. The data must fit the engine's limits and pass the plugin's own
  // validation; it then saves like any section. Returns the refusal, the plugin's own typed error when its validation
  // refused, which is also reported; null when the data changed or was already the same.
  setPluginData(id: string, value: unknown): Error | null {
    try {
      const data = value === null ? null : validatePluginData(id, value);
      if (data !== null) {
        const refusal = this.plugins.validate(id, data);
        if (refusal !== null) {
          this.report(pluginRefusal(id, refusal));
          return refusal;
        }
      }
      const current = pluginDataIn(this.pluginData, id);
      if (data === null ? current === null : current !== null && sameJson(current, data)) return null;
      this.pluginData = withPluginData(this.pluginData, id, data);
      this.changed('content');
      return null;
    } catch (error) {
      if (!isProjectDataError(error)) throw error;
      this.report(error);
      return error;
    }
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

  // Each edit returns its refusal, which is also reported, or null when it applied.
  setTitle(value: string): Error | null {
    try {
      this.title = projectTitle(value);
      this.changed('status');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  setTheme(value: unknown): Error | null { return this.setSection(() => { this.theme = validateTheme(value); }); }
  setHud(value: unknown): Error | null { return this.setSection(() => { this.hud = validateHud(value); }); }
  setEnemies(value: unknown): Error | null { return this.setSection(() => { this.enemies = validateEnemyArt(value); }); }

  setAudio(value: unknown): Error | null {
    return this.setSection(() => {
      const audio = validateAudio(value);
      const missing = audioSources(audio).filter((source) => source.startsWith('/') && !this.media.has(source));
      if (missing.length > 0) throw new ProjectError(`Add ${missing[0]} to the media library first.`, { section: 'audio' });
      this.audio = audio;
    });
  }

  // The added file's /media/ path, or the refusal.
  async addMedia(file: File): Promise<string | Error> {
    try {
      const path = mediaPathForFile(file.name);
      if (path === null) throw new ProjectError('Choose a .webm, .mp4, .mp3, .ogg, .wav or .m4a file with a letter or digit in its name.', { section: 'media' });
      if (file.size === 0 || file.size > MEDIA_LIMITS.bytes) throw new ProjectError(`Media files hold 1 byte to ${MEDIA_LIMITS.bytes / 1024 ** 2} MiB.`, { section: 'media' });
      // The signature is at the start; the server checks the whole file again on upload.
      checkMediaBytes(path, new Uint8Array(await file.slice(0, 64).arrayBuffer()));
      validateMediaIndex([...[...this.media.keys()].filter((existing) => existing !== path).map((existing) => ({ path: existing })), { path }]);
      const total = [...this.media.values()].reduce((sum, item) => sum + (item.path === path ? 0 : item.bytes), file.size);
      if (total > MEDIA_LIMITS.totalBytes) throw new ProjectError(`The media library holds at most ${MEDIA_LIMITS.totalBytes / 1024 ** 2} MiB.`, { section: 'media' });
      this.replaceMedia(path, { path, blob: file, server: null, published: null, url: URL.createObjectURL(file), bytes: file.size });
      this.changed('content');
      return path;
    } catch (error) {
      return this.refuse(error);
    }
  }

  removeMedia(path: string): Error | null {
    try {
      const manifest = { ...this.draftManifest(), media: [...this.media.keys()].filter((existing) => existing !== path).map((existing) => ({ path: existing })) };
      checkProjectReferences(validateProjectManifest(manifest), this.workspace.level.get());
      this.replaceMedia(path, null);
      this.changed('content');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  // The course artwork's GLBs, which the level places as terrain meshes and course artwork maps onto decorations.
  courseMeshes(): readonly { readonly id: string; readonly name: string }[] {
    return this.art.assets.map(({ id, name }) => ({ id, name }));
  }

  // The decoration models the course artwork draws, by model ID, as the project stands.
  decorationArt(): DecorationArt {
    return this.art.decorations;
  }

  // The decoration models the course artwork draws, by model ID, each with the name of the GLB drawing it.
  decorationModels(): readonly { readonly id: string; readonly name: string }[] {
    const names = new Map(this.art.assets.map((asset) => [asset.id, asset.name]));
    return Object.entries(this.art.decorations).map(([id, asset]) => ({ id, name: names.get(asset) ?? asset }));
  }

  // A course mesh's GLB, from this page, the server project that holds it or the published project.
  async courseMeshBlob(id: string): Promise<Blob> {
    const asset = this.art.assets.find((candidate) => candidate.id === id);
    if (asset === undefined) throw new ProjectError(`The course artwork has no mesh ${id}.`, { section: 'art' });
    return this.artBlob(asset);
  }

  // A course mesh turned `turn` radians about its vertical axis, ready to place: its collision is the shape its GLB
  // declares, or else the turned mesh's slice on the obstacle line or its projection along the view, baked off the page's
  // thread. Or the refusal, reported, when its GLB cannot be read or those outlines cannot be traced.
  async courseMeshTerrain(id: string, turn: number): Promise<MeshTerrain | Error> {
    const key = `${id}:${turn}`;
    let terrain = this.meshTerrains.get(key);
    if (terrain === undefined) {
      const baking = this.baker.bake(id, async () => (await this.courseMeshBlob(id)).arrayBuffer(), turn);
      // A bake that failed is tried again next time.
      baking.catch(() => { if (this.meshTerrains.get(key) === baking) this.meshTerrains.delete(key); });
      this.meshTerrains.set(key, baking);
      terrain = baking;
    }
    try {
      return await terrain;
    } catch (error) {
      return this.refuse(error);
    }
  }

  // Adds a GLB to the course artwork as a mesh to place, checked like releases check it; the same GLB again adds
  // nothing. The mesh ready to place, or the refusal.
  async addCourseMesh(file: File): Promise<{ readonly id: string; readonly name: string; readonly terrain: MeshTerrain } | Error> {
    try {
      if (file.size === 0 || file.size > ART_LIMITS.bytes) {
        throw new ArtError(`Choose a GLB file no larger than ${ART_LIMITS.bytes / 1024 ** 2} MiB.`);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = `asset-${await sha256Hex(bytes)}`;
      const terrain = meshTerrain(id, bytes.buffer);
      this.meshTerrains.set(`${id}:0`, Promise.resolve(terrain));
      const existing = this.art.assets.find((asset) => asset.id === id);
      if (existing !== undefined) return { id, name: existing.name, terrain };
      const name = artName(file.name.replace(/\.glb$/i, '').slice(0, 80) || 'Mesh');
      const blob = new Blob([bytes], { type: 'model/gltf-binary' });
      const assets = [...this.art.assets, { id, name, blob, server: null, published: null, bytes: blob.size }];
      inSection('art', () => validateProjectArt({ assets: assets.map((asset) => ({ id: asset.id, name: asset.name })), decorations: this.art.decorations }));
      checkFileBudget('art', assets.reduce((sum, asset) => sum + asset.bytes, 0));
      this.art = { ...this.art, assets };
      this.applyLook();
      this.changed('content');
      return { id, name, terrain };
    } catch (error) {
      return this.refuse(error);
    }
  }

  // Removes a GLB from the course artwork; the refusal while the level places it or a decoration draws it.
  removeCourseMesh(id: string): Error | null {
    try {
      const assets = this.art.assets.filter((asset) => asset.id !== id);
      const decorations = Object.entries(this.art.decorations).filter(([, asset]) => asset === id).map(([model]) => model);
      if (decorations.length > 0) {
        throw new ProjectError(`The mesh draws the decoration model ${decorations.join(', ')}; import a course package without it first.`, { section: 'art' });
      }
      const art = { assets: assets.map(({ id: asset, name }) => ({ id: asset, name })), decorations: this.art.decorations };
      checkProjectReferences(validateProjectManifest({ ...this.draftManifest(), art }), this.workspace.level.get());
      this.art = { ...this.art, assets };
      this.applyLook();
      this.changed('content');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  // Downloads a file as one of the session's operations, so the open project cannot change while it
  // arrives. Null when another operation is running or the download failed, which is reported.
  async download(label: string, source: () => Promise<File>): Promise<File | null> {
    const result: { file: File | null } = { file: null };
    await this.run(label, async () => { result.file = await source(); });
    return result.file;
  }

  // Adds a GLB to the model library for one part, checked like releases check it. A new avatar uses `model` (its bone
  // map, driver and hair) or maps its joints automatically, and takes the open character's grips, arm lengths and arm
  // forward distance. Returns the new model, or the refusal.
  async addLibraryModel(role: PartRole, file: File, model?: AvatarModelSettings): Promise<LibraryModel | Error> {
    try {
      if (file.size === 0 || file.size > MODEL_LIMITS.bytes) {
        throw new ProjectError(`Choose a GLB file no larger than ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`, { section: 'models' });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const taken = new Set(this.library.filter((item) => item.role === role).map((item) => item.entry.id));
      const stem = libraryIdForName(file.name);
      let id = stem;
      for (let suffix = 2; taken.has(id); suffix++) id = `${stem.slice(0, MODEL_LIBRARY_LIMITS.id - String(suffix).length - 1)}-${suffix}`;
      const base = { id, name: file.name.replace(/\.glb$/i, '').trim().slice(0, MODEL_LIBRARY_LIMITS.name) || id };
      const settings = this.characterAvatarSettings();
      // A new hammer starts with the game's default head.
      const entry = role === 'hammer' ? { ...base, head: this.workspace.settings.get().rig.head }
        : role !== 'avatar' ? base : model === undefined
          ? inSection('models', () => newAvatarEntry(bytes, base, settings, this.avatarRigs))
          : { ...base, ...model, ...settings };
      inSection('models', () => checkLibraryModel(role, entry, bytes, this.avatarRigs));
      const blob = new Blob([bytes], { type: 'model/gltf-binary' });
      const items = [...this.library, { role, entry, key: this.nextLibraryKey++, blob, server: null, published: null, bytes: blob.size }];
      inSection('models', () => libraryOf(items));
      this.library = items;
      this.changed('content');
      return this.snapshot().library.find((model) => model.role === role && model.id === id)!;
    } catch (error) {
      return this.refuse(error);
    }
  }

  removeLibraryModel(role: PartRole, id: string): void {
    this.library = this.library.filter((item) => item.role !== role || item.entry.id !== id);
    this.changed('content');
  }

  // Changes a library avatar's bone map and settings; the bone map must resolve against its model.
  // The library's hammers with their heads, without the rest of a snapshot.
  libraryHammers(): readonly { readonly id: string; readonly name: string; readonly head: HammerHead }[] {
    return this.library.flatMap(({ role, entry }) => role === 'hammer' ? [{ id: entry.id, name: entry.name, head: (entry as LibraryHammerEntry).head }] : []);
  }

  // Gives a library hammer a new head outline; the refusal, reported, when the outline is not a valid head.
  setLibraryHammerHead(id: string, head: HammerHead): Error | null {
    try {
      const item = this.libraryItem('hammer', id);
      const entry: LibraryHammerEntry = Object.freeze({ id, name: item.entry.name, head: inSection('models', () => libraryHammerHead(head)) });
      this.library = this.library.map((candidate) => candidate === item ? { ...item, entry } : candidate);
      this.changed('content');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  async setLibraryAvatar(id: string, settings: LibraryAvatarSettings): Promise<Error | null> {
    try {
      const item = this.libraryItem('avatar', id);
      const entry: LibraryAvatarEntry = Object.freeze({
        id, name: item.entry.name, ...inSection('models', () => validateAvatarSettings(settings as unknown as Record<string, unknown>)),
      });
      const bytes = new Uint8Array(await (await this.libraryBlob('avatar', id)).arrayBuffer());
      inSection('models', () => checkLibraryModel('avatar', entry, bytes, this.avatarRigs));
      if (!this.library.includes(item)) {
        throw new ProjectError(`Library avatar "${id}" changed while its model was checked; try again.`, { section: 'models' });
      }
      this.library = this.library.map((candidate) => candidate === item ? { ...item, entry } : candidate);
      this.changed('content');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  // Gives a library avatar the open character's grips, arm lengths and arm forward distance.
  async useCharacterSettings(id: string): Promise<Error | null> {
    const item = this.library.find((candidate) => candidate.role === 'avatar' && candidate.entry.id === id);
    if (item === undefined) return this.refuse(new ProjectError(`The project has no library avatar "${id}".`, { section: 'models' }));
    return this.setLibraryAvatar(id, { ...libraryAvatarSettings(item.entry as LibraryAvatarEntry), ...this.characterAvatarSettings() });
  }

  private settingsOf(entry: LibraryAvatarEntry): LibraryAvatarSettings {
    let settings = this.avatarSettings.get(entry);
    if (settings === undefined) {
      settings = libraryAvatarSettings(entry);
      this.avatarSettings.set(entry, settings);
    }
    return settings;
  }

  private characterAvatarSettings(): AvatarHoldSettings {
    const { armForwardDistance, grips, arms } = this.workspace.character.draft();
    return { armForwardDistance, grips, arms };
  }

  // Runs the same embedded-GLB and rig checks a release and the project server run, with this
  // Workshop's registry. A profile with an external model is left to the runtime loader, so an
  // editor-only profile that cannot be packaged never fails here.
  private checkCharacterProfile(document: SpriteDocument, label: string): void {
    if (document.models === undefined || !document.models.every((model) => embeddedModel(model.source) !== null)) return;
    checkCharacterModels(document, label, this.avatarRigs);
  }

  // A library model's GLB, from this page, the server project that holds it or the published project.
  async libraryBlob(role: PartRole, id: string): Promise<Blob> {
    return this.libraryItemBlob(this.libraryItem(role, id));
  }

  private libraryItemBlob(item: LibraryItem): Promise<Blob> {
    return this.fileBlob(item, (project) => this.client.libraryModelUrl(project, item.role, item.entry.id), 'model/gltf-binary',
      { section: 'models', label: `Library ${item.role} "${item.entry.name}"` });
  }

  private mediaBlob(item: MediaItem): Promise<Blob> {
    return this.fileBlob(item, (project) => this.client.mediaUrl(project, item.path), mediaType(item.path),
      { section: 'media', label: `Media file ${item.path}` });
  }

  private artBlob(asset: ArtItem): Promise<Blob> {
    return this.fileBlob(asset, (project) => this.client.artUrl(project, asset.id), 'model/gltf-binary',
      { section: 'art', label: `Course artwork ${asset.name}` });
  }

  // A file's bytes: this page's, or downloaded now from the server project that holds it or the published project.
  private async fileBlob(source: FileSource, serverUrl: (project: string) => string, type: string,
    file: { readonly section: ProjectSectionName; readonly label: string }): Promise<Blob> {
    if (source.blob !== null) return source.blob;
    if (source.server !== null) return this.client.blob(serverUrl(source.server));
    if (source.published !== null) return new Blob([await downloadPublishedFile(source.published, this.lifecycle.signal)], { type });
    throw new ProjectError(`${file.label} is not available in this page.`, { section: file.section });
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
      const document = parseProjectCharacter(await file.text());
      this.checkCharacterProfile(document, 'alternate character');
      this.alternate = document;
      this.changed('content');
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  alternateCharacter(): SpriteDocument | null {
    return this.alternate;
  }

  removeAlternate(): void {
    this.alternate = null;
    this.changed('content');
  }

  // Makes `document` the project's alternate character, or removes it with null; the refusal, reported, or null.
  setAlternate(document: SpriteDocument | null): Error | null {
    try {
      if (document === null) {
        if (this.alternate === null) return null;
        this.removeAlternate();
        return null;
      }
      const validated = validateProjectCharacter(document);
      this.checkCharacterProfile(validated, 'alternate character');
      this.alternate = validated;
      this.changed('content');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  // A course package from `npm run pack:course`: its level replaces the current one, with its GLBs. Returns the refusal,
  // or null once imported.
  async importCoursePackage(file: File): Promise<Error | null> {
    return this.attempt('Importing course package', async () => {
      if (file.size > 96 * 1024 * 1024) throw new ArtError('Course packages are limited to 96 MiB.');
      const pack = validateCoursePackage(JSON.parse(await file.text()));
      const assets: ArtItem[] = pack.assets.map((asset) => {
        const blob = new Blob([decodeBase64(asset.source.slice('data:model/gltf-binary;base64,'.length))], { type: 'model/gltf-binary' });
        return { id: asset.id, name: asset.name, blob, server: null, published: null, bytes: blob.size };
      });
      checkProjectReferences(validateProjectManifest({
        ...this.draftManifest(), art: { assets: assets.map(({ id, name }) => ({ id, name })), decorations: pack.decorations },
      }), pack.level);
      // The course meshes come before the level, which draws them as soon as it loads.
      this.art = { assets, decorations: pack.decorations };
      this.applyLook();
      this.workspace.level.load(pack.level);
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
      await this.applyContent(openDefaultCourse('Untitled game'));
      await this.storeCopy();
      // A failed copy keeps its notice.
      if (this.error !== null) return;
      this.workspace.notice(`Started a new project from the built-in course. ${this.copy === null ? 'Save it to keep it.'
        : 'This browser keeps it; export the project file to take it elsewhere.'}`, 'info');
    });
  }

  async open(id: string): Promise<boolean> {
    return this.run(`Opening ${id}`, async () => {
      // The level first: reading it numbers a level version the project lost, which the project's answer then says.
      const level = await this.client.section(id, 'level');
      const project = await this.client.project(id);
      const read = async (name: string) => (await this.client.section(id, name)).value;
      const primary = project.manifest.characters.primary === null ? null : await read('characters/primary');
      const alternate = project.manifest.characters.alternate === null ? null : await read('characters/alternate');
      const models = await Promise.all(project.manifest.appearance.map(async (part) => this.client.blob(this.client.modelUrl(id, part.part))));
      await this.applyServerProject(project.manifest, project, {
        level: level.value, levelRevision: level.revision ?? project.sections.level!, primary, alternate, models, sizes: fileSizes(project.files),
      });
      this.publishRecord = (await this.client.publishStatus(id)).release;
      this.workspace.notice(`Opened "${project.manifest.title}" from the project server; every change saves to it.`, 'info');
    });
  }

  async importBundle(file: File): Promise<boolean> {
    return this.run('Importing project file', async () => {
      if (file.size > PROJECT_LIMITS.bundleBytes) throw new ProjectError(`Project files are limited to ${PROJECT_LIMITS.bundleBytes / 1024 ** 2} MiB.`);
      const content = unpackProjectBundle(JSON.parse(await file.text()));
      // Library models a release would refuse fail here, before anything in the page changes.
      inSection('models', () => checkModelLibrary(content.manifest.models, (path) => content.files.get(path)!, this.avatarRigs));
      await this.applyContent(openedContent(content));
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
      this.prepareLevel();
      const draft = this.captureDraft();
      const parts = this.workspace.appearance.parts();
      const media = [...this.media.values()];
      const assets = [...this.art.assets];
      const library = this.library;
      // A project too large for one project file is refused before its files download.
      const sizes = new Map<string, number>([
        ...parts.map((part) => [appearanceFile(part.part), part.blob.size] as const),
        ...media.map((item) => [mediaFile(item.path), item.bytes] as const),
        ...assets.map((asset) => [artFile(asset.id), asset.bytes] as const),
        ...library.map((item) => [libraryModelFile(item.role, item.entry.id), item.bytes] as const),
      ]);
      checkBundleSize({ manifest: draft.manifest, level: draft.level, characters: { primary: draft.primary, alternate: draft.alternate } },
        (ref) => sizes.get(ref.path) ?? 0);
      const content = await this.captureFiles(draft, parts, media, assets, library);
      result = { bundle: packProjectBundle(content), filename: `${this.binding?.id ?? projectFileName(this.title)}.project.json` };
    });
    return result;
  }

  // Saves this page's version of the sections that also changed in the server project, over the project's.
  async keepMyVersions(): Promise<boolean> {
    const binding = this.binding;
    if (binding === null || this.conflicts.size === 0) return false;
    return this.run('Saving your version', async () => {
      const names = new Set(this.conflicts);
      this.requireSaved(await this.write(binding, names, names));
      this.workspace.notice(`Saved your ${[...names].join(', ')} over the project's.`, 'info');
    });
  }

  // Replaces this page's version of the sections that also changed in the server project with the project's.
  async useProjectVersions(): Promise<boolean> {
    const binding = this.binding;
    if (binding === null || this.conflicts.size === 0) return false;
    return this.run('Loading the project\'s version', async () => {
      const names = [...this.conflicts];
      await this.loadFromServer(binding, names);
      this.workspace.notice(`Loaded the project's ${names.join(', ')}.`, 'info');
    });
  }

  // Loads the changes this browser kept from an earlier session into their server project, where they save like any
  // edit, replacing the project's version of those sections.
  async restoreKept(): Promise<boolean> {
    const kept = this.kept;
    if (kept === null) return false;
    if (this.binding?.id !== kept.project) {
      this.report(new ProjectError(`Open "${kept.project}" to restore the changes this browser kept to it.`));
      return false;
    }
    return this.run('Restoring this browser\'s changes', async () => {
      await this.applyChanges(kept.copy.content, kept.sections);
      this.kept = null;
      await this.copy!.clear();
      this.workspace.notice(`Restored your changes to ${kept.sections.join(', ')}; they save to the project now.`, 'info');
    });
  }

  async discardKept(): Promise<boolean> {
    if (this.kept === null) return false;
    return this.run('Discarding this browser\'s changes', async () => {
      await this.copy!.clear();
      this.kept = null;
      this.workspace.notice('Discarded the changes this browser kept.', 'info');
    });
  }

  // The open server project's ID, or null when none is open.
  openProject(): string | null {
    return this.binding?.id ?? null;
  }

  // The saved level version the page plays: the open project's level and game settings as last saved or loaded, while
  // the page still holds them. Null without a server project, or while either has changes no save has numbered yet.
  // The same object until the version changes; cheap enough for every physics step.
  playedVersion(): PlayedVersion | null {
    const bound = this.binding?.version ?? null;
    return bound !== null && bound.level === this.workspace.level.get() && bound.settings === this.settingsText() ? bound : null;
  }

  // The project server as this page last found it; null before the first check.
  serverHealth(): ServerHealth | null {
    return this.server;
  }

  // Saves `names`, one editor's sections, into the open server project now instead of at the next automatic save; a
  // level takes along the media and course artwork it may name. `label` names them in the notice, e.g. "the level".
  async saveToProject(names: readonly ProjectSectionName[], label: string): Promise<boolean> {
    const binding = this.binding;
    if (binding === null) {
      this.report(new ProjectError('Open or save a server project in Project to save into it.'));
      return false;
    }
    if (names.includes('level') && !this.workspace.level.prepare()) return false;
    return this.run('Saving to the project', async () => {
      if (this.binding !== binding) throw new ProjectError('The server project was closed; open it again in Project.');
      const conflicts = names.filter((name) => this.conflicts.has(name));
      if (conflicts.length > 0) {
        throw new ProjectError(`${conflicts.join(', ')} also changed in the project; keep your version or use the project's in Project first.`);
      }
      const dirty = new Set(this.dirtySections());
      const wanted = new Set(names.filter((name) => dirty.has(name)));
      if (wanted.has('level')) {
        for (const name of ['media', 'art'] as const) if (dirty.has(name) && !this.conflicts.has(name)) wanted.add(name);
      }
      if (wanted.size > 0) this.requireSaved(await this.write(binding, wanted, new Set()));
      this.workspace.notice(wanted.size > 0 ? `Saved ${label} to project "${binding.id}".`
        : `${label[0]!.toUpperCase()}${label.slice(1)} was already saved in project "${binding.id}".`, 'info');
    });
  }

  // Stores the whole project on the server under `id`, replacing any project with that ID, which then saves itself. Its
  // files go one at a time, each read from wherever this page has it as it is sent, so no request carries the whole
  // project.
  async saveAs(id: string): Promise<boolean> {
    return this.run('Saving to the server', async () => {
      const valid = validateProjectId(id);
      this.prepareLevel();
      // Every section is checked before anything is written.
      this.captureDraft();
      const names = new Set(this.sectionNames());
      let binding: Binding;
      if (this.binding !== null && this.binding.id === valid) binding = this.binding;
      else {
        // Replacing a project deletes its files, so the page needs its own source for every file it kept there.
        const sources: FileSource[] = [...this.media.values(), ...this.art.assets, ...this.library];
        if (sources.some((source) => source.server === valid && source.blob === null && source.published === null)) {
          throw new ProjectError(`Some of this page's files are kept only in project "${valid}"; save as another project ID.`);
        }
        // The project starts as an empty game, then takes this page's files and every section.
        const state = await this.client.putBundle(valid, packProjectBundle(loadProjectContent(defaultProjectManifest(this.title), () => STARTER_LEVEL)));
        // Files the page kept there are gone, so they are sent again from the page's own sources.
        for (const [path, item] of this.media) if (item.server === valid) this.media.set(path, { ...item, server: null });
        this.art = { ...this.art, assets: this.art.assets.map((asset) => asset.server === valid ? { ...asset, server: null } : asset) };
        this.library = this.library.map((item) => item.server === valid ? { ...item, server: null } : item);
        binding = { id: valid, revision: state.revision, sections: { ...state.sections }, version: null };
        this.binding = binding;
        this.moving = valid;
        this.syncedModels.clear();
        // Nothing of the page is in the new project yet, so a section the writes below do not reach stays unsaved and
        // saves like any change; the move completes once every section is stored.
        for (const name of names) this.synced![name] = UNSAVED;
        this.workspace.level.markSaved(null);
      }
      // The page's version replaces the project's, conflicts included.
      this.conflicts.clear();
      this.requireSaved(await this.write(binding, names, names));
      this.applyLook();
      this.projects = await this.client.list();
      this.workspace.notice(`Saved the whole project as "${valid}" on the project server.`, 'info');
    });
  }

  async publish(): Promise<PublishRecord | null> {
    const binding = this.binding;
    if (binding === null) {
      this.report(new ProjectError('Save the project to the project server before publishing it.'));
      return null;
    }
    // A release builds what the server holds: pending level edits apply and every change is saved first.
    if (!this.workspace.level.prepare() || !await this.saveEverything(binding)) return null;
    const id = binding.id;
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
    if (this.saver !== null) clearInterval(this.saver);
    if (this.copyTimer !== null) clearInterval(this.copyTimer);
    this.copy?.dispose();
    this.baker.dispose();
    for (const item of this.media.values()) if (item.blob !== null) URL.revokeObjectURL(item.url);
    this.media.clear();
    this.listeners.clear();
  }

  // This browser's copy of the published project, or null without one; a copy that cannot be read is reported.
  private async readCopy(): Promise<ProjectCopy | null> {
    if (this.copy === null) return null;
    try {
      return await this.copy.read();
    } catch (error) {
      if (!isExpected(error)) throw error;
      this.workspace.notice(error.message, 'error');
      return null;
    }
  }

  // Once the Workshop's own project opened from the server, `copy`, this browser's copy of its published version:
  // unsaved changes in it wait for the owner to restore them into the project or discard them; a copy without any goes.
  private async keepChanges(project: string, copy: ProjectCopy | null): Promise<void> {
    if (copy === null || copy.origin === null) return;
    const sections = copy.dirty.filter(isProjectSection);
    if (sections.length === 0) {
      try {
        await this.copy!.clear();
      } catch (error) {
        if (!isExpected(error)) throw error;
        this.workspace.notice(error.message, 'error');
      }
      return;
    }
    this.kept = { copy, project, sections };
    this.workspace.notice(`This browser kept unsaved changes to ${sections.join(', ')} from an earlier session. ` +
      'Restore them into the project, or discard them, in Project.', 'info');
    this.changed('status');
  }

  // Runs every second while a server project is open: writes the changed sections once they have held still for one
  // check, or at once when the page is being left. Sections that also changed in the project wait for the owner.
  private async autosave(options: { now?: boolean } = {}): Promise<void> {
    const binding = this.binding;
    const synced = this.synced;
    if (binding === null || synced === null || this.busy !== null || this.saving !== null || this.disposed) return;
    const current = this.fingerprints();
    const pending = this.sectionNames().filter((name) => current[name] !== synced[name] && !this.conflicts.has(name));
    const seen = this.saveSeen;
    this.saveSeen = pending.length === 0 ? null : current;
    if (pending.length === 0) {
      if (this.saveFailure !== null) {
        this.saveFailure = null;
        this.changed('status');
      }
      // A section loaded from the project, not written, may have been the last one a Save as was waiting for.
      await this.settleMove(binding);
      return;
    }
    if (options.now !== true && (seen === null || pending.some((name) => seen[name] !== current[name]))) return;
    const failure = this.saveFailure;
    if (failure !== null && pending.every((name) => failure.fingerprints[name] === current[name]) &&
      (failure.retryAt === null || Date.now() < failure.retryAt)) return;
    const saving: Promise<void> = this.attemptSave(binding, new Set(pending), current).finally(() => {
      if (this.saving === saving) this.saving = null;
      this.changed('status');
    });
    this.saving = saving;
    this.changed('status');
    await saving;
  }

  // One automatic save. What it leaves unsaved is reported once and tried again when it changes, or shortly after the
  // server could not be reached; a section that also changed in the project becomes a conflict for the owner.
  private async attemptSave(binding: Binding, names: ReadonlySet<ProjectSectionName>,
    fingerprints: SectionRecord<unknown>): Promise<void> {
    let message: string | null = null;
    let retryAt: number | null = null;
    try {
      const problems = await this.write(binding, names, new Set());
      if (problems.size > 0) message = [...problems].map(([name, reason]) => `${name}: ${reason}`).join(' ');
    } catch (error) {
      if (error instanceof ProjectApiError && error.status === 412 && error.section !== null) {
        this.conflicts.add(error.section as ProjectSectionName);
        this.saveFailure = null;
        this.workspace.notice(`${error.section} changed in the project while you edited it here; choose which version to keep in Project.`, 'error');
        return;
      }
      if (!isExpected(error)) throw error;
      message = describe(error);
      if (error instanceof ProjectApiError && (error.status === 0 || error.status >= 500)) retryAt = Date.now() + SAVE_RETRY_MS;
    }
    if (this.binding !== binding) return;
    if (message !== null && message !== this.saveFailure?.message) this.workspace.notice(`Not saved yet: ${message}`, 'error');
    this.saveFailure = message === null ? null : { fingerprints, message, retryAt };
  }

  // Saves every change now, for an action that needs the project saved; false, with the reason reported, when a change
  // cannot be saved or also changed in the project.
  private async saveEverything(binding: Binding): Promise<boolean> {
    while (this.saving !== null) await this.saving;
    if (this.conflicts.size > 0) {
      this.report(new ProjectError(`${[...this.conflicts].join(', ')} also changed in the project; keep your version or use the project's in Project first.`));
      return false;
    }
    const names = new Set(this.dirtySections());
    if (names.size === 0) return true;
    return this.run('Saving', async () => { this.requireSaved(await this.write(binding, names, new Set())); });
  }

  // Fails with the first section a save left unsaved.
  private requireSaved(problems: ReadonlyMap<ProjectSectionName, string>): void {
    for (const [section, message] of problems) throw new ProjectError(`${section}: ${message}`, { section });
  }

  // Writes `names`, changed sections, to the bound server project and returns the ones that cannot be saved yet, with
  // why. A section in `overwrite` replaces the project's version even if that changed meanwhile; any other section
  // that changed there fails with a conflict (412).
  private async write(binding: Binding, names: ReadonlySet<ProjectSectionName>,
    overwrite: ReadonlySet<ProjectSectionName>): Promise<Map<ProjectSectionName, string>> {
    // Exactly what this save sends; edits made while its requests run stay unsaved.
    const baseline = this.fingerprints();
    const savedLevel = this.workspace.level.get();
    const parts = this.workspace.appearance.parts();
    const media = [...this.media.values()];
    const assets = [...this.art.assets];
    const library = this.library;
    const alternate = this.alternate;
    const wanted = new Set(names);
    // An alternate needs its primary stored first, even when the primary itself did not change.
    if (wanted.has('characters/alternate') && alternate !== null) wanted.add('characters/primary');
    const { values, problems } = this.capture(wanted);
    if (problems.has('characters/primary') && wanted.has('characters/alternate') && alternate !== null) {
      problems.set('characters/alternate', 'waits for the primary character.');
    }
    const saving = new Set([...wanted].filter((name) => !problems.has(name)));
    const revision = (name: ProjectSectionName): number | undefined => overwrite.has(name) ? undefined : binding.sections[name] ?? 0;
    // Only the written section's revision: other sections may have changed meanwhile, for the next poll.
    const adopt = (name: ProjectSectionName, state: ServerRevisions): void => {
      binding.sections[name] = state.sections[name] ?? 0;
    };
    // New files first, so the sections that reference them validate on the server. A file the project lacks is read from
    // wherever this page has it, one at a time.
    if (saving.has('media')) {
      for (const item of media) {
        if (item.server === binding.id) continue;
        adopt('media', await this.client.putMedia(binding.id, item.path, await this.mediaBlob(item), revision('media')));
        // A file only another server project held plays from this one now.
        const url = item.blob === null && item.published === null ? this.client.mediaUrl(binding.id, item.path) : item.url;
        if (this.media.get(item.path) === item) this.media.set(item.path, { ...item, server: binding.id, url });
      }
    }
    if (saving.has('art')) {
      const uploaded = new Set<string>();
      for (const asset of assets) {
        if (asset.server === binding.id) continue;
        adopt('art', await this.client.postArt(binding.id, await this.artBlob(asset), asset.name, revision('art')));
        uploaded.add(asset.id);
      }
      this.art = { ...this.art, assets: this.art.assets.map((asset) => uploaded.has(asset.id) ? { ...asset, server: binding.id } : asset) };
    }
    if (saving.has('appearance')) {
      for (const part of parts) {
        if (this.syncedModels.get(part.part) === part.blob) continue;
        adopt('appearance', await this.client.putModel(binding.id, part.part, part.blob, part.name, revision('appearance')));
        this.syncedModels.set(part.part, part.blob);
      }
    }
    if (saving.has('models')) {
      for (const item of library) {
        if (item.server === binding.id) continue;
        adopt('models', await this.client.putLibraryModel(binding.id, item.role, item.entry, await this.libraryItemBlob(item), revision('models')));
        this.library = this.library.map((candidate) => candidate === item ? { ...item, server: binding.id } : candidate);
      }
    }
    // The server checks a level against the stored course artwork, which may lack decoration models the page's artwork
    // maps, while the stored level may draw ones the page's artwork drops: both artworks together go first, so the level
    // passes, and the page's own follows it.
    if (saving.has('level') && saving.has('art')) {
      const page = values.get('art') as ProjectArt;
      const storedValue = (await this.client.section(binding.id, 'art')).value;
      const stored = inSection('art', () => validateProjectArt(storedValue));
      const combined = [...stored.assets, ...page.assets.filter((asset) => !stored.assets.some((known) => known.id === asset.id))];
      const both = inSection('art', () => validateProjectArt({ assets: combined, decorations: { ...stored.decorations, ...page.decorations } }));
      adopt('art', await this.client.putSection(binding.id, 'art', both, revision('art')));
    }
    // The server removes an alternate before the primary it depends on, and adds them the other way round.
    const order: ProjectSectionName[] = [...alternate !== null ? SAVE_ORDER : SAVE_ORDER.flatMap((name) =>
      name === 'characters/primary' ? ['characters/alternate', name] as const : name === 'characters/alternate' ? [] : [name]),
    ...[...saving].filter((name) => pluginOfSection(name) !== null).sort()];
    for (const name of order) {
      if (!saving.has(name)) continue;
      const state = await this.client.putSection(binding.id, name, values.get(name), revision(name));
      adopt(name, state);
      this.markSynced(name, baseline[name]);
      this.conflicts.delete(name);
      this.adoptVersion(binding, state);
      if (name === 'level') this.workspace.level.markSaved(savedLevel);
      if (name === 'appearance') this.syncedModels = new Map(parts.map((part) => [part.part, part.blob]));
      this.changed('status');
    }
    await this.settleMove(binding);
    return problems;
  }

  // A Save as completes once its project holds every section, however the last one got there: the page remembers the
  // project, and this browser's copy goes.
  private async settleMove(binding: Binding): Promise<void> {
    if (this.moving !== binding.id || this.binding !== binding || this.dirtySections().length > 0) return;
    this.moving = null;
    this.remember(binding.id);
    await this.storeCopy();
  }

  // The given sections as the server stores them, each checked on its own as the server checks it, so a section that
  // cannot be saved yet (a character mid-edit, a level naming a missing file) holds back only itself; the reasons come
  // back by section.
  private capture(names: ReadonlySet<ProjectSectionName>): { values: Map<ProjectSectionName, unknown>; problems: Map<ProjectSectionName, string> } {
    const manifest = this.manifestDraft();
    const value: Record<BuiltinSectionName, () => unknown> = {
      title: () => manifest.title,
      level: () => this.levelDraft(manifest),
      settings: () => manifest.settings,
      'characters/primary': () => this.primaryDraft(),
      'characters/alternate': () => this.alternate === null ? null : this.checkedCharacter(this.alternate, 'alternate character'),
      'arm-ik': () => manifest.armIk,
      appearance: () => manifest.appearance,
      models: () => manifest.models,
      theme: () => manifest.theme,
      hud: () => manifest.hud,
      audio: () => manifest.audio,
      enemies: () => manifest.enemies,
      art: () => manifest.art,
      media: () => manifest.media,
    };
    const values = new Map<ProjectSectionName, unknown>();
    const problems = new Map<ProjectSectionName, string>();
    for (const name of names) {
      try {
        const plugin = pluginOfSection(name);
        values.set(name, plugin === null ? value[name as BuiltinSectionName]() : pluginDataIn(manifest.plugins, plugin));
      } catch (error) {
        if (!isProjectDataError(error)) throw error;
        problems.set(name, error.message);
      }
    }
    return { values, problems };
  }

  // Loads `names` from the bound server project into the page, as saved.
  private async loadFromServer(binding: Binding, names: readonly ProjectSectionName[]): Promise<void> {
    // The level first: reading it numbers a level version the project lost, which the project's answer then says. It
    // may be older than that answer, so its own revision, when it has one, says which it is.
    const level = names.includes('level') ? await this.client.section(binding.id, 'level') : null;
    const levelRevision = level?.revision ?? null;
    const project = await this.client.project(binding.id);
    const values = new Map<ProjectSectionName, unknown>();
    if (level !== null) values.set('level', level.value);
    for (const name of names) {
      if (name === 'characters/primary' || name === 'characters/alternate') {
        values.set(name, project.manifest.characters[name === 'characters/primary' ? 'primary' : 'alternate'] === null ? null
          : (await this.client.section(binding.id, name)).value);
      }
    }
    const models = names.includes('appearance')
      ? await Promise.all(project.manifest.appearance.map((part) => this.client.blob(this.client.modelUrl(binding.id, part.part)))) : [];
    await this.applySections(project.manifest, names, values, models, binding.id, 'sync', fileSizes(project.files));
    if (names.includes('appearance')) this.syncedModels = new Map(this.workspace.appearance.parts().map((part) => [part.part, part.blob]));
    for (const name of names) binding.sections[name] = name === 'level' && levelRevision !== null ? levelRevision : project.sections[name] ?? 0;
    const synced = this.fingerprints();
    for (const name of names) {
      this.markSynced(name, synced[name]);
      this.conflicts.delete(name);
    }
    this.adoptVersion(binding, project);
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
      await this.applyContent(copy.content);
      this.origin = copy.origin;
      const dirty = copy.dirty.filter(isProjectSection);
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

  // Opens the published project as Import project file does, replacing any copy: it downloads what the editors use at
  // once, and every other file when it is used.
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
      await this.applyContent(content);
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
    return { fingerprints, origin: this.origin, dirty: synced === null ? [] : this.sectionNames().filter((name) => fingerprints[name] !== synced[name]) };
  }

  // Runs every second: stores changes once they have held still for one check, or at once when
  // the page is being left. While a Save as moves the page, the copy stays as it was.
  private async keepCopy(options: { now?: boolean } = {}): Promise<void> {
    if (this.copy === null || !this.keeping || this.busy !== null || this.copyTask !== null || this.moving !== null || this.disposed) return;
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
    if (copy === null || !this.keeping || this.moving !== null || this.disposed) return;
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
      if (primary !== null) this.checkedCharacter(primary, 'primary character');
      if (this.alternate !== null) this.checkedCharacter(this.alternate, 'alternate character');
    } catch (error) {
      if (isProjectDataError(error)) return null;
      throw error;
    }
    const files = new Map<string, unknown>([[PROJECT_FILES.manifest, manifest], [PROJECT_FILES.level, level]]);
    if (primary !== null) files.set(PROJECT_FILES.primary, primary);
    if (this.alternate !== null) files.set(PROJECT_FILES.alternate, this.alternate);
    for (const part of this.workspace.appearance.parts()) files.set(appearanceFile(part.part), part.blob);
    // A file the published project serves stays on the site; the copy keeps only the page's own bytes.
    const sources = new Map<string, FileSource>([
      ...[...this.media.values()].map((item) => [mediaFile(item.path), item] as const),
      ...this.art.assets.map((asset) => [artFile(asset.id), asset] as const),
      ...this.library.map((item) => [libraryModelFile(item.role, item.entry.id), item] as const),
    ]);
    for (const [path, source] of sources) {
      const file = source.blob ?? source.published;
      // Only a server project holds it, which a copy cannot refer to.
      if (file === null) return null;
      files.set(path, file);
    }
    return files;
  }

  // Applies server changes to sections this page has not changed; changed ones become conflicts.
  private async poll(): Promise<void> {
    const binding = this.binding;
    if (binding === null || this.busy !== null || this.saving !== null || this.disposed || document.visibilityState !== 'visible') return;
    let state: ServerRevisions;
    try {
      state = await this.client.revisions(binding.id);
    } catch (error) {
      if (!isExpected(error)) throw error;
      return;
    }
    if (this.binding !== binding || this.busy !== null || this.saving !== null) return;
    this.adoptVersion(binding, state);
    // binding.revision is the server revision this page has fully reconciled with.
    if (state.revision === binding.revision) return;
    const changed = this.sectionNames(state.sections).filter((name) => (state.sections[name] ?? 0) !== (binding.sections[name] ?? 0));
    const dirty = new Set(this.dirtySections());
    const conflicting = changed.filter((name) => dirty.has(name) && !this.conflicts.has(name));
    for (const name of conflicting) this.conflicts.add(name);
    if (conflicting.length > 0) {
      this.workspace.notice(`${conflicting.join(', ')} changed in the project while you edited it here; choose which version to keep in Project.`, 'error');
    }
    const incoming = changed.filter((name) => !this.conflicts.has(name));
    if (incoming.length === 0) {
      binding.revision = state.revision;
      this.changed('status');
      return;
    }
    await this.run('Updating from the server', async () => {
      // An edit made while the revisions were in flight wins over the server's version.
      const edited = new Set(this.dirtySections());
      for (const name of incoming) if (edited.has(name)) this.conflicts.add(name);
      const applying = incoming.filter((name) => !edited.has(name));
      if (applying.length > 0) {
        try {
          await this.loadFromServer(binding, applying);
        } catch (error) {
          // Stop retrying every poll; keeping this page's version or using the project's resolves it.
          for (const name of applying) this.conflicts.add(name);
          throw error;
        }
        this.workspace.notice(`Updated ${applying.join(', ')} from the project server.`, 'info');
      }
      // Every section that changed by this revision is now loaded or reported as a conflict.
      binding.revision = state.revision;
    });
  }

  private async applyServerProject(manifest: ProjectManifest, state: ServerRevisions & { id: string }, files: {
    level: unknown; levelRevision: number; primary: unknown; alternate: unknown; models: readonly Blob[]; sizes: ReadonlyMap<string, number>;
  }): Promise<void> {
    const values = new Map<ProjectSectionName, unknown>([
      ['level', files.level], ['characters/primary', files.primary], ['characters/alternate', files.alternate],
    ]);
    this.unbind();
    await this.applySections(manifest, this.wholeProject(manifest), values, files.models, state.id, 'load', files.sizes);
    // The level came on its own, maybe older than the project's answer: its own revision says which it is.
    const binding: Binding = { id: state.id, revision: state.revision, sections: { ...state.sections, level: files.levelRevision }, version: null };
    this.binding = binding;
    this.syncedModels = new Map(this.workspace.appearance.parts().map((part) => [part.part, part.blob]));
    this.synced = this.fingerprints();
    this.adoptVersion(binding, state);
    this.remember(state.id);
    this.workspace.level.markSaved();
    this.keeping = true;
    // The server holds the project now, so this browser's copy goes.
    await this.storeCopy();
  }

  // Validates the incoming sections completely, loads the parts that can fail, then applies the rest.
  // `opened` is the course artwork of a project opened from anywhere but a server, whose files the page holds or the
  // published project does.
  private async applySections(manifest: ProjectManifest, names: readonly ProjectSectionName[], values: ReadonlyMap<ProjectSectionName, unknown>,
    models: readonly Blob[], serverId: string | null, mode: 'load' | 'sync' = 'load', sizes: ReadonlyMap<string, number> = new Map(),
    opened: CourseArt | null = null): Promise<void> {
    const has = new Set(names);
    const level = has.has('level') ? validateLevel(values.get('level')) : null;
    // The level, kept or incoming, must be drawable with the course artwork it will have, so sections that would leave a
    // decoration nothing draws are refused before anything in the page changes.
    const decorationArt = opened?.decorations ?? (has.has('art') ? manifest.art.decorations : this.art.decorations);
    const stranded = unknownDecorationModels(level ?? this.workspace.level.get(), decorationArt);
    if (stranded.length > 0) {
      throw new ProjectError(stranded.slice(0, 8).join(' ') + (stranded.length > 8 ? ` (${stranded.length - 8} more)` : ''),
        { section: level === null ? 'art' : 'level' });
    }
    const primary = has.has('characters/primary') ? values.get('characters/primary') === null ? EMPTY_SPRITES
      : validateProjectCharacter(values.get('characters/primary')) : null;
    const alternate = has.has('characters/alternate') ? values.get('characters/alternate') === null ? null
      : validateProjectCharacter(values.get('characters/alternate')) : undefined;
    if (primary !== null) this.checkCharacterProfile(primary, 'primary character');
    if (alternate !== undefined && alternate !== null) this.checkCharacterProfile(alternate, 'alternate character');
    const parts = has.has('appearance') ? validateAppearanceParts(manifest.appearance).map((part, index) => ({ ...part, blob: models[index]! })) : null;
    // Each plugin checks its incoming data; a plugin this Workshop lacks keeps its data as it came.
    const plugins = names.flatMap((name) => {
      const id = pluginOfSection(name);
      return id === null ? [] : [id];
    });
    for (const id of plugins) {
      const data = pluginDataIn(manifest.plugins, id);
      if (data === null || !this.plugins.has(id)) continue;
      const refusal = this.plugins.validate(id, data);
      if (refusal !== null) throw pluginRefusal(id, refusal);
    }
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
    // The course meshes come before the level, which draws them as soon as it loads.
    if (opened !== null) this.art = opened;
    else if (has.has('art')) {
      const existing = new Map(this.art.assets.map((asset) => [asset.id, asset]));
      this.art = {
        decorations: manifest.art.decorations,
        // An asset is named by its content, so bytes the page already has for it stay usable.
        assets: manifest.art.assets.map((asset) => {
          const known = existing.get(asset.id);
          return {
            ...asset, blob: known?.blob ?? null, published: known?.published ?? null, server: serverId,
            bytes: sizes.get(artFile(asset.id)) ?? known?.bytes ?? 0,
          };
        }),
      };
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
    // A server project's library files stay on the server until the Workshop needs them.
    if (has.has('models') && serverId !== null) {
      this.library = libraryEntries(manifest.models).map(({ role, entry }) => ({
        role, entry, key: this.nextLibraryKey++, blob: null, server: serverId, published: null,
        bytes: sizes.get(libraryModelFile(role, entry.id)) ?? 0,
      }));
    }
    if (has.has('media') && serverId !== null) {
      const next = new Map<string, MediaItem>();
      for (const entry of manifest.media) {
        next.set(entry.path, {
          path: entry.path, blob: null, server: serverId, published: null, url: this.client.mediaUrl(serverId, entry.path),
          bytes: sizes.get(mediaFile(entry.path)) ?? this.media.get(entry.path)?.bytes ?? 0,
        });
      }
      this.setMedia(next);
    }
    // Audio references media, so it follows the library.
    if (has.has('audio')) this.audio = manifest.audio;
    for (const id of plugins) this.pluginData = withPluginData(this.pluginData, id, pluginDataIn(manifest.plugins, id));
    if (mode === 'load') {
      const lacking = plugins.filter((id) => pluginDataIn(manifest.plugins, id) !== null && !this.plugins.has(id));
      if (lacking.length > 0) {
        this.workspace.notice(`This project keeps data for the Workshop plugin${lacking.length === 1 ? '' : 's'} ${lacking.map((id) => `"${id}"`).join(', ')
        }, which this Workshop does not have. ${lacking.length === 1 ? 'Its data stays' : 'Their data stays'} unchanged.`, 'info');
      }
    }
    this.changed('content');
    this.applyLook();
  }

  // Replaces the page's game with a whole project opened from a project file, this browser's copy, the published project
  // or the defaults. Files the page does not hold stay where they are until it uses them.
  private async applyContent(content: OpenedProject): Promise<void> {
    // Appearance models the page cannot show fail here, before anything in the page changes.
    const appearance = appearanceBlobs(content);
    this.unbind();
    await this.applySections(content.manifest, this.wholeProject(content.manifest).filter((name) => !LOCAL_FILES.has(name)), contentValues(content),
      appearance, null, 'load', new Map(), openedArt(content));
    this.setMedia(openedMedia(content));
    this.library = this.openedLibrary(content);
    this.syncedModels.clear();
    this.synced = this.fingerprints();
    this.workspace.level.markSaved();
    this.keeping = true;
    this.changed('content');
    this.applyLook();
  }

  // Loads `names` from `content`, a browser copy, into the page as changes to the open project: they save like any edit.
  private async applyChanges(content: OpenedProject, names: readonly ProjectSectionName[]): Promise<void> {
    const has = new Set(names);
    await this.applySections(content.manifest, names.filter((name) => !LOCAL_FILES.has(name)), contentValues(content), appearanceBlobs(content), null,
      'load', new Map(), has.has('art') ? openedArt(content) : null);
    if (has.has('level')) this.workspace.level.markSaved(null);
    if (has.has('media')) this.setMedia(openedMedia(content));
    if (has.has('models')) this.library = this.openedLibrary(content);
    this.changed('content');
    this.applyLook();
  }

  // The library of a project opened from anywhere but a server: the page's bytes or the published project's files.
  private openedLibrary(content: OpenedProject): LibraryItem[] {
    return libraryEntries(content.manifest.models).map(({ role, entry }) => ({
      role, entry, key: this.nextLibraryKey++, ...openedSource(content, libraryModelFile(role, entry.id)),
    }));
  }

  // Before a whole project replaces the page's game: a failure part way must not leave the page
  // bound to the previous server project while holding the new project's data.
  private unbind(): void {
    this.binding = null;
    this.moving = null;
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
      art: validateProjectArt({ assets: this.art.assets.map(({ id, name }) => ({ id, name })), decorations: this.art.decorations }),
      settings: this.workspace.settings.get(),
      characters: { primary: null, alternate: null },
      armIk: this.workspace.appearance.armIk(),
      appearance: this.workspace.appearance.parts().map(({ part, name, alignment }) => ({ part, name, alignment })),
      models: libraryOf(this.library),
      theme: this.theme, hud: this.hud, audio: this.audio, enemies: this.enemies,
      media: [...this.media.keys()].map((path) => ({ path })),
      plugins: this.pluginData,
    });
  }

  // Before exporting or storing a whole project: pending trigger event edits apply, and an unfinished outline stops it.
  private prepareLevel(): void {
    if (!this.workspace.level.prepare()) {
      throw new ProjectError('Finish or cancel the unfinished outline, and fix any trigger events, in Level first.', { section: 'level' });
    }
  }

  // Everything except binary files, validated together with the level's references.
  private captureDraft(): { manifest: ProjectManifest; level: LevelDefinition; primary: SpriteDocument | null; alternate: SpriteDocument | null } {
    const manifest = this.manifestDraft();
    const primary = this.primaryDraft();
    if (this.alternate !== null) this.checkedCharacter(this.alternate, 'alternate character');
    return { manifest, level: this.levelDraft(manifest), primary, alternate: this.alternate };
  }

  // The manifest of this page's project, referring to the characters it holds.
  private manifestDraft(): ProjectManifest {
    const primary = this.workspace.character.hasContent() || this.alternate !== null;
    return validateProjectManifest({
      ...this.draftManifest(),
      characters: { primary: primary ? PROJECT_FILES.primary : null, alternate: this.alternate === null ? null : PROJECT_FILES.alternate },
    });
  }

  // The primary character as a project stores it, or null when the project has none. Each draft is validated once:
  // the character editor reports a draft it refuses.
  private primaryDraft(): SpriteDocument | null {
    if (!this.workspace.character.hasContent() && this.alternate === null) return null;
    const draft = this.workspace.character.draft();
    let document = this.validatedDrafts.get(draft);
    if (document === undefined) {
      document = this.workspace.character.validated();
      this.validatedDrafts.set(draft, document);
    }
    if (document === null) throw new ProjectError('The character profile cannot be saved yet; see Character.', { section: 'characters/primary' });
    return this.checkedCharacter(document, 'primary character');
  }

  // A character as a project stores it, checked once as a project file and as releases check it.
  private checkedCharacter(document: SpriteDocument, label: string): SpriteDocument {
    if (!this.checkedCharacters.has(document)) {
      validateProjectCharacter(document);
      this.checkCharacterProfile(document, label);
      this.checkedCharacters.add(document);
    }
    return document;
  }

  // The level as a project stores it, with every media and artwork reference found in `manifest`.
  private levelDraft(manifest: ProjectManifest): LevelDefinition {
    const level = validateLevel(this.workspace.level.get());
    checkProjectReferences(manifest, level);
    return level;
  }

  // The binary files for a captured draft, each read from wherever this page has it.
  private async captureFiles(draft: ReturnType<ProjectSession['captureDraft']>, parts: readonly AppearanceFile[],
    media: readonly MediaItem[], assets: readonly ArtItem[], library: readonly LibraryItem[]): Promise<ProjectContent> {
    const files = new Map<string, Uint8Array>();
    const bytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());
    for (const part of parts) files.set(appearanceFile(part.part), await bytes(part.blob));
    for (const item of media) files.set(mediaFile(item.path), await bytes(await this.mediaBlob(item)));
    for (const asset of assets) files.set(artFile(asset.id), await bytes(await this.artBlob(asset)));
    for (const item of library) files.set(libraryModelFile(item.role, item.entry.id), await bytes(await this.libraryItemBlob(item)));
    return loadProjectContent(draft.manifest, (ref) => ref.kind === 'level' ? draft.level
      : ref.kind === 'character' ? (ref.path === PROJECT_FILES.primary ? draft.primary : draft.alternate) : files.get(ref.path));
  }

  // Every section this page knows of: the engine's, and each plugin section that has data here, was synced or appears
  // among `revisions`.
  private sectionNames(revisions: Readonly<Record<string, unknown>> = {}): ProjectSectionName[] {
    const plugins = new Set(Object.keys(this.pluginData));
    for (const record of [this.synced ?? {}, this.binding?.sections ?? {}, revisions]) {
      for (const name of Object.keys(record)) {
        const id = pluginOfSection(name);
        if (id !== null) plugins.add(id);
      }
    }
    return [...PROJECT_SECTIONS, ...[...plugins].sort().map(pluginSection)];
  }

  // Every section of a whole project replacing this page's: the engine's, the plugin sections it brings and those this
  // page holds, which it removes.
  private wholeProject(manifest: ProjectManifest): ProjectSectionName[] {
    const plugins = new Set([...Object.keys(manifest.plugins), ...Object.keys(this.pluginData)]);
    return [...PROJECT_SECTIONS, ...[...plugins].sort().map(pluginSection)];
  }

  // Records a section's synced fingerprint; a plugin section without data has none.
  private markSynced(name: ProjectSectionName, fingerprint: unknown): void {
    if (fingerprint === undefined) delete this.synced![name];
    else this.synced![name] = fingerprint;
  }

  // Each section's current value as a fingerprint: equal while the section is unchanged.
  fingerprints(): SectionRecord<unknown> {
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
      settings: this.settingsText(),
      'characters/primary': this.workspace.character.draft(),
      'characters/alternate': this.alternate,
      'arm-ik': JSON.stringify(this.workspace.appearance.armIk()),
      appearance: JSON.stringify(this.workspace.appearance.parts().map((part) => [part.part, part.name, blob(part.blob), part.alignment])),
      models: JSON.stringify(this.library.map((item) => [item.role, item.entry, blob(item.blob)])),
      theme: this.theme, hud: this.hud, audio: this.audio, enemies: this.enemies,
      art: JSON.stringify([this.art.assets.map((asset) => [asset.id, asset.name]), this.art.decorations]),
      media: JSON.stringify([...this.media.values()].map((item) => [item.path, blob(item.blob)])),
      ...Object.fromEntries(Object.entries(this.pluginData).map(([id, data]) => [pluginSection(id), data])),
    };
  }

  // The settings' JSON, the same string while the settings object is the same.
  private settingsText(): string {
    const settings = this.workspace.settings.get();
    if (this.settingsJson?.settings !== settings) this.settingsJson = { settings, text: JSON.stringify(settings) };
    return this.settingsJson.text;
  }

  // Takes the project's level version from a server answer whose level and settings revisions are the ones this page
  // last saved or loaded, which the synced fingerprints hold: the page plays that version while it holds them. Versions
  // never change, so the binding stays right however the project moves on; answers about other revisions leave it.
  private adoptVersion(binding: Binding, state: ServerRevisions): void {
    const level = state.level;
    if (level === null || VERSIONED.some((name) => state.sections[name] !== binding.sections[name])) return;
    const synced = this.synced!;
    const bound = binding.version;
    if (bound?.version === level.version && bound.level === synced.level && bound.settings === synced.settings) return;
    binding.version = { project: binding.id, version: level.version, course: level.course, level: synced.level, settings: synced.settings };
    this.changed('status');
  }

  private replaceMedia(path: string, item: MediaItem | null): void {
    const next = new Map(this.media);
    if (item === null) next.delete(path);
    else next.set(path, item);
    this.setMedia(next);
    this.applyLook();
  }

  private setSection(update: () => void): Error | null {
    try {
      update();
      this.applyLook();
      this.changed('status');
      return null;
    } catch (error) {
      return this.refuse(error);
    }
  }

  private applyLook(): void {
    const art = this.courseArtwork();
    const look = this.gameLook;
    if (look.theme !== this.theme || look.hud !== this.hud || look.enemies !== this.enemies || look.art !== art) {
      this.gameLook = Object.freeze({ theme: this.theme, hud: this.hud, enemies: this.enemies, art });
    }
    this.workspace.onLook({ game: this.gameLook, audio: this.audio, resolveMedia: this.resolveMedia, mediaVersion: this.mediaVersion });
  }

  // The course artwork as the game draws it, none until the project has opened: the same object while its GLBs and the
  // decoration models they draw stay the same.
  private courseArtwork(): CourseArtwork {
    if (!this.courseShown) return NO_COURSE_ARTWORK;
    const { assets, decorations } = this.art;
    const previous = this.artwork;
    if (previous.decorations !== decorations || previous.assets.length !== assets.length ||
      previous.assets.some((asset, index) => asset.id !== assets[index]!.id || asset.name !== assets[index]!.name)) {
      this.artwork = Object.freeze({ assets: Object.freeze(assets.map(({ id, name }) => Object.freeze({ id, name }))), decorations });
    }
    return this.artwork;
  }

  private async run(label: string, task: () => Promise<void>): Promise<boolean> {
    return await this.attempt(label, task) === null;
  }

  // Runs one operation of the session, reporting a refusal; returns the refusal, or null when the operation finished.
  private async attempt(label: string, task: () => Promise<void>): Promise<Error | null> {
    // An automatic save finishes first, so an action never sees the project half written.
    while (this.saving !== null) await this.saving;
    if (this.busy !== null) {
      const refusal = new ProjectError(`Wait for "${this.busy}" to finish first.`);
      this.workspace.notice(refusal.message, 'error');
      return refusal;
    }
    this.busy = label;
    this.error = null;
    this.changed('status');
    try {
      await task();
      return null;
    } catch (error) {
      if (error instanceof ProjectApiError && error.status === 412 && error.section !== null) {
        this.conflicts.add(error.section as ProjectSectionName);
        return this.refuse(new ProjectError(`${error.message} In Project, keep your version of ${error.section} or use the project's.`));
      }
      return this.refuse(error);
    } finally {
      this.busy = null;
      this.changed('status');
    }
  }

  // Reports a refusal and returns it; anything but an expected refusal is a programmer error and propagates.
  private refuse(error: unknown): Error {
    this.report(error);
    return error as Error;
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

// An opened project's level and characters, as applySections takes them.
function contentValues(content: OpenedProject): Map<ProjectSectionName, unknown> {
  return new Map<ProjectSectionName, unknown>([
    ['level', content.level], ['characters/primary', content.characters.primary], ['characters/alternate', content.characters.alternate],
  ]);
}

// A project file's or new project's files, as bytes this page holds.
function openedContent(content: ProjectContent): OpenedProject {
  const files = new Map<string, OpenedFile>();
  for (const ref of projectFileRefs(content.manifest)) {
    if (ref.binary) files.set(ref.path, new Blob([content.files.get(ref.path)!], { type: projectFileType(ref, content.manifest) }));
  }
  return Object.freeze({ manifest: content.manifest, level: content.level, characters: content.characters, files });
}

// A plugin's refusal of its data as the project reports it, naming the plugin's section and its error code.
function pluginRefusal(id: string, refusal: Error): ProjectError {
  const code = Reflect.get(refusal, 'code');
  return new ProjectError(`${pluginSection(id)}: ${refusal.message}${typeof code === 'string' ? ` (${code})` : ''}`,
    { section: pluginSection(id), cause: refusal });
}

// An opened project's appearance models, which the page holds: Appearance shows them as soon as the project opens.
function appearanceBlobs(content: OpenedProject): Blob[] {
  return content.manifest.appearance.map((part) => {
    const file = content.files.get(appearanceFile(part.part));
    if (!(file instanceof Blob)) throw new ProjectError(`${appearanceFile(part.part)} is not available in this page.`, { section: 'appearance' });
    return file;
  });
}

// A file of a project opened from anywhere but a server: the page's bytes or the published project's file, with its size.
function openedSource(content: OpenedProject, path: string): FileSource & { readonly bytes: number } {
  const file = content.files.get(path)!;
  return file instanceof Blob ? { blob: file, server: null, published: null, bytes: file.size } : { blob: null, server: null, published: file, bytes: file.bytes };
}

// An opened project's media: the page's bytes play from object URLs, published files from the site.
function openedMedia(content: OpenedProject): Map<string, MediaItem> {
  return new Map(content.manifest.media.map((entry) => {
    const source = openedSource(content, mediaFile(entry.path));
    return [entry.path, { path: entry.path, ...source, url: source.blob === null ? source.published!.url : URL.createObjectURL(source.blob) }];
  }));
}

function openedArt(content: OpenedProject): CourseArt {
  const { art } = content.manifest;
  return {
    decorations: art.decorations,
    assets: art.assets.map((asset) => ({ ...asset, ...openedSource(content, artFile(asset.id)) })),
  };
}

function fileSizes(files: readonly { readonly path: string; readonly bytes: number }[]): Map<string, number> {
  return new Map(files.map((file) => [file.path, file.bytes]));
}

function projectFileName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}
