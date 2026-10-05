// Records phantoms: now and then, 10 seconds of the player's movement, reduced to the keyframes that
// reproduce every step of it within a centimetre and a half. See docs/phantoms.md.
import { PHYSICS, RIG } from './config';
import { angleDifference } from './math';
import {
  encodePhantom, PHANTOM_CHANNELS, PHANTOM_LIMITS, PHANTOM_TICK_RATE, PhantomError, phantomTool, phantomTrack, quantizePhantomValue,
} from './phantom-format';
import type { PhantomPose, PhantomTool, PhantomTrack } from './phantom-format';
import type { RigPose } from './simulation';

// Seconds, except where noted.
export const PHANTOM_RECORDING = {
  seconds: 10,
  // Play before the first recording starts, and between the end of one and the start of the next.
  firstDelay: { min: 5, max: 30 },
  delay: { min: 30, max: 90 },
  // A restart discards the recording in progress; the next one starts sooner.
  retryDelay: { min: 3, max: 10 },
  // Metres any part of the rig may stray from what its keyframes reproduce.
  tolerance: 0.015,
  // Keyframes at most this many ticks apart, so a still player costs little and playback stays live.
  maxGapTicks: PHANTOM_TICK_RATE / 2,
  // A recording is kept only if the character or the hammer head travelled at least this far, in metres.
  minTravel: { root: 0.5, tip: 3 },
} as const;

const CHANNELS = PHANTOM_CHANNELS.length;
// Stored units per metre or radian, per channel.
const SCALES = PHANTOM_CHANNELS.map((_, channel) => quantizePhantomValue(channel, 1));
// The rig's truth per sample: centre, pot angle, head centre and shaft angle.
const TRUTH = 6;
const STEP_TICKS = Math.round(PHYSICS.dt * PHANTOM_TICK_RATE);
if (STEP_TICKS < 1 || Math.abs(STEP_TICKS - PHYSICS.dt * PHANTOM_TICK_RATE) > 1e-9) {
  throw new Error('Phantom ticks must be a whole number of physics steps.');
}
const RECORDING_TICKS = PHANTOM_RECORDING.seconds * PHANTOM_TICK_RATE;
if (RECORDING_TICKS > PHANTOM_LIMITS.maxTicks) throw new Error('A phantom recording is longer than the format allows.');
// Tilting the pot moves its farthest corner by this much per radian.
const POT_RADIUS = Math.max(...RIG.potVertices.map((point) => Math.hypot(point.x, point.y)));

/**
 * Reduces one pose per physics step to keyframes, as they arrive. A stretch of steps becomes a
 * straight line between two keyframes while every step on it stays within the tolerance: the
 * character's centre, the hammer head, the pot's rim and the handle's far end, turned about the head,
 * all within PHANTOM_RECORDING.tolerance of the line's pose. Each step checks only the stretch since the last keyframe, so the cost per step is
 * bounded by the longest stretch.
 */
export class PhantomCapture {
  private handle = 0;
  private readonly keyTicks = new Int32Array(RECORDING_TICKS / STEP_TICKS + 1);
  private readonly keyValues = new Float64Array(this.keyTicks.length * CHANNELS);
  private keyframes = 0;
  // The steps since the last keyframe, which is the first of them.
  private readonly stretchTicks = new Int32Array(PHANTOM_RECORDING.maxGapTicks / STEP_TICKS + 2);
  private readonly stretchValues = new Float64Array(this.stretchTicks.length * CHANNELS);
  private readonly stretchTruth = new Float64Array(this.stretchTicks.length * TRUTH);
  private stretch = 0;
  private tick = 0;
  private angle = 0;
  private rootTravel = 0;
  private tipTravel = 0;
  private readonly pose: PhantomPose = { x: 0, y: 0, pot: 0, angle: 0, along: 0, across: 0 };
  private readonly tool: PhantomTool = { tipX: 0, tipY: 0, buttX: 0, buttY: 0 };

  get handleLength(): number {
    return this.handle;
  }

  get ticks(): number {
    return this.tick;
  }

  begin(handleLength: number): void {
    this.handle = handleLength;
    this.keyframes = 0;
    this.stretch = 0;
    this.tick = 0;
    this.rootTravel = 0;
    this.tipTravel = 0;
  }

  // Adds the pose one physics step after the previous one.
  add(rig: Readonly<RigPose>): void {
    if (this.keyframes === this.keyTicks.length) throw new Error('A phantom recording is full.');
    const at = this.stretch * TRUTH;
    if (this.keyframes > 0) {
      this.tick += STEP_TICKS;
      const previous = at - TRUTH;
      this.rootTravel += Math.hypot(rig.x - this.stretchTruth[previous]!, rig.y - this.stretchTruth[previous + 1]!);
      this.tipTravel += Math.hypot(rig.tipX - this.stretchTruth[previous + 3]!, rig.tipY - this.stretchTruth[previous + 4]!);
    }
    const shaft = Math.atan2(rig.tipY - rig.buttY, rig.tipX - rig.buttX);
    this.angle = this.keyframes === 0 ? shaft : this.angle + angleDifference(shaft, this.angle);
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const dx = rig.tipX - rig.x - RIG.shoulder.x;
    const dy = rig.tipY - rig.y - RIG.shoulder.y;
    this.stretchTicks[this.stretch] = this.tick;
    const truth = this.stretchTruth;
    truth[at] = rig.x;
    truth[at + 1] = rig.y;
    truth[at + 2] = rig.pot;
    truth[at + 3] = rig.tipX;
    truth[at + 4] = rig.tipY;
    truth[at + 5] = this.angle;
    const units = this.stretchValues;
    const offset = this.stretch * CHANNELS;
    units[offset] = quantizePhantomValue(0, rig.x);
    units[offset + 1] = quantizePhantomValue(1, rig.y);
    units[offset + 2] = quantizePhantomValue(2, rig.pot);
    units[offset + 3] = quantizePhantomValue(3, this.angle);
    units[offset + 4] = quantizePhantomValue(4, dx * cos + dy * sin);
    units[offset + 5] = quantizePhantomValue(5, dy * cos - dx * sin);
    this.stretch++;
    if (this.keyframes === 0) {
      this.keep(0);
      return;
    }
    if (this.tick - this.stretchTicks[0]! > PHANTOM_RECORDING.maxGapTicks || !this.fits()) {
      // The previous step ends this stretch as a keyframe and starts the next one.
      this.keep(this.stretch - 2);
      this.stretchTicks.copyWithin(0, this.stretch - 2, this.stretch);
      this.stretchValues.copyWithin(0, (this.stretch - 2) * CHANNELS, this.stretch * CHANNELS);
      this.stretchTruth.copyWithin(0, (this.stretch - 2) * TRUTH, this.stretch * TRUTH);
      this.stretch = 2;
    }
  }

  // Whether the character or the hammer head moved enough to be worth replaying.
  get moved(): boolean {
    return this.rootTravel >= PHANTOM_RECORDING.minTravel.root || this.tipTravel >= PHANTOM_RECORDING.minTravel.tip;
  }

  finish(): PhantomTrack {
    if (this.stretch > 1) this.keep(this.stretch - 1);
    const ticks = this.keyTicks.subarray(0, this.keyframes);
    const values = this.keyValues.subarray(0, this.keyframes * CHANNELS).map((units, index) => units / SCALES[index % CHANNELS]!);
    return phantomTrack(this.handle, ticks, values);
  }

  private keep(index: number): void {
    this.keyTicks[this.keyframes] = this.stretchTicks[index]!;
    this.keyValues.set(this.stretchValues.subarray(index * CHANNELS, (index + 1) * CHANNELS), this.keyframes * CHANNELS);
    this.keyframes++;
  }

  // Whether the line from the stretch's first step to its newest reproduces every step between them.
  private fits(): boolean {
    const last = this.stretch - 1;
    const start = this.stretchTicks[0]!;
    const span = this.stretchTicks[last]! - start;
    const units = this.stretchValues;
    const end = last * CHANNELS;
    const truth = this.stretchTruth;
    const { pose, tool } = this;
    const tolerance = PHANTOM_RECORDING.tolerance;
    for (let index = 1; index < last; index++) {
      const blend = (this.stretchTicks[index]! - start) / span;
      pose.x = (units[0]! + (units[end]! - units[0]!) * blend) / SCALES[0]!;
      pose.y = (units[1]! + (units[end + 1]! - units[1]!) * blend) / SCALES[1]!;
      pose.pot = (units[2]! + (units[end + 2]! - units[2]!) * blend) / SCALES[2]!;
      pose.angle = (units[3]! + (units[end + 3]! - units[3]!) * blend) / SCALES[3]!;
      pose.along = (units[4]! + (units[end + 4]! - units[4]!) * blend) / SCALES[4]!;
      pose.across = (units[5]! + (units[end + 5]! - units[5]!) * blend) / SCALES[5]!;
      const at = index * TRUTH;
      if (Math.hypot(pose.x - truth[at]!, pose.y - truth[at + 1]!) > tolerance) return false;
      if (POT_RADIUS * Math.abs(pose.pot - truth[at + 2]!) > tolerance) return false;
      phantomTool(pose, this.handle, tool);
      if (Math.hypot(tool.tipX - truth[at + 3]!, tool.tipY - truth[at + 4]!) > tolerance) return false;
      // The handle keeps its length, so the butt strays by the shaft's turn; the handle's own stretch under
      // impacts, at most a couple of centimetres, is not reproduced.
      if (this.handle * Math.abs(pose.angle - truth[at + 5]!) > tolerance) return false;
    }
    return true;
  }
}

/**
 * Chooses when to record: after a random stretch of play, it records the next 10 seconds and hands
 * the encoded recording to `onRecording`, then waits again. A restart, or a return to a bonfire,
 * discards the recording in progress; so does a recording in which the player hardly moved, and
 * one the format cannot hold, such as an endless fall past its coordinate range. Time is the
 * game's own, so pauses neither record nor count toward the wait.
 */
export class PhantomRecorder {
  private readonly capture = new PhantomCapture();
  private readonly random: () => number;
  private readonly onRecording: (recording: Uint8Array<ArrayBuffer>) => void;
  private wait: number;
  // Steps left in the recording in progress; 0 while waiting.
  private remaining = 0;
  private placement = -1;

  constructor(options: { onRecording: (recording: Uint8Array<ArrayBuffer>) => void; random?: () => number }) {
    this.onRecording = options.onRecording;
    this.random = options.random ?? Math.random;
    this.wait = this.delay(PHANTOM_RECORDING.firstDelay);
  }

  get recording(): boolean {
    return this.remaining > 0;
  }

  // After every physics step: the simulation's placement, which changes whenever the player is placed anew, and the rig.
  step(placement: number, rig: Readonly<RigPose>, handleLength: number): void {
    const placed = placement !== this.placement;
    this.placement = placement;
    if (this.remaining > 0 && (placed || handleLength !== this.capture.handleLength)) {
      this.remaining = 0;
      this.wait = this.delay(PHANTOM_RECORDING.retryDelay);
    }
    if (this.remaining === 0) {
      this.wait--;
      if (this.wait > 0) return;
      this.capture.begin(handleLength);
      this.remaining = RECORDING_TICKS / STEP_TICKS + 1;
    }
    this.capture.add(rig);
    this.remaining--;
    if (this.remaining > 0) return;
    this.wait = this.delay(PHANTOM_RECORDING.delay);
    if (!this.capture.moved) return;
    let recording: Uint8Array<ArrayBuffer>;
    try {
      recording = encodePhantom(this.capture.finish());
    } catch (error) {
      if (error instanceof PhantomError) return;
      throw error;
    }
    this.onRecording(recording);
  }

  // A random delay within the range, in steps.
  private delay(range: { readonly min: number; readonly max: number }): number {
    const seconds = range.min + (range.max - range.min) * this.random();
    return Math.max(1, Math.round(seconds / PHYSICS.dt));
  }
}
