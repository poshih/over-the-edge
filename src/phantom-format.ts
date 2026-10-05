// Phantoms are short recordings of one player's movement that other players' games replay as ghosts.
// This is their format, shared by the game, a game's backend and the reference store. It uses no DOM
// or three.js, and its imports carry extensions, so JavaScript backends can validate with it directly.
//
// A recording is the rig's pose at keyframes: the character's centre, the pot's tilt, the shaft's
// angle and the hammer head's offset from the shoulder along and across the shaft. Arms and hands are
// not recorded: playback places them with the same grips and arm IK the game uses, from the tool.
import { RIG } from './config.ts';
import { PHANTOM_LIMITS, PHANTOM_TICK_RATE } from './phantom-limits.ts';
import { RIG_LIMITS } from './rig.ts';

// The codec's consumers also use these limits; metadata-only consumers import the data module directly.
export { PHANTOM_LIMITS, PHANTOM_TICK_RATE } from './phantom-limits.ts';

export const PHANTOM_FORMAT = 1;

// Values per keyframe, in this order.
export const PHANTOM_CHANNELS = ['x', 'y', 'pot', 'angle', 'along', 'across'] as const;
const CHANNELS = PHANTOM_CHANNELS.length;
// Stored units per metre or radian: millimetres, and 1/4096 radian (a millimetre at 4 m).
const SCALE = [1000, 1000, 4096, 4096, 1000, 1000] as const;
const ANGLE_BOUND = 2 ** 29 / 4096;
// Integer bounds per channel, inclusive.
const RANGE: readonly (readonly [number, number])[] = [
  [-PHANTOM_LIMITS.coordinate * 1000, PHANTOM_LIMITS.coordinate * 1000],
  [-PHANTOM_LIMITS.coordinate * 1000, PHANTOM_LIMITS.coordinate * 1000],
  [-PHANTOM_LIMITS.potAngle * 4096, PHANTOM_LIMITS.potAngle * 4096],
  [-ANGLE_BOUND * 4096, ANGLE_BOUND * 4096],
  [PHANTOM_LIMITS.along.min * 1000, PHANTOM_LIMITS.along.max * 1000],
  [-PHANTOM_LIMITS.across * 1000, PHANTOM_LIMITS.across * 1000],
];

export class PhantomError extends Error {}

// A course is the SHA-256, in lowercase hex, of its level's play layout and the game's physics (src/phantom-course.ts):
// recordings replay only where everything that moves the player is as it was when they were made.
export function isPhantomCourse(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// Metres: a recording is near a point when its character's path passes this close to it.
export const PHANTOM_NEAR = 25;

export function isPhantomNear(bounds: PhantomBounds, x: number, y: number, reach = PHANTOM_NEAR): boolean {
  const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
  const dy = Math.max(bounds.minY - y, 0, y - bounds.maxY);
  return dx * dx + dy * dy <= reach * reach;
}

// One recorded pose, in metres and radians. `angle` is the shaft's, unwrapped: it turns past ±π.
export interface PhantomPose {
  x: number;
  y: number;
  pot: number;
  angle: number;
  along: number;
  across: number;
}

export interface PhantomBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PhantomTrack {
  // The recorded hammer's handle, from its butt to the head's centre, in metres.
  readonly handleLength: number;
  // Each keyframe's tick from the start, ascending from 0.
  readonly ticks: Int32Array;
  // PHANTOM_CHANNELS values per keyframe, in metres and radians, each a whole number of stored units.
  readonly values: Float64Array;
  readonly duration: number;
  // Where the character's centre went.
  readonly bounds: PhantomBounds;
}

// The rendered tool of a pose: the hammer head's centre and the handle's butt.
export interface PhantomTool {
  tipX: number;
  tipY: number;
  buttX: number;
  buttY: number;
}

export function quantizePhantomValue(channel: number, value: number): number {
  // Adding zero turns a rounded -0 into 0, as decoding produces it.
  return Math.round(value * SCALE[channel]!) + 0;
}

/**
 * Builds a track from keyframes, validating it as a decoded recording would be. Values are rounded
 * to the stored units, so encoding the track loses nothing.
 */
export function phantomTrack(handleLength: number, ticks: ArrayLike<number>, values: ArrayLike<number>): PhantomTrack {
  const count = ticks.length;
  if (values.length !== count * CHANNELS) throw new PhantomError('A phantom needs every channel of every keyframe.');
  const handle = Math.round(handleLength * 1000);
  const track = { ticks: new Int32Array(count), values: new Float64Array(count * CHANNELS) };
  for (let index = 0; index < count; index++) track.ticks[index] = ticks[index]!;
  for (let index = 0; index < values.length; index++) {
    track.values[index] = quantizePhantomValue(index % CHANNELS, values[index]!) / SCALE[index % CHANNELS]!;
  }
  return checked(handle, track.ticks, track.values);
}

function checked(handle: number, ticks: Int32Array, values: Float64Array): PhantomTrack {
  if (!Number.isInteger(handle) || handle < RIG_LIMITS.handleLength.min * 1000 || handle > RIG_LIMITS.handleLength.max * 1000) {
    throw new PhantomError('A phantom\'s handle length is outside the rig limits.');
  }
  const count = ticks.length;
  if (count < 2 || count > PHANTOM_LIMITS.maxTicks + 1) throw new PhantomError('A phantom needs 2 or more keyframes, at most one per tick.');
  if (ticks[0] !== 0) throw new PhantomError('A phantom starts at tick 0.');
  for (let index = 1; index < count; index++) {
    const gap = ticks[index]! - ticks[index - 1]!;
    if (!(gap >= 1 && gap <= PHANTOM_LIMITS.maxGapTicks)) throw new PhantomError('Phantom keyframes must be 1 tick to 1 second apart.');
  }
  const last = ticks[count - 1]!;
  if (last < PHANTOM_LIMITS.minTicks || last > PHANTOM_LIMITS.maxTicks) throw new PhantomError('A phantom lasts 1 to 10 seconds.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < values.length; index++) {
    const channel = index % CHANNELS;
    const units = values[index]! * SCALE[channel]!;
    const [low, high] = RANGE[channel]!;
    if (!(units >= low && units <= high)) throw new PhantomError(`A phantom's ${PHANTOM_CHANNELS[channel]} is out of range.`);
  }
  for (let index = 0; index < count; index++) {
    const x = values[index * CHANNELS]!, y = values[index * CHANNELS + 1]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return Object.freeze({
    handleLength: handle / 1000, ticks, values, duration: last / PHANTOM_TICK_RATE,
    bounds: Object.freeze({ minX, minY, maxX, maxY }),
  });
}

class Writer {
  private bytes = new Uint8Array(256);
  private length = 0;

  byte(value: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = value;
  }

  unsigned(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.byte((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.byte(rest);
  }

  // Zigzag: small magnitudes of either sign take few bytes.
  signed(value: number): void {
    this.unsigned(value < 0 ? -2 * value - 1 : 2 * value);
  }

  raw(bytes: Uint8Array): void {
    for (const value of bytes) this.byte(value);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.length);
  }
}

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw new PhantomError('The phantom ends early.');
    return this.bytes[this.offset++]!;
  }

  // At most 2^32 - 1, in at most five bytes.
  unsigned(): number {
    let value = 0;
    for (let shift = 1, index = 0; ; shift *= 0x80, index++) {
      const byte = this.byte();
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) {
        if (index > 0 && byte === 0) throw new PhantomError('The phantom has a padded number.');
        if (value > 0xffffffff) throw new PhantomError('The phantom has an oversized number.');
        return value;
      }
      if (index === 4) throw new PhantomError('The phantom has an oversized number.');
    }
  }

  signed(): number {
    const value = this.unsigned();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  raw(length: number): Uint8Array<ArrayBuffer> {
    if (length > this.bytes.length - this.offset) throw new PhantomError('The phantom batch ends early.');
    const bytes = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
}

/**
 * Encodes a track: the format version, the handle length in millimetres and the keyframe count, then
 * the first keyframe's values and, for each later keyframe, its ticks since the previous one and the
 * change in each value. Numbers are LEB128 varints; values and changes are zigzag-encoded.
 */
export function encodePhantom(track: PhantomTrack): Uint8Array<ArrayBuffer> {
  const writer = new Writer();
  writer.byte(PHANTOM_FORMAT);
  writer.unsigned(Math.round(track.handleLength * 1000));
  const count = track.ticks.length;
  writer.unsigned(count);
  for (let index = 0; index < count; index++) {
    if (index > 0) writer.unsigned(track.ticks[index]! - track.ticks[index - 1]!);
    for (let channel = 0; channel < CHANNELS; channel++) {
      const value = quantizePhantomValue(channel, track.values[index * CHANNELS + channel]!);
      writer.signed(index === 0 ? value : value - quantizePhantomValue(channel, track.values[(index - 1) * CHANNELS + channel]!));
    }
  }
  const bytes = writer.finish();
  if (bytes.byteLength > PHANTOM_LIMITS.bytes) throw new PhantomError('The phantom is larger than a recording may be.');
  return bytes;
}

// Decodes and validates a recording from anyone: whatever it holds, the result is a playable track.
export function decodePhantom(bytes: Uint8Array): PhantomTrack {
  if (bytes.byteLength > PHANTOM_LIMITS.bytes) throw new PhantomError('The phantom is larger than a recording may be.');
  const reader = new Reader(bytes);
  if (reader.byte() !== PHANTOM_FORMAT) throw new PhantomError(`Only phantom format ${PHANTOM_FORMAT} is supported.`);
  const handle = reader.unsigned();
  const count = reader.unsigned();
  if (count < 2 || count > PHANTOM_LIMITS.maxTicks + 1) throw new PhantomError('A phantom needs 2 or more keyframes, at most one per tick.');
  const ticks = new Int32Array(count);
  const values = new Float64Array(count * CHANNELS);
  const units = new Array<number>(CHANNELS).fill(0);
  let tick = 0;
  for (let index = 0; index < count; index++) {
    if (index > 0) {
      tick += reader.unsigned();
      if (tick > PHANTOM_LIMITS.maxTicks) throw new PhantomError('A phantom lasts 1 to 10 seconds.');
    }
    ticks[index] = tick;
    for (let channel = 0; channel < CHANNELS; channel++) {
      units[channel] = (index === 0 ? 0 : units[channel]!) + reader.signed();
      const [low, high] = RANGE[channel]!;
      if (units[channel]! < low || units[channel]! > high) throw new PhantomError(`A phantom's ${PHANTOM_CHANNELS[channel]} is out of range.`);
      values[index * CHANNELS + channel] = units[channel]! / SCALE[channel]!;
    }
  }
  if (!reader.done) throw new PhantomError('The phantom has bytes after its last keyframe.');
  return checked(handle, ticks, values);
}

// A count, then each recording's length and bytes: a service's answer (a batch) or a release's pack.
function encodeRecordings(recordings: readonly Uint8Array[], limit: number, name: string): Uint8Array<ArrayBuffer> {
  if (recordings.length > limit) throw new PhantomError(`A phantom ${name} holds at most ${limit} recordings.`);
  const writer = new Writer();
  writer.unsigned(recordings.length);
  for (const recording of recordings) {
    if (recording.byteLength > PHANTOM_LIMITS.bytes) throw new PhantomError('The phantom is larger than a recording may be.');
    writer.unsigned(recording.byteLength);
    writer.raw(recording);
  }
  return writer.finish();
}

function decodeRecordings(bytes: Uint8Array, limit: number, name: string): Uint8Array<ArrayBuffer>[] {
  const reader = new Reader(bytes);
  const count = reader.unsigned();
  if (count > limit) throw new PhantomError(`A phantom ${name} holds at most ${limit} recordings.`);
  const recordings: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < count; index++) {
    const length = reader.unsigned();
    if (length > PHANTOM_LIMITS.bytes) throw new PhantomError('The phantom is larger than a recording may be.');
    recordings.push(reader.raw(length));
  }
  if (!reader.done) throw new PhantomError(`The phantom ${name} has bytes after its last recording.`);
  return recordings;
}

// A service's answer.
export function encodePhantomBatch(recordings: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  return encodeRecordings(recordings, PHANTOM_LIMITS.batch, 'batch');
}

// Splits a batch into its recordings, which still need decoding.
export function decodePhantomBatch(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
  return decodeRecordings(bytes, PHANTOM_LIMITS.batch, 'batch');
}

// Recordings a release bundles, packed as a batch is, up to PHANTOM_LIMITS.pack of them.
export function encodePhantomPack(recordings: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  return encodeRecordings(recordings, PHANTOM_LIMITS.pack, 'pack');
}

export function decodePhantomPack(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
  return decodeRecordings(bytes, PHANTOM_LIMITS.pack, 'pack');
}

/**
 * Writes the pose `seconds` into the track to `out`, interpolated linearly between keyframes and held
 * at either end. Returns the keyframe the time falls after, which a later call may pass as `from`
 * while time only moves forward, so playback costs the same at any length.
 */
export function samplePhantom(track: PhantomTrack, seconds: number, out: PhantomPose, from = 0): number {
  const { ticks, values } = track;
  const tick = Math.min(Math.max(seconds * PHANTOM_TICK_RATE, 0), ticks[ticks.length - 1]!);
  let index = Math.min(Math.max(from, 0), ticks.length - 2);
  if (ticks[index]! > tick) index = 0;
  while (index < ticks.length - 2 && ticks[index + 1]! <= tick) index++;
  const start = ticks[index]!;
  const blend = (tick - start) / (ticks[index + 1]! - start);
  const a = index * CHANNELS;
  const b = a + CHANNELS;
  out.x = values[a]! + (values[b]! - values[a]!) * blend;
  out.y = values[a + 1]! + (values[b + 1]! - values[a + 1]!) * blend;
  out.pot = values[a + 2]! + (values[b + 2]! - values[a + 2]!) * blend;
  out.angle = values[a + 3]! + (values[b + 3]! - values[a + 3]!) * blend;
  out.along = values[a + 4]! + (values[b + 4]! - values[a + 4]!) * blend;
  out.across = values[a + 5]! + (values[b + 5]! - values[a + 5]!) * blend;
  return index;
}

// The tool a pose draws: the head's centre from the shoulder hinge, and the butt a handle behind it.
export function phantomTool(pose: Readonly<PhantomPose>, handleLength: number, out: PhantomTool): PhantomTool {
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  out.tipX = pose.x + RIG.shoulder.x + pose.along * cos - pose.across * sin;
  out.tipY = pose.y + RIG.shoulder.y + pose.along * sin + pose.across * cos;
  out.buttX = out.tipX - handleLength * cos;
  out.buttY = out.tipY - handleLength * sin;
  return out;
}
