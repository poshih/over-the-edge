import type { Point } from '../config';
import type { DecorationCategory } from '../decoration-models';
import type { DecorationObject, LevelDefinition, LevelObject, StartObject } from '../level';
import type { MeshTerrain } from '../mesh-collision';
import type { History } from './document/history';
import type { LevelChecks } from './level-checks';
import type { LevelState } from './level-state';
import type { ProjectSaveTarget } from './project-save';
import type { PlayedVersion } from './project-session';
import type { ReplayFigure, ReplaySource } from './replay-viewer';
import type { ServerLevel } from './server-levels';
import type { SetPieceCategory } from './set-pieces';

export interface EditorCamera {
  x: number;
  y: number;
  worldHeight: number;
}

export interface LevelEditorOptions {
  mount: HTMLElement;
  canvas: HTMLCanvasElement;
  // The project's one history: every level edit the tab makes is a step of it, and the tab follows its document's level.
  history: History;
  level: LevelState;
  camera: {
    state: () => EditorCamera;
    set: (camera: EditorCamera | null) => void;
    // Screen and course-plane positions; the Depth variants work at any depth, null at or behind the camera.
    project: (point: Point) => Point;
    unproject: (client: Point) => Point;
    projectDepth: (point: Point, z: number) => Point | null;
    unprojectDepth: (client: Point, z: number) => Point | null;
  };
  decorations: {
    // A model's natural size, or null while it is unknown or loading.
    size: (model: string) => { readonly width: number; readonly height: number; readonly depth: number } | null;
    // Shows a placement or drag as a translucent model in the scene, or nothing.
    preview: (object: DecorationObject | null) => void;
    // The models the project's course artwork draws, by model ID, each with the name of its GLB.
    models: () => readonly { readonly id: string; readonly name: string }[];
    // Calls `listener` whenever those models, or a model's size, may have changed, as when its GLB arrives.
    subscribe: (listener: () => void) => () => void;
    // Shows or hides every decoration in the scene, without changing the level.
    show: (shown: boolean) => void;
  };
  // The project's course meshes, which Level places as terrain.
  meshes: {
    list: () => readonly { readonly id: string; readonly name: string }[];
    // A mesh turned `turn` radians about its vertical axis, ready to place with its collision baked for that turn; or the
    // refusal, which the project reports.
    terrain: (id: string, turn: number) => Promise<MeshTerrain | Error>;
    // Draws each placed terrain object `turns` lists, by ID, at its listed turn before the level holds it, each axis
    // keeping its scale, until the next call; the rest as the level turns them.
    preview: (turns: ReadonlyMap<string, number>) => void;
    // Adds a GLB to the project's meshes: it, ready to place, or the refusal, which the project reports.
    add: (file: File) => Promise<{ readonly id: string; readonly terrain: MeshTerrain } | Error>;
    // Calls `listener` whenever the meshes may have changed.
    subscribe: (listener: () => void) => () => void;
  };
  onPlay: () => void;
  // The live player, which the designer can place anywhere to test part of the course without moving
  // the level's start. Playtests and resets start from it until `clear` returns them to the start.
  player: {
    place: (position: Point) => void;
    clear: () => void;
    placed: () => boolean;
  };
  onNotice: (message: string, kind: 'info' | 'error') => void;
  // Levels served with this Workshop, which Server levels loads: the published project's first, then the levels
  // folder's.
  serverLevels: readonly ServerLevel[];
  // The open server project: Save to project writes the level into it, and the level version the page plays shows in
  // the status.
  projectSave: ProjectSaveTarget & { playedVersion(): PlayedVersion | null };
  // The recordings Replays lists, and the phantom figure it poses over the level.
  replays: { readonly source: ReplaySource; readonly figure: ReplayFigure };
  // The level's checks, which Checks lists and the course marks while the Level tab is edited.
  checks: LevelChecks;
  // False when the project warns about leaving instead (a Workshop built with GAME_PROJECT, which
  // keeps its project, level included, in the browser).
  warnBeforeUnload?: boolean;
}

// 'player' moves the live player without editing the level; it previews in the start's pose. 'decorate' selects and moves
// decorations, the scenery; 'select' never picks them, so scenery cannot get in the way of the course.
export type LevelEditorTool =
  | 'select' | 'decorate' | 'draw'
  | 'place' | 'place-trigger' | 'place-enemy' | 'place-hazard'
  | 'place-set-piece' | 'place-decoration' | 'start' | 'player';

export type LevelEditorDragKind =
  | 'move' | 'platform-end' | 'connect' | 'pan' | 'pinch'
  | 'draw' | 'tilt' | 'turn'
  | Exclude<LevelEditorTool, 'select' | 'decorate' | 'draw'>;

export interface LevelEditorSnapshot {
  readonly mode: 'edit' | 'inactive';
  readonly tool: LevelEditorTool;
  readonly selectedId: string | null;
  readonly selected: LevelObject | null;
  readonly preset: string | null;
  readonly preview: Readonly<LevelObject> | null;
  readonly dragging: LevelEditorDragKind | null;
  readonly capturedPointer: number | null;
  readonly drawing: {
    readonly vertices: readonly Readonly<Point>[];
    readonly strokeSamples: number;
  };
  readonly dirty: boolean;
  readonly loading: 'file' | 'server' | null;
  readonly objectCount: number;
  readonly start: StartObject;
  readonly counts: ReturnType<LevelState['counts']>;
  readonly labelCount: number;
  readonly camera: Readonly<EditorCamera>;
  readonly overlay: {
    readonly visible: boolean;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly commits: number;
  readonly hitTests: number;
  readonly draws: number;
  readonly setPieces: {
    readonly armed: string | null;
    readonly chosen: string | null;
    readonly mirror: boolean;
    readonly category: SetPieceCategory;
    readonly anchor: Readonly<Point>;
    readonly snapped: boolean;
    readonly surfaceIndexBuilds: number;
    readonly catalog: typeof import('./set-pieces').SET_PIECE_CATALOG;
  };
  readonly decorations: {
    readonly armed: string | null;
    readonly category: DecorationCategory | 'project';
    readonly mirror: boolean;
    readonly turn: number;
    readonly preview: Readonly<DecorationObject> | null;
  };
}

export interface LevelEditorHandle {
  // Applies unapplied trigger events; false, having said why, while an unfinished outline or an invalid event keeps the
  // level from being saved, exported or played.
  preparePlay(): boolean;
  // Records `definition` as the level last saved; null records that the current level has unsaved changes.
  markSaved(definition: LevelDefinition | null): void;
  // Whether work the level does not hold yet is pending: unapplied trigger events, an outline, a bake or a level file.
  hasPendingEdits(): boolean;
  setMode(mode: 'edit' | 'inactive'): void;
  snapshot(): LevelEditorSnapshot;
  dispose(): void;
}
