import type { Point } from '../config';
import type { LevelState } from './level-state';
import type { CourseArtView } from '../course-art-view';

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
    project: (point: Point) => Point;
    unproject: (client: Point) => Point;
  };
  onPlay: () => void;
  onNotice: (message: string, kind: 'info' | 'error') => void;
  artwork: { view: CourseArtView; onDebug: () => void };
}
