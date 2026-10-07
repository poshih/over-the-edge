import { DEFAULT_ARM_IK } from './character';
import type { DecorationView } from './decoration-view';
import type { CharacterState } from './character';
import { PHYSICS } from './config';
import type { PlayerSpawn, Point, UiAction, UiActionOptions } from './config';
import { DEFAULT_GAME_SETTINGS } from './game-settings';
import type { GameSettings } from './game-settings';
import { checkInputDevice, DEFAULT_INPUT_BINDINGS, INPUT_BINDINGS, INPUT_DEVICES, isBindableAction, PointerInput } from './input';
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
import { DEATH_POSE_SECONDS, DeathSequenceError } from './death-sequence';
import type { DeathFrame, DeathInfo, DeathKind } from './death-sequence';
import type { SpriteDocument } from './sprite-data';
import type { CharacterModelLoader } from './character-model-types';
import type { MediaHost } from './media-host';
import type { ContentLoader } from './content-ref';
import { impactStrength, IMPACT_SPEED } from './audio-settings';
import type { AudioCue, GameCue } from './audio-settings';
import type { GameTheme } from './theme';
import type { EnemyArtSettings } from './enemy-art-data';
import type { EnemyEvent, EnemyPhase } from './enemy-types';
import type { HammerHead } from './hammer-head';
import type { PartRole } from './model-library';
import type { PartModel } from './view';
import type { Kinds } from './plugins/kinds';
import type { RuntimePlugins } from './plugins/runtime';
import type { HudFrame } from './hud-readouts';
import { checkGameObserver, EVENTS } from './game-events';
import type { GameEvent, GameObserver } from './game-events';
import { GameNotifications, stageCause } from './game-notifications';
import type { HurtCause } from './hazards';
import { HURT_EFFECTS } from './hurt-effects';
import { BLOCK_EFFECTS } from './block-effects';
import { AUDIO } from './game-audio';
import { LOOKS } from './object-looks';
import { checkSynchronous, PluginError } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import { Disposal } from './disposal';
import { createDeathSeed } from './player-pose';

const IMPACT_INTERVAL = 0.07;

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
  private readonly deathScreen: DeathScreen;
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
  private readonly onCue: ((cue: GameCue) => void) | null;
  private readonly onPauseChange: ((paused: boolean) => void) | null;
  private readonly audioPlugin: string | null;
  private readonly enemyPlugin: string | null;
  private readonly bonfirePlugin: string | null;
  private readonly switchPlugin: string | null;
  private readonly hurtPlugin: string | null;
  private readonly blockPlugin: string | null;
  private hurtPlacement: number;
  private readonly observers: Attributed<GameObserver>[] = [];
  private readonly devices: Attributed<InputDevice>[] = [];
  private readonly eventConsumers: boolean;
  private pending = new GameNotifications();
  private delivery = new GameNotifications();
  private readonly stepMovement: Point = { x: 0, y: 0 };
  // This frame's device sum, discarded unless input-enabled physics steps consume it.
  private readonly deviceMovement: Point = { x: 0, y: 0 };
  private readonly audioCue: { type: 'cue'; cue: AudioCue; strength: number } = { type: 'cue', cue: 'impact', strength: 1 };
  private readonly previewCue: { type: 'cue'; cue: AudioCue; strength: number } = { type: 'cue', cue: 'impact', strength: 1 };
  private readonly pressedSwitches: string[] = [];
  private lastImpact = -Infinity;
  private readonly stepObservers = new Set<StepObserver>();
  // Last phase of each enemy, so cues fire on hit and defeat transitions only.
  private readonly enemyPhases = new Map<string, EnemyPhase>();
  // The bonfire a death returns to, so its cue plays when another becomes it.
  private bonfire: string | null = null;
  private readonly renderState: CharacterState & { dt: number; death: DeathFrame | null } = { armIk: DEFAULT_ARM_IK, dt: 0, death: null };
  private hud: HudSettings;
  private death: Dying | null = null;
  private readonly deathSeed = createDeathSeed();
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
    // Receives staged cues after the step loop, before observers and rendering.
    // Impacts are tracked only while this output or gameplay observers need them.
    onCue?: (cue: GameCue) => void;
    // The initial pause state at start(), then changes only, so audio needs no per-frame polling.
    onPauseChange?: (paused: boolean) => void;
    // 'reset' must place the player synchronously through Game; death's return without a bonfire relies on it.
    onAction: (action: UiAction, options?: UiActionOptions) => void;
    onNotice: (message: string) => void;
    onShortcut?: (event: KeyboardEvent) => void;
  }) {
    this.canvas = options.canvas;
    this.onFatal = options.onFatal;
    this.onAction = options.onAction;
    this.onCue = options.onCue ?? null;
    this.onPauseChange = options.onPauseChange ?? null;
    this.audioPlugin = options.plugins.owner(AUDIO);
    this.enemyPlugin = options.plugins.owner(LOOKS.enemies);
    this.bonfirePlugin = options.plugins.owner(LOOKS.bonfire);
    this.switchPlugin = options.plugins.owner(LOOKS.switch);
    this.hurtPlugin = options.plugins.owner(HURT_EFFECTS);
    this.blockPlugin = options.plugins.owner(BLOCK_EFFECTS);
    this.hud = options.hud ?? DEFAULT_HUD;
    this.videos = options.videos ?? DEFAULT_VIDEO_PLAYBACK;
    const listen = { signal: this.lifecycle.signal };
    window.addEventListener('error', (event) => this.stop(event.message), listen);
    window.addEventListener('unhandledrejection', (event) =>
      this.stop(event.reason instanceof Error ? event.reason.message : String(event.reason)), listen);
    try {
      this.simulation = new Simulation(options.settings === undefined ? DEFAULT_GAME_SETTINGS : options.settings, options.level);
      this.hurtPlacement = this.simulation.placement;
      this.view = new GameView(options.canvas, this.simulation.frame(1), options.level, {
        characterModels: options.characterModels, content: options.content, theme: options.theme, enemyArt: options.enemyArt,
        decorations: options.decorations, kinds: options.kinds, plugins: options.plugins,
      });
      this.input = new PointerInput(options.canvas, {
        bindings: options.plugins.slot(INPUT_BINDINGS, DEFAULT_INPUT_BINDINGS),
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
      for (const { plugin, value: factory } of options.plugins.list(EVENTS)) {
        try {
          this.observers.push({ plugin, value: checkGameObserver(factory(), plugin) });
        } catch (error) {
          if (error instanceof PluginError && error.plugin === plugin && error.point === EVENTS.id) throw error;
          throw new PluginError('plugin-failed', `Plugin "${plugin}" failed creating "${EVENTS.id}".`,
            plugin, EVENTS.id, { cause: error });
        }
      }
      this.eventConsumers = this.onCue !== null || this.observers.length > 0;
      if (this.eventConsumers) this.simulation.trackImpacts(true);
      // TerrainView is engine-only. Its incremental physics hand-off stays synchronous.
      this.unsubscribeTerrain = this.simulation.subscribeTerrain((event) => this.view.terrain.apply(event));
      this.unsubscribeEnemies = this.simulation.subscribeEnemies((event) => this.stageEnemy(event));
      this.unsubscribeBonfires = this.simulation.subscribeBonfires((state) => {
        if (!this.stopped) {
          this.pending.lit = state.lit;
          if (state.current !== null && state.current !== this.bonfire) {
            const event = this.stageEvent('bonfire');
            if (event !== null) event.id = state.current;
          }
        }
        this.bonfire = state.current;
      });
      for (const { plugin, value: factory } of options.plugins.list(INPUT_DEVICES)) {
        const host: InputDeviceHost = Object.freeze({
          signal: this.lifecycle.signal,
          action: (action: BindableAction) => {
            if (!isBindableAction(action)) {
              throw new PluginError('invalid-contribution', `Plugin "${plugin}": "${INPUT_DEVICES.id}" action must be reset, pause or recenter.`,
                plugin, INPUT_DEVICES.id);
            }
            if (this.stopped || this.inputBlocks.size > 0) return;
            try { this.onAction(action); } catch (error) {
              throw new PluginError('plugin-failed', `Plugin "${plugin}" failed handling an "${INPUT_DEVICES.id}" action.`,
                plugin, INPUT_DEVICES.id, { cause: error });
            }
          },
        });
        try {
          this.devices.push({ plugin, value: checkInputDevice(factory(host), plugin) });
        } catch (error) {
          if (error instanceof PluginError && error.plugin === plugin && error.point === INPUT_DEVICES.id) throw error;
          throw new PluginError('plugin-failed', `Plugin "${plugin}" failed creating "${INPUT_DEVICES.id}".`,
            plugin, INPUT_DEVICES.id, { cause: error });
        }
      }
      document.addEventListener('visibilitychange', () => {
        this.accumulator = 0;
        this.previousTime = performance.now();
        this.settleDeathClock();
        this.clearMovement();
      }, listen);
      // Seed the looks before the first frame. There are no boot gameplay events.
      this.stageSwitches();
      this.flushNotifications();
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
    this.onPauseChange?.(this.pauseReasons.size > 0);
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
            this.simulation.step(perStep);
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
              const terminal = this.simulation.terminal();
              if (terminal !== null) {
                this.beginDeath(terminal);
                interrupted = true;
                break;
              }
              this.triggers.update(this.simulation.playerPosition(), this.simulation.time);
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
          // The held or released hammer blocks even during death; never gate its effects on vulnerability.
          const blocks = this.simulation.takeBlocks();
          for (let index = 0; index < blocks.count; index++) {
            if (!this.stopped) this.pending.block(blocks.hits[index]!, this.simulation.placement);
          }
          if (this.death === null && !interrupted) {
            const hurt = this.simulation.takeHurt();
            if (hurt !== null) {
              this.stageHurt(hurt, false);
              const event = this.stageEvent('hurt');
              if (event !== null) {
                const health = this.simulation.readHealth();
                event.health = health.current;
                event.max = health.max;
                stageCause(event.cause, hurt);
              }
            }
            if (this.eventConsumers) {
              const impact = this.simulation.takeImpact();
              if (impact >= IMPACT_SPEED.minimum && this.allowImpact()) {
                const event = this.stageEvent('impact');
                if (event !== null) event.strength = impactStrength(impact);
              }
            }
          }
        }
      } else {
        this.accumulator = 0;
        this.clearMovement();
      }
      // Never carry device movement from paused, blocked or zero-step frames into a later frame.
      if (hasDevices) this.deviceMovement.x = this.deviceMovement.y = 0;
      this.flushNotifications();
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
        if (visible) this.deathScreen.update(frame);
        if (this.death === dying) this.renderState.death = frame;
      }
      if (this.stopped) return;
      if (!this.presenter.coversGame) {
        this.prepareHurtPlacement();
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
    await this.view.sprites.replace(document, { signal: this.lifecycle.signal });
  }

  // Loads a second character profile for players to switch to; it stays loaded while hidden.
  async loadAlternateSprites(document: SpriteDocument): Promise<void> {
    if (this.stopped) throw new Error('Cannot load sprites into a stopped game.');
    await this.view.createAlternateCharacter().replace(document, { signal: this.lifecycle.signal });
  }

  selectCharacter(index: number): void {
    this.view.selectCharacter(index);
  }

  characterSelection() {
    return this.view.characterSelection();
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
    await this.view.setPartModel(role, part, signal);
    if (role === 'hammer' && !this.stopped) this.simulation.setHammerHead(part?.head ?? null);
  }

  // A new outline for the shown library hammer's head, as the Workshop edits it.
  setHammerHead(head: HammerHead | null): void {
    if (!this.stopped) this.simulation.setHammerHead(head);
  }

  partModels(): Record<PartRole, string | null> {
    return this.view.partModels();
  }

  setCharacter(state: CharacterState): void {
    this.renderState.armIk = { ...state.armIk };
  }

  setTheme(theme: GameTheme): void { this.view.setTheme(theme); }

  setEnemyArt(art: EnemyArtSettings): void { this.view.enemies.setArt(art); }

  setMedia(media: MediaHost): void { this.presenter.setMedia(media); }

  // Editor previews remain available after gameplay stops, but share the gameplay impact limit.
  playCue(cue: AudioCue): void {
    if (this.onCue === null || cue === 'impact' && !this.allowImpact()) return;
    this.previewCue.cue = cue;
    this.sendAudio(this.previewCue);
  }

  // Applies to future messages and deaths; an active death keeps the text and duration it started with.
  setHud(settings: HudSettings): void { this.hud = settings; }

  setPause(options: { reason: string; paused: boolean }): void {
    const wasPaused = this.pauseReasons.size > 0;
    if (options.paused) this.pauseReasons.add(options.reason);
    else this.pauseReasons.delete(options.reason);
    this.accumulator = 0;
    this.settleDeathClock();
    this.clearMovement();
    const paused = this.pauseReasons.size > 0;
    if (this.started && !this.stopped && paused !== wasPaused) this.onPauseChange?.(paused);
  }

  setInputBlock(options: { reason: string; blocked: boolean }): void {
    if (options.blocked) this.inputBlocks.add(options.reason);
    else this.inputBlocks.delete(options.reason);
    if (this.inputBlocks.size > 0) this.clearMovement();
    this.input.setInteraction({ enabled: this.inputBlocks.size === 0 });
  }

  // Engine-only recording/diagnostics. Only eligible live steps are sampled; death interrupts before its fatal sample.
  // Runtime plugins observe staged EVENTS instead. Returns this observer's removal.
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
    this.view.resetPresentation();
    this.accumulator = 0;
    this.clearMovement();
    this.view.recenter(this.simulation.frame(1));
    this.stageHurtClear();
    const event = this.stageEvent('respawn');
    if (event !== null) event.bonfire = this.bonfire;
  }

  // Everything a reset restarts besides the player and level objects.
  private restartRun(): void {
    this.cancelDeath();
    this.triggers.reset();
    this.presenter.clearToasts();
    this.view.resetPresentation();
    this.resetClock();
    this.accumulator = 0;
    this.clearMovement();
    this.view.recenter(this.simulation.frame(1));
    this.stageHurtClear();
    this.stageEvent('restart');
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
      this.view.resetPresentation();
      this.resetClock();
      this.accumulator = 0;
      this.clearMovement();
      this.view.recenter(this.simulation.frame(1));
      this.stageHurtClear();
      this.stageEvent('restart');
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
      const { plugin, value: device } = this.devices[index]!;
      disposal.run(() => {
        try { device.dispose?.(); } catch (error) {
          throw new PluginError('plugin-failed', `Plugin "${plugin}" failed disposing "${INPUT_DEVICES.id}".`,
            plugin, INPUT_DEVICES.id, { cause: error });
        }
      });
    }
    for (let index = this.observers.length - 1; index >= 0; index--) {
      const { plugin, value: observer } = this.observers[index]!;
      disposal.run(() => {
        try { observer.dispose?.(); } catch (error) {
          throw new PluginError('plugin-failed', `Plugin "${plugin}" failed disposing "${EVENTS.id}".`,
            plugin, EVENTS.id, { cause: error });
        }
      });
    }
    disposal.run(() => this.input?.dispose());
    disposal.run(() => this.view?.dispose());
    disposal.run(() => this.simulation?.dispose());
    this.pending.clear();
    this.delivery.clear();
    this.stepObservers.clear();
    this.enemyPhases.clear();
    disposal.finish();
  }

  private stop(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.animationFrame);
    this.pending.clear();
    this.delivery.clear();
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
      disposal.run(() => this.view?.disposeCharacters());
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

  private beginDeath(kind: DeathKind): void {
    const info: DeathInfo = kind === 'fall' ? { kind } : { kind, cause: { ...this.simulation.hurtCause() } };
    const settings = this.hud.death;
    const dying: Dying = {
      info, duration: settings.fadeIn + settings.hold, placement: this.simulation.placement,
      elapsed: 0, previousElapsed: 0, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    this.death = dying;
    // Falling wins the cue, but the killing hit still reaches the hurt effects.
    if (this.simulation.dead()) this.stageHurt(this.simulation.hurtCause(), true);
    if (kind === 'fall') this.stageEvent('fall');
    else {
      const event = this.stageEvent('death');
      if (event !== null && info.kind === 'health') stageCause(event.cause, info.cause);
    }
    this.view.writeDeathSeed(this.simulation.frame(1), this.deathSeed, this.renderState.armIk);
    this.simulation.beginDeath(this.deathSeed);
    this.view.beginDeath(this.simulation.frame(1), kind);
    this.clearMovement();
    for (const observer of this.stepObservers) observer.interrupt();
    if (this.death !== dying || this.stopped) return;
    this.presenter.setDeathHeld(true);
    this.triggers.interrupt();
    this.stageSwitches();
    if (this.death === dying && !this.stopped) this.deathScreen.show(info, settings);
  }

  private finishDeath(dying: Dying): void {
    if (this.death !== dying || this.stopped) return;
    if (this.simulation.placement !== dying.placement) throw new DeathSequenceError('placement-changed');
    if (this.simulation.respawn()) this.respawned();
    else {
      this.onAction('reset');
      if (this.stopped) return;
      if (this.simulation.placement === dying.placement) throw new DeathSequenceError('placement-failed');
      const event = this.stageEvent('respawn');
      if (event !== null) event.bonfire = null;
    }
  }

  private cancelDeath(): void {
    if (this.death === null) return;
    this.death = null;
    this.renderState.death = null;
    const disposal = new Disposal();
    disposal.run(() => this.view.cancelDeath());
    disposal.run(() => this.deathScreen.clear());
    disposal.run(() => this.presenter.setDeathHeld(false));
    disposal.finish();
  }

  private disposeDeathScreen(): void {
    if (this.deathScreenDisposed || this.deathScreen === undefined) return;
    this.deathScreenDisposed = true;
    this.deathScreen.dispose();
  }

  // Discard interpolation with the accumulator, so resuming cannot rewind the presentation by one step.
  private settleDeathClock(): void {
    if (this.death !== null) this.death.previousElapsed = this.death.elapsed;
  }

  private executeEvent(action: TriggerAction, signal: AbortSignal): EventOutcome | Promise<EventOutcome> {
    if (signal.aborted || this.death !== null || this.stopped) return 'cancelled';
    if (action.type === 'stop-timer') {
      this.timerRunning = false;
      this.stageEvent('finish');
      return 'completed';
    }
    if (action.type === 'launch-player') {
      this.simulation.launch(action);
      this.stageEvent('launch');
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
      const event = this.stageEvent('sound');
      if (event !== null) {
        event.source = action.source;
        event.volume = action.volume;
      }
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
    for (const { plugin, value: device } of this.devices) {
      try {
        checkSynchronous(device.poll(dt, this.deviceMovement), plugin, INPUT_DEVICES.id, 'poll');
      } catch (error) {
        if (error instanceof PluginError && error.plugin === plugin && error.point === INPUT_DEVICES.id) throw error;
        throw new PluginError('plugin-failed', `Plugin "${plugin}" failed polling "${INPUT_DEVICES.id}".`,
          plugin, INPUT_DEVICES.id, { cause: error });
      }
      if (!Number.isFinite(this.deviceMovement.x) || !Number.isFinite(this.deviceMovement.y)) {
        throw new PluginError('invalid-contribution', `Plugin "${plugin}": "${INPUT_DEVICES.id}" must add finite movement in metres.`,
          plugin, INPUT_DEVICES.id);
      }
      if (this.stopped) break;
    }
    if (this.simulation.placement !== placement || this.pauseReasons.size > 0 || this.inputBlocks.size > 0 || this.death !== null) this.clearMovement();
  }

  private stageEvent<T extends GameEvent['type']>(type: T) {
    return this.eventConsumers && !this.stopped ? this.pending.event(type) : null;
  }

  // The hurt effects always show, so their hits and clears are staged whoever else consumes events.
  private stageHurt(cause: Readonly<HurtCause>, fatal: boolean): void {
    if (!this.stopped) this.pending.hurt(cause, fatal, this.simulation.placement);
  }

  private stageHurtClear(): void {
    if (!this.stopped) this.pending.clearHurt(this.simulation.placement);
  }

  // Delivery callbacks may place the player again. Clear the latest placement before drawing, not one frame later.
  private prepareHurtPlacement(): void {
    const placement = this.simulation.placement;
    if (this.hurtPlacement === placement) return;
    this.hurtPlacement = placement;
    try { this.view.clearHurt(); } catch (error) {
      if (error instanceof PluginError && error.plugin === this.hurtPlugin && error.point === HURT_EFFECTS.id) throw error;
      throw new PluginError('plugin-failed', `Plugin "${this.hurtPlugin ?? 'engine'}" failed applying "${HURT_EFFECTS.id}" clear.`,
        this.hurtPlugin, HURT_EFFECTS.id, { cause: error });
    }
  }

  private stageSwitches(): void {
    if (this.stopped || !this.triggers.writePressedSwitches(this.pressedSwitches)) return;
    this.pending.switches = this.pressedSwitches.slice();
  }

  // Called synchronously by the simulation: copy only into engine-owned staging, never call a look or a plugin here.
  private stageEnemy(event: EnemyEvent): void {
    if (this.stopped) return;
    this.pending.enemy(event);
    if (!this.eventConsumers) return;
    if (event.type === 'reset') {
      this.enemyPhases.clear();
      for (const pose of event.poses) this.enemyPhases.set(pose.id, pose.phase);
    } else if (event.type === 'remove') {
      this.enemyPhases.delete(event.id);
    } else {
      const previous = this.enemyPhases.get(event.pose.id);
      this.enemyPhases.set(event.pose.id, event.pose.phase);
      if (previous === undefined || previous === event.pose.phase) return;
      if (event.pose.phase === 'hurt' || event.pose.phase === 'dead') {
        const notification = this.stageEvent(event.pose.phase === 'hurt' ? 'enemy-hit' : 'enemy-defeat');
        if (notification !== null) notification.id = event.pose.id;
      }
    }
  }

  private allowImpact(): boolean {
    const now = performance.now() / 1000;
    if (now - this.lastImpact < IMPACT_INTERVAL) return false;
    this.lastImpact = now;
    return true;
  }

  private sendAudio(cue: GameCue): void {
    try { this.onCue?.(cue); } catch (error) {
      throw new PluginError('plugin-failed', `Plugin "${this.audioPlugin ?? 'engine'}" failed handling "${AUDIO.id}".`,
        this.audioPlugin, AUDIO.id, { cause: error });
    }
  }

  private flushNotifications(): void {
    if (this.lifecycle.signal.aborted || !this.pending.pending) return;
    // Callbacks can raise more notifications. Give them the other buffer; never overwrite a borrowed event
    // being delivered, and defer their new notifications to the next flush.
    const batch = this.pending;
    this.pending = this.delivery;
    this.delivery = batch;
    try {
      // a. Looks: all enemy changes, then only the latest bonfire state.
      for (let index = 0; index < batch.enemyCount; index++) {
        if (this.lifecycle.signal.aborted) return;
        try { this.view.enemies.apply(batch.enemies[index]!); } catch (error) {
          throw new PluginError('plugin-failed', `Plugin "${this.enemyPlugin ?? 'engine'}" failed applying "${LOOKS.enemies.id}".`,
            this.enemyPlugin, LOOKS.enemies.id, { cause: error });
        }
      }
      if (batch.lit !== null && !this.lifecycle.signal.aborted) {
        try { this.view.setLitBonfires(batch.lit); } catch (error) {
          throw new PluginError('plugin-failed', `Plugin "${this.bonfirePlugin ?? 'engine'}" failed applying "${LOOKS.bonfire.id}".`,
            this.bonfirePlugin, LOOKS.bonfire.id, { cause: error });
        }
      }
      if (batch.switches !== null && !this.lifecycle.signal.aborted) {
        try { this.view.setPressedSwitches(batch.switches); } catch (error) {
          throw new PluginError('plugin-failed', `Plugin "${this.switchPlugin ?? 'engine'}" failed applying "${LOOKS.switch.id}".`,
            this.switchPlugin, LOOKS.switch.id, { cause: error });
        }
      }
      // Then hits and placements for the hurt effects, in the order they happened.
      for (let index = 0; index < batch.hurtCount; index++) {
        if (this.lifecycle.signal.aborted) return;
        const notice = batch.hurts[index]!;
        if (notice.placement !== this.simulation.placement) continue;
        this.prepareHurtPlacement();
        if (this.lifecycle.signal.aborted) return;
        if (notice.clear || notice.placement !== this.simulation.placement) continue;
        try {
          this.view.hurt(notice.cause, notice.fatal);
        } catch (error) {
          if (error instanceof PluginError && error.plugin === this.hurtPlugin && error.point === HURT_EFFECTS.id) throw error;
          throw new PluginError('plugin-failed', `Plugin "${this.hurtPlugin ?? 'engine'}" failed applying "${HURT_EFFECTS.id}".`,
            this.hurtPlugin, HURT_EFFECTS.id, { cause: error });
        }
      }
      for (let index = 0; index < batch.blockCount; index++) {
        if (this.lifecycle.signal.aborted) return;
        const notice = batch.blocks[index]!;
        if (notice.placement !== this.simulation.placement) continue;
        try {
          this.view.block(notice.hit);
        } catch (error) {
          if (error instanceof PluginError && error.plugin === this.blockPlugin && error.point === BLOCK_EFFECTS.id) throw error;
          throw new PluginError('plugin-failed', `Plugin "${this.blockPlugin ?? 'engine'}" failed applying "${BLOCK_EFFECTS.id}".`,
            this.blockPlugin, BLOCK_EFFECTS.id, { cause: error });
        }
      }
      // b. Audio: the same source order as the gameplay notifications, with impacts already limited.
      if (this.onCue !== null) {
        for (let index = 0; index < batch.eventCount; index++) {
          if (this.lifecycle.signal.aborted) return;
          const event = batch.events[index]!;
          if (event.type === 'sound') this.sendAudio(event);
          else if (event.type !== 'restart' && event.type !== 'respawn') {
            this.audioCue.cue = event.type;
            this.audioCue.strength = event.type === 'impact' ? event.strength : 1;
            this.sendAudio(this.audioCue);
          }
        }
      }
      // c. Observers: event order first, manifest order within each event; no calls on an idle frame.
      if (this.observers.length > 0) {
        for (let index = 0; index < batch.eventCount; index++) {
          const event = batch.events[index]!;
          for (const { plugin, value: observer } of this.observers) {
            if (this.lifecycle.signal.aborted) return;
            try {
              checkSynchronous(observer.event(event), plugin, EVENTS.id, 'event');
            } catch (error) {
              if (error instanceof PluginError && error.plugin === plugin && error.point === EVENTS.id) throw error;
              throw new PluginError('plugin-failed', `Plugin "${plugin}" failed observing "${EVENTS.id}" event "${event.type}".`,
                plugin, EVENTS.id, { cause: error });
            }
          }
        }
      }
    } finally {
      batch.clear();
    }
  }
}
