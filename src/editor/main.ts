import '../game-shell.css';
import './game-ui.css';
import './style.css';
import { Vector3 } from 'three';
import { PHYSICS } from '../config';
import { SPRITE_TARGET_IDS } from '../character';
import type { PlayerSpawn, Point, UiActionOptions } from '../config';
import { DEFAULT_LEVEL } from '../default-level';
import { GameSettingsError, withRig } from '../game-settings';
import { Game } from '../game';
import { createCharacterModelLoader } from '../character-model-loader';
import { levelSpawn } from '../level';
import { PhantomView } from '../phantom-view';
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
import { urlMediaHost } from '../media-host';
import { DEFAULT_AUDIO } from '../audio-settings';
import { isDarkSky } from '../theme';
import { ProjectClient } from './project-client';
import { ProjectSession } from './project-session';
import { createProjectEditor } from './project-editor';
import { createHammerHeadEditor } from './hammer-head-editor';
import type { HammerHeadEditor } from './hammer-head-editor';
import { PlayRecorder } from './play-recorder';
import { ServerCopies } from './server-copies';
import { publishedLevel } from './server-levels';
import { createDecorationView } from '../decoration-library';
import publishedProject from 'virtual:workshop-project';
import folderLevels from 'virtual:workshop-levels';
import serverModels from 'virtual:workshop-models';
import avatarRigs from 'virtual:avatar-rigs';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');

// A Workshop built with GAME_PROJECT opens that game and keeps it, with its changes, in this
// browser's copy of the project; the editors' own browser saves do not open at start.
const opensProject = publishedProject !== null;
const client = new ProjectClient();
const level = new LevelState(DEFAULT_LEVEL);
let debug = false;
// Where attempts start: a starting point, or where the designer placed the player in the Level tab to
// test part of the course. Placing the player never moves the level's own start.
let origin: PracticeId | PlayerSpawn = 'start';
let editing = false;
// Media resolve through the open project once it starts.
let resolveMedia = (source: string): string => source;
let mediaVersion = 0;
// The Workshop plays media from the open project's files, or from the URLs a level names.
const media = urlMediaHost((source) => resolveMedia(source));
const audio = new AudioDirector({
  settings: DEFAULT_AUDIO, media, onError: (message) => ui.notice(message, 'error'),
});
const game = new Game({
  canvas, fatal, eventMount: mount, level: level.definition(),
  characterModels: createCharacterModelLoader(),
  decorations: createDecorationView,
  media,
  // The Workshop never plays trigger videos: each is skipped at once and its trigger goes on, so testing
  // is never interrupted. Releases play them.
  videos: 'skip',
  avatarRigs,
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
  if (change.kind === 'replace') origin = 'start';
});
// The open project, created before the editors so each can save into it; it reads them only once started.
const project = new ProjectSession({
  avatarRigs, client,
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
      load: (document, options) => spriteEditor.loadDocument(document, options),
    },
    appearance: {
      armIk: () => appearance.armIkSettings(),
      loadArmIk: (settings) => appearance.previewArmIk(settings),
      parts: () => appearance.exportParts(),
      load: (parts) => appearance.replaceParts(parts),
    },
    get ready() { return Promise.all([appearanceRestored, spriteEditor.ready]); },
    onLook: (look) => {
      resolveMedia = look.resolveMedia;
      // Replaced or re-added files keep their paths, so drop sounds cached for the old files.
      if (look.mediaVersion !== mediaVersion) {
        mediaVersion = look.mediaVersion;
        audio.setMedia(urlMediaHost(look.resolveMedia));
      }
      game.setTheme(look.theme);
      ui.setSceneTone(isDarkSky(look.theme));
      game.setEnemyArt(look.enemies);
      ui.setHud(look.hud);
      game.setMessageStyle(look.hud.messages.style);
      audio.setSettings(look.audio);
    },
    notice: (message, kind) => ui.notice(message, kind),
  },
  published: publishedProject,
});
// Play is recorded for phantoms unless this browser turned recording off.
const RECORDING_KEY = 'over-the-edge:workshop:recording';
function recordingPreference(): boolean {
  try {
    return localStorage.getItem(RECORDING_KEY) !== 'off';
  } catch (error) {
    if (error instanceof DOMException) return true;
    throw error;
  }
}
const recorder = new PlayRecorder({
  game, enabled: recordingPreference(),
  target: () => project.playedVersion(),
  upload: (target, clip, recording) => client.postPhantom(target.project, target.version, clip, recording),
  onFailure: (error) => ui.notice(`Play recordings are not being saved: ${error instanceof Error ? error.message : String(error)}`, 'error'),
});
function toggleRecording(): void {
  recorder.setEnabled(!recorder.on);
  try {
    localStorage.setItem(RECORDING_KEY, recorder.on ? 'on' : 'off');
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}
// What Record does now, for its tip.
function recordingNote(): string {
  if (!recorder.on) return 'Record your play as phantoms of the open project\'s level. Off in this browser.';
  if (project.openProject() === null) return 'Recording waits for a server project: open or save one in Project.';
  if (project.playedVersion() === null) return 'Recording waits for the level and game settings to save, a moment after each change.';
  return 'Recording your play as phantoms of the saved version of the open project\'s level and game settings.';
}
const serverCopies = new ServerCopies({
  client, health: () => project.serverHealth(), watch: (listener) => project.subscribe(listener),
});
const published = publishedLevel(publishedProject);
const ui = createUI({
  mount,
  initialSettings: game.settings(),
  initialInputMode: game.input.mode,
  onAction: perform,
  onWorkshopChange: updateWorkshop,
  onPractice: resetPractice,
  onSettingsChange: (settings) => {
    game.setSettings(settings);
    spriteEditor.setHammerRig(game.simulation.rigGeometry);
    hammerHeads?.refresh();
  },
  projectSave: project, serverCopies,
});
const rig = new AppearanceRig(game.view.visuals);
const appearance = new Appearance(rig, ui.notice, { browserStore: !opensProject });
const appearanceUi = createAppearanceUI({ mount: ui.appearanceMount, appearance, onNotice: ui.notice, projectSave: project, serverCopies });
const unsubscribeAppearance = appearance.subscribe(() => game.setCharacter({
  armIk: appearance.armIkSettings(),
}));
const spriteEditor = createSpriteEditor({
  mount: ui.spriteMount, characterMount: ui.characterMount, rig: game.view.sprites, onNotice: ui.notice,
  describeModel: (source, usage) => game.view.characterModelReport(source, usage),
  viewport: { canvas, project: (point) => game.view.project(point) },
  targetIds: SPRITE_TARGET_IDS,
  hammerRig: game.simulation.rigGeometry,
  naturalArms: () => game.view.naturalArmLengths(),
  serverModels,
  // The Character tab's handle length edits the same game setting as Physics.
  onHandleLength: (handleLength) => {
    const settings = ui.settings();
    try {
      ui.applySettings(withRig(settings, { ...settings.rig, handleLength }));
    } catch (error) {
      if (!(error instanceof GameSettingsError)) throw error;
      ui.notice(error.message, 'error');
    }
  },
  applySavedProfile: !opensProject,
  projectSave: project, serverCopies,
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
// The figure Level / Replays poses: one held phantom, none played by the game.
const replayFigure = new PhantomView({ figures: 0 });
game.view.addLayer(replayFigure);
const unsubscribeOverlay = game.simulation.subscribeTerrain((event) => collisionOverlay.apply(event));
const decorations = game.view.decorations;
if (decorations === null) throw new Error('The Workshop draws decorations.');
const levelEditor = createLevelEditor({
  mount: ui.levelMount, canvas, level,
  camera: {
    state: () => game.view.cameraState(),
    set: (framing) => game.view.setFraming(framing),
    project: (point) => game.view.project(point),
    unproject: (point) => game.view.unproject(point),
    projectDepth: (point, z) => game.view.projectDepth(point, z),
    unprojectDepth: (point, z) => game.view.unprojectDepth(point, z),
  },
  decorations: {
    size: (model) => decorations.size(model),
    preview: (object) => decorations.setPreview(object),
  },
  onPlay: () => perform('play'),
  player: {
    place: placePlayer,
    clear: () => resetPractice('start'),
    placed: () => typeof origin !== 'string',
  },
  onNotice: ui.notice,
  warnBeforeUnload: !opensProject,
  serverLevels: published === null ? folderLevels : [published, ...folderLevels],
  projectSave: project,
  replays: {
    figure: replayFigure,
    source: {
      project: () => project.openProject(),
      played: () => project.playedVersion(),
      subscribe: (listener) => project.subscribe(listener),
      versions: (id) => client.levelVersions(id),
      recordings: (id, version) => client.phantoms(id, version),
      recording: (id, version, name, signal) => client.phantom(id, version, name, signal),
    },
  },
});
const appearanceRestored = appearance.restore();
// Physics / Hammer head shapes the default hammer's head, a game setting, and each library hammer's own.
let hammerHeads: HammerHeadEditor | null = null;
hammerHeads = createHammerHeadEditor({
  mount: ui.hammerHeadMount,
  hammers: () => [
    // The game's settings, which are current while a settings change is still being shown.
    { id: null, name: 'Default hammer', head: game.settings().rig.head },
    ...project.libraryHammers(),
  ],
  setHead: (id, head) => {
    if (id !== null) return project.setLibraryHammerHead(id, head);
    const settings = game.settings();
    try {
      ui.applySettings(withRig(settings, { ...settings.rig, head }));
      return true;
    } catch (error) {
      if (!(error instanceof GameSettingsError)) throw error;
      ui.notice(error.message, 'error');
      return false;
    }
  },
});
const unsubscribeHammerHeads = project.subscribe((event) => { if (event.kind === 'content') hammerHeads?.refresh(); });
const projectEditor = createProjectEditor({
  mount: ui.projectMount, session: project, onNotice: ui.notice,
  onTestCue: (cue) => audio.handle({ type: 'cue', cue, strength: 1 }),
  parts: game,
  serverModels,
});

function resetPractice(id: PracticeId): void {
  spriteEditor.leavePreview();
  origin = id;
  game.reset(id === 'start' ? levelSpawn(level.definition()) : practiceById(id));
}

// Moves the player to `position`, the pot's centre, in the start's pose, and starts attempts there.
function placePlayer(position: Point): void {
  const { angle, reach } = levelSpawn(level.definition());
  spriteEditor.leavePreview();
  origin = { position: { x: position.x, y: position.y }, angle, reach };
  game.reset(origin);
}

function restart(): void {
  if (typeof origin === 'string') resetPractice(origin);
  else {
    spriteEditor.leavePreview();
    game.reset(origin);
  }
}

const practice = (): PracticeId | null => typeof origin === 'string' ? origin : null;

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
  if (action === 'record') {
    toggleRecording();
    return;
  }
  if (action === 'reset') {
    restart();
    return;
  }
  if (action === 'play') {
    if (editing && !levelEditor.preparePlay()) return;
    spriteEditor.leavePreview();
    const playtest = editing;
    const workshop = ui.workshopState();
    if (editing || workshop.compact) ui.closeWorkshop();
    // A playtest starts at the level's start, or where the designer placed the player.
    if (playtest) {
      if (typeof origin === 'string') resetPractice('start');
      else restart();
    }
  }
  if (action === 'pause' && game.pauseState().length > 0) spriteEditor.leavePreview();
  game.perform(action, options);
}

const diagnostics = Object.freeze({
  snapshot: () => {
    const state = game.simulation.snapshot();
    const reasons = game.pauseState();
    return {
      ...state, practice: practice(), placedPlayer: typeof origin === 'string' ? null : origin, debug,
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
  gameProject: () => ({ ...project.snapshot(), playback: audio.inspect(), parts: game.view.partModels() }),
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
  ui.update({
    ...state, debug, practice: practice(),
    recording: recorder.on, capturing: recorder.recording && !state.paused, recordingNote: recordingNote(),
  });
  spriteEditor.updatePreview();
  audio.setPaused(state.paused);
});

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    recorder.dispose();
    unsubscribeHammerHeads();
    hammerHeads.dispose();
    projectEditor.dispose();
    serverCopies.dispose();
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
