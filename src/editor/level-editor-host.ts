import type { Point } from '../config';
import type { DecorationObject } from '../level';
import type { LevelState } from './level-state';
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
    size: (model: string) => { readonly width: number; readonly height: number } | null;
    // Shows a placement or drag as a translucent model in the scene, or nothing.
    preview: (object: DecorationObject | null) => void;
  };
  onPlay: () => void;
  onNotice: (message: string, kind: 'info' | 'error') => void;
  // The levels served with this Workshop, listed under Server levels.
  serverLevels: readonly ServerLevel[];
  // False when the project warns about leaving instead (a Workshop built with GAME_PROJECT, which
  // keeps its project, level included, in the browser).
  warnBeforeUnload?: boolean;
}
