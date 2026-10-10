// Runs the manifest's workshop facets (docs/workshop-plugins.md). Once the project is open, each plugin
// starts with a host of its own: its places in the Workshop, the project, its own data and the running game. Each is
// isolated: an error it throws stops it alone, and everything it added goes with it. A change to a workshop facet restarts
// the plugins and keeps the project's unsaved changes.
import workshopFacets from 'virtual:game-plugins/workshop';
import kinds, { plugins as manifestPlugins } from 'virtual:game-plugins/kinds';
import type { Point } from '../config';
import type { Game } from '../game';
import type { GameSettings } from '../game-settings';
import type { PluginData } from '../plugin-data';
import { isPluginId } from '../plugin-data';
import { isProjectDataError } from '../project';
import type { PresentationPreview } from '../character-view';
import { SCENE_LAYER_CONTRACT } from '../scene-layer';
import type { SceneLayer } from '../scene-layer';
import type { Appearance } from './appearance';
import type { WorkshopGameState } from './game-state';
import type { LevelState } from './level-state';
import { PROJECT_SECTIONS } from './project-session';
import type { ProjectPlugins, ProjectSession } from './project-session';
import type { SpriteEditorHandle } from './sprite-editor';
import type { GameUi, PluginSectionTab, PluginWorkshopTab, WorkshopState } from './ui-types';
import { apply1, attributed, call0, call1, call2, checkInstance, PluginError, pluginFailure, pluginRefusal } from '../plugins/kernel';
import type { Attributed, PluginEntry } from '../plugins/kernel';
import type { Kinds } from '../plugins/kinds';
import { composeWorkshop } from './workshop';
import type { AvatarMotionControls } from './avatar-motion-controls';
import { ENGINE_LEVEL_REACH, LEVEL_REACH } from './level-check-points';
import type { LevelCheck, LevelReachSource } from './level-check-points';
import { WORKSHOP_PREVIEW_LIMITS } from './workshop-sdk';
import type {
  WorkshopCharacterEdits, WorkshopEdits, WorkshopGame, WorkshopHost, WorkshopLevelEdits, WorkshopMount,
  WorkshopFacet, WorkshopPluginData, WorkshopPointerEvent, WorkshopPreview, WorkshopProject, WorkshopProjectSnapshot,
  WorkshopRefusal, WorkshopSectionTab,
} from './workshop-sdk';
import { createSection } from './workshop-section';
import { createWorkshopUiKit } from './workshop-ui-kit';
import './workshop-plugins.css';

const SECTION_TABS: readonly WorkshopSectionTab[] = ['character', 'level', 'physics', 'project'];
const POINTER_TYPES: Readonly<Record<string, WorkshopPointerEvent['type']>> = {
  pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel',
};

type RegistryEvent = { readonly kind: 'replaced' } | { readonly kind: 'failed'; readonly id: string; readonly error: Error };

/**
 * The workshop facets as this page has them, and what the project needs of them: which plugins the Workshop has, and
 * each one's check of its data. A hot update replaces them. A plugin that fails stays stopped until then,
 * and its data stays as it is, no longer checked.
 */
export class WorkshopPluginRegistry implements ProjectPlugins {
  private definitions: ReadonlyMap<string, WorkshopFacet> = new Map();
  private controls: AvatarMotionControls = new Map();
  private checks: ReadonlyMap<string, LevelCheck> = new Map();
  private reach: Attributed<LevelReachSource> = attributed(null, LEVEL_REACH.id, ENGINE_LEVEL_REACH);
  private readonly kinds: Kinds;
  private problem: PluginError | null = null;
  private readonly failures = new Set<string>();
  // Each plugin's last error, kept across hot updates.
  private readonly errors = new Map<string, Error>();
  private readonly listeners = new Set<(event: RegistryEvent) => void>();

  // Load and hot update share the same refusal state; the host reports it once the Workshop is ready.
  constructor(value: unknown, kinds: Kinds) {
    this.kinds = kinds;
    this.replace(value);
  }

  get plugins(): readonly PluginEntry<WorkshopFacet>[] {
    return [...this.definitions].map(([id, facet]) => ({ id, facet }));
  }

  motionControls(): AvatarMotionControls {
    return this.controls;
  }

  // The plugins' rules for the Level tab's checks, by ID.
  levelChecks(): ReadonlyMap<string, LevelCheck> {
    return this.checks;
  }

  // Where the Level tab's reach model comes from: the engine's, or a plugin's that replaced or wrapped it.
  levelReach(): Attributed<LevelReachSource> {
    return this.reach;
  }

  // Why the facets cannot run at load or after a hot update.
  get facetError(): PluginError | null {
    return this.problem;
  }

  failed(id: string): boolean {
    return this.failures.has(id);
  }

  lastError(id: string): Error | null {
    return this.errors.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  // The plugin's check of its data: its typed refusal, or null. A plugin whose check throws anything else has failed:
  // it stops, and its data, this one included, is no longer checked, so a faulty plugin never holds the project back.
  validate(id: string, data: PluginData): Error | null {
    const plugin = this.definitions.get(id);
    if (plugin?.validate === undefined || this.failures.has(id)) return null;
    // A typed data refusal is not a thrown plugin fault. Intercept it before the adapter attributes thrown faults.
    let refusal: PluginError | null = null;
    const validate = attributed(id, null, (value: PluginData) => {
      try { return plugin.validate!(value); } catch (error) {
        refusal = pluginRefusal(error, id);
        if (refusal === null) throw error;
      }
    });
    try {
      apply1(validate, 'validate', data);
      return refusal;
    } catch (error) {
      this.fail(id, error, 'validate');
      return null;
    }
  }

  fail(id: string, error: unknown, action: string): void {
    if (!this.definitions.has(id) || this.failures.has(id)) return;
    const failure = pluginFailure(error, id, null, action);
    this.failures.add(id);
    this.errors.set(id, failure);
    for (const listener of this.listeners) listener({ kind: 'failed', id, error: failure });
  }

  // Composition is atomic at load and hot update; invalid facets keep the project's data but cannot run.
  replace(value: unknown): void {
    this.failures.clear();
    try {
      const composed = composeWorkshop(value, this.kinds);
      this.definitions = new Map(composed.entries.map(({ id, facet }) => [id, facet]));
      this.controls = composed.controls;
      this.checks = composed.checks;
      this.reach = composed.reach;
      this.problem = null;
    } catch (error) {
      if (!(error instanceof PluginError)) throw error;
      this.definitions = new Map();
      this.controls = new Map();
      this.checks = new Map();
      this.reach = attributed(null, LEVEL_REACH.id, ENGINE_LEVEL_REACH);
      this.problem = error;
      if (error.plugin !== null) this.errors.set(error.plugin, error);
    }
    for (const listener of this.listeners) listener({ kind: 'replaced' });
  }

  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const workshopPlugins = new WorkshopPluginRegistry(workshopFacets, kinds);

// A change to the plugins replaces them here, so the Workshop itself, and the open project, stay.
if (import.meta.hot) {
  import.meta.hot.accept('virtual:game-plugins/workshop', (next) => {
    if (next !== undefined) workshopPlugins.replace(next.default);
  });
}

export interface WorkshopPluginHostOptions {
  readonly registry: WorkshopPluginRegistry;
  readonly ui: GameUi;
  readonly game: Game;
  readonly canvas: HTMLCanvasElement;
  readonly project: ProjectSession;
  readonly level: LevelState;
  readonly character: Pick<SpriteEditorHandle, 'snapshot' | 'subscribe' | 'edits'>;
  readonly appearance: Appearance;
  // Physics' edit of the game settings, which reports a refusal as Physics does and returns it.
  readonly settings: (value: GameSettings) => Error | null;
  readonly control: { restart(): void; placePlayer(position: Point): void; state(): WorkshopGameState };
  readonly notice: (message: string, kind: 'info' | 'error') => void;
}

type Fingerprints = ReturnType<ProjectSession['fingerprints']>;

// Whether the engine's sections are unchanged; plugins' data is not part of the project they read.
function sameProject(a: Fingerprints, b: Fingerprints): boolean {
  return PROJECT_SECTIONS.every((name) => a[name] === b[name]);
}

// `edits` whose operations first call `live`.
function checkedEdits<T extends object>(edits: T, live: () => void): T {
  return Object.freeze(Object.fromEntries(Object.entries(edits).map(([key, value]) => [
    key, typeof value === 'function'
      ? (...args: unknown[]) => {
        live();
        return (value as (...args: unknown[]) => unknown)(...args);
      }
      : checkedEdits(value as object, live),
  ]))) as T;
}

interface MountRecord {
  readonly listeners: Set<(shown: boolean) => void>;
  shown: boolean;
  readonly visible: (state: WorkshopState) => boolean;
  readonly remove: () => void;
}

class RunningPlugin {
  readonly id: string;
  readonly controller = new AbortController();
  readonly mounts = new Map<string, MountRecord>();
  readonly overlays = new Set<SceneLayer>();
  readonly pointerListeners = new Set<(event: WorkshopPointerEvent) => void>();
  readonly projectListeners = new Set<() => void>();
  readonly dataListeners = new Set<(data: PluginData | null) => void>();
  // The data its listeners last heard of.
  data: PluginData | null;
  paused = false;
  // Set at once on a failure or stop: nothing of the plugin runs after it, and its host refuses everything.
  stopping = false;
  private readonly registry: WorkshopPluginRegistry;

  constructor(id: string, registry: WorkshopPluginRegistry, data: PluginData | null) {
    this.id = id;
    this.registry = registry;
    this.data = data;
  }

  // `callback`, so that an error it throws, or a promise it rejects, stops this plugin.
  guard<A extends unknown[]>(callback: (...args: A) => unknown, action = 'callback'): (...args: A) => void {
    return (...args: A) => {
      if (this.stopping) return;
      try {
        const result = callback(...args);
        if (result instanceof Promise) result.catch((error: unknown) => this.fail(error, action));
      } catch (error) {
        this.fail(error, action);
      }
    };
  }

  fail(error: unknown, action: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.registry.fail(this.id, error, action);
  }

  // Refuses a host operation once the plugin has stopped, so late work of a stopped plugin adds nothing.
  live(): void {
    if (this.stopping) throw new PluginError('plugin-stopped', `Workshop plugin "${this.id}" has stopped.`, this.id);
  }
}

/**
 * The Workshop's running plugins: created with the editors; start() runs the plugins once the project is open. It adds
 * no per-frame work of its own: only plugins' overlays and previews run each frame, while they are active.
 */
export class WorkshopPluginHost {
  private readonly options: WorkshopPluginHostOptions;
  private readonly running = new Map<string, RunningPlugin>();
  private readonly lifecycle = new AbortController();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly edits: WorkshopEdits;
  private started = false;
  private workshop: WorkshopState;
  // The snapshot plugins read and the sections it shows; `stale` once anything may have changed them.
  private snapshotCache: { readonly fingerprints: Fingerprints; readonly snapshot: WorkshopProjectSnapshot } | null = null;
  private stale = true;
  // What plugins' project listeners last heard of, and whether a batch of changes is waiting to be told.
  private told: Fingerprints | null = null;
  private telling = false;
  private drag: { readonly plugin: RunningPlugin; readonly pointerId: number } | null = null;
  private preview: { readonly plugin: RunningPlugin; readonly preview: PresentationPreview } | null = null;

  constructor(options: WorkshopPluginHostOptions) {
    this.options = options;
    this.workshop = options.ui.workshopState();
    this.edits = this.createEdits();
    const changed = (): void => this.projectChanged();
    this.unsubscribe.push(
      options.registry.subscribe((event) => this.registryChanged(event)),
      options.project.subscribe(changed),
      options.level.subscribe(changed),
      options.character.subscribe(changed),
      options.appearance.subscribe(changed),
    );
    const signal = this.lifecycle.signal;
    // In the capture phase, before the game's own canvas listeners, so a drag a plugin takes never reaches the game.
    for (const type of Object.keys(POINTER_TYPES)) {
      options.canvas.addEventListener(type, (event) => this.pointer(event as PointerEvent), { capture: true, signal });
    }
    options.canvas.addEventListener('lostpointercapture', (event) => {
      const drag = this.drag;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      this.deliver(drag.plugin, event, 'cancel', false);
      this.endDrag();
    }, { signal });
  }

  // Starts the plugins, once the project is open.
  start(): void {
    if (this.started || this.lifecycle.signal.aborted) return;
    this.started = true;
    if (this.showFacetError()) return;
    this.startAll();
  }

  // The Workshop's open state and tab, which decide which plugin tabs and sections are shown.
  setWorkshop(state: WorkshopState): void {
    this.workshop = state;
    for (const plugin of this.running.values()) for (const mount of plugin.mounts.values()) this.updateMount(mount);
  }

  // The game settings changed; they are part of the project plugins read.
  settingsChanged(): void {
    this.projectChanged();
  }

  inspect() {
    const registry = this.options.registry;
    return {
      facetError: registry.facetError?.message ?? null,
      plugins: manifestPlugins.map(({ id, facets }) => ({
        id, facets, workshopRunning: this.running.get(id)?.stopping === false, error: registry.lastError(id)?.message ?? null,
      })),
    };
  }

  dispose(): void {
    for (const id of [...this.running.keys()].reverse()) this.stop(id);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.lifecycle.abort();
  }

  private startAll(): void {
    this.told = this.options.project.fingerprints();
    for (const { id, facet } of this.options.registry.plugins) {
      if (this.options.registry.failed(id)) continue;
      const plugin = new RunningPlugin(id, this.options.registry, this.options.project.pluginDataOf(id));
      const host = this.createHost(plugin);
      this.running.set(plugin.id, plugin);
      plugin.guard(() => facet.start(host), 'start')();
    }
  }

  private showFacetError(): boolean {
    const problem = this.options.registry.facetError;
    if (problem === null) return false;
    this.options.notice(`The Workshop facets cannot run until fixed: ${problem.message}`, 'error');
    return true;
  }

  private registryChanged(event: RegistryEvent): void {
    if (event.kind === 'failed') {
      console.error(`Workshop plugin "${event.id}" failed.`, event.error);
      this.options.notice(`Workshop plugin "${event.id}" failed and stopped: ${event.error.message}`, 'error');
      const plugin = this.running.get(event.id);
      if (plugin === undefined) return;
      plugin.stopping = true;
      // Outside the failing call, which may be the game's frame or another plugin's notification.
      queueMicrotask(() => { if (this.running.get(event.id) === plugin) this.stop(event.id); });
      return;
    }
    for (const id of [...this.running.keys()].reverse()) this.stop(id);
    if (this.showFacetError()) return;
    if (!this.started) return;
    this.startAll();
    const ids = this.options.registry.plugins.map(({ id }) => id);
    this.options.notice(ids.length === 0 ? 'There are now no Workshop facets.' : `Restarted the Workshop plugins: ${ids.join(', ')}.`, 'info');
  }

  // Removes everything the plugin added: its places, overlays, listeners, preview, pause and drag.
  private stop(id: string): void {
    const plugin = this.running.get(id);
    if (plugin === undefined) return;
    this.running.delete(id);
    plugin.stopping = true;
    plugin.controller.abort();
    for (const mount of [...plugin.mounts.values()]) mount.remove();
    for (const layer of [...plugin.overlays]) this.options.game.view.removeLayer(layer);
    plugin.overlays.clear();
    plugin.pointerListeners.clear();
    plugin.projectListeners.clear();
    plugin.dataListeners.clear();
    this.endPreview(plugin);
    if (this.drag?.plugin === plugin) this.endDrag();
    if (plugin.paused) this.options.game.setPause({ reason: `plugin:${id}`, paused: false });
  }

  // Something the project's snapshot holds may have changed. Plugins hear of real changes once per batch.
  private projectChanged(): void {
    this.stale = true;
    if (this.telling || this.running.size === 0) return;
    this.telling = true;
    queueMicrotask(() => {
      this.telling = false;
      this.tell();
    });
  }

  private tell(): void {
    const { project } = this.options;
    for (const plugin of this.running.values()) {
      const data = project.pluginDataOf(plugin.id);
      if (data === plugin.data) continue;
      plugin.data = data;
      for (const listener of plugin.dataListeners) listener(data);
    }
    const fingerprints = project.fingerprints();
    if (this.told !== null && sameProject(this.told, fingerprints)) return;
    this.told = fingerprints;
    for (const plugin of this.running.values()) for (const listener of plugin.projectListeners) listener();
  }

  // The open project as plugins read it: host.project.snapshot(), which the Level tab's checks also give plugins' rules.
  projectSnapshot(): WorkshopProjectSnapshot {
    return this.snapshot();
  }

  private snapshot(): WorkshopProjectSnapshot {
    const cached = this.snapshotCache;
    if (cached !== null && !this.stale) return cached.snapshot;
    const { project, level, character, appearance } = this.options;
    const fingerprints = project.fingerprints();
    if (cached !== null && sameProject(cached.fingerprints, fingerprints)) {
      this.stale = false;
      return cached.snapshot;
    }
    const manifest = project.manifest();
    const snapshot: WorkshopProjectSnapshot = Object.freeze({
      title: manifest.title, settings: manifest.settings, level: level.definition(),
      characters: Object.freeze({ primary: character.snapshot().document, alternate: project.alternateCharacter() }),
      library: manifest.models, theme: manifest.theme, hud: manifest.hud, audio: manifest.audio, enemies: manifest.enemies,
      art: manifest.art, media: manifest.media, armIk: appearance.armIkSettings(), appearance: manifest.appearance,
    });
    this.snapshotCache = { fingerprints, snapshot };
    this.stale = false;
    return snapshot;
  }

  private updateMount(mount: MountRecord): void {
    const shown = mount.visible(this.workshop);
    if (shown === mount.shown) return;
    mount.shown = shown;
    for (const listener of mount.listeners) listener(shown);
  }

  // A tab's or section's mount: `id` is unique among the plugin's tabs and sections.
  private mount(plugin: RunningPlugin, id: string, element: HTMLElement, visible: (state: WorkshopState) => boolean,
    remove: () => void, toggles?: HTMLDetailsElement): WorkshopMount {
    element.classList.add('workshop-plugin');
    const record: MountRecord = {
      listeners: new Set(), shown: visible(this.workshop), visible,
      remove: () => {
        if (plugin.mounts.get(id) !== record) return;
        plugin.mounts.delete(id);
        record.listeners.clear();
        remove();
      },
    };
    plugin.mounts.set(id, record);
    toggles?.addEventListener('toggle', () => this.updateMount(record), { signal: plugin.controller.signal });
    return Object.freeze({
      element,
      get shown() { return record.shown; },
      onVisibility: (listener: (shown: boolean) => void) => {
        plugin.live();
        const guarded = plugin.guard(listener);
        record.listeners.add(guarded);
        return () => { record.listeners.delete(guarded); };
      },
      remove: record.remove,
    });
  }

  private placeId(plugin: RunningPlugin, kind: 'tab' | 'section', id: string): void {
    if (!isPluginId(id)) {
      throw new PluginError('invalid-plugin', `Plugin ${kind} IDs use lowercase letters, digits and hyphens, starting with a letter, not "${id}".`, plugin.id);
    }
    if (plugin.mounts.has(id)) throw new PluginError('invalid-plugin', `Workshop plugin "${plugin.id}" already has a tab or section "${id}".`, plugin.id);
  }

  private createHost(plugin: RunningPlugin): WorkshopHost {
    const { options } = this;
    const signal = plugin.controller.signal;
    const live = (): void => plugin.live();
    const notice = (message: string, kind: 'info' | 'error' = 'info'): void => options.notice(message, kind);
    const listener = <A extends unknown[]>(listeners: Set<(...args: A) => void>, callback: (...args: A) => void): () => void => {
      live();
      const guarded = plugin.guard(callback);
      listeners.add(guarded);
      return () => { listeners.delete(guarded); };
    };
    const project: WorkshopProject = Object.freeze({
      snapshot: () => this.snapshot(),
      subscribe: (callback: () => void) => listener(plugin.projectListeners, callback),
      edit: checkedEdits(this.edits, live),
    });
    const data: WorkshopPluginData = Object.freeze({
      get: () => options.project.pluginDataOf(plugin.id),
      set: (value: PluginData | null) => {
        live();
        return options.project.setPluginData(plugin.id, value);
      },
      subscribe: (callback: (value: PluginData | null) => void) => listener(plugin.dataListeners, callback),
    });
    return Object.freeze({
      plugin: plugin.id,
      signal,
      addTab: (tab: { readonly id: string; readonly label: string; readonly title?: string }) => {
        live();
        this.placeId(plugin, 'tab', tab.id);
        const id: PluginWorkshopTab = `plugin_${plugin.id}_${tab.id}`;
        const added = options.ui.addTab({ id, label: tab.label, title: tab.title });
        return this.mount(plugin, tab.id, added.body, (state) => state.open && state.tab === id, added.remove);
      },
      addSection: (tab: WorkshopSectionTab, section: { readonly id: string; readonly title: string; readonly hint?: string; readonly open?: boolean }) => {
        live();
        if (!SECTION_TABS.includes(tab)) throw new PluginError('invalid-plugin', `Plugins add sections to ${SECTION_TABS.join(', ')}, not "${tab}".`, plugin.id);
        this.placeId(plugin, 'section', section.id);
        const created = createSection({ id: `plugin_${plugin.id}_${section.id}`, title: section.title, hint: section.hint, open: section.open });
        options.ui.pluginSections(tab as PluginSectionTab).append(created.root);
        return this.mount(plugin, section.id, created.body, (state) => state.open && state.tab === tab && created.root.open,
          () => created.root.remove(), created.root);
      },
      ui: createWorkshopUiKit({ prefix: `plugin_${plugin.id}`, signal, guard: (callback) => plugin.guard(callback), notice }),
      project,
      data,
      game: this.createGame(plugin),
      notice,
      guard: <A extends unknown[]>(callback: (...args: A) => void) => plugin.guard(callback),
      listen: (target: EventTarget, type: string, callback: (event: Event) => void, listenOptions: { readonly capture?: boolean; readonly passive?: boolean } = {}) => {
        live();
        target.addEventListener(type, plugin.guard(callback), { capture: listenOptions.capture, passive: listenOptions.passive, signal });
      },
    });
  }

  private createGame(plugin: RunningPlugin): WorkshopGame {
    const { game, control } = this.options;
    const live = (): void => plugin.live();
    return Object.freeze({
      addOverlay: (overlay: SceneLayer) => {
        live();
        const target = checkInstance<SceneLayer>(SCENE_LAYER_CONTRACT, overlay, { plugin: plugin.id, point: null }, 'invalid-plugin');
        const layer: SceneLayer = {
          root: overlay.root, pass: target.captured.pass!,
          update: overlay.update === undefined ? undefined : (frame) => {
            if (plugin.stopping) return;
            try {
              call1(target, 'update', frame);
            } catch (error) {
              plugin.fail(error, 'update');
            }
          },
          // Frees the overlay's resources even while the plugin stops.
          dispose: overlay.dispose === undefined ? undefined : () => {
            try {
              call0(target, 'dispose');
            } catch (error) {
              if (plugin.stopping) console.error(`Workshop plugin "${plugin.id}" failed freeing an overlay.`, error);
              else plugin.fail(error, 'dispose');
            }
          },
        };
        game.view.addLayer(layer, target);
        plugin.overlays.add(layer);
        return () => {
          if (plugin.overlays.delete(layer)) game.view.removeLayer(layer);
        };
      },
      onPointer: (callback: (event: WorkshopPointerEvent) => void) => {
        live();
        const guarded = plugin.guard(callback);
        plugin.pointerListeners.add(guarded);
        return () => { plugin.pointerListeners.delete(guarded); };
      },
      project: (point: Point) => game.view.project(point),
      unproject: (client: Point) => game.view.unproject(client),
      pause: (paused: boolean) => {
        live();
        plugin.paused = paused;
        game.setPause({ reason: `plugin:${plugin.id}`, paused });
      },
      restart: () => {
        live();
        control.restart();
      },
      placePlayer: (position: Point) => {
        live();
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
          throw new PluginError('invalid-plugin', 'The player is placed at a finite position.', plugin.id);
        }
        control.placePlayer({ x: position.x, y: position.y });
      },
      state: () => control.state(),
      avatar: () => game.view.character.importedAvatar(),
      preview: (preview: 'sway' | 'jolt' | WorkshopPreview | null) => {
        live();
        this.startPreview(plugin, preview);
      },
    });
  }

  private startPreview(plugin: RunningPlugin, value: 'sway' | 'jolt' | WorkshopPreview | null): void {
    const view = this.options.game.view.character;
    if (value === null) {
      this.endPreview(plugin);
      return;
    }
    if (value === 'sway' || value === 'jolt') {
      this.preview = null;
      view.previewMotion(value);
      return;
    }
    const { duration } = value;
    if (!Number.isFinite(duration) || duration <= 0 || duration > WORKSHOP_PREVIEW_LIMITS.duration) {
      throw new PluginError('invalid-plugin', `A preview lasts more than 0 and at most ${WORKSHOP_PREVIEW_LIMITS.duration} seconds.`, plugin.id);
    }
    const limit = WORKSHOP_PREVIEW_LIMITS.distance;
    const target = attributed(plugin.id, null, value);
    const preview: PresentationPreview = {
      duration,
      // A non-finite offset ends the preview: so does a failure, or the plugin stopping.
      offset: (elapsed, out) => {
        if (plugin.stopping) {
          out.x = Number.NaN;
          return;
        }
        try {
          call2(target, 'offset', elapsed, out);
        } catch (error) {
          plugin.fail(error, 'offset');
          out.x = Number.NaN;
          return;
        }
        // Within reach of the player, so a stray value never throws the character out of view.
        const distance = Math.sqrt(out.x * out.x + out.y * out.y);
        if (distance > limit) {
          out.x *= limit / distance;
          out.y *= limit / distance;
        }
      },
    };
    this.preview = { plugin, preview };
    view.previewPresentation(preview);
  }

  private endPreview(plugin: RunningPlugin): void {
    const running = this.preview;
    if (running === null || running.plugin !== plugin) return;
    this.preview = null;
    this.options.game.view.character.endPresentationPreview(running.preview);
  }

  // Canvas pointer events for plugins, unless the mouse is captured for play. A plugin that captures a `down` takes the
  // drag: the game sees none of its events, and game input stays blocked until it ends.
  private pointer(event: PointerEvent): void {
    if (this.running.size === 0 || document.pointerLockElement === this.options.canvas) return;
    const type = POINTER_TYPES[event.type]!;
    const drag = this.drag;
    if (drag !== null) {
      if (event.pointerId !== drag.pointerId) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      this.deliver(drag.plugin, event, type, false);
      if (type === 'up' || type === 'cancel') this.endDrag();
      return;
    }
    for (const plugin of this.running.values()) {
      if (!this.deliver(plugin, event, type, type === 'down') || plugin.stopping) continue;
      event.stopImmediatePropagation();
      event.preventDefault();
      this.drag = { plugin, pointerId: event.pointerId };
      this.options.canvas.setPointerCapture(event.pointerId);
      this.options.game.setInputBlock({ reason: `plugin:${plugin.id}`, blocked: true });
      return;
    }
  }

  // Tells the plugin's pointer listeners; returns whether one captured the event, which only a `down` allows.
  private deliver(plugin: RunningPlugin, event: PointerEvent, type: WorkshopPointerEvent['type'], capturable: boolean): boolean {
    if (plugin.stopping || plugin.pointerListeners.size === 0) return false;
    let open = capturable;
    let captured = false;
    const client = { x: event.clientX, y: event.clientY };
    const message: WorkshopPointerEvent = Object.freeze({
      type, pointerId: event.pointerId, button: event.button,
      client: Object.freeze(client), world: Object.freeze(this.options.game.view.unproject(client)),
      shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      capture: () => { if (open) captured = true; },
    });
    for (const listener of plugin.pointerListeners) listener(message);
    open = false;
    return captured;
  }

  private endDrag(): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    if (this.options.canvas.hasPointerCapture(drag.pointerId)) this.options.canvas.releasePointerCapture(drag.pointerId);
    this.options.game.setInputBlock({ reason: `plugin:${drag.plugin.id}`, blocked: false });
  }

  // The engine's edit operations, as the built-in tabs make them: each reports a refusal as its tab does, and returns it.
  private createEdits(): WorkshopEdits {
    const { options } = this;
    const project = options.project;
    const character = options.character.edits;
    // The Level tab's operations throw their refusals.
    const level = (edit: () => void): WorkshopRefusal | null => {
      try {
        edit();
        return null;
      } catch (error) {
        if (!isProjectDataError(error)) throw error;
        options.notice(error.message, 'error');
        return error;
      }
    };
    const levelEdits: WorkshopLevelEdits = {
      upsert: (object) => level(() => options.level.upsert(object)),
      remove: (id) => level(() => options.level.remove(id)),
      edit: (batch) => level(() => { options.level.edit(batch); }),
      labels: (labels) => level(() => options.level.metadata({ labels })),
      name: (name) => level(() => options.level.metadata({ name })),
      replace: (definition) => level(() => options.level.merge(definition)),
    };
    const characterEdits: WorkshopCharacterEdits = {
      document: (value) => character.setDocument(value),
      riggingType: (value) => character.setCharacterRiggingType(value),
      armForwardDistance: (value) => character.setArmForwardDistance(value),
      waistLean: (value) => character.setWaistLean(value),
      grips: (value) => character.setGrips(value),
      arms: (value) => character.setArms(value),
      avatarMotion: (value) => character.setAvatarMotion(value),
      presentation: (value) => character.setPresentation(value),
    };
    const edits: WorkshopEdits = {
      title: (value) => project.setTitle(value),
      settings: (value) => options.settings(value),
      level: levelEdits,
      character: characterEdits,
      alternate: (document) => project.setAlternate(document),
      appearance: {
        armIk: (value) => options.appearance.setArmIk(value),
        parts: (parts) => options.appearance.setParts(parts),
      },
      theme: (value) => project.setTheme(value),
      hud: (value) => project.setHud(value),
      audio: (value) => project.setAudio(value),
      enemies: (value) => project.setEnemies(value),
      enemyModel: (species, file) => project.addEnemyModel(species, file),
      enemyClips: (species, clips) => project.setEnemyClips(species, clips),
      coursePackage: (file) => project.importCoursePackage(file),
      media: {
        add: async (file) => {
          const added = await project.addMedia(file);
          return typeof added === 'string' ? null : added;
        },
        remove: (path) => project.removeMedia(path),
      },
      library: {
        add: async (role, file) => {
          const added = await project.addLibraryModel(role, file);
          return added instanceof Error ? added : null;
        },
        remove: (role, id) => {
          project.removeLibraryModel(role, id);
          return null;
        },
        avatar: (id, settings) => project.setLibraryAvatar(id, settings),
        hammerHead: (id, head) => project.setLibraryHammerHead(id, head),
      },
    };
    return edits;
  }
}
