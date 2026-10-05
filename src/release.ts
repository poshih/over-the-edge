// A game release's boot: it starts the game's module, loads the content through the module's access
// (or public access), builds the game from the manifest and hands the module its API. Nothing in
// the release decides who may load what; a refusal reaches the module, which may retry.
import type { DecorationView } from './decoration-view';
import type { AudioDirector } from './audio';
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
import { createPlayUI } from './play-ui';
import { validateHudReadouts } from './hud-readouts';
import type { HudReadouts } from './hud-readouts';
import { validateLooks } from './object-looks';
import type { Looks } from './object-looks';
import type { ReleaseApi, ReleaseHost, ReleaseModule, StartRelease } from './release-module';
import type { PhantomBuild, Phantoms } from './phantoms';
import { readSelection, ReleaseModelLibrary } from './release-library';
import { EMPTY_SELECTION } from './model-library';
import type { ModelSelection } from './model-library';
import avatarRigs from 'virtual:avatar-rigs';

// Code the shell includes only when its content needs it, chosen at build time.
export interface ReleaseCode {
  readonly pins: ContentPins;
  readonly createCharacterModels: ((options: { content: ContentLoader }) => CharacterModelLoader) | null;
  readonly loadCourseArt: ((game: Game, art: ContentArt, content: ContentLoader, signal: AbortSignal) => Promise<void>) | null;
  readonly loadAppearance: ((visuals: ReadonlyMap<VisualPartId, VisualBinding>, parts: readonly AppearanceSource[],
    options: { signal?: AbortSignal; content?: ContentLoader }) => Promise<unknown>) | null;
  readonly AudioDirector: typeof AudioDirector | null;
  readonly createDecorations: (() => DecorationView) | null;
  readonly phantoms: PhantomBuild | null;
  readonly start: StartRelease | null;
}

interface Loaded {
  readonly session: ContentSession;
  readonly manifest: ContentManifest;
  readonly game: Game;
  readonly audio: AudioDirector | null;
  readonly library: ReleaseModelLibrary;
}

interface Attempt {
  readonly session: ContentSession;
  game: Game | null;
  audio: AudioDirector | null;
  library: ReleaseModelLibrary | null;
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
  private readonly fatal: HTMLElement;
  private readonly code: ReleaseCode;
  private readonly lifecycle = new AbortController();
  private readonly ui: ReturnType<typeof createPlayUI>;
  private module: ReleaseModule | null = null;
  // The HUD readouts and the level objects' looks the game's module draws its own way.
  private readouts: HudReadouts = {};
  private looks: Looks = {};
  private loading: Attempt | null = null;
  private loaded: Loaded | null = null;
  private phantoms: Phantoms | null = null;

  constructor(elements: { canvas: HTMLCanvasElement; mount: HTMLElement; fatal: HTMLElement }, code: ReleaseCode) {
    this.canvas = elements.canvas;
    this.mount = elements.mount;
    this.fatal = elements.fatal;
    this.code = code;
    this.ui = createPlayUI({ mount: elements.mount });
  }

  async run(): Promise<void> {
    try {
      const contentUrl = new URL(this.code.pins.contentUrl, document.baseURI).href;
      const host: ReleaseHost = Object.freeze({
        mount: this.mount, contentUrl, phantomsUrl: this.phantomsUrl(),
        notice: (text: string, kind: 'info' | 'error' = 'info') => this.ui.notice(text, kind),
      });
      if (this.code.start !== null) {
        try {
          this.module = (await this.code.start(host)) ?? null;
        } catch (error) {
          throw new Error(`The game's module failed to start: ${message(error)}`);
        }
        // Closed while the module started, for example during sign-in: it is disposed now.
        if (this.lifecycle.signal.aborted) {
          this.module?.dispose?.();
          return;
        }
        if (this.module?.phantoms !== undefined && this.code.phantoms === null) {
          throw new Error('The game\'s module supplies phantoms, but this release was built without them: set GAME_PHANTOMS_URL.');
        }
        this.readouts = validateHudReadouts(this.module?.hud);
        this.looks = validateLooks(this.module?.looks);
      }
      const access = this.module?.access ?? publicAccess(contentUrl);
      for (;;) {
        try {
          this.loaded = await this.load(access);
          break;
        } catch (error) {
          // A game that stopped itself has shown why; the loads it cancelled say nothing new.
          const halted = this.loading?.game?.halted === true;
          this.discardAttempt();
          if (this.lifecycle.signal.aborted || halted && isAbort(error)) return;
          if (!(error instanceof ContentError) || this.module?.failed === undefined) throw error;
          await this.module.failed(error);
          if (this.lifecycle.signal.aborted) return;
        }
      }
      this.play(this.loaded);
    } catch (error) {
      if (this.lifecycle.signal.aborted && isAbort(error)) return;
      this.fatal.hidden = false;
      this.fatal.textContent = `The game could not load: ${message(error)}`;
    }
  }

  dispose(): void {
    this.lifecycle.abort(new DOMException('The release closed.', 'AbortError'));
    this.module?.dispose?.();
    this.discardAttempt();
    this.phantoms?.dispose();
    this.phantoms = null;
    if (this.loaded !== null) {
      this.loaded.audio?.dispose();
      // The game's views let go of library models before the library disposes them.
      this.loaded.game.dispose();
      this.loaded.library.dispose();
      this.loaded.session.dispose();
      this.loaded = null;
    }
    this.ui.dispose();
  }

  private discardAttempt(): void {
    if (this.loading === null) return;
    this.loading.audio?.dispose();
    this.loading.game?.dispose();
    this.loading.library?.dispose();
    this.loading.session.dispose();
    this.loading = null;
  }

  private async load(access: ContentAccess): Promise<Loaded> {
    const signal = this.lifecycle.signal;
    const module = this.module;
    const session = new ContentSession({
      access, pins: this.code.pins, onProgress: module?.progress === undefined ? undefined : (progress) => module.progress!(progress),
    });
    const attempt: Attempt = { session, game: null, audio: null, library: null };
    this.loading = attempt;
    // The backend's selection is read alongside the game group's grant, so it adds no round trip.
    const selectionRead = readSelection(access, signal).then(
      (selection): { selection: ModelSelection; error: Error | null } => ({ selection, error: null }),
      (error: unknown) => ({ selection: EMPTY_SELECTION, error: error instanceof Error ? error : new Error(String(error)) }));
    const manifest = await session.manifest(signal);
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
    const audio = this.code.AudioDirector === null ? null : new this.code.AudioDirector({
      settings: manifest.audio, sounds: levelSoundSources(manifest.level), media, onError: notice,
    });
    attempt.audio = audio;
    const characterModels = this.code.createCharacterModels?.({ content }) ?? null;
    const game = new Game({
      canvas: this.canvas, fatal: this.fatal, eventMount: this.mount, level: manifest.level, settings: manifest.settings,
      characterModels, content, media, decorations: this.code.createDecorations, avatarRigs, looks: this.looks,
      theme: manifest.theme, enemyArt: manifest.enemies, messageStyle: manifest.hud.messages.style,
      onCue: audio === null ? undefined : (cue) => audio.handle(cue),
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
    game.view.reserveParts(replaced);
    const parts = library.load(selection);
    game.setCharacter({ armIk: manifest.armIk });
    game.setInputBlock({ reason: 'loading', blocked: true });
    const { primary, alternate } = manifest.characters;
    // Every profile loads once, before play; switching later only changes the presentation.
    await Promise.all([
      game.loadSprites(primary),
      ...(alternate === null ? [] : [game.loadAlternateSprites(alternate)]),
      ...(this.code.loadCourseArt === null ? [] : [this.code.loadCourseArt(game, manifest.art, content, signal)]),
      ...(this.code.loadAppearance === null ? [] : [this.code.loadAppearance(game.view.visuals,
        manifest.appearance, { signal, content })]),
      parts,
    ]);
    // A part whose selection failed starts with the profile's own model, and the module hears why.
    const failures = await library.show(await parts);
    for (const failure of selectionError === null ? failures : [selectionError, ...failures]) this.modelFailed(failure);
    session.forgetDownloads();
    this.loading = null;
    return { session, manifest, game, audio, library };
  }

  private phantomsUrl(): string | null {
    const url = this.code.phantoms?.url ?? null;
    return url === null ? null : new URL(url, document.baseURI).href;
  }

  private modelFailed(error: unknown): void {
    this.module?.modelFailed?.(error instanceof Error ? error : new Error(String(error)));
  }

  private play(loaded: Loaded): void {
    const { game, manifest, audio, library } = loaded;
    const { primary, alternate } = manifest.characters;
    this.ui.show({
      hud: manifest.hud,
      readouts: this.readouts,
      characters: alternate === null ? null : {
        types: [primary.characterRiggingType, alternate.characterRiggingType],
        onSelect: (index) => { if (!game.halted) game.selectCharacter(index); },
      },
    });
    if (game.halted) return;
    game.selectCharacter(this.ui.enableCharacters());
    game.setInputBlock({ reason: 'loading', blocked: false });
    const api: ReleaseApi = Object.freeze({
      setPause: (paused: boolean) => game.setPause({ reason: 'module', paused }),
      setInputBlock: (blocked: boolean) => game.setInputBlock({ reason: 'module', blocked }),
      get halted() { return game.halted; },
      modelLibrary: library.api,
    });
    this.module?.ready?.(api);
    const phantoms = this.code.phantoms;
    if (phantoms !== null) {
      this.phantoms = phantoms.start({
        game, course: phantoms.course, url: this.phantomsUrl(), service: this.module?.phantoms ?? null,
        packs: manifest.phantoms, content: (source, request) => loaded.session.bytes(source, request),
      });
    }
    game.start((state) => {
      this.ui.update(state);
      audio?.setPaused(state.paused);
    });
  }
}
