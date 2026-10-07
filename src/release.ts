// Release boot: release facets compose access and load-flow services; each load attempt owns its runtime session.
// Nothing here decides who may load what. See docs/release-plugins.md.
import type { DecorationView } from './decoration-view';
import { AUDIO, createAudioOutput, SILENT_AUDIO_OUTPUT } from './game-audio';
import type { AudioOutput, GameAudioFactory } from './game-audio';
import { AudioDevice } from './audio-device';
import { bootSources, levelSoundSources } from './content';
import type { ContentArt, ContentManifest, ContentPins } from './content';
import type { ContentLoader } from './content-ref';
import { ContentError, ContentSession, publicAccess } from './content-session';
import type { ContentAccess } from './content-session';
import type { CharacterModelLoader } from './character-model-types';
import type { AppearanceSource } from './appearance-loader';
import type { VisualBinding, VisualPartId } from './character';
import { Game } from './game';
import type { MediaHost } from './media-host';
import { Disposal } from './disposal';
import { createPlayUI } from './play-ui';
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

// Code the shell includes only when its content needs it, chosen at build time.
export interface ReleaseCode {
  readonly pins: ContentPins;
  readonly createCharacterModels: ((options: { content: ContentLoader }) => CharacterModelLoader) | null;
  readonly loadCourseArt: ((game: Game, art: ContentArt, content: ContentLoader, signal: AbortSignal) => Promise<void>) | null;
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
  private loading: Attempt | null = null;
  private loaded: Loaded | null = null;
  private phantoms: Phantoms | null = null;

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
    const loaded = this.loaded;
    this.phantoms = null;
    this.loaded = null;
    disposal.run(() => phantoms?.dispose());
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
    const audioDevice = new AudioDevice(manifest.audio.volume, receivesAudio);
    attempt.audioDevice = audioDevice;
    const audio = createAudioOutput(audioFactory, {
      settings: manifest.audio, sounds: levelSoundSources(manifest.level), media, device: audioDevice, notice,
    });
    attempt.audio = audio;
    const characterModels = this.code.createCharacterModels?.({ content }) ?? null;
    const game = new Game({
      canvas: this.canvas, onFatal: (message) => call1(this.fatalDisplay, 'show', message),
      eventMount: this.mount, level: manifest.level, settings: manifest.settings,
      characterModels, content, media, decorations: this.code.createDecorations, kinds: this.code.kinds, plugins,
      theme: manifest.theme, enemyArt: manifest.enemies, hud: manifest.hud,
      audio: receivesAudio ? audio : null,
      onAction: (action, options) => game.perform(action, options),
      onNotice: notice,
    });
    attempt.game = game;
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
      ...(this.code.loadCourseArt === null ? [] : [this.code.loadCourseArt(game, manifest.art, content, signal)]),
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
    this.ui.show({
      hud: manifest.hud,
      plugins,
      characters: alternate === null ? null : {
        types: [primary.characterRiggingType, alternate.characterRiggingType],
        onSelect: (index) => { if (!game.halted) game.selectCharacter(index); },
      },
    });
    if (game.halted) return;
    game.selectCharacter(this.ui.enableCharacters());
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
    const phantoms = this.code.phantoms;
    if (phantoms !== null) {
      const releasePlugins = this.plugins!;
      this.phantoms = phantoms.start({
        game, plugins: loaded.plugins, course: phantoms.course, url: this.phantomsUrl(),
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
}
