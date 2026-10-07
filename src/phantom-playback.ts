// Which phantom figures show and when is engine-owned. Runtime looks draw only these reused sampled frames.
import type { Object3D } from 'three';
import type { HammerHead } from './hammer-head';
import { createPhantomLook, LOOKS } from './object-looks';
import type { PhantomFigureFrame, PhantomLook, PhantomLookFactory } from './object-looks';
import { phantomTool, samplePhantom } from './phantom-format';
import type { PhantomPose, PhantomTool, PhantomTrack } from './phantom-format';
import { DEFAULT_PHANTOM_LOOK } from './phantom-view';
import type { RuntimePlugins } from './plugins/runtime';
import { call0, call2 } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import type { SceneFrame, SceneLayer } from './scene-layer';
import type { GameView } from './view';

export const PHANTOM_TIMING = {
  figures: 3,
  fadeIn: 0.5,
  fadeOut: 0.8,
  // A longer step, like a restart's jump back, holds playback.
  maxFrameSeconds: 0.25,
} as const;

// Only phantom consumers import this module. Resolve once per runtime session, then own the drawing as a view
// layer until its Game closes or the consumer removes it. GameView and the catalogue never import playback.
export function createPhantomPlayback(view: GameView, plugins: RuntimePlugins, figures: number): PhantomPlayback {
  const factory = plugins.slot(LOOKS.phantoms, DEFAULT_PHANTOM_LOOK);
  const playback = new PhantomPlayback(factory, { figures, head: view.rigGeometry.head });
  view.addLayer(playback, factory);
  return playback;
}

interface Figure {
  track: PhantomTrack | null;
  time: number;
  keyframe: number;
  readonly frame: {
    visible: boolean;
    readonly pose: PhantomPose;
    readonly tool: PhantomTool;
    handleLength: number;
    opacity: number;
    fresh: boolean;
    dt: number;
  };
}

function figure(): Figure {
  return {
    track: null, time: 0, keyframe: 0,
    frame: {
      visible: false, pose: { x: 0, y: 0, pot: 0, angle: 0, along: 0, across: 0 },
      tool: { tipX: 0, tipY: 0, buttX: 0, buttY: 0 }, handleLength: 0, opacity: 0, fresh: false, dt: 0,
    },
  };
}

export class PhantomPlayback implements SceneLayer {
  readonly root: Object3D;
  readonly pass = 'actors';
  private readonly look: Attributed<PhantomLook>;
  private readonly figures: readonly Figure[];
  // A dedicated slot for the replay viewer, never advanced by game time.
  private readonly held: Figure = figure();
  private readonly frames: readonly PhantomFigureFrame[];
  private head: HammerHead;
  private time: number | null = null;
  private count = 0;

  constructor(factory: Attributed<PhantomLookFactory>, options: { readonly figures: number; readonly head: HammerHead }) {
    this.figures = Array.from({ length: options.figures }, figure);
    this.frames = [...this.figures.map(figure => figure.frame), this.held.frame];
    this.head = options.head;
    this.look = createPhantomLook(factory, this.frames.length);
    this.root = this.look.value.root;
    this.root.visible = false;
  }

  get playing(): number { return this.count; }

  // Starts a phantom from its beginning; false when every playback slot is busy.
  play(track: PhantomTrack): boolean {
    for (const figure of this.figures) {
      if (figure.track !== null) continue;
      figure.track = track;
      figure.time = 0;
      figure.keyframe = 0;
      figure.frame.fresh = true;
      this.count++;
      this.place(figure, 0, true);
      this.draw();
      return true;
    }
    return false;
  }

  // Playback follows the game's time, including pauses. Nothing is sampled or drawn when no figure shows.
  update(frame: SceneFrame): void {
    this.head = frame.rig.head;
    const previous = this.time;
    this.time = frame.time;
    if (this.count === 0 && !this.held.frame.visible) return;
    const elapsed = previous === null ? 0 : frame.time - previous;
    const dt = elapsed >= 0 && elapsed <= PHANTOM_TIMING.maxFrameSeconds ? elapsed : 0;
    for (const figure of this.figures) {
      if (figure.track === null) continue;
      figure.time += dt;
      if (figure.time >= figure.track.duration) {
        this.stop(figure);
        this.count--;
      } else this.place(figure, dt, true);
    }
    this.draw();
  }

  /**
   * Shows a recording at a held time, unfaded. The pose is reused, valid until the next hold(); null hides it.
   * A short forward step on the same track or into a continuing clip preserves hand/arm history; anything else
   * starts it afresh. Game time never advances this slot.
   */
  hold(track: PhantomTrack | null, seconds: number, continues = false): Readonly<PhantomPose> | null {
    const figure = this.held;
    if (track === null) {
      this.stop(figure);
      this.draw();
      return null;
    }
    const time = Math.min(Math.max(seconds, 0), track.duration);
    const step = figure.track === track ? time - figure.time : continues && figure.track !== null ? time : -1;
    const smooth = step >= 0 && step <= PHANTOM_TIMING.maxFrameSeconds;
    if (figure.track !== track) figure.keyframe = 0;
    figure.frame.fresh = !smooth;
    figure.track = track;
    figure.time = time;
    this.place(figure, smooth ? step : 0, false);
    this.draw();
    return figure.frame.pose;
  }

  clear(): void {
    for (const figure of this.figures) this.stop(figure);
    this.stop(this.held);
    this.count = 0;
    this.root.visible = false;
  }

  dispose(): void {
    this.clear();
    call0(this.look, 'dispose');
  }

  private stop(figure: Figure): void {
    figure.track = null;
    figure.frame.visible = false;
    figure.frame.dt = 0;
    figure.frame.fresh = false;
  }

  private place(figure: Figure, dt: number, fading: boolean): void {
    const track = figure.track!;
    const frame = figure.frame;
    figure.keyframe = samplePhantom(track, figure.time, frame.pose, figure.keyframe);
    phantomTool(frame.pose, track.handleLength, frame.tool);
    const fade = fading ? Math.min(1, figure.time / PHANTOM_TIMING.fadeIn, (track.duration - figure.time) / PHANTOM_TIMING.fadeOut) : 1;
    frame.opacity = Math.max(0, fade);
    frame.handleLength = track.handleLength;
    frame.visible = true;
    frame.dt = dt;
  }

  private draw(): void {
    this.root.visible = this.count > 0 || this.held.frame.visible;
    if (!this.root.visible) return;
    call2(this.look, 'draw', this.frames, this.head);
    // play() and hold() may draw between game frames. Other slots must not advance their drawing history twice.
    for (const frame of this.frames as readonly Figure['frame'][]) {
      frame.dt = 0;
      frame.fresh = false;
    }
  }
}
