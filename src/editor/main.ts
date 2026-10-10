import '../game-shell.css';
import './game-ui.css';
import './style.css';
import { Vector3 } from 'three';
import { SPRITE_TARGET_IDS } from '../character';
import type { PlayerSpawn, Point, UiActionOptions } from '../config';
import { DEFAULT_LEVEL } from '../default-course';
import { GameSettingsError, withRig } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { Game } from '../game';
import { Disposal } from '../disposal';
import { createCharacterModelLoader } from '../character-model-loader';
import { createCourseArt } from '../course-art-view';
import { createEnemyModels } from '../enemy-models';
import { levelSpawn, validateLevel } from '../level';
import { createPhantomPlayback } from '../phantom-playback';
import { Appearance } from './appearance';
import { AppearanceRig } from '../appearance-rig';
import { createAppearanceUI } from './appearance-ui';
import { VISUAL_PARTS } from './appearance-types';
import { CollisionOverlay } from './collision-overlay';
import { createLevelEditor } from './level-editor';
import { createLevelChecks } from './level-checks';
import { levelChange, LevelState } from './level-state';
import { createHistory } from './document/history';
import { createHistoryControls } from './history-controls';
import { PRACTICES, practiceById } from './practices';
import type { PracticeId } from './practices';
import { createUI } from './ui';
import { createSpriteEditor } from './sprite-editor';
import type { EditorAction, GameUi, HudState, WorkshopState } from './ui-types';
import { DEFAULT_AUDIO_OUTPUT } from '../audio';
import { AUDIO, createAudioOutput } from '../game-audio';
import { AudioDevice } from '../audio-device';
import { levelSoundSources } from '../content';
import { urlMediaHost } from '../media-host';
import { DEFAULT_AUDIO } from '../audio-settings';
import { isDarkSky } from '../theme';
import { ProjectClient } from './project-client';
import { ProjectSession } from './project-session';
import { createProjectEditor } from './project-editor';
import { createHammerHeadEditor } from './hammer-head-editor';
import type { HammerHeadEditor } from './hammer-head-editor';
import { createJarEditor } from './jar-editor';
import type { OutlineEditor } from './outline-editor';
import { PlayRecorder } from './play-recorder';
import { ServerCopies } from './server-copies';
import { publishedLevel } from './server-levels';
import { createDecorationView } from '../decoration-library';
import { gameDiagnostics, workshopGameState } from './game-state';
import { WorkshopPluginHost, workshopPlugins } from './workshop-plugin-host';
import publishedProject from 'virtual:workshop-project';
import folderLevels from 'virtual:workshop-levels';
import serverModels from 'virtual:workshop-models';
import kinds from 'virtual:game-plugins/kinds';
import runtimeFacets from 'virtual:game-plugins/runtime';
import { RuntimePlugins } from '../plugins/runtime';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const mount = document.querySelector<HTMLElement>('#interface');
const fatal = document.querySelector<HTMLElement>('#fatal-error');
if (!canvas || !mount || !fatal) throw new Error('The game canvas and interface mounts are required.');
const showFatal = (message: string): void => {
  fatal.hidden = false;
  fatal.textContent = message;
};

// Runtime facets start before the UI exists; their notices are explicitly buffered until it mounts.
const startupNotices: { message: string; kind: 'info' | 'error' }[] = [];
let runtimeNotice = (message: string, kind: 'info' | 'error' = 'info'): void => { startupNotices.push({ message, kind }); };
function startRuntime(): RuntimePlugins {
  try {
    return RuntimePlugins.start(runtimeFacets, { notice: (message, kind) => runtimeNotice(message, kind) });
  } catch (error) {
    showFatal(`The Workshop could not start: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
const runtimePlugins = startRuntime();
const avatarRigs = kinds.avatarRigs;
const cleanup: (() => void)[] = [() => runtimePlugins.dispose()];

function disposeWorkshop(): void {
  const disposal = new Disposal();
  while (cleanup.length > 0) disposal.run(cleanup.pop()!);
  disposal.finish();
}

function startupFailed(error: unknown): never {
  showFatal(`The Workshop could not start: ${error instanceof Error ? error.message : String(error)}`);
  try { disposeWorkshop(); } finally { throw error; }
}

// Consumer construction is also fatal: never keep a runtime session whose Game or HUD could not be built.
function boot<T>(create: () => T, discard?: (value: T) => void): T {
  try {
    const value = create();
    if (discard !== undefined) cleanup.push(() => discard(value));
    return value;
  } catch (error) {
    return startupFailed(error);
  }
}

// A Workshop built with GAME_PROJECT opens that game and keeps it, with its changes, in this
// browser's copy of the project; the editors' own browser saves do not open at start.
const opensProject = publishedProject !== null;
const client = new ProjectClient();
const history = boot(() => createHistory({ level: validateLevel(DEFAULT_LEVEL) }));
const level = boot(() => new LevelState(history.document), (value) => value.dispose());
let debug = false;
// Where attempts start: a starting point, or where the designer placed the player in the Level tab to
// test part of the course. Placing the player never moves the level's own start.
let origin: PracticeId | PlayerSpawn = 'start';
let editing = false;
// The game's Workshop plugins, which start once the project is open.
let plugins: WorkshopPluginHost | null = null;
// Media resolve through the open project once it starts.
let resolveMedia = (source: string): string => source;
let mediaVersion = 0;
// The Workshop plays media from the open project's files, or from the URLs a level names.
const media = urlMediaHost((source) => resolveMedia(source));
const audioDevice = boot(() => new AudioDevice(DEFAULT_AUDIO.volume), (value) => value.dispose());
const audio = boot(() => createAudioOutput(runtimePlugins.slot(AUDIO, DEFAULT_AUDIO_OUTPUT), {
  settings: DEFAULT_AUDIO, media, sounds: levelSoundSources(level.definition()), device: audioDevice,
  notice: (message) => runtimeNotice(message, 'error'),
}), (value) => value.dispose());
const game = boot(() => new Game({
  canvas, eventMount: mount, level: level.definition(),
  onFatal: showFatal,
  characterModels: createCharacterModelLoader(),
  decorations: createDecorationView,
  // The course draws the project's GLBs, as its releases draw them, each loaded from the project as the level uses it.
  courseArt: { create: createCourseArt, fetch: (id) => project.courseMeshBlob(id) },
  // Enemies draw their project models as releases draw them, each GLB loaded from the project once a species uses it.
  enemyModels: { create: createEnemyModels, fetch: (id) => project.courseMeshBlob(id) },
  media,
  // The Workshop never plays trigger videos: each is skipped at once and its trigger goes on, so testing
  // is never interrupted. Releases play them.
  videos: 'skip',
  kinds, plugins: runtimePlugins,
  audio,
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
}), (value) => value.dispose());
boot(() => history.document.subscribe('level', (change) => {
  game.applyLevel(levelChange(change));
  if (change.delta.kind === 'replace') origin = 'start';
}), (unsubscribe) => unsubscribe());
// Registered before the UI exists; bootstrap changes the document only after the editors mount.
boot(() => history.document.subscribe('level', (change) => ui.setLevelName(change.after.name)),
  (unsubscribe) => unsubscribe());
// The Level tab's checks, which read the game settings and the project only while it is edited.
const levelChecks = boot(() => createLevelChecks({
  document: history.document,
  settings: () => game.settings(),
  plugins: {
    checks: () => workshopPlugins.levelChecks(),
    reach: () => workshopPlugins.levelReach(),
    failed: (id) => workshopPlugins.failed(id),
    lastError: (id) => workshopPlugins.lastError(id),
    fail: (id, error, action) => workshopPlugins.fail(id, error, action),
    subscribe: (listener) => workshopPlugins.subscribe(() => listener()),
    project: () => plugins?.projectSnapshot() ?? null,
  },
}), (value) => value.dispose());
// The open project, created before the editors so each can save into it; it reads them only once started.
const project: ProjectSession = boot(() => new ProjectSession({
  history, level, avatarRigs, client, plugins: workshopPlugins,
  workspace: {
    prepareLevel: () => levelEditor.preparePlay(),
    markLevelSaved: (definition) => levelEditor.markSaved(definition),
    hasPendingLevelEdits: () => levelEditor.hasPendingEdits(),
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
      game.setLook(look.game);
      audioDevice.setVolume(look.audio.volume);
      audio.setSettings(look.audio);
    },
    notice: (message, kind) => ui.notice(message, kind),
  },
  published: publishedProject,
}), (value) => value.dispose());
// The level places only decorations something draws: the library's models and those the project's course artwork maps.
level.drawDecorationsWith(() => project.decorationArt());
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
const recorder = boot(() => new PlayRecorder({
  game, enabled: recordingPreference(),
  target: () => project.playedVersion(),
  upload: (target, clip, recording) => client.postPhantom(target.project, target.version, clip, recording),
  onFailure: (error) => ui.notice(`Play recordings are not being saved: ${error instanceof Error ? error.message : String(error)}`, 'error'),
}), (value) => value.dispose());
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
const serverCopies = boot(() => new ServerCopies({
  client, health: () => project.serverHealth(), watch: (listener) => project.subscribe(listener),
}), (value) => value.dispose());
const published = boot(() => publishedLevel(publishedProject));
const ui: GameUi = boot(() => createUI({
  mount,
  plugins: runtimePlugins,
  readStatus: () => game.simulation.status(),
  initialSettings: game.settings(),
  initialInputMode: game.input.mode,
  onAction: perform,
  onWorkshopChange: updateWorkshop,
  onPractice: resetPractice,
  onSettingsChange: (settings) => {
    game.setSettings(settings);
    spriteEditor.setHammerRig(game.simulation.rigGeometry);
    hammerHeads?.refresh();
    jarEditor?.refresh();
    plugins?.settingsChanged();
    // The reach model comes from the rig and grip.
    levelChecks.invalidate();
  },
  projectSave: project, serverCopies,
}), (value) => value.dispose());
runtimeNotice = (message, kind = 'info') => ui.notice(message, kind);
// The readout shows the HUD as the game's look sets it, and the header keeps legible over its sky.
boot(() => game.subscribeLook((look) => {
  ui.setHud(look.hud);
  ui.setSceneTone(isDarkSky(look.theme));
}), (unsubscribe) => unsubscribe());
for (const { message, kind } of startupNotices.splice(0)) ui.notice(message, kind);
// The game header names the open level, following each rename and each level opened.
ui.setLevelName(level.definition().name);
const rig = boot(() => new AppearanceRig(game.view.character.visuals), (value) => value.dispose());
const appearance = boot(() => new Appearance(rig, ui.notice, { browserStore: !opensProject }), (value) => value.dispose());
boot(() => createAppearanceUI({ mount: ui.appearanceMount, appearance, onNotice: ui.notice, projectSave: project, serverCopies }),
  (value) => value.dispose());
boot(() => appearance.subscribe(() => game.setCharacter({
  armIk: appearance.armIkSettings(),
})), (unsubscribe) => unsubscribe());
const spriteEditor = boot(() => createSpriteEditor({
  mount: ui.spriteMount, characterMount: ui.characterMount, rig: game.view.character.sprites, onNotice: ui.notice,
  describeModel: (source, usage) => game.view.character.characterModelReport(source, usage),
  viewport: { canvas, project: (point) => game.view.project(point) },
  targetIds: SPRITE_TARGET_IDS,
  hammerRig: game.simulation.rigGeometry,
  naturalArms: () => game.view.character.naturalArmLengths(),
  serverModels,
  // The Character tab's handle length edits the same game setting as Physics.
  onHandleLength: (handleLength) => {
    applySettings(() => {
      const settings = ui.settings();
      return withRig(settings, { ...settings.rig, handleLength });
    });
  },
  applySavedProfile: !opensProject,
  projectSave: project, serverCopies,
  motion: {
    kinds: avatarRigs.motionIds, controls: () => workshopPlugins.motionControls(),
    subscribe: (listener) => workshopPlugins.subscribe(() => listener()),
    preview: (kind) => game.view.character.previewMotion(kind),
  },
  anchors: VISUAL_PARTS.map(({ id, label }) => {
    const binding = game.view.character.visuals.get(id);
    if (!binding) throw new Error(`Missing sprite anchor: ${id}.`);
    const size = binding.bounds.getSize(new Vector3());
    const center = binding.bounds.getCenter(new Vector3());
    return { id, label, width: size.x, height: size.y, offset: { x: center.x, y: center.y, z: center.z } };
  }),
}), (value) => value.dispose());
const collisionOverlay = boot(() => {
  const overlay = new CollisionOverlay(game.simulation.world, () => game.view.character.armPoses());
  game.view.addLayer(overlay);
  return overlay;
}, (value) => game.view.removeLayer(value));
const courseMeshes = boot(() => {
  if (game.view.courseArt === null) throw new Error('The Workshop draws course artwork.');
  return game.view.courseArt;
});
// The figure Level / Replays poses: one held phantom, none played by the game.
const replayFigure = boot(() => createPhantomPlayback(game.view, runtimePlugins, 0), (value) => game.view.removeLayer(value));
const decorations = boot(() => {
  if (game.view.decorations === null) throw new Error('The Workshop draws decorations.');
  return game.view.decorations;
});
const levelEditor = boot(() => createLevelEditor({
  mount: ui.levelMount, canvas, history, level,
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
    models: () => project.decorationModels(),
    subscribe: (listener) => {
      const unsubscribeView = decorations.subscribe(listener);
      const unsubscribeProject = project.subscribe((event) => { if (event.kind === 'content') listener(); });
      return () => { unsubscribeView(); unsubscribeProject(); };
    },
    show: (shown) => decorations.setShown(shown),
  },
  meshes: {
    list: () => project.courseMeshes(),
    terrain: (id, turn) => project.courseMeshTerrain(id, turn),
    preview: (turns) => courseMeshes.previewTurns(turns),
    add: (file) => project.addCourseMesh(file),
    subscribe: (listener) => project.subscribe((event) => { if (event.kind === 'content') listener(); }),
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
  checks: levelChecks,
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
}), (value) => value.dispose());
const appearanceRestored = boot(() => appearance.restore());
// Physics / Hammer head shapes the default hammer's head, a game setting, and each library hammer's own.
let hammerHeads: HammerHeadEditor | null = null;
hammerHeads = boot(() => createHammerHeadEditor({
  mount: ui.hammerHeadMount,
  hammers: () => [
    // The game's settings, which are current while a settings change is still being shown.
    { id: null, name: 'Default hammer', head: game.settings().rig.head },
    ...project.libraryHammers(),
  ],
  setHead: (id, head) => {
    if (id !== null) return project.setLibraryHammerHead(id, head) === null;
    return applySettings(() => {
      const settings = game.settings();
      return withRig(settings, { ...settings.rig, head });
    }) === null;
  },
}), (value) => value.dispose());
boot(() => project.subscribe((event) => { if (event.kind === 'content') hammerHeads?.refresh(); }),
  (unsubscribe) => unsubscribe());
// Physics / Jar shapes the jar's collision outline, a game setting.
let jarEditor: OutlineEditor | null = null;
jarEditor = boot(() => createJarEditor({
  mount: ui.jarMount,
  pot: () => game.settings().rig.pot,
  setPot: (pot) => applySettings(() => {
    const settings = game.settings();
    return withRig(settings, { ...settings.rig, pot });
  }) === null,
}), (value) => value.dispose());
boot(() => createProjectEditor({
  mount: ui.projectMount, session: project, onNotice: ui.notice,
  onTestCue: (cue) => audio.preview(cue),
  parts: game,
  serverModels,
}), (value) => value.dispose());
boot(() => createHistoryControls({
  history,
  mount: ui.historyMount,
  workshop: ui.workshopState,
  tabLabel: ui.tabLabel,
  tabPane: ui.tabPane,
  notice: ui.notice,
}), (value) => value.dispose());

// Applies the game settings `next` builds, as Physics does: a refusal is reported and returned.
function applySettings(next: () => GameSettings): GameSettingsError | null {
  try {
    ui.applySettings(next());
    return null;
  } catch (error) {
    if (!(error instanceof GameSettingsError)) throw error;
    ui.notice(error.message, 'error');
    return error;
  }
}

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
  plugins?.setWorkshop(state);
  spriteEditor.setActive(state.open && state.tab === 'sprites');
  const nextEditing = state.open && state.tab === 'level';
  if (nextEditing !== editing) {
    editing = nextEditing;
    if (editing) {
      if (game.dying) restart();
      else game.simulation.restoreLevelObjects();
    }
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

const gameContext = () => ({ practice: practice(), placedPlayer: typeof origin === 'string' ? null : origin, debug });
const gameState = () => workshopGameState(game, gameContext());

plugins = boot(() => new WorkshopPluginHost({
  registry: workshopPlugins, ui, game, canvas, project, history, level, character: spriteEditor, appearance,
  settings: (settings) => applySettings(() => settings),
  control: { restart, placePlayer, state: gameState },
  notice: ui.notice,
}), (value) => value.dispose());

const rendering = () => game.view.statistics();
const diagnostics = Object.freeze({
  rendering,
  measurements: Object.freeze({
    start: (label: string): void => game.view.measurements.start(label),
    stop: (): void => game.view.measurements.stop(),
    samples: (): number[] => game.view.measurements.samples(),
  }),
  snapshot: () => gameDiagnostics(game, gameContext()),
  project: (point: Point) => game.view.project(point),
  settings: () => game.settings(),
  history: () => history.state(),
  appearance: () => appearance.snapshot(),
  sprites: () => ({ ...spriteEditor.snapshot(), rendering: game.view.character.sprites.inspect() }),
  events: () => game.eventState(),
  gameProject: () => ({ ...project.snapshot(), playback: audio.inspect() ?? null, parts: game.view.character.partModels() }),
  plugins: () => plugins.inspect(),
  level: () => ({
    definition: level.definition(),
    terrain: game.simulation.terrainState(),
    enemies: game.simulation.enemyState(),
    editor: levelEditor.snapshot(),
    rendering: rendering(),
  }),
});

declare global {
  interface Window {
    gettingOver?: typeof diagnostics;
  }
}
window.gettingOver = diagnostics;
cleanup.push(() => { delete window.gettingOver; });
boot(() => updateWorkshop(ui.workshopState()));
void project.start().then(() => plugins.start()).catch((error: unknown) => startupFailed(error));
const hudState: HudState = { debug, practice: practice(), recording: recorder.on, capturing: false, recordingNote: recordingNote() };
boot(() => game.start((state) => {
  hudState.debug = debug;
  hudState.practice = practice();
  hudState.recording = recorder.on;
  hudState.capturing = recorder.recording && !state.paused;
  hudState.recordingNote = recordingNote();
  ui.update(state, hudState);
  spriteEditor.updatePreview();
}));

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(disposeWorkshop);
}
