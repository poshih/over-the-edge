// Release boot: release facets compose access and load-flow services; each load attempt owns its runtime session.
// Nothing here decides who may load what. See docs/release-plugins.md.
import type { DecorationView } from './decoration-view';
import { AUDIO, createAudioOutput, SILENT_AUDIO_OUTPUT } from './game-audio';
import type { AudioOutput, GameAudioFactory } from './game-audio';
import { AudioDevice } from './audio-device';
import { bootSources, levelSoundSources } from './content';
import type { ContentManifest, ContentPins } from './content';
import type { ContentLoader } from './content-ref';
import { ContentError, ContentSession, publicAccess } from './content-session';
import type { ContentAccess } from './content-session';
import type { CharacterModelLoader } from './character-model-types';
import type { AppearanceSource } from './appearance-loader';
import type { VisualBinding, VisualPartId } from './character';
import { Game } from './game';
import type { GameLook } from './game-look';
import type { CourseArtSource } from './course-art-view';
import type { EnemyModelSource } from './enemy-models';
import type { MediaHost } from './media-host';
import { Disposal } from './disposal';
import { characterLabels, createPlayUI } from './play-ui';
import { DEFAULT_NOTICES, NOTICES } from './notice';
import { createFatalDisplay, DEFAULT_FATAL, FATAL } from './fatal-display';
import type { FatalDisplay } from './fatal-display';
import { ACCESS, FAILED, MODEL_FAILED, PHANTOMS, PROGRESS, READY, ReleasePlugins } from './plugins/release';
import type { ReleaseApi, ReleaseFacet } from './plugins/release';
import { RuntimePlugins } from './plugins/runtime';
import type { RuntimeFacet } from './plugins/runtime';
import { attributed, call0, call1, invalidResult } from './plugins/kernel';
import type { Attributed, PluginEntry } from './plugins/kernel';
import type { Kinds } from './plugins/kinds';
import type { PhantomBuild, Phantoms } from './phantoms';
import { readSelection, ReleaseModelLibrary } from './release-library';
import { EMPTY_SELECTION } from './model-library';
import type { ModelSelection } from './model-library';
import type { HudFrame } from './hud-readouts';
import { ReleaseMeasurements } from './release-measurements';
import { MENU } from './game-menu';
import type { MenuFactory } from './game-menu';
import { MenuSession } from './menu-session';
import { changePlayerSettings, playerAudio, readPlayerSettings, writePlayerSettings } from './player-settings';
import type { PlayerSettings } from './player-settings';

// Code the shell includes only when its content needs it, chosen at build time.
export interface ReleaseCode {
  readonly pins: ContentPins;
  // The SHA-256 of the level's play layout and physics, which phantom recordings and saved runs belong to.
  readonly course: string;
  readonly createCharacterModels: ((options: { content: ContentLoader }) => CharacterModelLoader) | null;
  readonly createCourseArt: CourseArtSource['create'] | null;
  readonly createEnemyModels: EnemyModelSource['create'] | null;
  readonly loadAppearance: ((visuals: ReadonlyMap<VisualPartId, VisualBinding>, parts: readonly AppearanceSource[],
    options: { signal?: AbortSignal; content?: ContentLoader }) => Promise<unknown>) | null;
  readonly audioOutput: GameAudioFactory | null;
  readonly createDecorations: (() => DecorationView) | null;
  readonly phantoms: PhantomBuild | null;
  readonly runtimePlugins: readonly PluginEntry<RuntimeFacet>[];
  readonly releasePlugins: readonly PluginEntry<ReleaseFacet>[];
  readonly kinds: Kinds;
}

interface Loaded {
  readonly session: ContentSession;
  readonly manifest: ContentManifest;
  readonly game: Game;
  readonly audio: AudioOutput;
  readonly audioDevice: AudioDevice;
  readonly library: ReleaseModelLibrary;
  readonly plugins: RuntimePlugins;
  readonly lifecycle: AbortController;
}

interface Attempt {
  readonly session: ContentSession;
  game: Game | null;
  audio: AudioOutput | null;
  audioDevice: AudioDevice | null;
  library: ReleaseModelLibrary | null;
  readonly plugins: RuntimePlugins;
  readonly lifecycle: AbortController;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class Release {
  private readonly canvas: HTMLCanvasElement;
  private readonly mount: HTMLElement;
  private readonly fatalElement: HTMLElement;
  private fatalDisplay: Attributed<FatalDisplay>;
  private readonly code: ReleaseCode;
  private readonly lifecycle = new AbortController();
  private readonly measurements = new ReleaseMeasurements();
  private readonly ui: ReturnType<typeof createPlayUI>;
  private plugins: ReleasePlugins | null = null;
  private menuFactory: Attributed<MenuFactory> | null = null;
  private loading: Attempt | null = null;
  private loaded: Loaded | null = null;
  private phantoms: Phantoms | null = null;
  private menu: MenuSession | null = null;
  // The player's own settings, read once and kept as they change.
  private playerSettings: PlayerSettings = readPlayerSettings();

  constructor(elements: { canvas: HTMLCanvasElement; mount: HTMLElement; fatal: HTMLElement }, code: ReleaseCode) {
    this.canvas = elements.canvas;
    this.mount = elements.mount;
    this.fatalElement = elements.fatal;
    this.fatalDisplay = createFatalDisplay(attributed(null, FATAL.id, DEFAULT_FATAL), elements.fatal);
    this.code = code;
    this.ui = createPlayUI({ mount: elements.mount });
  }

  async run(): Promise<void> {
    this.measurements.start();
    try {
      const contentUrl = new URL(this.code.pins.contentUrl, document.baseURI).href;
      this.plugins = await ReleasePlugins.start(this.code.releasePlugins, {
        mount: this.mount, contentUrl, phantomsUrl: this.phantomsUrl(), signal: this.lifecycle.signal,
        notice: (text: string, kind: 'info' | 'error' = 'info') => this.ui.notice(text, kind),
      });
      try { this.lifecycle.signal.throwIfAborted(); } catch (error) {
        // dispose() can run after startup succeeds but before this await hands the session to us.
        // It already disposed the UI; finish handing off the session by disposing its signals too.
        this.plugins.dispose();
        throw error;
      }
      const plugins = this.plugins;
      const fatalFactory = plugins.slot(FATAL, DEFAULT_FATAL);
      if (fatalFactory.value !== DEFAULT_FATAL) {
        const display = createFatalDisplay(fatalFactory, this.fatalElement);
        if (this.fatalDisplay.value.dispose !== undefined) call0(this.fatalDisplay, 'dispose');
        this.fatalDisplay = display;
      }
      this.ui.setNotices(plugins.slot(NOTICES, DEFAULT_NOTICES));
      const phantoms = plugins.slot(PHANTOMS, null);
      if (this.code.phantoms === null && phantoms.value !== null) {
        throw invalidResult(phantoms, 'supplies phantoms, but this release was built without them: set GAME_PHANTOMS_URL');
      }
      const access = plugins.slot(ACCESS, publicAccess(contentUrl)).value;
      const failed = plugins.slot(FAILED, async (error: ContentError) => { throw error; }).value;
      const menu = plugins.slot(MENU, null);
      this.menuFactory = menu.value === null ? null : attributed(menu.plugin, menu.point, menu.value);
      for (;;) {
        try {
          this.loaded = await this.load(access);
          break;
        } catch (error) {
          // A game that stopped itself has shown why; the loads it cancelled say nothing new.
          const halted = this.loading?.game?.halted === true;
          this.measurements.mark(this.lifecycle.signal.aborted ? 'aborted' : 'failed',
            this.loading?.session ?? null);
          this.discardAttempt();
          if (this.lifecycle.signal.aborted || halted && isAbort(error)) return;
          if (!(error instanceof ContentError)) throw error;
          await failed(error);
          if (this.lifecycle.signal.aborted) return;
        }
      }
      this.play(this.loaded);
    } catch (error) {
      this.measurements.mark(this.lifecycle.signal.aborted ? 'aborted' : 'failed',
        this.loading?.session ?? this.loaded?.session ?? null);
      const disposal = new Disposal();
      disposal.run(() => this.discardAttempt());
      disposal.run(() => this.discardLoaded());
      if (!this.lifecycle.signal.aborted || !isAbort(error)) {
        disposal.run(() => call1(this.fatalDisplay, 'show', `The game could not load: ${message(error)}`));
      }
      disposal.finish();
    }
  }

  dispose(): void {
    const disposal = new Disposal();
    disposal.run(() => this.lifecycle.abort(new DOMException('The release closed.', 'AbortError')));
    disposal.run(() => this.measurements.mark('aborted', this.loading?.session ?? this.loaded?.session ?? null));
    disposal.run(() => this.measurements.close());
    disposal.run(() => this.discardAttempt());
    disposal.run(() => this.discardLoaded());
    disposal.run(() => this.ui.dispose());
    if (this.fatalDisplay.value.dispose !== undefined) disposal.run(() => call0(this.fatalDisplay, 'dispose'));
    disposal.run(() => this.plugins?.dispose());
    disposal.finish();
  }

  private discardLoaded(): void {
    const disposal = new Disposal();
    const phantoms = this.phantoms;
    const menu = this.menu;
    const loaded = this.loaded;
    this.phantoms = null;
    this.menu = null;
    this.loaded = null;
    disposal.run(() => phantoms?.dispose());
    // The menu lets go of the game before it is disposed.
    disposal.run(() => menu?.dispose());
    if (loaded !== null) {
      disposal.run(() => loaded.lifecycle.abort(new DOMException('The game closed.', 'AbortError')));
      disposal.run(() => loaded.audio.dispose());
      disposal.run(() => loaded.audioDevice.dispose());
      // The game's views let go of library models before the library disposes them.
      disposal.run(() => loaded.game.dispose());
      disposal.run(() => loaded.library.dispose());
      disposal.run(() => loaded.session.dispose());
      disposal.run(() => this.ui.clear());
      disposal.run(() => loaded.plugins.dispose());
    }
    disposal.finish();
  }

  private discardAttempt(): void {
    const attempt = this.loading;
    if (attempt === null) return;
    this.loading = null;
    const disposal = new Disposal();
    const audio = attempt.audio;
    if (audio !== null) disposal.run(() => audio.dispose());
    disposal.run(() => attempt.audioDevice?.dispose());
    disposal.run(() => attempt.lifecycle.abort(new DOMException('The load attempt closed.', 'AbortError')));
    disposal.run(() => attempt.game?.dispose());
    disposal.run(() => attempt.library?.dispose());
    disposal.run(() => attempt.session.dispose());
    disposal.run(() => attempt.plugins.dispose());
    disposal.finish();
  }

  private async load(access: ContentAccess): Promise<Loaded> {
    this.measurements.beginAttempt();
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([this.lifecycle.signal, lifecycle.signal]);
    const plugins = RuntimePlugins.start(this.code.runtimePlugins, {
      notice: (text, kind = 'info') => this.ui.notice(text, kind),
    });
    const session = new ContentSession({
      access, pins: this.code.pins, onProgress: (progress) => this.plugins!.notify(PROGRESS, () => progress),
    });
    const attempt: Attempt = { session, game: null, audio: null, audioDevice: null, library: null, plugins, lifecycle };
    this.loading = attempt;
    // The backend's selection is read alongside the game group's grant, so it adds no round trip.
    const selectionRead = readSelection(access, signal).then(
      (selection): { selection: ModelSelection; error: Error | null } => ({ selection, error: null }),
      (error: unknown) => ({ selection: EMPTY_SELECTION, error: error instanceof Error ? error : new Error(String(error)) }));
    const manifest = await session.manifest(signal);
    this.measurements.mark('manifest-ready', session);
    const { selection, error: selectionError } = await selectionRead;
    signal.throwIfAborted();
    const content: ContentLoader = (source, request) => session.bytes(source, request);
    const packaged = (source: string): string => {
      if (!Object.hasOwn(manifest.media, source)) throw new ContentError('integrity', `${source} is not part of this release.`);
      return manifest.media[source]!;
    };
    const media: MediaHost = {
      load: async (source, request) => (await session.bytes(packaged(source), request)).buffer,
      stream: (source, request) => session.stream(packaged(source), request),
    };
    const notice = (text: string): void => this.ui.notice(text, 'error');
    const audioFactory = plugins.slot(AUDIO, this.code.audioOutput === null ? SILENT_AUDIO_OUTPUT : this.code.audioOutput);
    const receivesAudio = audioFactory.value !== SILENT_AUDIO_OUTPUT;
    const heard = playerAudio(manifest.audio, this.playerSettings);
    const audioDevice = new AudioDevice(heard.volume, receivesAudio);
    attempt.audioDevice = audioDevice;
    const audio = createAudioOutput(audioFactory, {
      settings: heard, sounds: levelSoundSources(manifest.level), media, device: audioDevice, notice,
    });
    attempt.audio = audio;
    const characterModels = this.code.createCharacterModels?.({ content }) ?? null;
    const look: GameLook = { theme: manifest.theme, hud: manifest.hud, enemies: manifest.enemies, art: manifest.art };
    const sources = new Map(manifest.art.assets.map((asset) => [asset.id, asset.source]));
    // Course meshes and enemy models are both GLBs of the course artwork.
    const fetchArt = async (id: string, request: AbortSignal): Promise<Blob> => {
      const source = sources.get(id);
      if (source === undefined) throw new Error(`This release does not contain the course artwork GLB ${id}.`);
      return new Blob([await content(source, request)], { type: 'model/gltf-binary' });
    };
    const createCourseArt = this.code.createCourseArt;
    const createEnemyModels = this.code.createEnemyModels;
    const game = new Game({
      canvas: this.canvas, onFatal: (message) => call1(this.fatalDisplay, 'show', message),
      eventMount: this.mount, level: manifest.level, settings: manifest.settings,
      characterModels, content, media, decorations: this.code.createDecorations, kinds: this.code.kinds, plugins,
      look,
      courseArt: createCourseArt === null ? null : { create: createCourseArt, fetch: fetchArt },
      enemyModels: createEnemyModels === null ? null : { create: createEnemyModels, fetch: fetchArt },
      audio: receivesAudio ? audio : null,
      onAction: (action, options) => game.perform(action, options),
      onNotice: notice,
    });
    attempt.game = game;
    game.setSensitivity(this.playerSettings.sensitivity);
    const library = new ReleaseModelLibrary({
      library: manifest.library, access, loader: characterModels, parts: game, signal,
      onFailure: (error) => this.modelFailed(error),
    });
    attempt.library = library;
    // A part the backend selected shows its library model: its profile model is never fetched.
    const replaced = library.replaced(selection);
    session.prefetch(bootSources(manifest, replaced));
    game.view.character.reserveParts(replaced);
    const parts = library.load(selection);
    game.setCharacter({ armIk: manifest.armIk });
    game.setInputBlock({ reason: 'loading', blocked: true });
    const { primary, alternate } = manifest.characters;
    // Every profile loads once, before play; switching later only changes the presentation.
    await Promise.all([
      game.loadSprites(primary),
      ...(alternate === null ? [] : [game.loadAlternateSprites(alternate)]),
      game.loadArtwork(signal),
      ...(this.code.loadAppearance === null ? [] : [this.code.loadAppearance(game.view.character.visuals,
        manifest.appearance, { signal, content })]),
      parts,
    ]);
    // A part whose selection failed starts with the profile's own model, and release observers hear why.
    const failures = await library.show(await parts);
    for (const failure of selectionError === null ? failures : [selectionError, ...failures]) this.modelFailed(failure);
    session.forgetDownloads();
    this.measurements.mark('boot-content-loaded', session);
    this.loading = null;
    return { session, manifest, game, audio, audioDevice, library, plugins, lifecycle };
  }

  private phantomsUrl(): string | null {
    const url = this.code.phantoms?.url ?? null;
    return url === null ? null : new URL(url, document.baseURI).href;
  }

  private modelFailed(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.plugins!.notify(MODEL_FAILED, () => failure);
  }

  private play(loaded: Loaded): void {
    const { game, manifest, library, plugins } = loaded;
    const { primary, alternate } = manifest.characters;
    const types = alternate === null ? [primary.characterRiggingType]
      : [primary.characterRiggingType, alternate.characterRiggingType];
    // A kept choice this release does not have falls back to its first character.
    if (this.playerSettings.character >= types.length) this.playerSettings = Object.freeze({ ...this.playerSettings, character: 0 });
    this.ui.show({
      hud: game.look.hud,
      plugins,
      characters: alternate === null ? null : {
        types,
        selected: this.playerSettings.character,
        onSelect: (index) => this.applyPlayerSettings(loaded, this.checkPlayerSettings(loaded, { character: index })),
      },
    });
    if (game.halted) return;
    this.ui.enableCharacters();
    game.selectCharacter(this.playerSettings.character);
    game.setInputBlock({ reason: 'loading', blocked: false });
    this.measurements.mark('loading-unblocked', loaded.session);
    this.plugins!.notify(READY, (plugin): ReleaseApi => {
      const api: ReleaseApi = Object.freeze({
        setPause: (paused: boolean) => game.setPause({ reason: `release:${plugin}`, paused }),
        setInputBlock: (blocked: boolean) => game.setInputBlock({ reason: `release:${plugin}`, blocked }),
        get halted() { return game.halted; },
        modelLibrary: library.api,
      });
      return api;
    });
    // A game's menu holds play behind it from the first frame, until it starts a run.
    const menu = this.menuFactory;
    if (menu !== null) {
      this.menu = new MenuSession(menu, this.ui.addMenu(), {
        game, course: this.code.course, characters: Object.freeze(characterLabels(types)),
        settings: () => this.playerSettings,
        checkSettings: (changes) => this.checkPlayerSettings(loaded, changes),
        applySettings: (settings) => this.applyPlayerSettings(loaded, settings),
        notice: (text) => this.ui.notice(text, 'error'),
      });
    }
    const phantoms = this.code.phantoms;
    if (phantoms !== null) {
      const releasePlugins = this.plugins!;
      this.phantoms = phantoms.start({
        game, plugins: loaded.plugins, course: this.code.course, url: this.phantomsUrl(),
        phantomService: (base) => releasePlugins.slot(PHANTOMS, base).value,
        packs: manifest.phantoms, content: (source, request) => loaded.session.bytes(source, request),
      });
    }
    let onFrame: (state: HudFrame) => void = (state) => {
      if (game.acceptsInput()) {
        this.measurements.mark('input-enabled', loaded.session);
        // Once measured, frames go straight to the HUD with no more input probes.
        onFrame = (state) => this.ui.update(state);
      }
      this.ui.update(state);
    };
    game.start((state) => onFrame(state));
  }

  // The player's settings with `changes`, for this release's characters. Throws a RangeError stating a broken rule.
  private checkPlayerSettings(loaded: Loaded, changes: unknown): PlayerSettings {
    return changePlayerSettings(this.playerSettings, changes, loaded.manifest.characters.alternate === null ? 1 : 2);
  }

  // Keeps the player's settings and applies what changed: the volume to the game's audio, the sensitivity to its
  // controls and the character to the game and the character choice.
  private applyPlayerSettings(loaded: Loaded, settings: PlayerSettings): void {
    const previous = this.playerSettings;
    this.playerSettings = settings;
    writePlayerSettings(settings);
    if (settings.volume !== previous.volume) {
      const heard = playerAudio(loaded.manifest.audio, settings);
      loaded.audioDevice.setVolume(heard.volume);
      loaded.audio.setSettings(heard);
    }
    if (settings.sensitivity !== previous.sensitivity) loaded.game.setSensitivity(settings.sensitivity);
    if (settings.character !== previous.character) {
      loaded.game.selectCharacter(settings.character);
      this.ui.setCharacter(settings.character);
    }
  }
}
