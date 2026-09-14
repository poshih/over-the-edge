import './style.css';
import { Appearance } from './appearance';
import { createAppearanceUI } from './appearance-ui';
import { DEFAULT_TUNING, PHYSICS } from './config';
import type { GameUi, Point, PracticeId, Tuning, UiAction, UiActionOptions, WorkshopState } from './config';
import { PointerInput } from './input';
import { clamp } from './math';
import { Simulation } from './simulation';
import { createUI } from './ui';
import { GameView } from './view';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

let stopped = false;
let animationFrame = 0;
const lifecycle = new AbortController();
const stopWithMessage = (message: string): void => {
  stopped = true;
  cancelAnimationFrame(animationFrame);
  fatal.hidden = false;
  fatal.textContent = `The game stopped: ${message}`;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
};
window.addEventListener('error', (event) => stopWithMessage(event.message), { signal: lifecycle.signal });
window.addEventListener('unhandledrejection', (event) => {
  stopWithMessage(event.reason instanceof Error ? event.reason.message : String(event.reason));
}, { signal: lifecycle.signal });

let tuning: Tuning = { ...DEFAULT_TUNING };
const simulation = new Simulation(tuning);
const view = new GameView(canvas, simulation.frame(1));
const pauseReasons = new Set<'user' | 'workshop'>();
let debug = false;
let practice: PracticeId = 'start';
let accumulator = 0;
let previousTime = performance.now();
let ui: GameUi;
const input = new PointerInput(canvas, {
  onAction: perform,
  onPractice: reset,
  onNotice: (message) => ui.notice(message, 'error'),
});
ui = createUI({
  mount,
  initialTuning: tuning,
  initialInputMode: input.mode,
  onAction: perform,
  onWorkshopChange: updateWorkshop,
  onPractice: reset,
  onTuningChange: (next) => {
    tuning = { ...next };
    simulation.setTuning(tuning);
  },
});
const appearance = new Appearance(view.appearance, (message, kind) => ui.notice(message, kind));
const appearanceUi = createAppearanceUI({
  mount: ui.appearanceMount,
  appearance,
  onDebug: () => perform('debug'),
  onNotice: (message, kind) => ui.notice(message, kind),
});
void appearance.restore();

function reset(next: PracticeId): void {
  practice = next;
  simulation.reset(practice);
  input.clear();
  accumulator = 0;
  view.recenter(simulation.frame(1));
}

function updateWorkshop(state: WorkshopState): void {
  if (state.open && state.compact) pauseReasons.add('workshop');
  else pauseReasons.delete('workshop');
  input.clear();
  accumulator = 0;
}

function resume(): void {
  pauseReasons.delete('user');
  if (pauseReasons.has('workshop')) ui.closeWorkshop();
}

function perform(action: UiAction, options: UiActionOptions = {}): void {
  switch (action) {
    case 'play':
      resume();
      input.clear();
      input.activate(options.inputMode ?? input.mode);
      break;
    case 'reset':
      reset(practice);
      break;
    case 'pause':
      if (pauseReasons.size > 0) resume();
      else pauseReasons.add('user');
      input.clear();
      accumulator = 0;
      break;
    case 'debug':
      debug = !debug;
      break;
    case 'recenter':
      view.recenter(simulation.frame(1));
      break;
  }
}

document.addEventListener('visibilitychange', () => {
  accumulator = 0;
  previousTime = performance.now();
  input.clear();
}, { signal: lifecycle.signal });

function animate(now: number): void {
  if (stopped) return;
  const dt = clamp((now - previousTime) / 1000, 0, PHYSICS.dt * PHYSICS.maxFrameSteps);
  previousTime = now;
  const paused = pauseReasons.size > 0;
  if (!paused && document.visibilityState === 'visible') {
    accumulator += dt;
    const steps = Math.min(Math.floor(accumulator / PHYSICS.dt), PHYSICS.maxFrameSteps);
    if (steps > 0) {
      const movement = view.pointerDelta(input.takeMovement(), tuning.mouseSensitivity, input.mode);
      const perStep = { x: movement.x / steps, y: movement.y / steps };
      for (let index = 0; index < steps; index++) simulation.step(perStep);
      accumulator -= steps * PHYSICS.dt;
    }
  } else {
    accumulator = 0;
    input.clear();
  }
  const frame = simulation.frame(paused ? 1 : clamp(accumulator / PHYSICS.dt, 0, 1));
  view.render(frame, { dt, debug, armIk: appearance.armIkSettings() });
  const state = simulation.snapshot();
  ui.update({
    height: state.height,
    bestHeight: state.bestHeight,
    elapsed: state.time,
    paused,
    pointerLocked: input.locked,
    inputMode: input.mode,
    debug,
    practice,
    contacts: state.contacts,
    hingeLoad: state.hingeLoad,
    sliderLoad: state.sliderLoad,
    summit: state.summit,
  });
  animationFrame = requestAnimationFrame(animate);
}

const diagnostics = Object.freeze({
  snapshot: () => ({
    ...simulation.snapshot(),
    parts: simulation.frame(1).parts.map((part) => ({
      ...part, vertices: part.vertices.map((point) => ({ ...point })),
    })),
    paused: pauseReasons.size > 0,
    pauseReasons: [...pauseReasons],
    debug,
    pointerLocked: input.locked,
    inputMode: input.mode,
    camera: view.cameraState(),
    cursorScreen: view.project(simulation.snapshot().cursor),
    step: PHYSICS.dt,
    stopped,
  }),
  project: (point: Point) => view.project(point),
  appearance: () => appearance.snapshot(),
});

declare global {
  interface Window {
    gettingOver?: typeof diagnostics;
  }
}
window.gettingOver = diagnostics;
animationFrame = requestAnimationFrame(animate);

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    stopped = true;
    cancelAnimationFrame(animationFrame);
    lifecycle.abort();
    input.dispose();
    appearanceUi.dispose();
    appearance.dispose();
    ui.dispose();
    view.dispose();
    simulation.dispose();
    delete window.gettingOver;
  });
}
