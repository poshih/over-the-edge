import { DEFAULT_ARM_IK } from './character';
import type { CharacterState } from './character';
import { DEFAULT_TUNING, PHYSICS } from './config';
import type { PlayerSpawn, Tuning, UiAction, UiActionOptions } from './config';
import { PointerInput } from './input';
import type { LevelChange, LevelDefinition } from './level';
import { clamp } from './math';
import { Simulation } from './simulation';
import { GameView } from './view';

export class Game {
  readonly simulation: Simulation;
  readonly view: GameView;
  readonly input: PointerInput;
  private readonly canvas: HTMLCanvasElement;
  private readonly fatal: HTMLElement;
  private readonly lifecycle = new AbortController();
  private readonly pauseReasons = new Set<string>();
  private readonly unsubscribeTerrain: () => void;
  private tuning: Readonly<Tuning>;
  private character: CharacterState = { armIk: DEFAULT_ARM_IK, shaft: 'segmented' };
  private stopped = false;
  private started = false;
  private animationFrame = 0;
  private accumulator = 0;
  private previousTime = 0;

  constructor(options: {
    canvas: HTMLCanvasElement;
    fatal: HTMLElement;
    level: LevelDefinition;
    tuning?: Readonly<Tuning>;
    onAction: (action: UiAction, options?: UiActionOptions) => void;
    onNotice: (message: string) => void;
    onShortcut?: (event: KeyboardEvent) => void;
  }) {
    this.canvas = options.canvas;
    this.fatal = options.fatal;
    this.tuning = options.tuning === undefined ? DEFAULT_TUNING : options.tuning;
    const listen = { signal: this.lifecycle.signal };
    window.addEventListener('error', (event) => this.stop(event.message), listen);
    window.addEventListener('unhandledrejection', (event) =>
      this.stop(event.reason instanceof Error ? event.reason.message : String(event.reason)), listen);
    this.simulation = new Simulation(this.tuning, options.level);
    this.view = new GameView(options.canvas, this.simulation.frame(1), options.level);
    this.unsubscribeTerrain = this.simulation.subscribeTerrain((event) => this.view.terrain.apply(event));
    this.input = new PointerInput(options.canvas, {
      onAction: options.onAction, onNotice: options.onNotice, onShortcut: options.onShortcut,
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
          const movement = this.view.pointerDelta(this.input.takeMovement(), this.tuning.mouseSensitivity, this.input.mode);
          const perStep = { x: movement.x / steps, y: movement.y / steps };
          for (let index = 0; index < steps; index++) this.simulation.step(perStep);
          this.accumulator -= steps * PHYSICS.dt;
        }
      } else {
        this.accumulator = 0;
        this.input.clear();
      }
      const frame = this.simulation.frame(paused ? 1 : clamp(this.accumulator / PHYSICS.dt, 0, 1));
      this.view.render(frame, { dt, ...this.character });
      onFrame(this.state());
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  state() {
    const state = this.simulation.status();
    return {
      ...state, elapsed: state.time,
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

  setTuning(tuning: Readonly<Tuning>): void {
    this.simulation.setTuning(tuning);
    this.tuning = { ...tuning };
  }

  setCharacter(state: CharacterState): void {
    this.character = { armIk: { ...state.armIk }, shaft: state.shaft };
  }

  setPause(options: { reason: string; paused: boolean }): void {
    if (options.paused) this.pauseReasons.add(options.reason);
    else this.pauseReasons.delete(options.reason);
    this.accumulator = 0;
    this.input.clear();
  }

  reset(spawn?: Readonly<PlayerSpawn>): void {
    this.simulation.reset(spawn);
    this.accumulator = 0;
    this.input.clear();
    this.view.recenter(this.simulation.frame(1));
  }

  applyLevel(change: LevelChange): void {
    this.simulation.applyLevel(change);
    this.view.setLevel(change.level);
    if (change.kind === 'replace') {
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
    this.unsubscribeTerrain();
    this.input.dispose();
    this.view.dispose();
    this.simulation.dispose();
  }

  private stop(message: string): void {
    this.stopped = true;
    cancelAnimationFrame(this.animationFrame);
    this.fatal.hidden = false;
    this.fatal.textContent = `The game stopped: ${message}`;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}
