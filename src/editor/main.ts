import '../game.css';
import './style.css';
import { PHYSICS } from '../config';
import type { Point, UiActionOptions } from '../config';
import { DEFAULT_LEVEL } from '../default-level';
import { Game } from '../game';
import { Appearance } from './appearance';
import { AppearanceRig } from './appearance-rig';
import { createAppearanceUI } from './appearance-ui';
import { CollisionOverlay } from './collision-overlay';
import { createLevelEditor } from './level-editor';
import { LevelState } from './level-state';
import { PRACTICES, practiceById } from './practices';
import { createUI } from './ui';
import type { EditorAction, PracticeId, WorkshopState } from './ui-types';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

const level = new LevelState(DEFAULT_LEVEL);
let debug = false;
let practice: PracticeId = 'start';
let editing = false;
const game = new Game({
  canvas, fatal, level: level.definition(),
  onAction: perform,
  onNotice: (message) => ui.notice(message, 'error'),
  onShortcut: (event) => {
    const key = event.key.toLowerCase();
    if (key === 'd') {
      event.preventDefault();
      perform('debug');
    } else if (/^[1-4]$/.test(key)) {
      event.preventDefault();
      resetPractice(PRACTICES[Number(key) - 1].id);
    }
  },
});
const unsubscribeLevel = level.subscribe((change) => {
  game.applyLevel(change);
  if (change.kind === 'replace') practice = 'start';
});
const ui = createUI({
  mount,
  initialTuning: game.simulation.snapshot().tuning,
  initialInputMode: game.input.mode,
  onAction: perform,
  onWorkshopChange: updateWorkshop,
  onPractice: resetPractice,
  onTuningChange: (tuning) => game.setTuning(tuning),
});
const rig = new AppearanceRig(game.view.visuals);
const appearance = new Appearance(rig, ui.notice);
const appearanceUi = createAppearanceUI({
  mount: ui.appearanceMount, appearance,
  onDebug: () => perform('debug'), onNotice: ui.notice,
});
const unsubscribeAppearance = appearance.subscribe(() => game.setCharacter({
  armIk: appearance.armIkSettings(),
  shaft: rig.isCustom('hammer-shaft') ? 'straight' : 'segmented',
}));
const collisionOverlay = new CollisionOverlay();
game.view.addLayer(collisionOverlay);
const unsubscribeOverlay = game.simulation.subscribeTerrain((event) => collisionOverlay.apply(event));
const levelEditor = createLevelEditor({
  mount: ui.levelMount, canvas, level,
  camera: {
    state: () => game.view.cameraState(),
    set: (framing) => game.view.setFraming(framing),
    project: (point) => game.view.project(point),
    unproject: (point) => game.view.unproject(point),
  },
  onPlay: () => perform('play'),
  onNotice: ui.notice,
});

function resetPractice(id: PracticeId): void {
  practice = id;
  game.reset(id === 'start' ? level.definition().spawn : practiceById(id));
}

function updateWorkshop(state: WorkshopState): void {
  const nextEditing = state.open && state.tab === 'level';
  if (nextEditing !== editing) {
    editing = nextEditing;
    if (editing) game.simulation.restoreTerrain();
    game.input.setInteraction({ enabled: !editing });
    levelEditor.setMode(editing ? 'edit' : 'inactive');
  }
  game.setPause({ reason: 'workshop', paused: state.open && state.compact });
  game.setPause({ reason: 'level-editor', paused: editing });
}

function perform(action: EditorAction, options: UiActionOptions = {}): void {
  if (action === 'debug') {
    debug = !debug;
    collisionOverlay.setMode(debug ? 'visible' : 'hidden');
    return;
  }
  if (action === 'reset') {
    resetPractice(practice);
    return;
  }
  if (action === 'play') {
    const startFromLevel = editing;
    const workshop = ui.workshopState();
    if (editing || workshop.compact) ui.closeWorkshop();
    if (startFromLevel) resetPractice('start');
  }
  game.perform(action, options);
}

const diagnostics = Object.freeze({
  snapshot: () => {
    const state = game.simulation.snapshot();
    const reasons = game.pauseState();
    return {
      ...state, practice, debug,
      parts: game.simulation.frame(1).parts.map((part) => ({
        ...part, vertices: part.vertices.map((point) => ({ ...point })),
      })),
      paused: reasons.length > 0, pauseReasons: reasons,
      pointerLocked: game.input.locked, inputMode: game.input.mode,
      camera: game.view.cameraState(), cursorScreen: game.view.project(state.cursor),
      step: PHYSICS.dt, stopped: game.halted,
    };
  },
  project: (point: Point) => game.view.project(point),
  appearance: () => appearance.snapshot(),
  level: () => ({
    definition: level.definition(),
    terrain: game.simulation.terrainState(),
    editor: levelEditor.snapshot(),
    rendering: game.view.statistics(),
  }),
});

declare global {
  interface Window {
    gettingOver?: typeof diagnostics;
  }
}
window.gettingOver = diagnostics;
updateWorkshop(ui.workshopState());
void appearance.restore();
game.start((state) => ui.update({ ...state, debug, practice }));

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    unsubscribeLevel();
    unsubscribeAppearance();
    unsubscribeOverlay();
    levelEditor.dispose();
    appearanceUi.dispose();
    appearance.dispose();
    ui.dispose();
    game.dispose();
    delete window.gettingOver;
  });
}
