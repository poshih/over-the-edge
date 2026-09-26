import '../game-shell.css';
import './game-ui.css';
import './style.css';
import { Vector3 } from 'three';
import { PHYSICS } from '../config';
import { SPRITE_TARGET_IDS } from '../character';
import type { Point, UiActionOptions } from '../config';
import { DEFAULT_LEVEL } from '../default-level';
import { Game } from '../game';
import { createCharacterModelLoader } from '../character-model-loader';
import { levelSpawn } from '../level';
import { Appearance } from './appearance';
import { AppearanceRig } from '../appearance-rig';
import { createAppearanceUI } from './appearance-ui';
import { VISUAL_PARTS } from './appearance-types';
import { CollisionOverlay } from './collision-overlay';
import { createLevelEditor } from './level-editor';
import { LevelState } from './level-state';
import { PRACTICES, practiceById } from './practices';
import { createUI } from './ui';
import { createSpriteEditor } from './sprite-editor';
import type { EditorAction, PracticeId, WorkshopState } from './ui-types';
import { AudioDirector } from '../audio';
import { DEFAULT_AUDIO } from '../audio-settings';
import { isDarkSky } from '../theme';
import { ProjectSession } from './project-session';
import { createProjectEditor } from './project-editor';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

const level = new LevelState(DEFAULT_LEVEL);
let debug = false;
let practice: PracticeId = 'start';
let editing = false;
// Media resolve through the open project, which is created once the editors exist.
let resolveMedia = (source: string): string => source;
let mediaVersion = 0;
const audio = new AudioDirector({
  settings: DEFAULT_AUDIO, resolve: (source) => resolveMedia(source), onError: (message) => ui.notice(message, 'error'),
});
const game = new Game({
  canvas, fatal, eventMount: mount, level: level.definition(),
  characterModels: createCharacterModelLoader(),
  resolveMedia: (source) => resolveMedia(source),
  onCue: (cue) => audio.handle(cue),
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
const appearanceUi = createAppearanceUI({ mount: ui.appearanceMount, appearance, onNotice: ui.notice });
const unsubscribeAppearance = appearance.subscribe(() => game.setCharacter({
  armIk: appearance.armIkSettings(),
}));
const spriteEditor = createSpriteEditor({
  mount: ui.spriteMount, characterMount: ui.characterMount, rig: game.view.sprites, onNotice: ui.notice,
  describeModel: (source, usage) => game.view.characterModelReport(source, usage),
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
const appearanceRestored = appearance.restore();
const project = new ProjectSession({
  workspace: {
    level: {
      get: () => level.definition(),
      load: (definition) => levelEditor.loadLevel(definition),
      sync: (definition) => levelEditor.syncLevel(definition),
      prepare: () => levelEditor.preparePlay(),
      markSaved: (definition) => levelEditor.markSaved(definition),
    },
    settings: { get: () => ui.settings(), load: (settings) => ui.applySettings(settings) },
    character: {
      draft: () => spriteEditor.snapshot().document,
      hasContent: () => spriteEditor.snapshot().hasContent,
      validated: () => spriteEditor.validatedDocument(),
      load: (document) => spriteEditor.loadDocument(document),
    },
    appearance: {
      armIk: () => appearance.armIkSettings(),
      loadArmIk: (settings) => appearance.previewArmIk(settings),
      parts: () => appearance.exportParts(),
      load: (parts) => appearance.replaceParts(parts),
    },
    ready: Promise.all([appearanceRestored, spriteEditor.ready]),
    onLook: (look) => {
      resolveMedia = look.resolveMedia;
      // Replaced or re-added files keep their paths, so drop sounds cached for the old files.
      if (look.mediaVersion !== mediaVersion) {
        mediaVersion = look.mediaVersion;
        audio.setResolver(look.resolveMedia);
      }
      game.setTheme(look.theme);
      ui.setSceneTone(isDarkSky(look.theme));
      game.setEnemyArt(look.enemies);
      ui.setHud(look.hud);
      audio.setSettings(look.audio);
    },
    notice: ui.notice,
  },
});
const projectEditor = createProjectEditor({
  mount: ui.projectMount, session: project, onNotice: ui.notice,
  onTestCue: (cue) => audio.handle({ type: 'cue', cue, strength: 1 }),
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
  gameProject: () => ({ ...project.snapshot(), playback: audio.inspect() }),
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
void project.start();
game.start((state) => {
  ui.update({ ...state, debug, practice });
  spriteEditor.updatePreview();
  audio.setPaused(state.paused);
});

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    projectEditor.dispose();
    project.dispose();
    audio.dispose();
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
