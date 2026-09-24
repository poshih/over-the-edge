import '../game-shell.css';
import './game-ui.css';
import './style.css';
import { Vector3 } from 'three';
import { PHYSICS } from '../config';
import { SPRITE_TARGET_IDS } from '../character';
import type { Point, UiActionOptions } from '../config';
import { DEFAULT_LEVEL } from '../default-level';
import { Game } from '../game';
import { levelSpawn } from '../level';
import { Appearance } from './appearance';
import { AppearanceRig } from './appearance-rig';
import { createAppearanceUI } from './appearance-ui';
import { VISUAL_PARTS } from './appearance-types';
import { CollisionOverlay } from './collision-overlay';
import { createLevelEditor } from './level-editor';
import { LevelState } from './level-state';
import { PRACTICES, practiceById } from './practices';
import { createUI } from './ui';
import { createSpriteEditor } from './sprite-editor';
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
  canvas, fatal, eventMount: mount, level: level.definition(),
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
  initialSettings: game.settings(),
  initialInputMode: game.input.mode,
  onAction: perform,
  onWorkshopChange: updateWorkshop,
  onPractice: resetPractice,
  onSettingsChange: (settings) => game.setSettings(settings),
});
const rig = new AppearanceRig(game.view.visuals);
const appearance = new Appearance(rig, ui.notice);
const appearanceUi = createAppearanceUI({
  mount: ui.appearanceMount, appearance,
  onDebug: () => perform('debug'), onNotice: ui.notice,
});
const unsubscribeAppearance = appearance.subscribe(() => game.setCharacter({
  armIk: appearance.armIkSettings(),
}));
const spriteEditor = createSpriteEditor({
  mount: ui.spriteMount, characterMount: ui.characterMount, rig: game.view.sprites, onNotice: ui.notice,
  viewport: { canvas, project: (point) => game.view.project(point) },
  targetIds: SPRITE_TARGET_IDS,
  anchors: VISUAL_PARTS.map(({ id, label }) => {
    const binding = game.view.visuals.get(id);
    if (!binding) throw new Error(`Missing sprite anchor: ${id}.`);
    const size = binding.bounds.getSize(new Vector3());
    const center = binding.bounds.getCenter(new Vector3());
    return { id, label, width: size.x, height: size.y, offset: { x: center.x, y: center.y, z: center.z } };
  }),
});
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
  spriteEditor.leavePreview();
  practice = id;
  game.reset(id === 'start' ? levelSpawn(level.definition()) : practiceById(id));
}

function updateWorkshop(state: WorkshopState): void {
  spriteEditor.setActive(state.open && state.tab === 'sprites');
  const nextEditing = state.open && state.tab === 'level';
  if (nextEditing !== editing) {
    editing = nextEditing;
    if (editing) game.simulation.restoreLevelObjects();
    game.setInputBlock({ reason: 'level-editor', blocked: editing });
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
    if (editing && !levelEditor.preparePlay()) return;
    spriteEditor.leavePreview();
    const startFromLevel = editing;
    const workshop = ui.workshopState();
    if (editing || workshop.compact) ui.closeWorkshop();
    if (startFromLevel) resetPractice('start');
  }
  if (action === 'pause' && game.pauseState().length > 0) spriteEditor.leavePreview();
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
      step: PHYSICS.dt, stopped: game.halted, timer: game.timerState(),
    };
  },
  project: (point: Point) => game.view.project(point),
  settings: () => game.settings(),
  appearance: () => appearance.snapshot(),
  sprites: () => ({ ...spriteEditor.snapshot(), rendering: game.view.sprites.inspect() }),
  events: () => game.eventState(),
  level: () => ({
    definition: level.definition(),
    terrain: game.simulation.terrainState(),
    enemies: game.simulation.enemyState(),
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
game.start((state) => {
  ui.update({ ...state, debug, practice });
  spriteEditor.updatePreview();
});

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    unsubscribeLevel();
    unsubscribeAppearance();
    unsubscribeOverlay();
    levelEditor.dispose();
    spriteEditor.dispose();
    appearanceUi.dispose();
    appearance.dispose();
    rig.dispose();
    ui.dispose();
    game.dispose();
    delete window.gettingOver;
  });
}
