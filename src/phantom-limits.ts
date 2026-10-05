// Recording and pack limits, shared by content metadata and the optional phantom codec. Data only: loading a
// content manifest must never pull recording, service or playback code into a release without phantoms.
import { MAX_RIG_REACH } from './rig.ts';

// Recording time counts ticks of 1/240 s, one physics step.
export const PHANTOM_TICK_RATE = 240;
export const PHANTOM_LIMITS = {
  // A recording spans 1 to 10 seconds, with keyframes at most 1 second apart.
  minTicks: PHANTOM_TICK_RATE,
  maxTicks: 10 * PHANTOM_TICK_RATE,
  maxGapTicks: PHANTOM_TICK_RATE,
  bytes: 32 * 1024,
  // Recordings in one response from a phantom service, and in one pack a release bundles.
  batch: 16,
  pack: 64,
  // Metres from the origin, in x and y: twice the level limit, room for flights above the course.
  coordinate: 4096,
  potAngle: 0.5,
  along: { min: -0.5, max: MAX_RIG_REACH + 0.5 },
  across: 1,
} as const;

// The largest pack: its count, and each recording's length (at most three bytes) and bytes.
export const PHANTOM_PACK_BYTES = 1 + PHANTOM_LIMITS.pack * (3 + PHANTOM_LIMITS.bytes);
