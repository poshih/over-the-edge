import type { DecorationView } from './decoration-view';
import type { CharacterState } from './character';
import { PHYSICS } from './config';
import type { PlayerSpawn, Point, UiAction, UiActionOptions } from './config';
import { DEFAULT_GAME_SETTINGS } from './game-settings';
import type { GameSettings } from './game-settings';
import { DEFAULT_INPUT_BINDINGS, INPUT_BINDINGS, INPUT_DEVICE_CONTRACT, INPUT_DEVICES, isBindableAction, PointerInput } from './input';
import type { BindableAction, InputDevice, InputDeviceHost } from './input';
import { isTriggerObject } from './level';
import type { LevelChange, LevelDefinition } from './level';
import { clamp } from './math';
import { Simulation } from './simulation';
import { GameView } from './view';
import { TriggerRuntime } from './triggers';
import { DEFAULT_VIDEO_PLAYBACK } from './trigger-events';
import type { EventOutcome, TriggerAction, VideoPlayback } from './trigger-events';
import { EventPresenter } from './event-presenter';
import { DEFAULT_HUD } from './hud';
import type { HudSettings } from './hud';
import { createDeathScreen } from './death-screen';
import type { DeathScreen } from './death-screen';
import { deathInfo, DEATH_POSE_SECONDS, DeathSequenceError } from './death-sequence';
import type { DeathFrame, DeathInfo, DeathKind } from './death-sequence';
import type { SpriteDocument } from './sprite-data';
import type { CharacterModelLoader } from './character-model-types';
import type { MediaHost } from './media-host';
import type { ContentLoader } from './content-ref';
import type { GameTheme } from './theme';
import type { EnemyArtSettings } from './enemy-art-data';
import type { HammerHead } from './hammer-head';
import type { PartRole } from './model-library';
import type { PartModel } from './character-view';
import type { Kinds } from './plugins/kinds';
import type { RuntimePlugins } from './plugins/runtime';
import type { HudFrame } from './hud-readouts';
import { OBSERVERS, OBSERVER_CONTRACT } from './game-observers';
import type { GameObserver } from './game-observers';
import { LookUpdates } from './look-updates';
import { MomentJournal, momentRoutes } from './moments';
import type { MomentType } from './moments';
import type { AudioOutput } from './game-audio';
import { call0, call1, call2, createInstance, invalidResult, pluginFailure } from './plugins/kernel';
import type { Attributed, CheckedInstance } from './plugins/kernel';
import { Disposal } from './disposal';
import { DEFAULT_CHARACTER_FIGURE } from './character-figure';

export interface StepObserver {
  step(): void;
  interrupt(): void;
}

interface Dying {
  readonly info: DeathInfo;
  readonly duration: number;
  readonly reducedMotion: boolean;
  readonly placement: number;
  elapsed: number;
  previousElapsed: number;
}

export class Game {
  readonly simulation: Simulation;
  readonly view: GameView;
  readonly input: PointerInput;
  readonly triggers: TriggerRuntime;
  private readonly presenter: EventPresenter;
  private readonly deathScreen: Attributed<DeathScreen>;
  private deathScreenDisposed = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly onFatal: (message: string) => void;
  private readonly lifecycle = new AbortController();
  private readonly pauseReasons = new Set<string>();
  private readonly inputBlocks = new Set<string>();
  private readonly unsubscribeTerrain: () => void;
  private readonly unsubscribeEnemies: () => void;
  private readonly unsubscribeBonfires: () => void;
  private readonly onAction: (action: UiAction, options?: UiActionOptions) => void;
  private readonly audio: AudioOutput | null;
  private readonly observers: CheckedInstance<GameObserver>[] = [];
  private readonly observerRoutes: Readonly<Record<MomentType, readonly Attributed<GameObserver>[]>>;
  private readonly devices: Attributed<InputDevice>[] = [];
  private readonly journal = new MomentJournal();
  private pendingLooks = new LookUpdates();
  private deliveringLooks = new LookUpdates();
  private readonly stepMovement: Point = { x: 0, y: 0 };
  private readonly triggerPosition: Point = { x: 0, y: 0 };
  // This frame's device sum, discarded unless input-enabled physics steps consume it.
  private readonly deviceMovement: Point = { x: 0, y: 0 };
  private readonly pressedSwitches: string[] = [];
  private readonly stepObservers = new Set<StepObserver>();
  private readonly renderState: { dt: number; death: DeathFrame | null } = { dt: 0, death: null };
  private hud: HudSettings;
  private death: Dying | null = null;
  private readonly deathFrame: { -readonly [K in keyof DeathFrame]: DeathFrame[K] } = {
    elapsed: 0, duration: 0, poseProgress: 0, reducedMotion: false,
  };
  private readonly videos: VideoPlayback;
  private stopped = false;
  private disposed = false;
  private started = false;
  private animationFrame = 0;
  private accumulator = 0;
  private previousTime = 0;
  private timerElapsed = 0;
  private timerRunning = true;
  private readonly hudFrame: { -readonly [K in keyof HudFrame]: HudFrame[K] } = {
    height: 0, bestHeight: 0, elapsed: 0, timerRunning: true, health: null, death: null, paused: false,
    pointerLocked: false, inputMode: 'mouse',
  };

  constructor(options: {
    canvas: HTMLCanvasElement;
    // The complete fatal message; the owner chooses its display.
    onFatal: (message: string) => void;
    eventMount: HTMLElement;
    level: LevelDefinition;
    settings?: Readonly<GameSettings>;
    characterModels?: CharacterModelLoader | null;
    // Required, explicit environment sessions; nothing silently chooses a registry or runtime defaults.
    kinds: Kinds;
    plugins: RuntimePlugins;
    // Loads a release's packaged sprite images.
    content?: ContentLoader;
    theme?: GameTheme;
    enemyArt?: EnemyArtSettings;
    // Creates the decoration view, when the game draws decorations.
    decorations?: (() => DecorationView) | null;
    hud?: HudSettings;
    // Whether play-video events play or are skipped; they play by default. The Workshop skips them.
    videos?: VideoPlayback;
    // Streams authored video sources; by default sources are URLs.
    media?: MediaHost;
    // Host-owned and not disposed by the Game. Receives moments after effects, before observers.
    audio?: AudioOutput | null;
    // 'reset' must place the player synchronously through Game; death's return without a bonfire relies on it.
    onAction: (action: UiAction, options?: UiActionOptions) => void;
    onNotice: (message: string) => void;
    onShortcut?: (event: KeyboardEvent) => void;
  }) {
    this.canvas = options.canvas;
    this.onFatal = options.onFatal;
    this.onAction = options.onAction;
    this.audio = options.audio ?? null;
    this.hud = options.hud ?? DEFAULT_HUD;
    this.videos = options.videos ?? DEFAULT_VIDEO_PLAYBACK;
    const listen = { signal: this.lifecycle.signal };
    window.addEventListener('error', (event) => this.stop(event.message), listen);
    window.addEventListener('unhandledrejection', (event) =>
      this.stop(event.reason instanceof Error ? event.reason.message : String(event.reason)), listen);
    try {
      this.simulation = new Simulation(options.settings === undefined ? DEFAULT_GAME_SETTINGS : options.settings, options.level,
        DEFAULT_CHARACTER_FIGURE, this.journal);
      this.view = new GameView(options.canvas, this.simulation.frame(1), options.level, {
        characterModels: options.characterModels, content: options.content, theme: options.theme, enemyArt: options.enemyArt,
        decorations: options.decorations, kinds: options.kinds, plugins: options.plugins,
        onCharacterFigure: (figure) => this.simulation.setCharacterFigure(figure),
      });
      this.input = new PointerInput(options.canvas, {
        bindings: options.plugins.slot(INPUT_BINDINGS, DEFAULT_INPUT_BINDINGS).value,
        onAction: options.onAction, onNotice: options.onNotice, onShortcut: options.onShortcut,
      });
      this.presenter = new EventPresenter({
        mount: options.eventMount,
        plugins: options.plugins,
        media: options.media,
        onModalChange: ({ active }) => {
          this.setPause({ reason: 'event', paused: active });
          this.setInputBlock({ reason: 'event', blocked: active });
        },
      });
      this.deathScreen = createDeathScreen(options.plugins, options.eventMount);
      this.triggers = new TriggerRuntime(options.level.objects.filter(isTriggerObject), {
        execute: (action, signal) => this.executeEvent(action, signal),
        onFailure: ({ triggerId, eventIndex, message }) => options.onNotice(`Trigger "${triggerId}", event ${eventIndex + 1}: ${message}`),
        onFault: (error) => this.stop(error instanceof Error ? error.message : String(error)),
      });
      for (const factory of options.plugins.list(OBSERVERS)) {
        this.observers.push(createInstance(OBSERVER_CONTRACT, factory, factory.value));
      }
      this.observerRoutes = momentRoutes(this.observers, observer => observer.captured.moments);
      this.simulation.trackImpacts(this.audio !== null || this.view.effects.takes('impact') || this.observerRoutes.impact.length > 0);
      // TerrainView is engine-only. Its incremental physics hand-off stays synchronous.
      this.unsubscribeTerrain = this.simulation.subscribeTerrain((event) => this.view.terrain.apply(event));
      this.unsubscribeEnemies = this.simulation.subscribeEnemies((event) => {
        if (!this.stopped) this.pendingLooks.enemy(event);
      });
      this.unsubscribeBonfires = this.simulation.subscribeBonfires((state) => {
        if (!this.stopped) this.pendingLooks.lit = state.lit;
      });
      for (const factory of options.plugins.list(INPUT_DEVICES)) {
        const create = factory.value;
        const host: InputDeviceHost = Object.freeze({
          signal: this.lifecycle.signal,
          action: (action: BindableAction) => {
            if (!isBindableAction(action)) {
              throw invalidResult(factory, 'action must be reset, pause or recenter');
            }
            if (this.stopped || this.inputBlocks.size > 0) return;
            try { this.onAction(action); } catch (error) {
              throw pluginFailure(error, factory.plugin, factory.point, 'action');
            }
          },
        });
        this.devices.push(createInstance(INPUT_DEVICE_CONTRACT, factory, () => create(host)));
      }
      document.addEventListener('visibilitychange', () => {
        this.previousTime = performance.now();
        this.settleInterpolation();
        this.clearMovement();
      }, listen);
      // Seed the looks before the first frame. There are no boot gameplay moments.
      this.stageSwitches();
      this.flush();
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      disposal.run(() => this.dispose());
      disposal.finish();
      throw error;
    }
  }

  start(onFrame: (state: HudFrame) => void): void {
    if (this.started) throw new Error('The game loop is already running.');
    this.started = true;
    this.audio?.setPaused(this.pauseReasons.size > 0);
    this.previousTime = performance.now();
    const animate = (now: number): void => {
      if (this.stopped) return;
      const dt = clamp((now - this.previousTime) / 1000, 0, PHYSICS.dt * PHYSICS.maxFrameSteps);
      this.previousTime = now;
      const visible = document.visibilityState === 'visible';
      const hasDevices = this.devices.length > 0;
      // Poll paused and input-blocked frames too: actions can resume play, and blocked buttons keep their edges.
      if (visible && hasDevices) this.pollDevices(dt);
      if (this.stopped) return;
      if (this.pauseReasons.size === 0 && visible) {
        this.accumulator += dt;
        const steps = Math.min(Math.floor(this.accumulator / PHYSICS.dt), PHYSICS.maxFrameSteps);
        if (steps > 0) {
          const perStep = this.stepMovement;
          if (this.death === null) {
            this.view.pointerDelta(this.input.takeMovement(), this.settings().physics.mouseSensitivity, this.input.mode, perStep);
            if (hasDevices && this.inputBlocks.size === 0) {
              perStep.x += this.deviceMovement.x;
              perStep.y += this.deviceMovement.y;
            }
            perStep.x /= steps;
            perStep.y /= steps;
          } else {
            this.clearMovement();
            perStep.x = perStep.y = 0;
          }
          let completed = 0;
          let interrupted = false;
          for (; completed < steps;) {
            const placement = this.simulation.placement;
            const dying = this.death;
            const ended = this.simulation.step(perStep);
            if (this.timerRunning) this.timerElapsed += PHYSICS.dt;
            completed++;
            if (dying !== null) {
              dying.previousElapsed = dying.elapsed;
              dying.elapsed += PHYSICS.dt;
              if (dying.elapsed >= dying.duration) {
                this.finishDeath(dying);
                interrupted = true;
                break;
              }
            } else {
              if (ended !== null) {
                this.beginDeath(deathInfo(ended));
                interrupted = true;
                break;
              }
              this.triggers.update(this.simulation.playerPosition(this.triggerPosition), this.simulation.time);
              this.stageSwitches();
              if (this.stopped) return;
              // A trigger or an observer can reset synchronously. Never sample the placement it made.
              for (const observer of this.stepObservers) {
                if (this.simulation.placement !== placement || this.stopped) break;
                observer.step();
              }
              if (this.stopped) return;
              if (this.simulation.placement !== placement) {
                interrupted = true;
                break;
              }
            }
            if (this.pauseReasons.size > 0) break;
          }
          if (interrupted) this.accumulator = 0;
          else if (this.pauseReasons.size === 0) this.accumulator -= completed * PHYSICS.dt;
        }
      } else {
        this.accumulator = 0;
        this.clearMovement();
      }
      // Never carry device movement from paused, blocked or zero-step frames into a later frame.
      if (hasDevices) this.deviceMovement.x = this.deviceMovement.y = 0;
      this.flush();
      if (this.stopped) return;
      const alpha = this.pauseReasons.size > 0 || !visible ? 1 : clamp(this.accumulator / PHYSICS.dt, 0, 1);
      const dying = this.death;
      this.renderState.death = null;
      if (dying !== null) {
        const frame = this.deathFrame;
        frame.elapsed = dying.previousElapsed + (dying.elapsed - dying.previousElapsed) * alpha;
        frame.duration = dying.duration;
        frame.poseProgress = Math.min(1, frame.elapsed / DEATH_POSE_SECONDS);
        frame.reducedMotion = dying.reducedMotion;
        if (visible) call1(this.deathScreen, 'update', frame);
        if (this.death === dying) this.renderState.death = frame;
      }
      if (this.stopped) return;
      if (!this.presenter.coversGame) {
        this.showPlacement();
        if (this.stopped) return;
        const frame = this.simulation.frame(alpha);
        this.renderState.dt = dt;
        this.view.render(frame, this.renderState);
      }
      onFrame(this.readHudFrame());
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  // Reused, read-only to consumers. Diagnostics request simulation.status() separately in the Workshop.
  readHudFrame(): HudFrame {
    const frame = this.hudFrame;
    this.simulation.writeHudFrame(frame);
    frame.elapsed = this.timerElapsed;
    frame.timerRunning = this.timerRunning;
    frame.paused = this.pauseReasons.size > 0;
    frame.pointerLocked = this.input.locked;
    frame.inputMode = this.input.mode;
    frame.death = this.deathKind;
    return frame;
  }

  get halted(): boolean {
    return this.stopped;
  }

  get dying(): boolean { return this.death !== null; }

  get deathKind(): DeathKind | null { return this.death?.info.kind ?? null; }

  pauseState(): readonly string[] {
    return [...this.pauseReasons];
  }

  timerState() {
    return { elapsed: this.timerElapsed, running: this.timerRunning };
  }

  eventState() {
    return { triggers: this.triggers.inspect(), presentation: this.presenter.inspect(), timer: this.timerState() };
  }

  async loadSprites(document: SpriteDocument): Promise<void> {
    if (this.stopped) throw new Error('Cannot load sprites into a stopped game.');
    await this.view.character.sprites.replace(document, { signal: this.lifecycle.signal });
  }

  // Loads a second character profile for players to switch to; it stays loaded while hidden.
  async loadAlternateSprites(document: SpriteDocument): Promise<void> {
    if (this.stopped) throw new Error('Cannot load sprites into a stopped game.');
    await this.view.character.createAlternateCharacter().replace(document, { signal: this.lifecycle.signal });
  }

  selectCharacter(index: number): void {
    if (this.stopped) return;
    this.view.character.selectCharacter(index);
  }

  characterSelection() {
    return this.view.character.characterSelection();
  }

  settings(): GameSettings { return this.simulation.gameSettings(); }

  // New rig settings rebuild the player, so they restart the run like Reset.
  setSettings(settings: Readonly<GameSettings>): void {
    if (this.simulation.setSettings(settings) === 'restarted') this.restartRun();
  }

  // Shows a library model for one part, or the characters' own with null. A library hammer brings its head's outline
  // into the physics, and the characters' own hammer the settings' default head, so the hammer shown is the one that
  // collides. The head changes mid-run without restarting it.
  async setPartModel(role: PartRole, part: PartModel | null, signal: AbortSignal): Promise<void> {
    if (this.stopped) return;
    await this.view.character.setPartModel(role, part, AbortSignal.any([signal, this.lifecycle.signal]));
    if (role === 'hammer' && !this.stopped) this.simulation.setHammerHead(part?.head ?? null);
  }

  // A new outline for the shown library hammer's head, as the Workshop edits it.
  setHammerHead(head: HammerHead | null): void {
    if (!this.stopped) this.simulation.setHammerHead(head);
  }

  partModels(): Record<PartRole, string | null> {
    return this.view.character.partModels();
  }

  setCharacter(state: CharacterState): void {
    if (this.stopped) return;
    this.view.character.setArmIk(state.armIk);
  }

  setTheme(theme: GameTheme): void { this.view.setTheme(theme); }

  setEnemyArt(art: EnemyArtSettings): void { this.view.setEnemyArt(art); }

  setMedia(media: MediaHost): void { this.presenter.setMedia(media); }

  // Applies to future messages and deaths; an active death keeps the text and duration it started with.
  setHud(settings: HudSettings): void { this.hud = settings; }

  setPause(options: { reason: string; paused: boolean }): void {
    const wasPaused = this.pauseReasons.size > 0;
    if (options.paused) this.pauseReasons.add(options.reason);
    else this.pauseReasons.delete(options.reason);
    this.settleInterpolation();
    this.clearMovement();
    const paused = this.pauseReasons.size > 0;
    if (this.started && !this.stopped && paused !== wasPaused) this.audio?.setPaused(paused);
  }

  setInputBlock(options: { reason: string; blocked: boolean }): void {
    if (options.blocked) this.inputBlocks.add(options.reason);
    else this.inputBlocks.delete(options.reason);
    if (this.inputBlocks.size > 0) this.clearMovement();
    this.input.setInteraction({ enabled: this.inputBlocks.size === 0 });
  }

  // Engine-only recording/diagnostics. Only eligible live steps are sampled; death interrupts before its fatal sample.
  // Runtime plugins observe gameplay moments instead. Returns this observer's removal.
  observeSteps(observer: StepObserver): () => void {
    this.stepObservers.add(observer);
    return () => { this.stepObservers.delete(observer); };
  }

  reset(spawn?: Readonly<PlayerSpawn>): void {
    this.simulation.reset(spawn);
    this.restartRun();
  }

  // What follows the player back to a bonfire, the run going on: triggers forget the jump, and the character, input and
  // camera start afresh there.
  private respawned(): void {
    this.cancelDeath();
    this.triggers.jump();
    this.stageSwitches();
    this.view.character.resetPresentation();
    this.accumulator = 0;
    this.clearMovement();
    this.view.recenter(this.simulation.frame(1));
  }

  // Everything a reset restarts besides the player and level objects.
  private restartRun(): void {
    this.cancelDeath();
    this.triggers.reset();
    this.presenter.clearToasts();
    this.view.character.resetPresentation();
    this.resetClock();
    this.accumulator = 0;
    this.clearMovement();
    this.view.recenter(this.simulation.frame(1));
    this.stageSwitches();
  }

  applyLevel(change: LevelChange): void {
    if (change.kind === 'replace') this.cancelDeath();
    this.triggers.apply(change);
    this.stageSwitches();
    this.simulation.applyLevel(change);
    this.view.applyLevel(change);
    if (change.kind === 'replace') {
      this.presenter.clearToasts();
      this.view.character.resetPresentation();
      this.resetClock();
      this.accumulator = 0;
      this.clearMovement();
      this.view.recenter(this.simulation.frame(1));
    }
  }

  perform(action: UiAction, options: UiActionOptions = {}): void {
    switch (action) {
      case 'play':
        this.setPause({ reason: 'user', paused: false });
        this.input.activate(options.inputMode ?? this.input.mode);
        break;
      case 'pause':
        this.setPause({ reason: 'user', paused: !this.pauseReasons.has('user') });
        break;
      case 'reset':
        this.reset();
        break;
      case 'recenter':
        this.view.recenter(this.simulation.frame(1));
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.journal.close();
    const disposal = new Disposal();
    disposal.run(() => cancelAnimationFrame(this.animationFrame));
    disposal.run(() => this.lifecycle.abort());
    disposal.run(() => this.cancelDeath());
    disposal.run(() => this.disposeDeathScreen());
    // Optional access also covers a constructor failure: dispose only the parts already made.
    disposal.run(() => this.triggers?.dispose());
    disposal.run(() => this.presenter?.dispose());
    disposal.run(() => this.unsubscribeTerrain?.());
    disposal.run(() => this.unsubscribeEnemies?.());
    disposal.run(() => this.unsubscribeBonfires?.());
    for (let index = this.devices.length - 1; index >= 0; index--) {
      const device = this.devices[index]!;
      if (device.value.dispose !== undefined) disposal.run(() => call0(device, 'dispose'));
    }
    for (let index = this.observers.length - 1; index >= 0; index--) {
      const observer = this.observers[index]!;
      if (observer.value.dispose !== undefined) disposal.run(() => call0(observer, 'dispose'));
    }
    disposal.run(() => this.input?.dispose());
    disposal.run(() => this.view?.dispose());
    disposal.run(() => this.simulation?.dispose());
    this.pendingLooks.clear();
    this.deliveringLooks.clear();
    this.stepObservers.clear();
    disposal.finish();
  }

  private stop(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.animationFrame);
    this.journal.close();
    this.pendingLooks.clear();
    this.deliveringLooks.clear();
    this.deviceMovement.x = this.deviceMovement.y = 0;
    const disposal = new Disposal();
    try {
      this.onFatal(`The game stopped: ${message}`);
    } catch (error) {
      disposal.run(() => { throw error; });
    } finally {
      // A failing display or cleanup cannot skip any remaining interaction teardown.
      // These parts are idempotent; dispose() later releases the rest of the Game exactly once.
      disposal.run(() => this.lifecycle.abort());
      disposal.run(() => this.cancelDeath());
      disposal.run(() => this.disposeDeathScreen());
      disposal.run(() => this.triggers?.dispose());
      disposal.run(() => this.presenter?.dispose());
      disposal.run(() => this.view?.character.disposeCharacters());
      disposal.run(() => this.input?.setInteraction({ enabled: false }));
      disposal.run(() => {
        if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      });
      disposal.finish();
    }
  }

  private resetClock(): void {
    this.timerElapsed = 0;
    this.timerRunning = true;
  }

  private beginDeath(info: DeathInfo): void {
    const kind = info.kind;
    const settings = this.hud.death;
    const dying: Dying = {
      info, duration: this.settings().death.wait, placement: this.simulation.placement,
      elapsed: 0, previousElapsed: 0, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    this.death = dying;
    this.simulation.beginDeath();
    this.view.character.beginDeath(this.simulation.frame(1), kind);
    this.clearMovement();
    for (const observer of this.stepObservers) observer.interrupt();
    if (this.death !== dying || this.stopped) return;
    this.presenter.setDeathHeld(true);
    this.triggers.interrupt();
    this.stageSwitches();
    if (this.death === dying && !this.stopped) call2(this.deathScreen, 'show', info, settings);
  }

  private finishDeath(dying: Dying): void {
    if (this.death !== dying || this.stopped) return;
    if (this.simulation.placement !== dying.placement) throw new DeathSequenceError('placement-changed');
    if (this.simulation.respawn()) this.respawned();
    else {
      this.onAction('reset');
      if (this.stopped) return;
      if (this.simulation.placement === dying.placement) throw new DeathSequenceError('placement-failed');
    }
  }

  private cancelDeath(): void {
    if (this.death === null) return;
    this.death = null;
    this.renderState.death = null;
    const disposal = new Disposal();
    disposal.run(() => this.view.character.cancelDeath());
    disposal.run(() => call0(this.deathScreen, 'clear'));
    disposal.run(() => this.presenter.setDeathHeld(false));
    disposal.finish();
  }

  private disposeDeathScreen(): void {
    if (this.deathScreenDisposed || this.deathScreen === undefined) return;
    this.deathScreenDisposed = true;
    call0(this.deathScreen, 'dispose');
  }

  // Discard interpolation with the accumulator, so resuming cannot rewind the presentation by one step.
  // Stopped games never draw, and their simulation may already be disposed.
  private settleInterpolation(): void {
    this.accumulator = 0;
    if (!this.stopped) this.simulation.settleInterpolation();
    if (this.death !== null) this.death.previousElapsed = this.death.elapsed;
  }

  private executeEvent(action: TriggerAction, signal: AbortSignal): EventOutcome | Promise<EventOutcome> {
    if (signal.aborted || this.death !== null || this.stopped) return 'cancelled';
    if (action.type === 'stop-timer') {
      this.timerRunning = false;
      this.stageMoment('finish');
      return 'completed';
    }
    if (action.type === 'launch-player') {
      this.simulation.launch(action);
      this.stageMoment('launch');
      return 'completed';
    }
    if (action.type === 'fire-trap') {
      this.simulation.fireTrap(action.trap, action.shots);
      return 'completed';
    }
    if (action.type === 'move-platform') {
      this.simulation.movePlatform(action.platform, action.to);
      return 'completed';
    }
    if (action.type === 'play-sound') {
      const moment = this.stageMoment('sound');
      moment.source = action.source;
      moment.volume = action.volume;
      return 'completed';
    }
    // A toast never holds up the triggers: the next event, or the next trigger, starts at once.
    if (action.type === 'message' && this.hud.messages.style === 'toast') {
      this.presenter.toast(action);
      return 'completed';
    }
    // A skipped video never shows: the trigger goes on to its next event, as after the player skips one.
    if (action.type === 'play-video' && this.videos === 'skip') return 'skipped';
    return this.presenter.present(action, signal);
  }

  private clearMovement(): void {
    this.input.clear();
    this.deviceMovement.x = this.deviceMovement.y = 0;
  }

  private pollDevices(dt: number): void {
    const placement = this.simulation.placement;
    for (const device of this.devices) {
      call2(device, 'poll', dt, this.deviceMovement);
      if (!Number.isFinite(this.deviceMovement.x) || !Number.isFinite(this.deviceMovement.y)) {
        throw invalidResult(device, 'must add finite movement in metres');
      }
      if (this.stopped) break;
    }
    if (this.simulation.placement !== placement || this.pauseReasons.size > 0 || this.inputBlocks.size > 0 || this.death !== null) this.clearMovement();
  }

  private stageMoment<T extends 'launch' | 'finish' | 'sound'>(type: T) {
    return this.journal.append(type, this.simulation.placement, this.simulation.time);
  }

  // A callback can place the player during the drain. Effects catch up before interpolation and drawing.
  private showPlacement(): void {
    const placement = this.simulation.placement;
    if (this.view.effects.placement === placement) return;
    const moment = this.journal.pendingPlacement(placement);
    if (moment === null) throw new Error('The current player placement has no pending placed moment.');
    this.view.effects.moment(moment, placement);
  }

  private stageSwitches(): void {
    if (this.stopped || !this.triggers.writePressedSwitches(this.pressedSwitches)) return;
    this.pendingLooks.switches = this.pressedSwitches.slice();
  }

  private flush(): void {
    if (this.lifecycle.signal.aborted) return;
    // Take both channels before any consumer runs: callback writes wait for the next drain.
    const batch = this.journal.take();
    const looks = this.pendingLooks;
    if (!looks.pending && batch === null) return;
    this.pendingLooks = this.deliveringLooks;
    this.deliveringLooks = looks;
    try {
      for (let index = 0; index < looks.enemyCount; index++) {
        if (this.lifecycle.signal.aborted) return;
        this.view.applyEnemy(looks.enemies[index]!);
      }
      if (this.lifecycle.signal.aborted) return;
      if (looks.lit !== null) this.view.setLitBonfires(looks.lit);
      if (this.lifecycle.signal.aborted) return;
      if (looks.switches !== null) this.view.setPressedSwitches(looks.switches);
      if (batch === null) return;
      for (let index = 0; index < batch.count; index++) {
        const moment = batch.moments[index]!;
        if (this.lifecycle.signal.aborted) return;
        this.view.effects.moment(moment, this.simulation.placement);
        if (this.lifecycle.signal.aborted) return;
        this.audio?.moment(moment);
        if (this.lifecycle.signal.aborted) return;
        const observers = this.observerRoutes[moment.type];
        for (let observer = 0; observer < observers.length; observer++) {
          if (this.lifecycle.signal.aborted) return;
          call1(observers[observer]!, 'moment', moment);
        }
      }
    } finally {
      looks.clear();
      if (batch !== null) this.journal.release(batch);
    }
  }
}
