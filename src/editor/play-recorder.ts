import type { Game } from '../game';
import { encodePhantom, PHANTOM_LIMITS, PhantomError } from '../phantom-format';
import { PhantomCapture } from '../phantom-recorder';
import type { RigPose } from '../simulation';
import type { PlayedLevel } from './project-session';

// One clip in a session, as the project server files it.
export interface RecordedClip {
  readonly session: string;
  readonly clip: number;
}

function sessionId(): string {
  // getRandomValues works on plain HTTP too, unlike randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Records Workshop play as phantom recordings of the level version being played (see docs/phantoms.md). While it is
 * on and the page plays a saved version of the open project's level, each run becomes a session of clips up to the
 * longest a recording may be, each starting with the previous one's last pose, so a run replays as one. A restart
 * starts the next session. A clip also ends when the handle length changes, the level stops being that version or
 * recording turns off; one shorter than a second, or in which the player hardly moved, is dropped. Clips upload as
 * they end, on the game's steps, so pauses record nothing.
 */
export class PlayRecorder {
  private readonly game: Game;
  private readonly target: () => PlayedLevel | null;
  private readonly upload: (target: PlayedLevel, clip: RecordedClip, recording: Uint8Array<ArrayBuffer>) => Promise<void>;
  private readonly onFailure: (error: unknown) => void;
  private readonly capture = new PhantomCapture();
  private readonly pose: RigPose = { x: 0, y: 0, pot: 0, tipX: 0, tipY: 0, buttX: 0, buttY: 0 };
  private readonly unobserve: () => void;
  private enabled: boolean;
  // The clip being captured, or null between clips.
  private clip: { readonly target: PlayedLevel; readonly session: string; readonly index: number } | null = null;
  private session: string | null = null;
  private clips = 0;
  private time = -Infinity;
  // Whether the latest upload failed: one notice per failing stretch.
  private failing = false;

  constructor(options: {
    readonly game: Game;
    readonly enabled: boolean;
    // What the page plays now: the version to record for, or null when nothing can be recorded.
    readonly target: () => PlayedLevel | null;
    readonly upload: (target: PlayedLevel, clip: RecordedClip, recording: Uint8Array<ArrayBuffer>) => Promise<void>;
    readonly onFailure: (error: unknown) => void;
  }) {
    this.game = options.game;
    this.enabled = options.enabled;
    this.target = options.target;
    this.upload = options.upload;
    this.onFailure = options.onFailure;
    this.unobserve = options.game.observeSteps(() => this.step());
  }

  // Whether a clip is being captured.
  get recording(): boolean {
    return this.clip !== null;
  }

  get on(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.end();
  }

  dispose(): void {
    this.unobserve();
    this.end();
  }

  private step(): void {
    const { simulation } = this.game;
    // The game's time restarts with every attempt.
    if (simulation.time <= this.time) {
      this.end();
      this.session = null;
    }
    this.time = simulation.time;
    const target = this.enabled ? this.target() : null;
    const handle = simulation.rigGeometry.handleLength;
    const clip = this.clip;
    if (clip !== null && (target === null || target.project !== clip.target.project || target.version !== clip.target.version ||
      handle !== this.capture.handleLength)) this.end();
    if (target === null) return;
    simulation.rigPose(this.pose);
    if (this.clip === null) this.begin(target, handle);
    this.capture.add(this.pose);
    if (this.capture.ticks < PHANTOM_LIMITS.maxTicks) return;
    this.end();
    this.begin(target, handle);
    this.capture.add(this.pose);
  }

  private begin(target: PlayedLevel, handle: number): void {
    if (this.session === null) {
      this.session = sessionId();
      this.clips = 0;
    }
    this.clip = { target, session: this.session, index: this.clips++ };
    this.capture.begin(handle);
  }

  private end(): void {
    const clip = this.clip;
    if (clip === null) return;
    this.clip = null;
    if (this.capture.ticks < PHANTOM_LIMITS.minTicks || !this.capture.moved) return;
    let recording: Uint8Array<ArrayBuffer>;
    try {
      recording = encodePhantom(this.capture.finish());
    } catch (error) {
      // Such as a fall past the format's coordinate range.
      if (error instanceof PhantomError) return;
      throw error;
    }
    this.upload(clip.target, { session: clip.session, clip: clip.index }, recording).then(() => {
      this.failing = false;
    }, (error: unknown) => {
      if (this.failing) return;
      this.failing = true;
      this.onFailure(error);
    });
  }
}
