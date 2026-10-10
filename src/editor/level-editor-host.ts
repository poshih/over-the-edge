import type { Point } from '../config';
import type { DecorationObject } from '../level';
import type { MeshTerrain } from '../mesh-collision';
import type { LevelChecks } from './level-checks';
import type { LevelState } from './level-state';
import type { ProjectSaveTarget } from './project-save';
import type { PlayedVersion } from './project-session';
import type { ReplayFigure, ReplaySource } from './replay-viewer';
import type { ServerLevel } from './server-levels';

export interface EditorCamera {
  x: number;
  y: number;
  worldHeight: number;
}

export interface LevelEditorOptions {
  mount: HTMLElement;
  canvas: HTMLCanvasElement;
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
    // Calls `listener` whenever a model's size may have changed, as when its GLB arrives.
    subscribe: (listener: () => void) => () => void;
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
