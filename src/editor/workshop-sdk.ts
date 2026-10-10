/**
 * The public Workshop plugin SDK: the one editor module a game's Workshop plugins import (they may also import the
 * engine's public kinds SDK and the game's own code).
 *
 * GAME_PLUGINS names each plugin's workshop facet, whose default export is a WorkshopFacet (docs/workshop-plugins.md).
 * When the Workshop's project is open, it starts each facet with a WorkshopHost, through which the
 * plugin adds its tabs and sections, reads the open project, edits it through the operations the built-in tabs use,
 * keeps its own data in the project, and works with the running game. Everything a plugin adds goes when it stops: on
 * an error it throws, or when a workshop facet changes, which restarts the plugins and keeps the project's unsaved changes;
 * Undo then stops short of a changed plugin's data, which its old facet checked. A stopped plugin's host then refuses
 * everything that would add or change something, with `plugin-stopped`.
 * Plugins are the game's trusted code, never content. Releases contain none of their code or data.
 */
import type { Matrix4 } from 'three';
import type { ArmIkSettings, VisualPartId } from '../character';
import type { AppearancePart, VisualAlignment } from '../appearance-profile';
import type { AudioSettings } from '../audio-settings';
import type { AvatarMotionEntry } from '../avatar-motion-data';
import type { AvatarMotionModel } from '../avatar-motion';
import type { CharacterArms } from '../character-arms';
import type { Point } from '../config';
import type { DirectionalPresentation } from '../directional-data';
import type { EnemyArtSettings } from '../enemy-art-data';
import type { EnemyClipRole } from '../enemy-motion-data';
import type { EnemyPose, EnemySpecies } from '../enemy-types';
import type { GameSettings } from '../game-settings';
import type { Grips } from '../grips';
import type { HammerHead } from '../hammer-head';
import type { HudSettings } from '../hud';
import type { LevelDefinition, LevelLabel, LevelObject } from '../level';
import type { MediaEntry } from '../media';
import type { LibraryAvatarSettings, ModelLibrary, PartRole } from '../model-library';
import type { PluginData } from '../plugin-data';
import type { ProjectArt } from '../project';
import type { CharacterRiggingType, SpriteDocument } from '../sprite-data';
import type { GameTheme } from '../theme';
import type { WorkshopGameState } from './game-state';
import type { Contribution } from '../plugins/kernel';
import type { SceneLayer } from '../scene-layer';

export {
  add, isNamespacedId, namespaceOf, PLUGIN_API_VERSION, PLUGIN_ERROR_CODES, PLUGIN_LIMITS, PluginError, pluginRefusal, replace, wrap,
} from '../plugins/kernel';
export type { Contribution, KeyedPoint, ListPoint, PluginEnvironment, SlotPoint } from '../plugins/kernel';
export { AVATAR_MOTION_CONTROLS, AVATAR_MOTION_CONTROL_LIMITS } from './avatar-motion-controls';
export type {
  AvatarMotionControl, AvatarMotionControls, AvatarMotionControlSet, AvatarMotionListControl, AvatarMotionNumberControl, AvatarMotionPath,
} from './avatar-motion-controls';
export { LEVEL_CHECK_LIMITS, LEVEL_CHECKS, LEVEL_REACH } from './level-check-points';
export type {
  LevelCheck, LevelCheckCourse, LevelCheckFinding, LevelCheckInput, LevelCheckReach, LevelReachInput, LevelReachPlan, LevelReachSource,
} from './level-check-points';
export { ENGINE_DEFAULT_REACH, levelGoal, reachForSettings } from '../course-checks';
export type { FindingSeverity, LevelFinding, LevelReachSummary, LevelStand, ReachModel } from '../course-checks';
export { PLUGIN_DATA_LIMITS } from '../plugin-data';
export type { PluginData } from '../plugin-data';
export type { JsonValue } from '../bounded-json';
export type { WorkshopGameState } from './game-state';
export type { SceneLayer } from '../scene-layer';
export type { SceneBounds, SceneCharacter, SceneFrame, SceneHammer, ScenePoint, ScenePose } from '../scene-frame';
export type {
  AppearancePart, ArmIkSettings, AudioSettings, AvatarMotionEntry, AvatarMotionModel, CharacterArms, CharacterRiggingType,
  DirectionalPresentation, EnemyArtSettings, EnemyClipRole, EnemyPose, EnemySpecies, GameSettings, GameTheme, Grips, HammerHead, HudSettings,
  LevelDefinition, LevelLabel, LevelObject, LibraryAvatarSettings, MediaEntry, ModelLibrary, PartRole, Point, ProjectArt,
  SpriteDocument, VisualAlignment, VisualPartId,
};

// ---------------------------------------------------------------------------------------------------------------------
// A plugin's authoring facet

export interface WorkshopFacet {
  readonly contributes?: readonly Contribution[];
  // Checks new data as it loads or changes, refusing with PluginError and a code of the plugin's own. Synchronous and
  // pure: it may run before the plugin starts, and never touches the page. Calling a mutating host service from validate
  // stops the plugin with invalid-contribution. Anything else it throws stops the plugin. Until its facet changes, a
  // plugin stopped by any error fails every check of its data with its `plugin-failed` failure, so edits and restores
  // refuse, while a project opening or a server update takes it unchecked. Undo and Redo never run it.
  validate?(data: PluginData): void;
  // Starts the plugin once the Workshop's project is open. Synchronous: an error or a promise-like result stops it.
  start(host: WorkshopHost): void;
}

export function defineWorkshop<T extends WorkshopFacet>(facet: T): T { return facet; }

// ---------------------------------------------------------------------------------------------------------------------
// The host

// The built-in tabs a plugin can add sections to.
export type WorkshopSectionTab = 'character' | 'level' | 'physics' | 'project';

export interface WorkshopHost {
  // The plugin's ID.
  readonly plugin: string;
  // Aborted when the plugin stops.
  readonly signal: AbortSignal;
  // A tab of the plugin's own, after the built-in ones. `id` is unique among the plugin's tabs and sections.
  addTab(options: { readonly id: string; readonly label: string; readonly title?: string }): WorkshopMount;
  // A collapsible section of the plugin's own at the end of a built-in tab.
  addSection(tab: WorkshopSectionTab, options: {
    readonly id: string; readonly title: string; readonly hint?: string; readonly open?: boolean;
  }): WorkshopMount;
  // Controls that look and behave like the built-in ones.
  readonly ui: WorkshopUiKit;
  readonly project: WorkshopProject;
  // The plugin's own data in the open project.
  readonly data: WorkshopPluginData;
  // Groups in the Workshop's one undo history.
  readonly history: WorkshopHistory;
  // The running game: overlays, canvas input, control, avatar facts and previews. Presentation only.
  readonly game: WorkshopGame;
  // Refuses with plugin-stopped after stop, as ui.notice does.
  notice(message: string, kind?: 'info' | 'error'): void;
  // `callback` wrapped so an error or a promise-like result is reported with the plugin's ID and stops the
  // plugin. Callbacks finish synchronously and do nothing once the plugin stops: for callbacks the plugin registers
  // outside the host, such as its own timers.
  guard<A extends unknown[]>(callback: (...args: A) => void): (...args: A) => void;
  // Adds a guarded event listener that the plugin's stop removes.
  listen(target: EventTarget, type: string, listener: (event: Event) => void, options?: { readonly capture?: boolean; readonly passive?: boolean }): void;
}

// Where a tab or section shows the plugin's UI.
export interface WorkshopMount {
  readonly element: HTMLElement;
  // Whether the mount is visible: its tab is selected in the open Workshop, and a section is expanded.
  readonly shown: boolean;
  // Tells `listener` whenever the mount is shown or hidden; returns its removal.
  onVisibility(listener: (shown: boolean) => void): () => void;
  // Removes the mount before the plugin stops.
  remove(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Controls

export interface WorkshopOption {
  readonly value: string;
  readonly label: string;
}

export interface WorkshopRange {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  set(value: number, options?: { readonly disabled?: boolean }): void;
}

export interface WorkshopSelect {
  readonly element: HTMLElement;
  readonly select: HTMLSelectElement;
  // Shows `value`, and new options when given.
  set(value: string, options?: { readonly disabled?: boolean; readonly options?: readonly WorkshopOption[] }): void;
}

export interface WorkshopToggle {
  readonly element: HTMLButtonElement;
  set(value: boolean, options?: { readonly disabled?: boolean }): void;
}

export interface WorkshopUiKit {
  // A labelled slider with step buttons and its value, as Physics and Character show them. The project and data edits its
  // onInput makes during one scrub are one undo step, named "<plugin>: <label>". The label is 1-80 characters.
  range(options: {
    readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly value: number;
    readonly unit?: string; readonly description?: string; onInput(value: number): void;
  }): WorkshopRange;
  button(options: { readonly label: string; readonly title?: string; onClick(): void }): HTMLButtonElement;
  select(options: {
    readonly label: string; readonly options: readonly WorkshopOption[]; readonly value: string; onChange(value: string): void;
  }): WorkshopSelect;
  // An on/off switch.
  toggle(options: { readonly label: string; readonly value: boolean; readonly title?: string; onChange(value: boolean): void }): WorkshopToggle;
  // A titled group of controls.
  group(legend: string): HTMLFieldSetElement;
  // A muted paragraph of help.
  note(text: string): HTMLParagraphElement;
  // The Workshop's notice.
  notice(message: string, kind?: 'info' | 'error'): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// The open project

// The open project as the Workshop holds it, unsaved changes included. Read-only and the same object until the project
// changes; plugins' data is not part of it. Its primary character and appearance parts are the project's values, which the
// game shows once their images and models load.
export interface WorkshopProjectSnapshot {
  readonly title: string;
  readonly settings: GameSettings;
  readonly level: LevelDefinition;
  readonly characters: { readonly primary: SpriteDocument; readonly alternate: SpriteDocument | null };
  readonly library: ModelLibrary;
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly audio: AudioSettings;
  readonly enemies: EnemyArtSettings;
  readonly art: ProjectArt;
  readonly media: readonly MediaEntry[];
  readonly armIk: Readonly<ArmIkSettings>;
  readonly appearance: readonly AppearancePart[];
}

export interface WorkshopProject {
  snapshot(): WorkshopProjectSnapshot;
  // Tells `listener` after the project changes, once per batch of changes; returns its removal.
  subscribe(listener: () => void): () => void;
  readonly edit: WorkshopEdits;
}

// The engine's typed error for a refused edit (for example LevelError, GameSettingsError, SpriteError and its
// CharacterModelError and AvatarMotionError, ProjectError, or PluginError), which the Workshop has also shown.
export type WorkshopRefusal = Error;

/**
 * Every edit the built-in tabs make, through the same operations: each is validated, changes the project's document as
 * a step of the Workshop's undo history, marks the project unsaved and goes through Save, Revert, export and conflict
 * handling as it does in its tab. Each returns the refusal, or null when the edit applied or changed nothing. Its step
 * joins the plugin's open group or is named "<plugin>: <operation>", such as "<plugin>: theme", "<plugin>: upsert",
 * "<plugin>: character.grips" or "<plugin>: media.add". Outside a group, calls of one operation each within a second of
 * the last merge into one step. An edit that returns a promise waits for a file, a bake or its check: it commits an
 * open group before it starts and becomes a step of its own once ready; until then Undo, or another project opening,
 * cancels it and it resolves null. It resolves `plugin-stopped` if the plugin stops first. An applied edit is in the
 * project's document, and in snapshot(), once the call returns or resolves; the game shows new character images and
 * models, and new appearance models, once they load, the newest value winning.
 */
export interface WorkshopEdits {
  title(value: string): WorkshopRefusal | null;
  // Physics, including the hammer rig and the default hammer's head.
  settings(value: GameSettings): WorkshopRefusal | null;
  readonly level: WorkshopLevelEdits;
  // The primary character profile, as Character, Appearance and Sprites edit it.
  readonly character: WorkshopCharacterEdits;
  // The project's second character profile, or null for none.
  alternate(document: SpriteDocument | null): WorkshopRefusal | null;
  readonly appearance: {
    armIk(value: ArmIkSettings): WorkshopRefusal | null;
    // Exactly these Mesh-parts models, imported as Appearance imports them; parts not listed return to their procedural
    // visuals. The game shows each model once it loads, after the project takes them.
    parts(parts: readonly { readonly part: VisualPartId; readonly name: string; readonly blob: Blob; readonly alignment: VisualAlignment }[]):
      Promise<WorkshopRefusal | null>;
  };
  theme(value: GameTheme): WorkshopRefusal | null;
  hud(value: HudSettings): WorkshopRefusal | null;
  audio(value: AudioSettings): WorkshopRefusal | null;
  enemies(value: EnemyArtSettings): WorkshopRefusal | null;
  // Draws a species as a skinned GLB, as Project / Enemy art does: the GLB joins the course artwork, and each of the
  // species' roles plays the clip its name suggests.
  enemyModel(species: EnemySpecies, file: File): Promise<WorkshopRefusal | null>;
  // Chooses the clip a model species plays for each role given, its moves travelling as the clip does.
  enemyClips(species: EnemySpecies, clips: Readonly<Partial<Record<EnemyClipRole, string>>>): Promise<WorkshopRefusal | null>;
  // A course package from `npm run pack:course`: its level and course artwork.
  coursePackage(file: File): Promise<WorkshopRefusal | null>;
  readonly media: {
    add(file: File): Promise<WorkshopRefusal | null>;
    remove(path: string): WorkshopRefusal | null;
  };
  readonly library: {
    // A GLB for one part; a new avatar maps its joints and takes the character's hold settings, as in Project.
    add(role: PartRole, file: File): Promise<WorkshopRefusal | null>;
    // Refuses an unknown role or a malformed ID; an ID the library lacks changes nothing.
    remove(role: PartRole, id: string): WorkshopRefusal | null;
    avatar(id: string, settings: LibraryAvatarSettings): Promise<WorkshopRefusal | null>;
    hammerHead(id: string, head: HammerHead): WorkshopRefusal | null;
  };
}

// The Level tab's operations.
export interface WorkshopLevelEdits {
  // Adds an object, or replaces the one with its ID.
  upsert(object: LevelObject): WorkshopRefusal | null;
  remove(id: string): WorkshopRefusal | null;
  // Adds, removes and relabels as one edit.
  edit(batch: { readonly add?: readonly LevelObject[]; readonly remove?: readonly string[]; readonly labels?: readonly LevelLabel[] }):
    WorkshopRefusal | null;
  labels(labels: readonly LevelLabel[]): WorkshopRefusal | null;
  // Renames the level; null leaves it unnamed.
  name(name: string | null): WorkshopRefusal | null;
  // Adopts a whole level as one edit: only the objects that differ change, so a playtest goes on.
  replace(level: LevelDefinition): WorkshopRefusal | null;
}

export interface WorkshopCharacterEdits {
  // Replaces the whole profile, checked as an imported one is; the character loads its images and models after the
  // project takes it.
  document(value: SpriteDocument): Promise<WorkshopRefusal | null>;
  // As Character's controls edit them. avatarMotion checks each motion against the joints of the profile's avatar model,
  // so it refuses until that model's joint report is known, as it is at once after the avatar's import.
  riggingType(value: CharacterRiggingType): WorkshopRefusal | null;
  armForwardDistance(value: number): WorkshopRefusal | null;
  waistLean(value: number): WorkshopRefusal | null;
  grips(value: Grips): WorkshopRefusal | null;
  arms(value: CharacterArms | null): WorkshopRefusal | null;
  avatarMotion(value: readonly AvatarMotionEntry[]): WorkshopRefusal | null;
  presentation(value: DirectionalPresentation | null): WorkshopRefusal | null;
}

export type WorkshopChangeCause = 'edit' | 'undo' | 'redo' | 'open' | 'server';

// Transient selection, not project data: at most 16 IDs in each list, each 1-64 characters.
// Undo restores before, Redo after. Omitted selection records none, so the step restores no selection.
export interface WorkshopSelection {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface WorkshopHistory {
  // One live undo step, named "<plugin>: <label>"; label is 1-80 characters. A new begin, Undo, Redo or an outside edit
  // commits it first; opening a project drops it, and stopping the plugin cancels it. Groups do not nest. A group that
  // Undo, Redo, an outside edit or an opening already closed stays as History left it: commit and cancel do nothing,
  // without reading options or affecting a newer group. After stop, even an ended handle refuses with plugin-stopped.
  // Edits show at once; commit records one step, cancel restores exact prior values without a step and notifies as undo
  // with no IDs. Bad labels, selections, null options or unknown option keys stop the plugin with invalid-contribution
  // and cancel its open group, even if caught. Omitted select records none.
  begin(label: string): {
    commit(options?: { readonly select?: WorkshopSelection }): void;
    cancel(): void;
  };
}

// The plugin's own data: one bounded JSON document in the open project, its section `plugins/<id>`, which saves,
// reverts, exports and conflict-checks with the project. The engine checks PLUGIN_DATA_LIMITS and runs the plugin's
// validate; it never interprets the data.
export interface WorkshopPluginData {
  get(): PluginData | null;
  // Replaces the data, or removes it with null, joining the open group or naming a step "<plugin>: <label>". The label
  // is 1-80 characters, "Set data" by default; the same effective label each within a second of the last merges unless
  // another history action intervenes.
  // Bad labels, selections, null options or unknown option keys stop the plugin with invalid-contribution and cancel
  // its open group, even if caught. Omitted select records none.
  // Returns null or the refusal: a PluginError, `invalid-contribution` for data beyond
  // PLUGIN_DATA_LIMITS or `too-many` when the project already keeps data for as many plugins as they allow; the plugin's
  // own typed error when its validate refused; or its failure when its validate threw anything else, which stops it.
  set(value: PluginData | null, options?: {
    readonly label?: string; readonly select?: WorkshopSelection;
  }): WorkshopRefusal | null;
  // Captured changes, FIFO a microtask later. Plugin steps (no tab) supply before IDs on Undo, after IDs on edit/Redo.
  // Other steps, null selection, cancel and open/server supply none. Listeners finish synchronously.
  // At most 200 undelivered receipts host-wide; too-many stops the plugin holding the most (ties: the one admitting now).
  subscribe(listener: (data: PluginData | null, change: {
    readonly cause: WorkshopChangeCause; readonly select: readonly string[];
  }) => void): () => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// The running game. Presentation only: physics, gameplay, play recordings and the authored level and profiles never see
// any of it.

// A pointer event on the game canvas. Events arrive while the canvas receives them and the mouse is not captured for play.
export interface WorkshopPointerEvent {
  readonly type: 'down' | 'move' | 'up' | 'cancel';
  readonly pointerId: number;
  readonly button: number;
  // Client (CSS) pixels, and the point under them on the course plane, in metres.
  readonly client: Readonly<Point>;
  readonly world: Readonly<Point>;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  // Called by a listener of a `down`: takes the drag, unless a plugin before this one took it, and the rest of the
  // plugins never hear of it. The game sees none of the drag's events, and game input stays blocked under the plugin's
  // reason until the drag's `up` or `cancel`. It does nothing on other events or after the listeners return.
  capture(): void;
}

// The loaded imported avatar's facts, as its motion kinds get them, read-only.
export interface WorkshopAvatar {
  readonly model: AvatarMotionModel;
  // Each motion and the skin joints it claims, hair first.
  readonly motions: readonly { readonly id: string; readonly claims: readonly number[] }[];
  // Writes skin joint `index`'s current world frame into `out`.
  jointWorld(index: number, out: Matrix4): Matrix4;
}

// A preview of the plugin's own: over `duration` seconds of game time, the character's whole presentation, its body,
// pot and tool together, moves by `offset` in the view's plane and turns about the player's root. The avatar's motions
// see it as real movement.
export interface WorkshopPreview {
  // Seconds, at most WORKSHOP_PREVIEW_LIMITS.duration.
  readonly duration: number;
  // The offset `elapsed` seconds in: metres in the view's plane and radians counterclockwise. It must not allocate.
  offset(elapsed: number, out: { x: number; y: number; turn: number }): void;
}

export const WORKSHOP_PREVIEW_LIMITS = Object.freeze({ duration: 10, distance: 20 });

export interface WorkshopGame {
  // Adds a scene layer; returns its removal.
  addOverlay(overlay: SceneLayer): () => void;
  // Tells `listener` about pointer events on the game canvas; returns its removal.
  onPointer(listener: (event: WorkshopPointerEvent) => void): () => void;
  // A course-plane point in client pixels, and the course-plane point under client pixels.
  project(point: Point): Point;
  unproject(client: Point): Point;
  // Pauses or resumes under the plugin's own reason; other reasons keep their pauses.
  pause(paused: boolean): void;
  // Restarts the attempt, as Reset does.
  restart(): void;
  // Moves the player to `position`, the pot's centre, in the start's pose, and starts attempts there, as the Level tab does.
  placePlayer(position: Point): void;
  // Explicit plain-data control and gameplay readings, built on request; no engine diagnostics.
  state(): WorkshopGameState;
  // The loaded imported avatar, or null while the character shows none; while a new avatar model loads, it lags the
  // project's profile.
  avatar(): WorkshopAvatar | null;
  // Runs the engine's Sway or Jolt, as Character's buttons do, or a preview of the plugin's own, whose offsets are kept
  // within WORKSHOP_PREVIEW_LIMITS.distance of the player; null ends the plugin's own preview. A preview ends early on a
  // placement, a restart or another preview. Pauses and tab hiding settle interpolation; only explicit placements rewind
  // presentation time, and placements also restart lean, head aim, hair and motions, with elapsed time clamped at zero.
  preview(preview: 'sway' | 'jolt' | WorkshopPreview | null): void;
}
