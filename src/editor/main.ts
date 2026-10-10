import '../game-shell.css';
import './game-ui.css';
import './style.css';
import { Vector3 } from 'three';
import { SPRITE_TARGET_IDS } from '../character';
import type { PlayerSpawn, Point, UiActionOptions } from '../config';
import { DEFAULT_COURSE_ART, DEFAULT_LEVEL } from '../default-course';
import { DEFAULT_ENEMY_ART } from '../enemy-art-data';
import { DEFAULT_GAME_SETTINGS } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { Game } from '../game';
import { Disposal } from '../disposal';
import { DEFAULT_HUD } from '../hud';
import { createCharacterModelLoader } from '../character-model-loader';
import { createCourseArt } from '../course-art-view';
import { createEnemyModels } from '../enemy-models';
import { levelSpawn, validateLevel } from '../level';
import type { AvatarHoldSettings } from '../model-library';
import { createPhantomPlayback } from '../phantom-playback';
import { artFile } from '../project';
import { Appearance } from './appearance';
import { AppearanceRig } from '../appearance-rig';
import { createAppearanceUI } from './appearance-ui';
import { VISUAL_PARTS } from './appearance-types';
import { CollisionOverlay } from './collision-overlay';
import { DEFAULT_COURSE_FILES } from './default-course-files';
import { createLevelEditor } from './level-editor';
import { createLevelChecks } from './level-checks';
import { levelChange, LevelState } from './level-state';
import { createProjectFileRetention } from './document/file-retention';
import { createFileStore } from './document/files';
import type { FileStore } from './document/files';
import { createHistory } from './document/history';
import { createProjectCommands, UNTITLED_GAME_TITLE } from './document/project-commands';
import type { SectionName, SectionValues } from './document/project-document';
import { createProjectImports } from './document/project-imports';
import { createProjectProjection } from './document/project-projection';
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
import { DEFAULT_THEME, isDarkSky } from '../theme';
import { ProjectClient } from './project-client';
import { ProjectSession } from './project-session';
import { createProjectEditor } from './project-editor';
import { createHammerHeadEditor } from './hammer-head-editor';
import { createJarEditor } from './jar-editor';
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

// The page starts on a new game: the default settings and look, and the built-in course with its artwork, whose GLBs
// stay on the site until the course draws them.
function newGame(files: FileStore): SectionValues {
  const meshes = new Map(DEFAULT_COURSE_FILES.map((file) => [file.path, file]));
  const assets = DEFAULT_COURSE_ART.assets.map(({ id, name }) => {
    const mesh = meshes.get(artFile(id));
    if (mesh === undefined) throw new Error(`This Workshop is missing the built-in course mesh ${id}.`);
    return Object.freeze({ id, name, file: files.registerPublished(mesh) });
  });
  return {
    title: UNTITLED_GAME_TITLE, level: validateLevel(DEFAULT_LEVEL), settings: DEFAULT_GAME_SETTINGS, theme: DEFAULT_THEME,
    hud: DEFAULT_HUD, audio: DEFAULT_AUDIO, enemies: DEFAULT_ENEMY_ART,
    art: Object.freeze({ assets: Object.freeze(assets), decorations: DEFAULT_COURSE_ART.decorations }),
    media: Object.freeze([]),
    models: Object.freeze({ avatar: Object.freeze([]), hammer: Object.freeze([]), pot: Object.freeze([]) }),
    'characters/alternate': null,
  };
}

// A Workshop built with GAME_PROJECT opens that game and keeps it, with its changes, in this
// browser's copy of the project; the editors' own browser saves do not open at start.
const opensProject = publishedProject !== null;
const client = new ProjectClient();
// The open project's files, wherever their bytes are, and its document, which only its history changes.
const files = boot(() => createFileStore({ client }), (value) => value.dispose());
const history = boot(() => createHistory(newGame(files), { files }), (value) => value.dispose());
// The level's first listener, so every other one finds its indexes current.
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
const audioDevice = boot(() => new AudioDevice(history.document.get('audio').volume), (value) => value.dispose());
const audio = boot(() => createAudioOutput(runtimePlugins.slot(AUDIO, DEFAULT_AUDIO_OUTPUT), {
  settings: history.document.get('audio'), media, sounds: levelSoundSources(level.definition()), device: audioDevice,
  notice: (message) => runtimeNotice(message, 'error'),
}), (value) => value.dispose());
const game = boot(() => new Game({
  canvas, eventMount: mount, level: level.definition(), settings: history.document.get('settings'),
  onFatal: showFatal,
  characterModels: createCharacterModelLoader(),
  decorations: createDecorationView,
  // The course draws the project's GLBs, as its releases draw them, each loaded from the project as the level uses it.
  courseArt: { create: createCourseArt, fetch: (id, signal) => projection.courseMeshBlob(id, signal) },
  // Enemies draw their project models as releases draw them, each GLB loaded from the project once a species uses it.
  enemyModels: { create: createEnemyModels, fetch: (id, signal) => projection.courseMeshBlob(id, signal) },
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
// The look, media, library and course resources the document's sections make. It hears each change before the game's
// follower below, so the game has new course artwork before a level that draws it.
const projection = boot(() => createProjectProjection({
  document: history.document, files,
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
}), (value) => value.dispose());
// The game follows the document: the level by the objects each change touched, then the settings, once per change.
boot(() => history.document.subscribeAll((changes) => {
  let settings: GameSettings | null = null;
  for (const change of changes) {
    if (change.section === 'level') game.applyLevel(levelChange(change));
    else if (change.section === 'settings') settings = change.after;
  }
  if (settings === null) return;
  game.setSettings(settings);
  // Character's handle length and grips follow the rig.
  spriteEditor.setHammerRig(game.simulation.rigGeometry);
}), (unsubscribe) => unsubscribe());
// A level replaced whole is played from its start. Heard before the Level tab, which shows where play starts.
boot(() => history.document.subscribe('level', (change) => {
  if (change.delta.kind === 'replace') origin = 'start';
}), (unsubscribe) => unsubscribe());
// Registered before the UI exists; bootstrap changes the document only after the editors mount.
boot(() => history.document.subscribe('level', (change) => ui.setLevelName(change.after.name)),
  (unsubscribe) => unsubscribe());
// The Level tab's checks, which read the game settings and the project only while it is edited.
const levelChecks = boot(() => createLevelChecks({
  document: history.document,
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
// Every edit of a project section is one of these commands, which the history applies; edits that wait for a file or a
// bake are imports, each a pending edit until it is ready.
const commands = boot(() => createProjectCommands({
  document: history.document, level, files, plugins: workshopPlugins, avatarRigs,
  primary: () => spriteEditor.validatedDocument(),
  levelSelection: () => levelEditor.selection(),
}));
const imports = boot(() => createProjectImports({
  history, commands, files, projection, avatarRigs, holdSettings,
  prepareLevel: () => levelEditor.preparePlay(),
}), (value) => value.dispose());
// The page keeps the bytes of every file Undo can still bring back before a save deletes them from the server.
const retention = boot(() => createProjectFileRetention({ files }), (value) => value.dispose());
// The open project, created before the editors so each can save into it; it reads them only once started.
const project: ProjectSession = boot(() => new ProjectSession({
  history, level, files, retention, commands, imports, projection, avatarRigs, client, plugins: workshopPlugins,
  workspace: {
    prepareLevel: () => levelEditor.preparePlay(),
    markLevelSaved: (definition) => levelEditor.markSaved(definition),
    hasPendingLevelEdits: () => levelEditor.hasPendingEdits(),
    character: {
      draft: () => spriteEditor.snapshot().document,
      hasContent: () => spriteEditor.snapshot().hasContent,
      validated: () => spriteEditor.validatedDocument(),
      load: (document, options) => spriteEditor.loadDocument(document, options),
      prepare: (document, options) => spriteEditor.prepareDocument(document, options),
    },
    appearance: {
      armIk: () => appearance.armIkSettings(),
      loadArmIk: (settings) => appearance.previewArmIk(settings),
      parts: () => appearance.exportParts(),
      load: (parts) => appearance.replaceParts(parts),
    },
    get ready() { return Promise.all([appearanceRestored, spriteEditor.ready]); },
    notice: (message, kind) => ui.notice(message, kind),
  },
  published: publishedProject,
}), (value) => value.dispose());
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
  history, commands, imports,
  readStatus: () => game.simulation.status(),
  initialInputMode: game.input.mode,
  onAction: perform,
  onWorkshopChange: updateWorkshop,
  onPractice: resetPractice,
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
  settingsEditing: { history, commands },
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
    models: () => projection.decorationModels(),
    subscribe: (listener) => {
      const unsubscribeView = decorations.subscribe(listener);
      const unsubscribeArt = followSections(['art'], listener);
      return () => { unsubscribeView(); unsubscribeArt(); };
    },
    show: (shown) => decorations.setShown(shown),
  },
  meshes: {
    list: () => projection.courseMeshes(),
    // The Level tab drops a turn whose bake is refused; the refusal is reported here.
    terrain: async (id, turn) => {
      const terrain = await projection.courseMeshTerrain(id, turn);
      if (terrain instanceof Error) ui.notice(terrain.message, 'error');
      return terrain;
    },
    preview: (turns) => courseMeshes.previewTurns(turns),
    add: (file, signal) => imports.courseMesh(file, {
      info: {
        label: `Import mesh ${file.name.replace(/\.glb$/i, '')}`,
        place: { tab: 'level', section: 'level-build', select: null }, coalesce: null,
      },
      signal,
    }),
    // Course artwork drawing an enemy is not a course mesh.
    subscribe: (listener) => followSections(['art', 'enemies'], listener),
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
boot(() => createHammerHeadEditor({ mount: ui.hammerHeadMount, history, commands, projection }),
  (value) => value.dispose());
// Physics / Jar shapes the jar's collision outline, a game setting.
boot(() => createJarEditor({ mount: ui.jarMount, history, commands }), (value) => value.dispose());
boot(() => createProjectEditor({
  mount: ui.projectMount, session: project, history, commands, imports, projection, onNotice: ui.notice,
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

// The open character's grips, arm lengths and arm forward distance, which a library avatar takes; the character keeps
// its own draft until it joins the document.
function holdSettings(): AvatarHoldSettings {
  const { armForwardDistance, grips, arms } = spriteEditor.snapshot().document;
  return { armForwardDistance, grips, arms };
}

// Tells `listener` once per document change touching `sections`, after every section's own listeners, so the level's
// indexes are current whatever else the change touched.
function followSections(sections: readonly SectionName[], listener: () => void): () => void {
  return history.document.subscribeAll((changes) => {
    if (changes.some((change) => sections.includes(change.section))) listener();
  });
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
  registry: workshopPlugins, ui, game, canvas, history, level, commands, imports, projection,
  character: spriteEditor, appearance,
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
