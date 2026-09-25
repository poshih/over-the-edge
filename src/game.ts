import { DEFAULT_ARM_IK } from './character';
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
import type { TriggerAction, EventOutcome } from './trigger-events';
import { EventPresenter } from './event-presenter';
import type { SpriteDocument } from './sprite-data';

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
  private readonly onAction: (action: UiAction, options?: UiActionOptions) => void;
  private character: CharacterState = { armIk: DEFAULT_ARM_IK };
  private stopped = false;
  private started = false;
  private animationFrame = 0;
  private accumulator = 0;
  private previousTime = 0;
  private timerElapsed = 0;
  private timerRunning = true;

  constructor(options: {
    canvas: HTMLCanvasElement;
    fatal: HTMLElement;
    eventMount: HTMLElement;
    level: LevelDefinition;
    settings?: Readonly<GameSettings>;
    onAction: (action: UiAction, options?: UiActionOptions) => void;
    onNotice: (message: string) => void;
    onShortcut?: (event: KeyboardEvent) => void;
  }) {
    this.canvas = options.canvas;
    this.fatal = options.fatal;
    this.onAction = options.onAction;
    const listen = { signal: this.lifecycle.signal };
    window.addEventListener('error', (event) => this.stop(event.message), listen);
    window.addEventListener('unhandledrejection', (event) =>
      this.stop(event.reason instanceof Error ? event.reason.message : String(event.reason)), listen);
    this.simulation = new Simulation(options.settings === undefined ? DEFAULT_GAME_SETTINGS : options.settings, options.level);
    this.view = new GameView(options.canvas, this.simulation.frame(1), options.level);
    this.unsubscribeTerrain = this.simulation.subscribeTerrain((event) => this.view.terrain.apply(event));
    this.unsubscribeEnemies = this.simulation.subscribeEnemies((event) => this.view.enemies.apply(event));
    this.input = new PointerInput(options.canvas, {
      onAction: options.onAction, onNotice: options.onNotice, onShortcut: options.onShortcut,
    });
    this.presenter = new EventPresenter({
      mount: options.eventMount,
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

  start(onFrame: (state: ReturnType<Game['state']>) => void): void {
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
          let restarted = false;
          for (; completed < steps;) {
            this.simulation.step(perStep);
            if (this.timerRunning) this.timerElapsed += PHYSICS.dt;
            completed++;
            this.triggers.update(this.simulation.playerPosition(), this.simulation.time);
            if (this.stopped) return;
            if (this.simulation.fellOutOfLevel()) {
              // Falling below everything in the level restarts the attempt exactly like Reset.
              restarted = true;
              this.onAction('reset');
              break;
            }
            if (this.pauseReasons.size > 0) break;
          }
          if (!restarted && this.pauseReasons.size === 0) this.accumulator -= completed * PHYSICS.dt;
        }
      } else {
        this.accumulator = 0;
        this.input.clear();
      }
      if (!this.presenter.coversGame) {
        const frame = this.simulation.frame(this.pauseReasons.size > 0 ? 1 : clamp(this.accumulator / PHYSICS.dt, 0, 1));
        this.view.render(frame, { dt, ...this.character });
      }
      onFrame(this.state());
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  state() {
    const state = this.simulation.status();
    return {
      ...state, elapsed: this.timerElapsed, timerRunning: this.timerRunning,
      paused: this.pauseReasons.size > 0,
      pointerLocked: this.input.locked,
      inputMode: this.input.mode,
    };
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

  settings(): GameSettings { return this.simulation.gameSettings(); }

  setSettings(settings: Readonly<GameSettings>): void { this.simulation.setSettings(settings); }

  setCharacter(state: CharacterState): void {
    this.character = { armIk: { ...state.armIk } };
  }

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

  reset(spawn?: Readonly<PlayerSpawn>): void {
    this.triggers.reset();
    this.simulation.reset(spawn);
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
    this.view?.sprites?.dispose();
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
      return 'completed';
    }
    if (action.type === 'launch-player') {
      this.simulation.launch(action);
      return 'completed';
    }
    return this.presenter.present(action, signal);
  }
}
