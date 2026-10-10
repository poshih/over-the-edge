import type { AudioSettings } from '../audio-settings';
import { checkAppearanceModel } from '../appearance-model';
import { checkEmbeddedCharacterModels } from '../character-model-check';
import type { DecorationArt } from '../decoration-art';
import { STARTER_LEVEL } from '../default-course';
import type { EnemyArtSettings } from '../enemy-art-data';
import { Disposal } from '../disposal';
import type { HudSettings } from '../hud';
import { validateLevel } from '../level';
import type { LevelDefinition } from '../level';
import { mediaFile, mediaKind } from '../media';
import {
  appearanceFile, artFile, checkBundleSize, checkFileBudget, checkProjectReferences, defaultProjectManifest, inSection, isProjectDataError,
  loadProjectContent, packProjectBundle, PROJECT_FILES, PROJECT_FORMAT, PROJECT_LIMITS, PROJECT_SCHEMA_VERSION, projectFileRefs,
  projectFileType, ProjectError, unpackProjectBundle, validateProjectArt, validateProjectCharacter, validateProjectId, validateProjectManifest,
} from '../project';
import type { ProjectArt, ProjectBundle, ProjectContent, ProjectManifest } from '../project';
import { EMPTY_SPRITES } from '../sprite-data';
import type { SpriteDocument } from '../sprite-data';
import { checkModelLibrary, libraryModelFile, PART_ROLES } from '../model-library';
import type { LibraryEntry, PartRole } from '../model-library';
import type { AvatarRigRegistry } from '../avatar-rig';
import type { GameTheme } from '../theme';
import { pluginDataIn, pluginOfSection, pluginSection, validatePluginData, validateProjectPlugins } from '../plugin-data';
import type { PluginData } from '../plugin-data';
import { sameJson } from '../bounded-json';
import { PluginError } from '../plugins/kernel';
import { ProjectApiError, ProjectClient } from './project-client';
import type { PublishRecord, ServerHealth, ServerProjectSummary, ServerRevisions } from './project-client';
import { ProjectCopyStore } from './project-copy';
import type { ProjectCopy, ProjectCopyFiles } from './project-copy';
import { DEFAULT_COURSE_FILES, openDefaultCourse } from './default-course-files';
import { loadPublishedProject } from './published-project';
import type { OpenedFile, OpenedProject, PublishedProject, WorkshopScene } from './published-project';
import type { History } from './document/history';
import { BINARY_SECTIONS } from './document/files';
import type { BinarySectionName, FileHandle, FileStore } from './document/files';
import type { PreparedFileWrite, ProjectFileRetention, ServerFileWrite } from './document/file-retention';
import { UNTITLED_GAME_TITLE } from './document/project-commands';
import type { ProjectCommandInfo, ProjectCommands, ProjectPlugins } from './document/project-commands';
import type { ProjectImports } from './document/project-imports';
import type { LibraryModel, ProjectProjection } from './document/project-projection';
import type {
  DocumentAppearance, DocumentAppearancePart, DocumentArt, DocumentMedia, DocumentModel, DocumentModels, FrozenPluginData, PluginSectionName,
  SectionName, SectionValue, SectionValues, SomeSectionChange,
} from './document/project-document';
import { adapterFor } from './document/sections';
import { armIkValue, DEFAULT_VISUAL_VALUES } from './document/visual-values';
import { isDefaultCharacter } from './sprite-state';

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

const NO_PLUGINS: ProjectPlugins = Object.freeze({ has: () => false, validate: () => null });

function restoreInfo(): ProjectCommandInfo {
  return { label: 'Restore kept changes', place: { tab: 'project', section: null, select: null }, coalesce: null };
}

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
// A section reopened with unsaved changes: equal to no fingerprint, so it stays unsaved.
const UNSAVED = Symbol('unsaved');

export interface ProjectSessionOptions {
  readonly history: History;
  readonly files: FileStore;
  readonly retention: ProjectFileRetention;
  readonly commands: ProjectCommands;
  readonly imports: ProjectImports;
  readonly projection: ProjectProjection;
  readonly avatarRigs: AvatarRigRegistry;
  readonly plugins?: ProjectPlugins;
  readonly client?: ProjectClient;
  readonly published?: PublishedProject | null;
  // The example scenes this Workshop serves, which openScene opens.
  readonly scenes?: readonly WorkshopScene[];

  prepareLevel(): boolean;
  // Records `level` as the saved version; null records unsaved changes.
  markLevelSaved(level: LevelDefinition | null): void;
  hasPendingLevelEdits(): boolean;
  notice(message: string, kind: 'info' | 'error'): void;
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

// The page plays the version while its level, settings and enemy art are still these roots:
// their synced fingerprints when the project said which version they are.
interface BoundVersion extends PlayedVersion {
  readonly level: unknown;
  readonly settings: unknown;
  readonly enemies: unknown;
}

// The sections a level version holds, and the enemies, whose model motion joins its course.
const VERSIONED = ['level', 'settings', 'enemies'] as const;

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

type StartupProject =
  | { readonly kind: 'server'; readonly id: string }
  | { readonly kind: 'published'; readonly title: string }
  | { readonly kind: 'copy'; readonly title: string };

interface AutomaticOpening {
  readonly skipped: boolean;
  check(target: StartupProject): void;
}

export interface AppliedProjectSections {
  readonly names: readonly ProjectSectionName[];
  readonly level: LevelDefinition;
  readonly fingerprints: SectionRecord<unknown>;
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
  readonly browserCopy: {
    readonly stored: boolean;
    readonly pending: boolean;
    readonly writes: number;
    // A startup copy not opened because this page had already accepted work; its bytes remain in browser storage.
    readonly deferred: string | null;
  } | null;
  // Automatic saving to the open server project, null without one: whether a save is running, and why changes are not
  // saved yet.
  readonly autosave: { readonly saving: boolean; readonly problem: string | null } | null;
  // Sections with unsaved changes this browser kept from an earlier session, waiting to be restored into the open server
  // project or discarded; null when there are none.
  readonly kept: readonly ProjectSectionName[] | null;
}

class SessionClosed extends Error {
  constructor() {
    super('The project session has closed.');
    this.name = 'SessionClosed';
  }
}

class AutomaticOpeningSkipped extends Error {}

class ProjectBindingLost extends ProjectError {
  constructor(id: string, unavailable: readonly string[] = []) {
    super(`Project "${id}" is missing or was replaced on the server. This page keeps its project and undo history. `
      + (unavailable.length === 0 ? 'Save as stores this page\'s project on the server again.'
        : `${unavailable.length} file${unavailable.length === 1 ? ' is' : 's are'} no longer available: ${unavailable.slice(0, 2).join(', ')}. `
          + `Replace or remove ${unavailable.length === 1 ? 'it' : 'them'} before Save as or this browser's copy can keep the project.`));
    this.name = 'ProjectBindingLost';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpected(error: unknown): error is Error {
  return error instanceof ProjectApiError || isProjectDataError(error) || error instanceof SyntaxError || error instanceof DOMException ||
    error instanceof PluginError;
}

/** Opens, saves and reconciles the document with project files, the server and this browser's copy. */
export class ProjectSession {
  private readonly options: ProjectSessionOptions;
  private readonly history: History;
  private readonly files: FileStore;
  private readonly retention: ProjectFileRetention;
  private readonly commands: ProjectCommands;
  private readonly imports: ProjectImports;
  private readonly projection: ProjectProjection;
  private readonly unsubscribeDocument: () => void;
  private readonly historyHolds = new Set<() => void>();
  private readonly fileWork = new Set<() => void>();
  private readonly keptRestores = new Set<AbortController>();
  // Openings and binding-tied work belong to the project they began in.
  private generation = 0;
  // The avatar drivers this Workshop accepts; the composed Kinds registry reaches every validator.
  private readonly avatarRigs: AvatarRigRegistry;
  private readonly plugins: ProjectPlugins;
  private readonly client: ProjectClient;
  private readonly published: PublishedProject | null;
  private readonly scenes: readonly WorkshopScene[];
  private readonly copy: ProjectCopyStore | null;
  private readonly lifecycle = new AbortController();
  private readonly listeners = new Set<(event: ProjectEvent) => void>();
  private binding: Binding | null = null;
  // The project a Save as moves the page to, while that project lacks some of its sections: the page is bound to it, but
  // remembers the project it came from and keeps this browser's copy until the move completes.
  private moving: string | null = null;
  private synced: SectionRecord<unknown> | null = null;
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
  private deferredCopy: string | null = null;
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

  constructor(options: ProjectSessionOptions) {
    this.options = options;
    this.history = options.history;
    this.files = options.files;
    this.retention = options.retention;
    this.commands = options.commands;
    this.imports = options.imports;
    this.projection = options.projection;
    this.avatarRigs = options.avatarRigs;
    this.plugins = options.plugins ?? NO_PLUGINS;
    this.client = options.client ?? new ProjectClient();
    this.published = options.published ?? null;
    this.scenes = options.scenes ?? [];
    // A copy may hold a project opened from any file this Workshop serves.
    this.copy = this.published === null ? null
      : new ProjectCopyStore([...this.published.files, ...DEFAULT_COURSE_FILES, ...this.scenes.flatMap((scene) => scene.files)]);
    this.unsubscribeDocument = this.history.document.subscribeAll((changes) => {
      const bound = this.binding?.version ?? null;
      const status = changes.some((change) => {
        const name = change.section;
        const plugin = pluginOfSection(name) !== null;
        const before = plugin && change.before === null ? undefined : change.before;
        const after = plugin && change.after === null ? undefined : change.after;
        const version = bound !== null && VERSIONED.some((section) => section === name)
          ? bound[name as (typeof VERSIONED)[number]] : undefined;
        return [this.synced?.[name], this.copyWritten?.fingerprints[name], version]
          .some((value) => (before === value) !== (after === value));
      });
      if (status) this.changed('status');
    });
  }

  // Over the initialized document: find the server and open its project, the one this page
  // opened last or else the one this Workshop was started with; every change then saves to it. Otherwise a Workshop
  // built with a project reopens this browser's copy or the published project.
  async start(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const binding = this.binding;
    const hasWork = (): boolean => {
      const state = this.history.state();
      return state.steps > 0 || state.redoSteps > 0 || state.pending.length > 0 || state.transaction !== null;
    };
    let touched = hasWork();
    let skipped = false;
    // A cancellation or Undo back to the baseline never makes the page untouched again.
    const observe = (): void => { touched ||= hasWork(); };
    const unsubscribe = this.history.subscribe(observe);
    const signal = this.lifecycle.signal;
    signal.addEventListener('abort', unsubscribe, { once: true });
    const automatic: AutomaticOpening = {
      get skipped() { return skipped; },
      check: (target) => {
        this.requireActive();
        if (generation !== this.generation || this.binding !== binding) {
          skipped = true;
          throw new AutomaticOpeningSkipped();
        }
        observe();
        if (!touched) return;
        if (!skipped) {
          skipped = true;
          this.copyStored = false;
          this.copyWritten = null;
          this.deferredCopy = target.kind === 'copy' ? target.title : null;
          this.options.markLevelSaved(null);
          const name = target.kind === 'server' ? `server project "${target.id}"`
            : target.kind === 'published' ? `the published project "${target.title}"` : `this browser's copy of "${target.title}"`;
          const action = target.kind === 'server' ? `Open "${target.id}" from Project / Project server when you want to replace this page.`
            : target.kind === 'published' ? 'Use Reopen published project in Project when you want to replace this page.'
              : 'Use Open browser copy in Project when you want to replace this page.';
          this.options.notice(`Automatic opening of ${name} was skipped because you started work in this page. ` +
            `Your document and undo history are unchanged; this is a new unsaved project. ${action}`, 'info');
          this.changed('status');
        }
        throw new AutomaticOpeningSkipped();
      },
    };
    try {
      this.synced = this.fingerprints();
      await this.refreshServer();
      if (this.disposed) return;
      // Discovery never blocks editing; a project the designer chose meanwhile owns the page.
      if (generation === this.generation) {
        const server = this.server;
        const signedIn = server !== null && server.available && server.authenticated;
        const listed = (id: string | null): string | null => id !== null && this.projects.some((project) => project.id === id) ? id : null;
        const remembered = signedIn ? listed(this.rememberedProject()) : null;
        const own = signedIn ? listed(server.project) : null;
        // This browser's copy of the Workshop's own project, which may hold changes from an earlier session.
        const copy = own === null ? null : await this.readCopy();
        if (this.disposed) return;
        if (generation === this.generation) {
          // A copy holding another project (imported or new) reopens instead, as without a server.
          const opening = remembered ?? (copy?.origin === null ? null : own);
          if (opening !== null) await this.openServer(opening, automatic);
          if (own !== null && this.binding?.id === own && !this.disposed) await this.keepChanges(own, copy);
          if (!automatic.skipped && generation === this.generation && this.binding === null && this.published !== null && !this.disposed) {
            await this.openStartProject(automatic);
          }
        }
      }
      if (this.disposed) return;
      this.poller = setInterval(() => { void this.poll(); }, POLL_MS);
      this.saver = setInterval(() => { void this.autosave(); }, SAVE_MS);
      // Leaving the page saves, or stores in this browser, the latest changes at once.
      const leaving = (): void => {
        void this.autosave({ now: true });
        void this.keepCopy({ now: true });
      };
      window.addEventListener('beforeunload', leaving, { signal });
      window.addEventListener('pagehide', leaving, { signal });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leaving(); }, { signal });
      if (this.copy !== null) this.copyTimer = setInterval(() => { void this.keepCopy(); }, COPY_MS);
    } finally {
      signal.removeEventListener('abort', unsubscribe);
      unsubscribe();
    }
  }

  snapshot(): ProjectSnapshot {
    const document = this.history.document;
    const art = document.get('art');
    return {
      title: document.get('title'),
      binding: this.binding === null ? null : { id: this.binding.id, revision: this.binding.revision },
      server: this.server, projects: this.projects, busy: this.busy,
      dirty: this.dirtySections(), conflicts: [...this.conflicts],
      theme: document.get('theme'), hud: document.get('hud'), audio: document.get('audio'), enemies: document.get('enemies'),
      art: { assets: art.assets.map(({ id, name }) => ({ id, name })), decorations: art.decorations },
      media: document.get('media').map((item) => ({ path: item.path, bytes: item.file.bytes, kind: mediaKind(item.path) })),
      library: this.projection.libraryModels(),
      alternate: document.get('characters/alternate'),
      plugins: document.sections().flatMap((section) => {
        const id = pluginOfSection(section);
        return id === null ? [] : [id];
      }), publish: this.publishRecord, error: this.error,
      published: this.published === null ? null : {
        title: this.published.title, version: this.published.version,
        origin: this.origin === this.published.version ? 'current' : this.origin === null ? 'none' : 'outdated',
      },
      browserCopy: this.copy === null ? null : {
        stored: this.copyStored, pending: this.hasUnsavedProjectChanges(), writes: this.copyWrites, deferred: this.deferredCopy,
      },
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

  // Unsaved work that exists only in this page, including level drafts no browser copy stores. A
  // Workshop built with a project warns for every section instead, and while this browser's copy
  // keeps the project only changes not stored there yet count.
  hasUnsavedProjectChanges(): boolean {
    if (this.options.hasPendingLevelEdits()) return true;
    if (this.copy !== null) {
      if (!this.keeping || this.binding !== null) return this.dirtySections().length > 0;
      const state = this.copyState();
      return this.copyWanted(state) && !sameCopy(state, this.copyWritten);
    }
    return this.dirtySections().some((name) => name !== 'level' && name !== 'characters/primary' && name !== 'settings');
  }

  // Embedded roles use the release's model and rig checks; URL-backed roles wait for their loader.
  private checkCharacterProfile(document: SpriteDocument, label: string): void {
    checkEmbeddedCharacterModels(document, label, this.avatarRigs);
  }

  async refreshServer(): Promise<void> {
    if (this.disposed) return;
    const server = await this.client.health();
    if (this.disposed) return;
    this.server = server;
    this.projects = [];
    if (server.available && server.authenticated) {
      try {
        const projects = await this.client.list();
        if (this.disposed) return;
        this.projects = projects;
      } catch (error) {
        if (!isExpected(error)) throw error;
        if (this.disposed) return;
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
      await this.applyContent(openDefaultCourse(UNTITLED_GAME_TITLE));
      this.requireActive();
      await this.storeCopy();
      this.requireActive();
      // A failed copy keeps its notice.
      if (this.error !== null) return;
      this.options.notice(`Started a new project from the built-in course. ${this.copy === null ? 'Save it to keep it.'
        : 'This browser keeps it; export the project file to take it elsewhere.'}`, 'info');
    }, true);
  }

  // The example scenes this Workshop serves, by folder name with their titles.
  exampleScenes(): readonly { readonly name: string; readonly title: string }[] {
    return this.scenes.map(({ name, title }) => ({ name, title }));
  }

  // Opens one of this Workshop's example scenes as a new game, not yet saved anywhere, as Import project file opens a
  // project: it downloads what the editors use at once, and every other file when the page uses it.
  async openScene(name: string): Promise<boolean> {
    const scene = this.scenes.find((candidate) => candidate.name === name);
    const label = `Opening the example scene "${scene?.title ?? name}"`;
    return this.run(label, async () => {
      if (scene === undefined) throw new ProjectError(`This Workshop serves no example scene "${name}".`);
      let percent = -1;
      const content = await loadPublishedProject(scene, {
        signal: this.lifecycle.signal,
        onProgress: (fraction) => {
          const next = Math.floor(fraction * 100);
          if (next === percent) return;
          percent = next;
          this.busy = `${label} (${next}%)`;
          this.changed('status');
        },
      });
      this.requireActive();
      await this.applyContent(content);
      this.requireActive();
      await this.storeCopy();
      this.requireActive();
      // A failed copy keeps its notice.
      if (this.error !== null) return;
      this.options.notice(`Opened the example scene "${scene.title}" as a new project. ${this.copy === null
        ? 'Save it to the project server or export it to keep your changes.'
        : 'This browser keeps it with your changes; export the project file to take it elsewhere.'}`, 'info');
    }, true);
  }

  async open(id: string): Promise<boolean> {
    return this.openServer(id);
  }

  private async openServer(id: string, automatic?: AutomaticOpening): Promise<boolean> {
    const beforeOpen = automatic === undefined ? undefined : () => automatic.check({ kind: 'server', id });
    return this.run(`Opening ${id}`, async () => {
      beforeOpen?.();
      const generation = this.generation;
      // The level first: reading it numbers a level version the project lost, which the project's answer then says.
      const level = await this.client.section(id, 'level');
      this.requireActive(generation);
      const project = await this.client.project(id);
      this.requireActive(generation);
      const read = async (name: string) => (await this.client.section(id, name)).value;
      const primary = project.manifest.characters.primary === null ? null : await read('characters/primary');
      const alternate = project.manifest.characters.alternate === null ? null : await read('characters/alternate');
      this.requireActive(generation);
      await this.applyServerProject(project.manifest, project, {
        level: level.value, levelRevision: level.revision ?? project.sections.level!, primary, alternate, sizes: fileSizes(project.files),
      }, beforeOpen);
      this.requireActive();
      const published = await this.client.publishStatus(id);
      this.requireActive();
      this.publishRecord = published.release;
      this.options.notice(`Opened "${project.manifest.title}" from the project server; every change saves to it.`, 'info');
    }, automatic === undefined);
  }

  async importBundle(file: File): Promise<boolean> {
    return this.run('Importing project file', async () => {
      if (file.size > PROJECT_LIMITS.bundleBytes) throw new ProjectError(`Project files are limited to ${PROJECT_LIMITS.bundleBytes / 1024 ** 2} MiB.`);
      const content = unpackProjectBundle(JSON.parse(await file.text()));
      // Models a release would refuse fail here, while the bundle's bytes are in memory.
      inSection('models', () => checkModelLibrary(content.manifest.models, (path) => content.files.get(path)!, this.avatarRigs));
      for (const part of content.manifest.appearance) {
        inSection('appearance', () => checkAppearanceModel(content.files.get(appearanceFile(part.part))!.buffer));
      }
      await this.applyContent(openedContent(content));
      this.requireActive();
      await this.storeCopy();
      this.requireActive();
      if (this.error !== null) return;
      this.options.notice(`Imported "${content.manifest.title}". ${this.copy === null ? 'Save it to the project server or export it to keep changes.'
        : 'This browser keeps it with your changes; export the project file to take it elsewhere.'}`, 'info');
    }, true);
  }

  // Discards this browser's copy and opens the project this Workshop was built with.
  async reopenPublished(): Promise<boolean> {
    return this.published !== null && this.openPublished();
  }

  async openBrowserCopy(): Promise<boolean> {
    const store = this.copy;
    if (store === null || this.deferredCopy === null) return false;
    return this.run('Opening this browser\'s copy', async () => {
      const generation = this.generation;
      const copy = await store.read();
      this.requireActive(generation);
      if (copy === null) throw new ProjectError('This browser no longer has a project copy to open.');
      await this.applyCopy(copy);
    }, true);
  }

  async exportBundle(): Promise<{ bundle: ProjectBundle; filename: string } | null> {
    let result: { bundle: ProjectBundle; filename: string } | null = null;
    await this.run('Exporting project file', async () => {
      this.prepareLevel();
      const roots = this.documentValues();
      const draft = this.captureDraft(roots);
      const binaries = this.binaryFiles(roots);
      const release = this.retainFiles(binaries.map(({ file }) => file));
      try {
        // A project too large for one project file is refused before its files download.
        const sizes = new Map(binaries.map(({ path, file }) => [path, file.bytes]));
        checkBundleSize({ manifest: draft.manifest, level: draft.level, characters: { primary: draft.primary, alternate: draft.alternate } },
          (ref) => sizes.get(ref.path) ?? 0);
        const content = await this.captureFiles(draft, binaries);
        result = { bundle: packProjectBundle(content), filename: `${this.binding?.id ?? projectFileName(roots.title)}.project.json` };
      } finally {
        release();
      }
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
      this.options.notice(`Saved your ${[...names].join(', ')} over the project's.`, 'info');
    });
  }

  // Replaces this page's version of the sections that also changed in the server project with the project's.
  async useProjectVersions(): Promise<boolean> {
    const binding = this.binding;
    if (binding === null || this.conflicts.size === 0) return false;
    return this.run('Loading the project\'s version', async () => {
      const names = [...this.conflicts];
      const applied = await this.loadFromServer(binding, names, false);
      if (applied.length > 0) this.options.notice(`Loaded the project's ${applied.join(', ')}.`, 'info');
      const remaining = names.filter((name) => !applied.includes(name));
      if (remaining.length > 0) throw new ProjectError(`${remaining.join(', ')} changed here while loading; choose which version to keep again.`);
    }, true);
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
    if (kept.sections.includes('level') && !this.options.prepareLevel()) return false;
    const binding = this.binding;
    const complete = async (): Promise<void> => {
      if (this.kept !== kept || this.binding !== binding) throw new ProjectError('The project changed while its kept changes were restored.');
      await this.copy!.clear();
      this.kept = null;
      this.options.notice(`Restored your changes to ${kept.sections.join(', ')}; they save to the project now.`, 'info');
      this.changed('status');
    };
    const leases = new Set<() => void>();
    const controller = new AbortController();
    this.keptRestores.add(controller);
    let closed = false;
    try {
      const outcome = await this.imports.sections(async (signal) => {
        const reading = await this.readDocumentSections(kept.copy.content.manifest, kept.sections, contentValues(kept.copy.content),
          new Map(), kept.copy.content, signal);
        if (closed || signal.aborted) {
          reading.release();
          throw new DOMException('Restoring the kept changes was cancelled.', 'AbortError');
        }
        leases.add(reading.release);
        if (this.kept !== kept || this.binding !== binding) throw new ProjectError('The project changed while its kept changes loaded.');
        return reading.values;
      }, { info: restoreInfo(), signal: AbortSignal.any([this.lifecycle.signal, controller.signal]) });
      if (outcome.kind === 'cancelled') return false;
      if (outcome.kind === 'refused') {
        this.report(outcome.error);
        return false;
      }
      await complete();
      return true;
    } catch (error) {
      this.refuse(error);
      return false;
    } finally {
      closed = true;
      this.keptRestores.delete(controller);
      const disposal = new Disposal();
      disposal.run(() => controller.abort());
      for (const release of [...leases].reverse()) disposal.run(release);
      leases.clear();
      disposal.finish();
    }
  }

  async discardKept(): Promise<boolean> {
    if (this.kept === null) return false;
    return this.run('Discarding this browser\'s changes', async () => {
      this.cancelKeptRestores();
      await this.copy!.clear();
      this.kept = null;
      this.options.notice('Discarded the changes this browser kept.', 'info');
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
    const document = this.history.document;
    return bound !== null && bound.level === document.get('level') && bound.settings === document.get('settings') &&
      bound.enemies === document.get('enemies') ? bound : null;
  }

  // The project server as this page last found it; null before the first check.
  serverHealth(): ServerHealth | null {
    return this.server;
  }

  // Saves `names`, one editor's sections, into the open server project now instead of at the next automatic save; a
  // level takes along the media and course artwork it may name, and the course artwork the enemies, whose models may
  // have joined or left it. `label` names them in the notice, e.g. "the level".
  async saveToProject(names: readonly ProjectSectionName[], label: string): Promise<boolean> {
    const binding = this.binding;
    if (binding === null) {
      this.report(new ProjectError('Open or save a server project in Project to save into it.'));
      return false;
    }
    if (names.includes('level') && !this.options.prepareLevel()) return false;
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
      if (wanted.has('art') && dirty.has('enemies') && !this.conflicts.has('enemies')) wanted.add('enemies');
      if (wanted.size > 0) this.requireSaved(await this.write(binding, wanted, new Set()));
      this.options.notice(wanted.size > 0 ? `Saved ${label} to project "${binding.id}".`
        : `${label[0]!.toUpperCase()}${label.slice(1)} was already saved in project "${binding.id}".`, 'info');
    });
  }

  // Stores the whole project on the server under `id`, replacing any project with that ID, which then saves itself. Its
  // files go one at a time, each read from wherever this page has it as it is sent, so no request carries the whole
  // project.
  async saveAs(id: string): Promise<boolean> {
    return this.run('Saving to the server', async () => {
      const generation = this.generation;
      const previous = this.binding;
      const valid = validateProjectId(id);
      this.prepareLevel();
      // Every section is checked before anything is written.
      this.captureDraft();
      if (this.binding?.id !== valid) this.files.forgetProject(valid);
      for (const { path, file } of this.binaryFiles(this.documentValues())) {
        const locations = this.files.locations(file);
        if (locations.page === null && locations.published.length === 0 && locations.servers.length === 0) {
          throw new ProjectError(`${path} is not available in this page.`);
        }
      }
      let binding: Binding;
      if (this.binding !== null && this.binding.id === valid) binding = this.binding;
      else {
        // The project starts as an empty game, then takes this page's files and every section.
        const state = await this.replaceServerProject(valid,
          packProjectBundle(loadProjectContent(defaultProjectManifest(this.history.document.get('title')), () => STARTER_LEVEL)));
        if (previous !== null) this.requireBinding(previous);
        this.requireActive(generation);
        binding = { id: valid, revision: state.revision, sections: { ...state.sections }, version: null };
        // The document and its imports stay put; discovery and work tied to the old binding do not.
        this.invalidateBinding();
        this.binding = binding;
        this.moving = valid;
        // Nothing of the page is in the new project yet, so a section the writes below do not reach stays unsaved and
        // saves like any change; the move completes once every section is stored.
        this.synced ??= {};
        for (const name of this.sectionNames()) this.synced[name] = UNSAVED;
        this.options.markLevelSaved(null);
      }
      // The page's version replaces the project's, conflicts included.
      this.conflicts.clear();
      const names = new Set(this.sectionNames());
      this.requireSaved(await this.write(binding, names, names));
      this.projects = await this.client.list();
      this.requireBinding(binding);
      this.options.notice(`Saved the whole project as "${valid}" on the project server.`, 'info');
    }, this.binding?.id !== id);
  }

  async publish(): Promise<PublishRecord | null> {
    const binding = this.binding;
    if (binding === null) {
      this.report(new ProjectError('Save the project to the project server before publishing it.'));
      return null;
    }
    // A release builds what the server holds: pending level edits apply and every change is saved first.
    if (!this.options.prepareLevel() || !await this.saveEverything(binding)) return null;
    const id = binding.id;
    let record: PublishRecord | null = null;
    await this.run('Publishing', async () => {
      this.requireBinding(binding);
      record = await this.client.publish(id);
      this.requireBinding(binding);
      this.publishRecord = record;
      this.options.notice(`Published "${this.history.document.get('title')}": ${record.files} files, ${(record.bytes / 1024 / 1024).toFixed(1)} MiB, in ${
        (record.durationMs / 1000).toFixed(1)} s. Open ${record.url} to play it.`, 'info');
    });
    return record;
  }

  dispose(): void {
    this.disposed = true;
    const disposal = new Disposal();
    disposal.run(() => this.unsubscribeDocument());
    disposal.run(() => this.lifecycle.abort());
    disposal.run(() => this.cancelKeptRestores());
    disposal.run(() => this.imports.invalidateProject());
    if (this.poller !== null) clearInterval(this.poller);
    if (this.saver !== null) clearInterval(this.saver);
    if (this.copyTimer !== null) clearInterval(this.copyTimer);
    for (const release of [...this.historyHolds]) disposal.run(release);
    for (const release of [...this.fileWork]) disposal.run(release);
    disposal.run(() => this.copy?.dispose());
    this.listeners.clear();
    disposal.finish();
  }

  // This browser's copy of the published project, or null without one; a copy that cannot be read is reported.
  private async readCopy(): Promise<ProjectCopy | null> {
    if (this.copy === null) return null;
    try {
      return await this.copy.read();
    } catch (error) {
      if (!isExpected(error)) throw error;
      this.options.notice(error.message, 'error');
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
        this.options.notice(error.message, 'error');
      }
      return;
    }
    this.kept = { copy, project, sections };
    this.options.notice(`This browser kept unsaved changes to ${sections.join(', ')} from an earlier session. ` +
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
    if (this.disposed) return;
    let message: string | null = null;
    let retryAt: number | null = null;
    try {
      const problems = await this.write(binding, names, new Set());
      if (problems.size > 0) message = [...problems].map(([name, reason]) => `${name}: ${reason}`).join(' ');
    } catch (error) {
      if (error instanceof SessionClosed || error instanceof ProjectBindingLost) return;
      if (!isExpected(error)) throw error;
      if (this.disposed) return;
      if (error instanceof ProjectApiError && error.status === 412 && error.section !== null) {
        this.conflicts.add(error.section as ProjectSectionName);
        this.saveFailure = null;
        this.options.notice(`${error.section} changed in the project while you edited it here; choose which version to keep in Project.`, 'error');
        return;
      }
      message = describe(error);
      if (error instanceof ProjectApiError && (error.status === 0 || error.status >= 500)) retryAt = Date.now() + SAVE_RETRY_MS;
    }
    if (this.disposed || this.binding !== binding) return;
    if (message !== null && message !== this.saveFailure?.message) this.options.notice(`Not saved yet: ${message}`, 'error');
    this.saveFailure = message === null ? null : { fingerprints, message, retryAt };
  }

  // Saves every change now, for an action that needs the project saved; false, with the reason reported, when a change
  // cannot be saved or also changed in the project.
  private async saveEverything(binding: Binding): Promise<boolean> {
    while (this.saving !== null) await this.saving;
    if (this.disposed || this.binding !== binding) return false;
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
  // why. `overwrite` takes the project's current version as its starting point; a concurrent binary change still
  // refuses (412), because its file proofs and preservation must remain current.
  private async write(binding: Binding, names: ReadonlySet<ProjectSectionName>,
    overwrite: ReadonlySet<ProjectSectionName>): Promise<Map<ProjectSectionName, string>> {
    // Exactly what this save sends; edits made while its requests run stay unsaved.
    const generation = this.generation;
    this.requireBinding(binding);
    const roots = this.documentValues();
    const baseline = this.fingerprints(roots);
    const alternate = roots['characters/alternate'];
    const wanted = new Set(names);
    // An alternate needs its primary stored first, even when the primary itself did not change.
    if (wanted.has('characters/alternate') && alternate !== null) wanted.add('characters/primary');
    const { values, problems } = this.capture(wanted, roots);
    if (problems.has('characters/primary') && wanted.has('characters/alternate') && alternate !== null) {
      problems.set('characters/alternate', 'waits for the primary character.');
    }
    const saving = new Set([...wanted].filter((name) => !problems.has(name)));
    const release = this.retainFiles(this.binaryFiles(roots).map(({ file }) => file));
    try {
      // A forced binary save starts at the server's current revision, not the conflicted one. Its file proofs and
      // preservation must still hold when the request writes.
      const expected = { ...binding.sections };
      const forced = BINARY_SECTIONS.filter((name) => saving.has(name) && overwrite.has(name));
      // Check the project's identity before trusting remote holds or write preconditions.
      const current = await this.projectRevisions(binding);
      this.requireActive(generation);
      for (const name of forced) expected[name] = current.sections[name] ?? 0;
      const revision = (name: ProjectSectionName): number | undefined => overwrite.has(name) && !BINARY_SECTIONS.some((section) => section === name)
        ? undefined : expected[name] ?? 0;
      // Only the written section's revision: other sections may have changed meanwhile, for the next poll.
      const adopt = (name: ProjectSectionName, state: ServerRevisions): void => {
        this.checkProject(binding, state);
        binding.sections[name] = state.sections[name] ?? 0;
        expected[name] = binding.sections[name]!;
      };
      const held = (file: FileHandle, section: BinarySectionName, path: string): boolean => this.files.locations(file).servers
        .some((source) => source.project === binding.id && source.path === path && source.revision === (expected[section] ?? 0));
      // New files first, so the sections that reference them validate on the server. A file the project lacks is read from
      // wherever this page has it, one at a time.
      if (saving.has('media')) {
        for (const item of roots.media) {
          const path = mediaFile(item.path);
          if (held(item.file, 'media', path)) continue;
          const blob = await this.files.blob(item.file, this.lifecycle.signal);
          this.requireActive(generation);
          adopt('media', await this.writeFiles(binding, {
            section: 'media', files: [{ path, file: item.file }], replacesSection: false,
          }, () => this.client.putMedia(binding.id, item.path, blob, revision('media')),
          [{ file: item.file, path, url: this.client.mediaUrl(binding.id, item.path) }]));
          this.requireActive(generation);
        }
      }
      if (saving.has('art')) {
        for (const asset of roots.art.assets) {
          const path = artFile(asset.id);
          if (held(asset.file, 'art', path)) continue;
          const blob = await this.files.blob(asset.file, this.lifecycle.signal);
          this.requireActive(generation);
          adopt('art', await this.writeFiles(binding, {
            section: 'art', files: [{ path, file: asset.file }], replacesSection: false,
          }, () => this.client.postArt(binding.id, blob, asset.name, revision('art')),
          [{ file: asset.file, path, url: this.client.artUrl(binding.id, asset.id) }]));
          this.requireActive(generation);
        }
      }
      if (saving.has('appearance')) {
        for (const part of roots.appearance) {
          const path = appearanceFile(part.part);
          if (held(part.file, 'appearance', path)) continue;
          const blob = await this.files.blob(part.file, this.lifecycle.signal);
          this.requireActive(generation);
          adopt('appearance', await this.writeFiles(binding, {
            section: 'appearance', files: [{ path, file: part.file }], replacesSection: false,
          }, () => this.client.putModel(binding.id, part.part, blob, part.name, revision('appearance')),
          [{ file: part.file, path, url: this.client.modelUrl(binding.id, part.part) }]));
          this.requireActive(generation);
        }
      }
      if (saving.has('models')) {
        for (const role of PART_ROLES) for (const item of roots.models[role]) {
          const path = libraryModelFile(role, item.entry.id);
          if (held(item.file, 'models', path)) continue;
          const blob = await this.files.blob(item.file, this.lifecycle.signal);
          this.requireActive(generation);
          adopt('models', await this.writeFiles(binding, {
            section: 'models', files: [{ path, file: item.file }], replacesSection: false,
          }, () => this.client.putLibraryModel(binding.id, role, item.entry, blob, revision('models')),
          [{ file: item.file, path, url: this.client.libraryModelUrl(binding.id, role, item.entry.id) }]));
          this.requireActive(generation);
        }
      }
      // The server checks a level against the stored course artwork, which may lack decoration models the page's artwork
      // maps, while the stored level may draw ones the page's artwork drops: both artworks together go first, so the level
      // passes, and the page's own follows it.
      if (saving.has('level') && saving.has('art')) {
        const page = values.get('art') as ProjectArt;
        const project = await this.client.project(binding.id);
        this.requireActive(generation);
        this.checkProject(binding, project);
        const stored = inSection('art', () => validateProjectArt(project.manifest.art));
        const combined = [...stored.assets, ...page.assets.filter((asset) => !stored.assets.some((known) => known.id === asset.id))];
        const both = inSection('art', () => validateProjectArt({ assets: combined, decorations: { ...stored.decorations, ...page.decorations } }));
        const registered = this.serverFileValues(project.manifest, project, fileSizes(project.files), ['art']).get('art') as DocumentArt;
        const pageFiles = new Map(roots.art.assets.map((asset) => [asset.id, asset.file]));
        const files = registered.assets.map((asset) => ({ path: artFile(asset.id), file: pageFiles.get(asset.id) ?? asset.file }));
        for (const asset of roots.art.assets) if (!stored.assets.some((known) => known.id === asset.id)) files.push({ path: artFile(asset.id), file: asset.file });
        adopt('art', await this.writeFiles(binding, { section: 'art', files, replacesSection: true },
          () => this.client.putSection(binding.id, 'art', both, revision('art'))));
        this.requireActive(generation);
      }
      // The server removes an alternate before the primary it depends on, and adds them the other way round.
      const order: ProjectSectionName[] = [...alternate !== null ? SAVE_ORDER : SAVE_ORDER.flatMap((name) =>
        name === 'characters/primary' ? ['characters/alternate', name] as const : name === 'characters/alternate' ? [] : [name]),
      ...[...saving].filter((name) => pluginOfSection(name) !== null).sort()];
      for (const name of order) {
        if (!saving.has(name)) continue;
        const state = BINARY_SECTIONS.some((section) => section === name)
          ? await this.writeFiles(binding, this.sectionFileWrite(roots, name as BinarySectionName),
            () => this.client.putSection(binding.id, name, values.get(name), revision(name)))
          : await this.client.putSection(binding.id, name, values.get(name), revision(name));
        this.requireActive(generation);
        adopt(name, state);
        this.markSynced(name, baseline[name]);
        this.conflicts.delete(name);
        this.adoptVersion(binding, state);
        if (name === 'level') this.options.markLevelSaved(roots.level);
        this.changed('status');
      }
      await this.settleMove(binding);
      return problems;
    } catch (error) {
      if (isExpected(error)) this.requireBinding(binding);
      throw error;
    } finally {
      release();
    }
  }

  private async writeFiles(binding: Binding, write: ServerFileWrite, send: () => Promise<ServerRevisions>,
    uploads: readonly { readonly file: FileHandle; readonly path: string; readonly url: string }[] = []): Promise<ServerRevisions> {
    this.requireBinding(binding);
    const project = binding.id;
    const prepared = await this.retention.prepare(project, write, this.lifecycle.signal);
    try {
      this.requireBinding(binding);
      let state: ServerRevisions;
      try {
        state = await send();
      } catch (error) {
        if (unanswered(error)) prepared.uncertain();
        throw error;
      }
      if (!this.disposed) {
        this.checkProject(binding, state);
        const revision = state.sections[write.section];
        if (revision === undefined || !Number.isSafeInteger(revision) || revision < 1) {
          prepared.uncertain();
          throw new ProjectError(`The server did not acknowledge ${write.section}.`, { section: write.section });
        }
        for (const { file, path, url } of uploads) this.files.uploaded(file, { project, section: write.section, revision, path, url });
        prepared.finish(revision);
      }
      return state;
    } finally {
      prepared.release();
    }
  }

  private async replaceServerProject(project: string, bundle: ProjectBundle): Promise<ServerRevisions> {
    const prepared: { readonly section: BinarySectionName; readonly write: PreparedFileWrite }[] = [];
    try {
      for (const section of BINARY_SECTIONS) {
        prepared.push({ section, write: await this.retention.prepare(project, { section, files: [], replacesSection: true }, this.lifecycle.signal) });
      }
      this.requireActive();
      let state: ServerRevisions;
      try {
        state = await this.client.putBundle(project, bundle);
      } catch (error) {
        if (unanswered(error)) for (const entry of prepared) entry.write.uncertain();
        throw error;
      }
      if (!this.disposed) {
        for (const { section } of prepared) {
          const revision = state.sections[section];
          if (revision === undefined || !Number.isSafeInteger(revision) || revision < 1) {
            for (const entry of prepared) entry.write.uncertain();
            throw new ProjectError(`The server did not acknowledge ${section}.`, { section });
          }
        }
        for (const { section, write } of prepared) write.finish(state.sections[section]!);
      }
      return state;
    } finally {
      const disposal = new Disposal();
      for (const { write } of prepared.reverse()) disposal.run(() => write.release());
      disposal.finish();
    }
  }

  // A Save as completes once its project holds every section, however the last one got there: the page remembers the
  // project, and this browser's copy goes.
  private async settleMove(binding: Binding): Promise<void> {
    if (this.moving !== binding.id || this.binding !== binding || this.dirtySections().length > 0) return;
    this.moving = null;
    this.remember(binding.id);
    await this.storeCopy();
  }

  // Each section as the server stores it, checked on its own: a profile that cannot be packaged or a level naming a
  // missing file holds back only itself, with its reason.
  private capture(names: ReadonlySet<ProjectSectionName>, roots: SectionValues):
    { values: Map<ProjectSectionName, unknown>; problems: Map<ProjectSectionName, string> } {
    const manifest = this.manifestDraft(roots);
    const value: Record<BuiltinSectionName, () => unknown> = {
      title: () => manifest.title,
      level: () => this.levelDraft(manifest, roots.level),
      settings: () => manifest.settings,
      'characters/primary': () => this.primaryDraft(roots),
      'characters/alternate': () => roots['characters/alternate'] === null ? null : this.checkedCharacter(roots['characters/alternate'], 'alternate character'),
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
  private async loadFromServer(binding: Binding, names: readonly ProjectSectionName[], protectEdits: boolean): Promise<readonly ProjectSectionName[]> {
    this.requireBinding(binding);
    try {
      const before = this.fingerprints();
      // The level first: reading it numbers a level version the project lost, which the project's answer then says. It
      // may be older than that answer, so its own revision, when it has one, says which it is.
      const level = names.includes('level') ? await this.client.section(binding.id, 'level') : null;
      this.requireBinding(binding);
      const levelRevision = level?.revision ?? null;
      const project = await this.client.project(binding.id);
      this.checkProject(binding, project);
      const values = new Map<ProjectSectionName, unknown>();
      if (level !== null) values.set('level', level.value);
      for (const name of names) {
        if (name === 'characters/primary' || name === 'characters/alternate') {
          values.set(name, project.manifest.characters[name === 'characters/primary' ? 'primary' : 'alternate'] === null ? null
            : (await this.client.section(binding.id, name)).value);
          this.requireBinding(binding);
        }
      }
      const current = this.fingerprints();
      const dirty = new Set(protectEdits ? this.dirtySections() : []);
      const applying = names.filter((name) => {
        if (current[name] === before[name] && !dirty.has(name)) return true;
        this.conflicts.add(name);
        return false;
      });
      const sizes = fileSizes(project.files);
      for (const [name, value] of this.serverFileValues(project.manifest, project, sizes, applying)) values.set(name, value);
      const applied = await this.applySections(project.manifest, applying, values, 'server', sizes, null, protectEdits);
      this.requireBinding(binding);
      for (const name of applied.names) binding.sections[name] = name === 'level' && levelRevision !== null ? levelRevision : project.sections[name] ?? 0;
      for (const name of applied.names) {
        this.markSynced(name, applied.fingerprints[name]);
        this.conflicts.delete(name);
      }
      if (applied.names.includes('level')) this.options.markLevelSaved(applied.level);
      this.adoptVersion(binding, project);
      const conflicting = names.filter((name) => !applied.names.includes(name));
      if (conflicting.length > 0) {
        this.options.notice(`${conflicting.join(', ')} changed here while the project's version loaded; choose which version to keep in Project.`, 'error');
      }
      return applied.names;
    } catch (error) {
      if (isExpected(error)) this.requireBinding(binding);
      throw error;
    }
  }

  // A copy that holds changes, or another project, reopens; otherwise the published project opens.
  private async openStartProject(automatic: AutomaticOpening): Promise<void> {
    const generation = this.generation;
    const read = await this.attempt('Opening the project', async () => {
      try {
        return { copy: await this.copy!.read(), failure: null };
      } catch (error) {
        if (!isExpected(error)) throw error;
        return { copy: null, failure: error.message };
      }
    });
    if (read instanceof Error || generation !== this.generation) return;
    let { copy, failure } = read;
    if (copy !== null && (copy.origin === null || copy.dirty.length > 0)) {
      if (await this.openCopy(copy, automatic) || automatic.skipped) return;
      failure = this.error;
      copy = null;
    }
    // A copy that could not be opened stays stored until the project changes.
    this.copyStored = copy !== null;
    if (await this.openPublished(automatic) && failure !== null) {
      this.options.notice(`This browser's copy of the project could not be opened: ${failure} Opened the published project instead; ` +
        'the copy is replaced once you change the project.', 'error');
    }
  }

  private async openCopy(copy: ProjectCopy, automatic: AutomaticOpening): Promise<boolean> {
    return this.run('Opening this browser\'s copy', () => this.applyCopy(copy, () => automatic.check({
      kind: 'copy', title: copy.content.manifest.title,
    })));
  }

  private async applyCopy(copy: ProjectCopy, beforeOpen?: () => void): Promise<void> {
    const published = this.published!;
    await this.applyContent(copy.content, beforeOpen);
    this.requireActive();
    this.origin = copy.origin;
    const dirty = copy.dirty.filter(isProjectSection);
    for (const name of dirty) this.synced![name] = UNSAVED;
    if (dirty.includes('level')) this.options.markLevelSaved(null);
    // The page now shows exactly what the copy holds.
    const files = this.copyFiles();
    if (files !== null) {
      this.copy!.adopt(files);
      this.copyWritten = this.copyState();
    }
    this.copyStored = true;
    const title = copy.content.manifest.title;
    this.options.notice(copy.origin !== null && copy.origin !== published.version
      ? `"${published.title}" has a newer published version. This browser kept your unsaved changes to "${title}"; Reopen published project in Project takes the new version and discards them.`
      : `Reopened "${title}" from this browser${dirty.length > 0 ? ` with unsaved changes: ${dirty.join(', ')}` : ''}.`, 'info');
  }

  // Opens the published project as Import project file does, replacing any copy: it downloads what the editors use at
  // once, and every other file when it is used.
  private async openPublished(automatic?: AutomaticOpening): Promise<boolean> {
    const published = this.published!;
    const label = 'Opening the published project';
    const beforeOpen = automatic === undefined ? undefined : () => automatic.check({ kind: 'published', title: published.title });
    return this.run(label, async () => {
      beforeOpen?.();
      let percent = -1;
      const content = await loadPublishedProject(published, {
        signal: this.lifecycle.signal,
        onProgress: (fraction) => {
          const next = Math.floor(fraction * 100);
          if (next === percent) return;
          if (Math.floor(next / 10) !== Math.floor(percent / 10)) this.options.notice(`Loading "${published.title}": ${next}%`, 'info');
          percent = next;
          this.busy = `${label} (${next}%)`;
          this.changed('status');
        },
      });
      this.requireActive();
      await this.applyContent(content, beforeOpen);
      this.requireActive();
      this.origin = published.version;
      await this.storeCopy();
      this.requireActive();
      if (this.error !== null) return;
      this.options.notice(`Opened the published project "${content.manifest.title}".`, 'info');
    }, automatic === undefined);
  }

  // Whether the page holds what the published project does not: changes, or another project.
  private copyWanted(state: CopyState = this.copyState()): boolean {
    return this.binding === null && (state.origin !== this.published?.version || state.dirty.length > 0);
  }

  private copyState(roots: SectionValues = this.documentValues()): CopyState {
    const fingerprints = this.fingerprints(roots);
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
    const roots = this.documentValues();
    const state = this.copyState(roots);
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
    const files = this.copyFiles(roots, state.fingerprints);
    // Not a complete project yet, for example while a trigger uses a sound not in the media library.
    if (files === null) return;
    const release = this.retainFiles(this.binaryFiles(roots).map(({ file }) => file));
    try {
      await copy.write({ origin: state.origin, dirty: state.dirty }, files);
      this.copyWritten = state;
      this.copyStored = true;
      this.copyFailed = null;
      this.copyWrites++;
    } catch (error) {
      this.copyFailed = state;
      this.report(error);
    } finally {
      release();
    }
    this.changed('status');
  }

  // The open project's files for this browser's copy, checked like an export but without notices;
  // null while the page does not hold a valid project.
  private copyFiles(roots: SectionValues = this.documentValues(),
    sectionFingerprints: SectionRecord<unknown> = this.fingerprints(roots)): ProjectCopyFiles | null {
    const alternate = roots['characters/alternate'];
    const primary = primaryProfile(roots);
    const level = roots.level;
    let manifest: ProjectManifest;
    try {
      manifest = validateProjectManifest({
        ...this.draftManifest(roots),
        characters: { primary: primary === null ? null : PROJECT_FILES.primary, alternate: alternate === null ? null : PROJECT_FILES.alternate },
      });
      checkProjectReferences(manifest, level);
      if (primary !== null) this.checkedCharacter(primary, 'primary character');
      if (alternate !== null) this.checkedCharacter(alternate, 'alternate character');
    } catch (error) {
      if (isProjectDataError(error)) return null;
      throw error;
    }
    const values = new Map<string, unknown>([[PROJECT_FILES.manifest, manifest], [PROJECT_FILES.level, level]]);
    const fingerprints = new Map<string, unknown>([[PROJECT_FILES.manifest, sectionFingerprints], [PROJECT_FILES.level, level]]);
    if (primary !== null) {
      values.set(PROJECT_FILES.primary, primary);
      fingerprints.set(PROJECT_FILES.primary, primary);
    }
    if (alternate !== null) {
      values.set(PROJECT_FILES.alternate, alternate);
      fingerprints.set(PROJECT_FILES.alternate, alternate);
    }
    // A file the published project serves stays on the site; the copy keeps only the page's own bytes.
    for (const { path, file } of this.binaryFiles(roots)) {
      const source = this.files.copySource(file);
      // Only a server project holds it, which a copy cannot refer to.
      if (source === null) return null;
      values.set(path, source);
      fingerprints.set(path, file);
    }
    return { values, fingerprints };
  }

  // Applies server changes to sections this page has not changed; changed ones become conflicts.
  private async poll(): Promise<void> {
    const binding = this.binding;
    if (binding === null || this.busy !== null || this.saving !== null || this.disposed || document.visibilityState !== 'visible') return;
    const known = { revision: binding.revision, sections: { ...binding.sections } };
    let state: ServerRevisions;
    try {
      state = await this.projectRevisions(binding, known);
    } catch (error) {
      if (!isExpected(error)) throw error;
      return;
    }
    // A completed save can supersede a poll's answer without a project restart.
    if (this.disposed || this.binding !== binding || this.busy !== null || this.saving !== null ||
      binding.revision !== known.revision || !sameSections(binding.sections, known.sections)) return;
    this.checkProject(binding, state);
    this.adoptVersion(binding, state);
    // binding.revision is the server revision this page has fully reconciled with.
    if (state.revision === binding.revision) return;
    const changed = this.sectionNames(state.sections).filter((name) => (state.sections[name] ?? 0) !== (binding.sections[name] ?? 0));
    const dirty = new Set(this.dirtySections());
    const conflicting = changed.filter((name) => dirty.has(name) && !this.conflicts.has(name));
    for (const name of conflicting) this.conflicts.add(name);
    if (conflicting.length > 0) {
      this.options.notice(`${conflicting.join(', ')} changed in the project while you edited it here; choose which version to keep in Project.`, 'error');
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
        let applied: readonly ProjectSectionName[];
        try {
          applied = await this.loadFromServer(binding, applying, true);
        } catch (error) {
          // Stop retrying every poll; keeping this page's version or using the project's resolves it.
          if (this.binding === binding) for (const name of applying) this.conflicts.add(name);
          throw error;
        }
        if (applied.length > 0) this.options.notice(`Updated ${applied.join(', ')} from the project server.`, 'info');
      }
      // Every section that changed by this revision is now loaded or reported as a conflict.
      binding.revision = state.revision;
    }, true);
  }

  private async applyServerProject(manifest: ProjectManifest, state: ServerRevisions & { id: string }, files: {
    level: unknown; levelRevision: number; primary: unknown; alternate: unknown; sizes: ReadonlyMap<string, number>;
  }, beforeOpen?: () => void): Promise<void> {
    this.requireActive();
    beforeOpen?.();
    const values = new Map<ProjectSectionName, unknown>([
      ['level', files.level], ['characters/primary', files.primary], ['characters/alternate', files.alternate],
    ]);
    this.files.forgetProject(state.id);
    if (beforeOpen === undefined) {
      this.imports.invalidateProject();
      this.unbind();
    }
    const names = this.wholeProject(manifest);
    for (const [name, value] of this.serverFileValues(manifest, state, files.sizes, names)) values.set(name, value);
    const applied = await this.applySections(manifest, names, values, 'open', files.sizes, null, false, beforeOpen);
    this.requireActive();
    // The level came on its own, maybe older than the project's answer: its own revision says which it is.
    const binding: Binding = { id: state.id, revision: state.revision, sections: { ...state.sections, level: files.levelRevision }, version: null };
    this.binding = binding;
    this.synced = applied.fingerprints;
    this.adoptVersion(binding, state);
    this.remember(state.id);
    this.options.markLevelSaved(applied.level);
    this.keeping = true;
    // The server holds the project now, so this browser's copy goes.
    await this.storeCopy();
  }

  // Validates and adopts incoming document values; rigs follow without holding the opening.
  // `opened` supplies page or published files instead of the server's registered handles.
  private async applySections(manifest: ProjectManifest, names: readonly ProjectSectionName[], values: ReadonlyMap<ProjectSectionName, unknown>,
    mode: 'open' | 'server', sizes: ReadonlyMap<string, number> = new Map(),
    opened: OpenedProject | null = null, protectEdits = false, beforeOpen?: () => void): Promise<AppliedProjectSections> {
    const generation = this.generation;
    this.requireActive(generation);
    const before = this.fingerprints();
    const has = new Set(names);
    const retainClean = (): void => {
      if (mode !== 'server') return;
      const current = this.fingerprints();
      const dirty = new Set(protectEdits ? this.dirtySections() : []);
      for (const name of names) {
        if (!has.has(name) || (current[name] === before[name] && !dirty.has(name))) continue;
        has.delete(name);
        this.conflicts.add(name);
      }
    };
    retainClean();
    const reading = await this.readDocumentSections(manifest, [...has].filter((name) => mode !== 'server' || name !== 'level'),
      values, sizes, opened, this.lifecycle.signal);
    try {
      this.requireActive(generation);
      retainClean();
      const incoming = Object.freeze({
        ...Object.fromEntries(Object.entries(reading.values).filter(([name]) => has.has(name as ProjectSectionName))),
        ...(mode === 'server' && has.has('level') ? { level: values.get('level') } : {}),
      }) as Partial<SectionValues>;
      // A server level is checked and built once, then reaches the running game as an edit.
      const changes = this.adoptionChanges(incoming).map((change): SomeSectionChange => mode !== 'server' || change.section !== 'level'
        ? change : Object.freeze({
          ...change, delta: Object.freeze({ ...change.delta, kind: 'edit' as const }),
        }));
      if (mode === 'open') {
        if (beforeOpen !== undefined) {
          // Reads can wait; only this final check admits the synchronous project replacement.
          beforeOpen();
          this.unbind();
        }
        this.invalidateProject();
        this.history.load(Object.freeze({
          ...this.documentValues(), ...Object.fromEntries(changes.map((change) => [change.section, change.after])),
        }) as SectionValues);
      } else {
        const changed = new Set(changes.map((change) => change.section));
        // A new revision cuts even when its value equals the page's.
        for (const name of names) if (has.has(name) && !changed.has(name)) {
          changes.push(unchangedSection(this.history, name));
        }
        if (changes.length > 0) this.history.external(withConsumerCuts(this.history, changes));
      }
      if (mode === 'open') {
        const lacking = names.flatMap((name) => {
          const id = pluginOfSection(name);
          return has.has(name) && id !== null && pluginDataIn(manifest.plugins, id) !== null && !this.plugins.has(id) ? [id] : [];
        });
        if (lacking.length > 0) this.options.notice(`This project keeps data for the Workshop plugin${lacking.length === 1 ? '' : 's'} ${
          lacking.map((id) => `"${id}"`).join(', ')}, which this Workshop does not have. ${
          lacking.length === 1 ? 'Its data stays' : 'Their data stays'} unchanged.`, 'info');
      }
      this.changed('content');
      return {
        names: names.filter((name) => has.has(name)), level: this.history.document.get('level'),
        fingerprints: this.fingerprints(),
      };
    } finally {
      reading.release();
    }
  }

  private adoptionChanges(values: Partial<SectionValues>): readonly SomeSectionChange[] {
    const document = this.history.document;
    // Adoption records no selection; the command validates a raw level before anything reads its objects.
    const info: ProjectCommandInfo = {
      ...restoreInfo(), place: { tab: 'project', section: null, select: { before: [], after: [] } },
    };
    const entries = Object.entries(values);
    const builtin = Object.freeze(Object.fromEntries(entries.filter(([section]) => pluginOfSection(section) === null))) as Partial<SectionValues>;
    const plugins = Object.freeze(Object.fromEntries(entries.filter(([section]) => pluginOfSection(section) !== null))) as Partial<SectionValues>;
    const changes = [...this.commands.sections(builtin, info).run(document)];
    const unchecked = new Map<PluginSectionName, FrozenPluginData>();
    for (;;) {
      const checking = unchecked.size === 0 ? plugins : Object.freeze(Object.fromEntries(
        Object.entries(plugins).filter(([section]) => !unchecked.has(section as PluginSectionName)),
      )) as Partial<SectionValues>;
      try {
        changes.push(...this.commands.sections(checking, info).run(document));
        break;
      } catch (error) {
        if (!(error instanceof PluginError) || error.code !== 'plugin-failed' || error.plugin === null) throw error;
        const section = pluginSection(error.plugin);
        const value = plugins[section];
        if (value === undefined || value === null || unchecked.has(section)) throw error;
        unchecked.set(section, value);
      }
    }
    if (unchecked.size > 0) {
      // A failed facet cannot block adoption; engine JSON and combined section limits still apply.
      const prospective: Record<string, PluginData> = {};
      for (const section of document.sections()) {
        const id = pluginOfSection(section);
        if (id === null) continue;
        const value = document.get(pluginSection(id));
        if (value !== null) prospective[id] = value.data;
      }
      for (const section of Object.keys(plugins)) {
        const id = pluginOfSection(section)!;
        const value = plugins[pluginSection(id)]!;
        if (value === null) delete prospective[id];
        else prospective[id] = value.data;
      }
      validateProjectPlugins(prospective);
      for (const [section, value] of unchecked) {
        const before = document.get(section);
        if (before !== null && sameJson(before.data, value.data)) continue;
        changes.push(adapterFor(section).change(before, value));
      }
    }
    return Object.freeze(changes);
  }

  // File revisions and sizes come from the same server listing; an unread path is never assumed to have known bytes.
  private serverFileValues(manifest: ProjectManifest, state: ServerRevisions & { readonly id: string }, sizes: ReadonlyMap<string, number>,
    names: readonly ProjectSectionName[]): Map<ProjectSectionName, unknown> {
    const has = new Set(names);
    const values = new Map<ProjectSectionName, unknown>();
    const file = (section: BinarySectionName, path: string, url: string): FileHandle => {
      const bytes = sizes.get(path);
      if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 1) {
        throw new ProjectError(`The project did not list the size of ${path}.`, { section });
      }
      const revision = state.sections[section];
      if (revision === undefined || !Number.isSafeInteger(revision) || revision < 0) {
        throw new ProjectError(`The project did not list the revision of ${section}.`, { section });
      }
      return this.files.registerServer({ project: state.id, section, revision, path, url }, bytes);
    };
    if (has.has('art')) values.set('art', Object.freeze({
      decorations: manifest.art.decorations,
      assets: Object.freeze(manifest.art.assets.map((asset) => Object.freeze({
        ...asset, file: file('art', artFile(asset.id), this.client.artUrl(state.id, asset.id)),
      }))),
    } satisfies DocumentArt));
    if (has.has('media')) values.set('media', Object.freeze(manifest.media.map(({ path }) => Object.freeze({
      path, file: file('media', mediaFile(path), this.client.mediaUrl(state.id, path)),
    }))) satisfies DocumentMedia);
    const models = <E extends LibraryEntry>(role: PartRole, entries: readonly E[]): readonly DocumentModel<E>[] => Object.freeze(entries.map((entry) =>
      Object.freeze({ entry, file: file('models', libraryModelFile(role, entry.id), this.client.libraryModelUrl(state.id, role, entry.id)) })));
    if (has.has('models')) values.set('models', Object.freeze({
      avatar: models('avatar', manifest.models.avatar), hammer: models('hammer', manifest.models.hammer), pot: models('pot', manifest.models.pot),
    } satisfies DocumentModels));
    if (has.has('appearance')) values.set('appearance', Object.freeze(manifest.appearance.map((part) => Object.freeze({
      ...part, file: file('appearance', appearanceFile(part.part), this.client.modelUrl(state.id, part.part)),
    }))) satisfies DocumentAppearance);
    return values;
  }

  private async readDocumentSections(manifest: ProjectManifest, names: readonly ProjectSectionName[], raw: ReadonlyMap<ProjectSectionName, unknown>,
    sizes: ReadonlyMap<string, number>, opened: OpenedProject | null, signal: AbortSignal):
    Promise<{ readonly values: Partial<SectionValues>; release(): void }> {
    const has = new Set(names);
    const values = new Map<SectionName, SectionValues[SectionName]>();
    const releases: (() => void)[] = [];
    const release = (): void => {
      const disposal = new Disposal();
      for (const done of releases.splice(0).reverse()) disposal.run(done);
      disposal.finish();
    };
    const refs = new Map(projectFileRefs(manifest).filter((ref) => ref.binary).map((ref) => [ref.path, ref]));
    const file = async (path: string, section: BinarySectionName): Promise<FileHandle> => {
      signal.throwIfAborted();
      const source = opened?.files.get(path);
      const ref = refs.get(path);
      if (source === undefined || ref === undefined) throw new ProjectError(`${path} is missing.`, { section });
      const bytes = source instanceof Blob ? source.size : source.bytes;
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ref.maxBytes) throw new ProjectError(`${path} has an invalid size.`, { section });
      if (source instanceof Blob) {
        const staged = await this.files.stagePage(source, signal);
        releases.push(staged.release);
        signal.throwIfAborted();
        return staged.handle;
      }
      const handle = this.files.registerPublished(source);
      releases.push(this.files.retain([handle], 'work'));
      return handle;
    };
    const models = async <E extends LibraryEntry>(role: PartRole, entries: readonly E[]): Promise<readonly DocumentModel<E>[]> => {
      const items: DocumentModel<E>[] = [];
      for (const entry of entries) items.push(Object.freeze({ entry, file: await file(libraryModelFile(role, entry.id), 'models') }));
      return Object.freeze(items);
    };
    try {
      signal.throwIfAborted();
      const builtin = {
        title: manifest.title, settings: manifest.settings, theme: manifest.theme, hud: manifest.hud, audio: manifest.audio, enemies: manifest.enemies,
      } as const;
      for (const name of Object.keys(builtin) as (keyof typeof builtin)[]) if (has.has(name)) values.set(name, builtin[name]);
      if (has.has('level')) values.set('level', validateLevel(raw.get('level')));
      if (has.has('characters/primary')) {
        values.set('characters/primary', raw.get('characters/primary') === null ? EMPTY_SPRITES : validateProjectCharacter(raw.get('characters/primary')));
      }
      if (has.has('characters/alternate')) {
        values.set('characters/alternate', raw.get('characters/alternate') === null ? null : validateProjectCharacter(raw.get('characters/alternate')));
      }
      if (has.has('arm-ik')) values.set('arm-ik', armIkValue(manifest.armIk, DEFAULT_VISUAL_VALUES['arm-ik']));
      if (opened !== null) {
        // Refuse the whole section's budget before hashing any of its page files.
        for (const section of BINARY_SECTIONS) if (has.has(section)) {
          const kind = section === 'models' ? 'model' : section;
          const total = [...refs.values()].filter((ref) => ref.kind === kind).reduce((sum, ref) => {
            const source = opened.files.get(ref.path);
            if (source === undefined) throw new ProjectError(`${ref.path} is missing.`, { section });
            return sum + (source instanceof Blob ? source.size : source.bytes);
          }, 0);
          checkFileBudget(kind, total);
        }
        if (has.has('art')) {
          const assets: DocumentArt['assets'][number][] = [];
          for (const asset of manifest.art.assets) assets.push(Object.freeze({ ...asset, file: await file(artFile(asset.id), 'art') }));
          values.set('art', Object.freeze({ assets: Object.freeze(assets), decorations: manifest.art.decorations }));
        }
        if (has.has('media')) {
          const media: DocumentMedia[number][] = [];
          for (const entry of manifest.media) media.push(Object.freeze({ path: entry.path, file: await file(mediaFile(entry.path), 'media') }));
          values.set('media', Object.freeze(media));
        }
        if (has.has('models')) values.set('models', Object.freeze({
          avatar: await models('avatar', manifest.models.avatar), hammer: await models('hammer', manifest.models.hammer),
          pot: await models('pot', manifest.models.pot),
        }));
        if (has.has('appearance')) {
          const parts: DocumentAppearancePart[] = [];
          for (const part of manifest.appearance) parts.push(Object.freeze({ ...part, file: await file(appearanceFile(part.part), 'appearance') }));
          values.set('appearance', Object.freeze(parts));
        }
      } else {
        for (const section of BINARY_SECTIONS) if (has.has(section)) {
          if (!raw.has(section)) throw new ProjectError(`The project did not list the files of ${section}.`, { section });
          const value = raw.get(section) as SectionValue<typeof section>;
          const handles = adapterFor(section).files(value);
          releases.push(this.files.retain(handles, 'work'));
          for (const { path, file } of this.sectionFileWriteValue(section, value).files) {
            if (sizes.get(path) !== file.bytes) throw new ProjectError(`${path} does not match the project's file listing.`, { section });
          }
          values.set(section, value);
        }
      }
      for (const name of names) {
        const id = pluginOfSection(name);
        if (id === null) continue;
        const data = pluginDataIn(manifest.plugins, id);
        if (data === null) values.set(pluginSection(id), null);
        else {
          let bytes = 0;
          const checked = validatePluginData(id, data, (size) => { bytes = size; });
          if (checked === null) throw new Error('Non-null plugin data validated as null.');
          values.set(pluginSection(id), Object.freeze({ data: checked, bytes }));
        }
      }
      signal.throwIfAborted();
      return Object.freeze({ values: Object.freeze(Object.fromEntries(values)) as Partial<SectionValues>, release });
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      disposal.run(release);
      disposal.finish();
      throw error;
    }
  }

  // Replaces the page's game with a whole project opened from a project file, this browser's copy, the published project
  // or the defaults. Files the page does not hold stay where they are until it uses them.
  private async applyContent(content: OpenedProject, beforeOpen?: () => void): Promise<void> {
    this.requireActive();
    beforeOpen?.();
    if (beforeOpen === undefined) {
      this.imports.invalidateProject();
      this.unbind();
    }
    const applied = await this.applySections(content.manifest, this.wholeProject(content.manifest), contentValues(content),
      'open', new Map(), content, false, beforeOpen);
    this.requireActive();
    this.synced = applied.fingerprints;
    this.options.markLevelSaved(applied.level);
    this.keeping = true;
    this.changed('content');
  }

  private async projectRevisions(binding: Binding, known: Pick<Binding, 'revision' | 'sections'> = binding): Promise<ServerRevisions> {
    this.requireBinding(binding);
    let state: ServerRevisions;
    try {
      state = await this.client.revisions(binding.id, this.lifecycle.signal);
    } catch (error) {
      this.requireBinding(binding);
      // Only this project-level read proves absence; a missing file does not.
      if (error instanceof ProjectApiError && error.status === 404) throw this.forgetBoundProject(binding);
      throw error;
    }
    this.checkProject(binding, state, known);
    return state;
  }

  private checkProject(binding: Binding, state: ServerRevisions, known: Pick<Binding, 'revision' | 'sections'> = binding): void {
    this.requireBinding(binding);
    if (state.revision < known.revision || Object.entries(known.sections).some(([name, revision]) => (state.sections[name] ?? 0) < revision)) {
      throw this.forgetBoundProject(binding);
    }
  }

  private forgetBoundProject(binding: Binding): ProjectBindingLost {
    this.requireBinding(binding);
    this.files.forgetProject(binding.id);
    const names = this.sectionNames();
    this.unbind();
    const synced: SectionRecord<unknown> = {};
    for (const name of names) synced[name] = UNSAVED;
    this.synced = synced;
    this.publishRecord = null;
    this.saveSeen = null;
    this.saveFailure = null;
    this.copySeen = null;
    this.copyFailed = null;
    this.keeping = true;
    this.options.markLevelSaved(null);
    const unavailable = this.binaryFiles(this.documentValues()).filter(({ file }) => {
      const locations = this.files.locations(file);
      return locations.page === null && locations.published.length === 0 && locations.servers.length === 0;
    }).map(({ path }) => path);
    const refusal = new ProjectBindingLost(binding.id, unavailable);
    this.options.notice(refusal.message, 'error');
    this.changed('status');
    void this.storeCopy();
    return refusal;
  }

  // Before a whole project replaces the page's game: a failure part way must not leave the page
  // bound to the previous server project while holding the new project's data.
  private unbind(): void {
    this.invalidateBinding();
    this.binding = null;
    this.moving = null;
    this.origin = null;
    this.conflicts.clear();
    this.forget();
  }

  private invalidateProject(): void {
    this.imports.invalidateProject();
    this.invalidateBinding();
  }

  private invalidateBinding(): void {
    this.generation++;
    this.deferredCopy = null;
    this.cancelKeptRestores();
  }

  private cancelKeptRestores(): void {
    for (const controller of this.keptRestores) controller.abort();
    this.keptRestores.clear();
  }

  private retainFiles(files: readonly FileHandle[]): () => void {
    const release = this.files.retain([...new Set(files)], 'work');
    const done = (): void => {
      if (!this.fileWork.delete(done)) return;
      release();
    };
    this.fileWork.add(done);
    return done;
  }

  private draftManifest(roots: SectionValues = this.documentValues()): ProjectManifest {
    return validateProjectManifest({
      format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, title: roots.title, level: PROJECT_FILES.level,
      art: { assets: roots.art.assets.map(({ id, name }) => ({ id, name })), decorations: roots.art.decorations },
      settings: roots.settings,
      characters: { primary: null, alternate: null },
      armIk: roots['arm-ik'],
      appearance: roots.appearance.map(({ part, name, alignment }) => ({ part, name, alignment })),
      models: Object.fromEntries(PART_ROLES.map((role) => [role, roots.models[role].map((item) => item.entry)])),
      theme: roots.theme, hud: roots.hud, audio: roots.audio, enemies: roots.enemies,
      media: roots.media.map(({ path }) => ({ path })),
      plugins: Object.fromEntries(Object.entries(roots).flatMap(([name, value]) => {
        const id = pluginOfSection(name);
        return id === null || value === null ? [] : [[id, (value as SectionValues[`plugins/${string}`])!.data]];
      })),
    });
  }

  // Before exporting or storing a whole project: pending trigger event edits apply, and an unfinished outline stops it.
  private prepareLevel(): void {
    if (!this.options.prepareLevel()) {
      throw new ProjectError('Finish or cancel the unfinished outline, and fix any trigger events, in Level first.', { section: 'level' });
    }
  }

  // Everything except binary files, validated together with the level's references.
  private captureDraft(roots: SectionValues = this.documentValues()):
    { manifest: ProjectManifest; level: LevelDefinition; primary: SpriteDocument | null; alternate: SpriteDocument | null } {
    const manifest = this.manifestDraft(roots);
    const alternate = roots['characters/alternate'];
    const primary = this.primaryDraft(roots);
    if (alternate !== null) this.checkedCharacter(alternate, 'alternate character');
    return { manifest, level: this.levelDraft(manifest, roots.level), primary, alternate };
  }

  // The manifest of this page's project, referring to the characters it holds.
  private manifestDraft(roots: SectionValues = this.documentValues()): ProjectManifest {
    const alternate = roots['characters/alternate'];
    const primary = primaryProfile(roots);
    return validateProjectManifest({
      ...this.draftManifest(roots),
      characters: { primary: primary === null ? null : PROJECT_FILES.primary, alternate: alternate === null ? null : PROJECT_FILES.alternate },
    });
  }

  // The captured primary as a project stores it, or null for the default without an alternate.
  private primaryDraft(roots: SectionValues): SpriteDocument | null {
    const primary = primaryProfile(roots);
    return primary === null ? null : this.checkedCharacter(primary, 'primary character');
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
  private levelDraft(manifest: ProjectManifest, level: LevelDefinition): LevelDefinition {
    checkProjectReferences(manifest, level);
    return level;
  }

  // The binary files for a captured draft, each read from wherever this page has it.
  private async captureFiles(draft: ReturnType<ProjectSession['captureDraft']>, binaries: ServerFileWrite['files']): Promise<ProjectContent> {
    const files = new Map<string, Uint8Array>();
    const bytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());
    for (const { path, file } of binaries) files.set(path, await bytes(await this.files.blob(file, this.lifecycle.signal)));
    this.requireActive();
    return loadProjectContent(draft.manifest, (ref) => ref.kind === 'level' ? draft.level
      : ref.kind === 'character' ? (ref.path === PROJECT_FILES.primary ? draft.primary : draft.alternate) : files.get(ref.path));
  }

  // Every section this page knows of: the engine's, and each plugin section that has data here, was synced or appears
  // among `revisions`.
  private sectionNames(revisions: Readonly<Record<string, unknown>> = {}): ProjectSectionName[] {
    const plugins = new Set(this.history.document.sections().flatMap((section) => {
      const id = pluginOfSection(section);
      return id === null ? [] : [id];
    }));
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
    const plugins = new Set([...Object.keys(manifest.plugins), ...this.history.document.sections().flatMap((section) => {
      const id = pluginOfSection(section);
      return id === null ? [] : [id];
    })]);
    return [...PROJECT_SECTIONS, ...[...plugins].sort().map(pluginSection)];
  }

  // Records a section's synced fingerprint; a plugin section without data has none.
  private markSynced(name: ProjectSectionName, fingerprint: unknown): void {
    if (fingerprint === undefined) delete this.synced![name];
    else this.synced![name] = fingerprint;
  }

  // Each section's current value as a fingerprint: equal while the section is unchanged.
  fingerprints(roots: SectionValues = this.documentValues()): SectionRecord<unknown> {
    return { ...roots };
  }

  private documentValues(): SectionValues {
    const document = this.history.document;
    return Object.freeze(Object.fromEntries(document.sections().map((section) => [section, document.get(section)]))) as unknown as SectionValues;
  }

  private sectionFileWriteValue(section: BinarySectionName, value: SectionValue<BinarySectionName>): ServerFileWrite {
    switch (section) {
      case 'art': return { section, files: (value as DocumentArt).assets.map((asset) => ({ path: artFile(asset.id), file: asset.file })), replacesSection: true };
      case 'media': return { section, files: (value as DocumentMedia).map((item) => ({ path: mediaFile(item.path), file: item.file })), replacesSection: true };
      case 'models': {
        const models = value as DocumentModels;
        return { section, files: PART_ROLES.flatMap((role) => models[role].map((item) => ({ path: libraryModelFile(role, item.entry.id), file: item.file }))),
          replacesSection: true };
      }
      case 'appearance': return { section, files: (value as DocumentAppearance).map((part) => ({ path: appearanceFile(part.part), file: part.file })),
        replacesSection: true };
    }
  }

  private sectionFileWrite(roots: SectionValues, section: BinarySectionName): ServerFileWrite {
    return this.sectionFileWriteValue(section, roots[section]);
  }

  private binaryFiles(roots: SectionValues): ServerFileWrite['files'] {
    return BINARY_SECTIONS.flatMap((section) => this.sectionFileWrite(roots, section).files);
  }

  // Takes the project's level version from a server answer whose level, settings and enemies revisions are the ones this
  // page last saved or loaded, which the synced fingerprints hold: the page plays that version while it holds them.
  // Versions never change, so the binding stays right however the project moves on; answers about other revisions leave
  // it.
  private adoptVersion(binding: Binding, state: ServerRevisions): void {
    this.checkProject(binding, state);
    const level = state.level;
    if (level === null || VERSIONED.some((name) => state.sections[name] !== binding.sections[name])) return;
    const synced = this.synced!;
    const bound = binding.version;
    if (bound?.version === level.version && bound.level === synced.level && bound.settings === synced.settings &&
      bound.enemies === synced.enemies) return;
    binding.version = {
      project: binding.id, version: level.version, course: level.course,
      level: synced.level, settings: synced.settings, enemies: synced.enemies,
    };
    this.changed('status');
  }

  private async run(label: string, task: () => Promise<void>, held = false): Promise<boolean> {
    return await this.attempt(label, task, held) === undefined;
  }

  private requireActive(generation = this.generation): void {
    if (this.disposed) throw new SessionClosed();
    if (generation !== this.generation) throw new ProjectError('The project was replaced while this operation was running. Try again.');
  }

  private requireBinding(binding: Binding): void {
    this.requireActive();
    if (this.binding !== binding) throw new ProjectBindingLost(binding.id);
  }

  private holdHistory(): () => void {
    const release = this.history.hold();
    const done = (): void => {
      this.historyHolds.delete(done);
      release();
    };
    this.historyHolds.add(done);
    return done;
  }

  // Runs one operation, reporting a typed refusal; project boundaries hold Undo/Redo while they wait.
  private async attempt<T>(label: string, task: () => Promise<T>, held = false): Promise<T | Error> {
    let release: (() => void) | null = null;
    let running = false;
    try {
      this.requireActive();
      if (held) release = this.holdHistory();
      // An automatic save finishes first, so an action never sees the project half written.
      while (this.saving !== null) {
        await this.saving;
        this.requireActive();
      }
      if (this.busy !== null) {
        const refusal = new ProjectError(`Wait for "${this.busy}" to finish first.`);
        this.options.notice(refusal.message, 'error');
        return refusal;
      }
      this.busy = label;
      running = true;
      this.error = null;
      this.changed('status');
      const result = await task();
      this.requireActive();
      return result;
    } catch (error) {
      if (error instanceof SessionClosed || (this.disposed && isExpected(error))) return this.refuse(error);
      if (error instanceof ProjectApiError && error.status === 412 && error.section !== null) {
        this.conflicts.add(error.section as ProjectSectionName);
        return this.refuse(new ProjectError(`${error.message} In Project, keep your version of ${error.section} or use the project's.`));
      }
      return this.refuse(error);
    } finally {
      try {
        if (running) {
          this.busy = null;
          this.changed('status');
        }
      } finally {
        release?.();
      }
    }
  }

  // Reports a refusal and returns it; anything but an expected refusal is a programmer error and propagates.
  private refuse(error: unknown): Error {
    if (error instanceof SessionClosed || error instanceof ProjectBindingLost || error instanceof AutomaticOpeningSkipped) return error;
    if (this.disposed && isExpected(error)) return new SessionClosed();
    this.report(error);
    return error as Error;
  }

  private report(error: unknown): void {
    if (error instanceof SessionClosed) return;
    if (!isExpected(error)) throw error;
    if (this.disposed) return;
    this.error = error instanceof SyntaxError ? `The file is not valid JSON: ${error.message}` : describe(error);
    this.options.notice(this.error, 'error');
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

// Default profiles need no project file unless an alternate requires one.
function primaryProfile(roots: SectionValues): SpriteDocument | null {
  const primary = roots['characters/primary'];
  return roots['characters/alternate'] === null && isDefaultCharacter(primary) ? null : primary;
}

function unanswered(error: unknown): boolean {
  return error instanceof ProjectApiError && (error.status === 0 || error.status >= 500) ||
    error instanceof DOMException && error.name === 'AbortError' || error instanceof SyntaxError;
}

function unchangedSection<S extends SectionName>(history: History, section: S): SomeSectionChange {
  const value = history.document.get(section);
  return adapterFor(section).change(value, value) as SomeSectionChange;
}

function withConsumerCuts(history: History, changes: readonly SomeSectionChange[]): readonly SomeSectionChange[] {
  const consumers = new Set<SectionName>();
  for (const change of changes) {
    if (change.before === change.after) continue;
    if (change.section === 'art') {
      const assets = new Set(change.after.assets.map((asset) => asset.id));
      if (change.before.assets.some((asset) => !assets.has(asset.id)) ||
        Object.keys(change.before.decorations).some((id) => !Object.hasOwn(change.after.decorations, id))) {
        consumers.add('level');
        consumers.add('enemies');
      }
    } else if (change.section === 'media') {
      const paths = new Set(change.after.map((file) => file.path));
      if (change.before.some((file) => !paths.has(file.path))) {
        consumers.add('level');
        consumers.add('audio');
      }
    }
  }
  if (consumers.size === 0) return changes;
  const named = new Set(changes.map((change) => change.section));
  // Equal-value changes cut without changing the consumers' roots.
  return [...changes, ...[...consumers].filter((section) => !named.has(section)).map((section) => unchangedSection(history, section))];
}

function fileSizes(files: readonly { readonly path: string; readonly bytes: number }[]): Map<string, number> {
  return new Map(files.map((file) => [file.path, file.bytes]));
}

function projectFileName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}
