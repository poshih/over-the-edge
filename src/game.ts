import { DEFAULT_ARM_IK } from './character';
import type { DecorationView } from './decoration-view';
import type { CharacterState } from './character';
import { PHYSICS } from './config';
import type { PlayerSpawn, UiAction, UiActionOptions } from './config';
import { DEFAULT_GAME_SETTINGS } from './game-settings';
import type { GameSettings } from './game-settings';
import { PointerInput } from './input';
import { isTriggerObject } from './level';
import type { LevelChange, LevelDefinition } from './level';
import { clamp } from './math';
import { Simulation } from './simulation';
import { GameView } from './view';
import { TriggerRuntime } from './triggers';
import { DEFAULT_MESSAGE_STYLE, DEFAULT_VIDEO_PLAYBACK } from './trigger-events';
import type { EventOutcome, MessageStyle, TriggerAction, VideoPlayback } from './trigger-events';
import { EventPresenter } from './event-presenter';
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

export class Game {
  readonly simulation: Simulation;
  readonly view: GameView;
  readonly input: PointerInput;
  readonly triggers: TriggerRuntime;
  private readonly presenter: EventPresenter;
  private readonly canvas: HTMLCanvasElement;
  private readonly fatal: HTMLElement;
  private readonly lifecycle = new AbortController();
  private readonly pauseReasons = new Set<string>();
  private readonly inputBlocks = new Set<string>();
  private readonly unsubscribeTerrain: () => void;
  private readonly unsubscribeEnemies: () => void;
  private readonly unsubscribeBonfires: () => void;
  private readonly onAction: (action: UiAction, options?: UiActionOptions) => void;
  private readonly onCue: ((cue: GameCue) => void) | null;
  private readonly stepObservers = new Set<() => void>();
  // Last phase of each enemy, so cues fire on hit and defeat transitions only.
  private readonly enemyPhases = new Map<string, EnemyPhase>();
  // The bonfire a death returns to, so its cue plays when another becomes it.
  private bonfire: string | null = null;
  private character: CharacterState = { armIk: DEFAULT_ARM_IK };
  private messageStyle: MessageStyle;
  private readonly videos: VideoPlayback;
  private stopped = false;
  private started = false;
  private animationFrame = 0;
  private accumulator = 0;
  private previousTime = 0;
  private timerElapsed = 0;
  private timerRunning = true;
  private readonly hudFrame: { -readonly [K in keyof HudFrame]: HudFrame[K] } = {
    height: 0, bestHeight: 0, elapsed: 0, timerRunning: true, health: null, paused: false,
    pointerLocked: false, inputMode: 'mouse',
  };

  constructor(options: {
    canvas: HTMLCanvasElement;
    fatal: HTMLElement;
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
    // How message events appear; toasts by default.
    messageStyle?: MessageStyle;
    // Whether play-video events play or are skipped; they play by default. The Workshop skips them.
    videos?: VideoPlayback;
    // Streams authored video sources; by default sources are URLs.
    media?: MediaHost;
    // Receives sound cues and play-sound events; without it the game tracks no impacts.
    onCue?: (cue: GameCue) => void;
    onAction: (action: UiAction, options?: UiActionOptions) => void;
    onNotice: (message: string) => void;
    onShortcut?: (event: KeyboardEvent) => void;
  }) {
    this.canvas = options.canvas;
    this.fatal = options.fatal;
    this.onAction = options.onAction;
    this.onCue = options.onCue ?? null;
    this.messageStyle = options.messageStyle ?? DEFAULT_MESSAGE_STYLE;
    this.videos = options.videos ?? DEFAULT_VIDEO_PLAYBACK;
    const listen = { signal: this.lifecycle.signal };
    window.addEventListener('error', (event) => this.stop(event.message), listen);
    window.addEventListener('unhandledrejection', (event) =>
      this.stop(event.reason instanceof Error ? event.reason.message : String(event.reason)), listen);
    this.simulation = new Simulation(options.settings === undefined ? DEFAULT_GAME_SETTINGS : options.settings, options.level);
    try {
      this.view = new GameView(options.canvas, this.simulation.frame(1), options.level, {
        characterModels: options.characterModels, content: options.content, theme: options.theme, enemyArt: options.enemyArt,
        decorations: options.decorations, kinds: options.kinds, plugins: options.plugins,
      });
    } catch (error) {
      this.lifecycle.abort();
      this.simulation.dispose();
      throw error;
    }
    if (this.onCue !== null) this.simulation.trackImpacts(true);
    this.unsubscribeTerrain = this.simulation.subscribeTerrain((event) => this.view.terrain.apply(event));
    this.unsubscribeEnemies = this.simulation.subscribeEnemies((event) => {
      this.view.enemies.apply(event);
      if (this.onCue !== null) this.enemyCue(event);
    });
    this.unsubscribeBonfires = this.simulation.subscribeBonfires((state) => {
      this.view.setLitBonfires(state.lit);
      if (state.current !== null && state.current !== this.bonfire) this.cue('bonfire');
      this.bonfire = state.current;
    });
    this.input = new PointerInput(options.canvas, {
      onAction: options.onAction, onNotice: options.onNotice, onShortcut: options.onShortcut,
    });
    this.presenter = new EventPresenter({
      mount: options.eventMount,
      media: options.media,
      onModalChange: ({ active }) => {
        this.setPause({ reason: 'event', paused: active });
        this.setInputBlock({ reason: 'event', blocked: active });
      },
    });
    this.triggers = new TriggerRuntime(options.level.objects.filter(isTriggerObject), {
      execute: (action, signal) => this.executeEvent(action, signal),
      onFailure: ({ triggerId, eventIndex, message }) => options.onNotice(`Trigger "${triggerId}", event ${eventIndex + 1}: ${message}`),
      onFault: (error) => this.stop(error instanceof Error ? error.message : String(error)),
    });
    document.addEventListener('visibilitychange', () => {
      this.accumulator = 0;
      this.previousTime = performance.now();
      this.input.clear();
    }, listen);
  }

  start(onFrame: (state: HudFrame) => void): void {
    if (this.started) throw new Error('The game loop is already running.');
    this.started = true;
    this.previousTime = performance.now();
    const animate = (now: number): void => {
      if (this.stopped) return;
      const dt = clamp((now - this.previousTime) / 1000, 0, PHYSICS.dt * PHYSICS.maxFrameSteps);
      this.previousTime = now;
      const paused = this.pauseReasons.size > 0;
      if (!paused && document.visibilityState === 'visible') {
        this.accumulator += dt;
        const steps = Math.min(Math.floor(this.accumulator / PHYSICS.dt), PHYSICS.maxFrameSteps);
        if (steps > 0) {
          const movement = this.view.pointerDelta(this.input.takeMovement(), this.settings().physics.mouseSensitivity, this.input.mode);
          const perStep = { x: movement.x / steps, y: movement.y / steps };
          let completed = 0;
          let placed = false;
          for (; completed < steps;) {
            this.simulation.step(perStep);
            if (this.timerRunning) this.timerElapsed += PHYSICS.dt;
            completed++;
            this.triggers.update(this.simulation.playerPosition(), this.simulation.time);
            if (this.stopped) return;
            for (const observer of this.stepObservers) observer();
            const fell = this.simulation.fellOutOfLevel();
            if (fell || this.simulation.dead()) {
              placed = true;
              this.cue(fell ? 'fall' : 'death');
              // A death returns the player to the bonfire reached last, the run going on; before any, it restarts the
              // attempt exactly like Reset.
              if (this.simulation.respawn()) this.respawned();
              else this.onAction('reset');
              break;
            }
            if (this.pauseReasons.size > 0) break;
          }
          if (!placed && this.pauseReasons.size === 0) this.accumulator -= completed * PHYSICS.dt;
          if (this.simulation.takeHurt()) this.cue('hurt');
          if (this.onCue !== null) {
            const impact = this.simulation.takeImpact();
            if (impact >= IMPACT_SPEED.minimum) this.onCue({ type: 'cue', cue: 'impact', strength: impactStrength(impact) });
          }
        }
      } else {
        this.accumulator = 0;
        this.input.clear();
      }
      if (!this.presenter.coversGame) {
        const frame = this.simulation.frame(this.pauseReasons.size > 0 ? 1 : clamp(this.accumulator / PHYSICS.dt, 0, 1));
        this.view.render(frame, { dt, ...this.character });
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
    return frame;
  }

  get halted(): boolean {
    return this.stopped;
  }

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
    this.character = { armIk: { ...state.armIk } };
  }

  setTheme(theme: GameTheme): void { this.view.setTheme(theme); }

  setEnemyArt(art: EnemyArtSettings): void { this.view.enemies.setArt(art); }

  setMedia(media: MediaHost): void { this.presenter.setMedia(media); }

  // Applies to future message events; toasts already showing or queued finish as toasts.
  setMessageStyle(style: MessageStyle): void { this.messageStyle = style; }

  setPause(options: { reason: string; paused: boolean }): void {
    if (options.paused) this.pauseReasons.add(options.reason);
    else this.pauseReasons.delete(options.reason);
    this.accumulator = 0;
    this.input.clear();
  }

  setInputBlock(options: { reason: string; blocked: boolean }): void {
    if (options.blocked) this.inputBlocks.add(options.reason);
    else this.inputBlocks.delete(options.reason);
    this.input.setInteraction({ enabled: this.inputBlocks.size === 0 });
  }

  // Runs `observer` after every physics step, before a death brings the player back. Returns its removal.
  observeSteps(observer: () => void): () => void {
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
    this.triggers.jump();
    this.view.resetPresentation();
    this.accumulator = 0;
    this.input.clear();
    this.view.recenter(this.simulation.frame(1));
  }

  // Everything a reset restarts besides the player and level objects.
  private restartRun(): void {
    this.triggers.reset();
    this.presenter.clearToasts();
    this.view.resetPresentation();
    this.resetClock();
    this.accumulator = 0;
    this.input.clear();
    this.view.recenter(this.simulation.frame(1));
  }

  applyLevel(change: LevelChange): void {
    this.triggers.apply(change);
    this.simulation.applyLevel(change);
    this.view.applyLevel(change);
    if (change.kind === 'replace') {
      this.presenter.clearToasts();
      this.view.resetPresentation();
      this.resetClock();
      this.accumulator = 0;
      this.input.clear();
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
    this.stopped = true;
    cancelAnimationFrame(this.animationFrame);
    this.lifecycle.abort();
    this.triggers.dispose();
    this.presenter.dispose();
    this.unsubscribeTerrain();
    this.unsubscribeEnemies();
    this.unsubscribeBonfires();
    this.input.dispose();
    this.view.dispose();
    this.simulation.dispose();
  }

  private stop(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.animationFrame);
    this.fatal.hidden = false;
    this.fatal.textContent = `The game stopped: ${message}`;
    this.lifecycle.abort();
    this.triggers?.dispose();
    this.presenter?.dispose();
    this.view?.disposeCharacters();
    this.input?.setInteraction({ enabled: false });
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private resetClock(): void {
    this.timerElapsed = 0;
    this.timerRunning = true;
  }

  private executeEvent(action: TriggerAction, signal: AbortSignal): EventOutcome | Promise<EventOutcome> {
    if (signal.aborted) return 'cancelled';
    if (action.type === 'stop-timer') {
      this.timerRunning = false;
      this.cue('finish');
      return 'completed';
    }
    if (action.type === 'launch-player') {
      this.simulation.launch(action);
      this.cue('launch');
      return 'completed';
    }
    if (action.type === 'play-sound') {
      this.onCue?.({ type: 'sound', source: action.source, volume: action.volume });
      return 'completed';
    }
    // A toast never holds up the triggers: the next event, or the next trigger, starts at once.
    if (action.type === 'message' && this.messageStyle === 'toast') {
      this.presenter.toast(action);
      return 'completed';
    }
    // A skipped video never shows: the trigger goes on to its next event, as after the player skips one.
    if (action.type === 'play-video' && this.videos === 'skip') return 'skipped';
    return this.presenter.present(action, signal);
  }

  private cue(cue: AudioCue): void {
    this.onCue?.({ type: 'cue', cue, strength: 1 });
  }

  private enemyCue(event: EnemyEvent): void {
    if (event.type === 'reset') {
      this.enemyPhases.clear();
      for (const pose of event.poses) this.enemyPhases.set(pose.id, pose.phase);
    } else if (event.type === 'remove') {
      this.enemyPhases.delete(event.id);
    } else {
      const previous = this.enemyPhases.get(event.pose.id);
      this.enemyPhases.set(event.pose.id, event.pose.phase);
      if (previous === undefined || previous === event.pose.phase) return;
      if (event.pose.phase === 'hurt') this.cue('enemy-hit');
      else if (event.pose.phase === 'dead') this.cue('enemy-defeat');
    }
  }
}
