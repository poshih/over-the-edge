import { RIG } from './config';
import type { Point } from './config';
import { clamp } from './math';
import { createInstance, instanceContract, invalidResult, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { DeathKind } from './death-sequence';
// Plain data, also used by course scripts running in Node to place scenery for this framing.
import VIEW_FRAME from './view-frame.json' with { type: 'json' };

// One reused, read-only input. Focus is the pot root and reach is the hammer head's centre, in metres on the
// obstacle line. Width and height are CSS pixels; dt is the drawn frame's elapsed real seconds.
export interface CameraView {
  readonly focus: Readonly<Point>;
  readonly reach: Readonly<Point>;
  readonly reachRadius: number;
  readonly maxReach: number;
  readonly width: number;
  readonly height: number;
  readonly dt: number;
  readonly death: DeathKind | null;
}

// The current aim on entry; a director writes the next one in place. The engine owns projection, depths, fog and
// matrices. Mouse pointerDelta uses worldHeight / CSS height too, so changing the framing also changes mouse gain.
export interface CameraAim extends Point {
  worldHeight: number;
}

export interface CameraDirector {
  aim(view: CameraView, out: CameraAim): void;
  // A resize, a recenter or a player placed anew: go straight to the framing, without following from the old aim.
  snap(view: CameraView, out: CameraAim): void;
  inspect?(): unknown;
}

export type CameraDirectorFactory = () => CameraDirector;

function directorFactory(value: unknown): CameraDirectorFactory {
  if (typeof value !== 'function') throw new TypeError('A camera director must be a factory.');
  return value as CameraDirectorFactory;
}

export const CAMERA = slotPoint('camera.director', 'runtime', directorFactory);

const FRAMING = {
  viewHeight: VIEW_FRAME.viewHeight,
  cameraLead: 0.9,
  cameraLift: 1.15,
  cameraMinimumY: 2.9,
  cameraResponse: 3.5,
  compactWidth: 680,
  compactHeight: 580,
  reachMargin: 0.5,
  framingMargin: 0.2,
  visibleGroundDepth: 1.3,
  characterTop: 1.35,
} as const;
const POT_HALF_WIDTH = Math.max(...RIG.potVertices.map((point) => Math.abs(point.x)));

class FollowCamera implements CameraDirector {
  private compact = false;
  private readonly bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  aim(view: CameraView, out: CameraAim): void {
    this.place(view, out, false);
  }

  snap(view: CameraView, out: CameraAim): void {
    this.place(view, out, true);
  }

  inspect() { return { compact: this.compact }; }

  private place(view: CameraView, out: CameraAim, snap: boolean): void {
    if (view.death !== null) return;
    const { focus, reach, reachRadius, width, height } = view;
    const aspect = width / height;
    this.compact = width < FRAMING.compactWidth || height < FRAMING.compactHeight || aspect < 1;
    const bounds = this.bounds;
    bounds.minX = Math.min(focus.x - POT_HALF_WIDTH, reach.x - reachRadius);
    bounds.maxX = Math.max(focus.x + POT_HALF_WIDTH, reach.x + reachRadius);
    bounds.minY = Math.min(focus.y + RIG.potBottom, reach.y - reachRadius);
    bounds.maxY = Math.max(focus.y + FRAMING.characterTop, reach.y + reachRadius);
    const span = 2 * (view.maxReach + FRAMING.reachMargin);
    const padding = 2 * FRAMING.framingMargin;
    out.worldHeight = this.compact ? Math.max(
      span, span / aspect, bounds.maxY - bounds.minY + padding,
      (bounds.maxX - bounds.minX + padding) / aspect,
    ) : FRAMING.viewHeight;
    const x = focus.x + (this.compact ? RIG.shoulder.x : FRAMING.cameraLead);
    const y = this.compact
      ? Math.max(focus.y + RIG.shoulder.y, out.worldHeight / 2 - FRAMING.visibleGroundDepth)
      : Math.max(FRAMING.cameraMinimumY, focus.y + FRAMING.cameraLift);
    if (snap) {
      out.x = x;
      out.y = y;
    } else {
      const blend = 1 - Math.exp(-FRAMING.cameraResponse * view.dt);
      out.x += (x - out.x) * blend;
      out.y += (y - out.y) * blend;
    }
    if (!this.compact) return;
    const halfHeight = out.worldHeight / 2;
    const halfWidth = halfHeight * aspect;
    out.x = clamp(out.x, bounds.maxX + FRAMING.framingMargin - halfWidth, bounds.minX - FRAMING.framingMargin + halfWidth);
    out.y = clamp(out.y, bounds.maxY + FRAMING.framingMargin - halfHeight, bounds.minY - FRAMING.framingMargin + halfHeight);
  }
}

export const DEFAULT_CAMERA_DIRECTOR: CameraDirectorFactory = () => new FollowCamera();

const CAMERA_DIRECTOR_CONTRACT = instanceContract({
  returns: 'aim(view, out), snap(view, out) and, when given, inspect()',
  methods: ['aim', 'snap'],
  optional: ['inspect'],
});

export function createCameraDirector(plugins: RuntimePlugins): Attributed<CameraDirector> {
  const factory = plugins.slot(CAMERA, DEFAULT_CAMERA_DIRECTOR);
  return createInstance(CAMERA_DIRECTOR_CONTRACT, factory, factory.value);
}

// Check each written aim, not just the factory: an invalid frame must fail explicitly, never poison the projection.
export function checkCameraAim(aim: CameraAim, director: Attributed<CameraDirector>): void {
  if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y) || !Number.isFinite(aim.worldHeight) || aim.worldHeight <= 0) {
    throw invalidResult(director, 'must write finite coordinates and a positive worldHeight');
  }
}
