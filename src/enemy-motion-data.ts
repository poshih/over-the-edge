import { ENEMY_SPECS } from './enemy-types';
import type { EnemySpecies } from './enemy-types';
import { exactRecord, ProjectError } from './project-fields';

export const ENEMY_CLIP_ROLES = ['idle', 'walk', 'windup', 'dive', 'recover', 'hurt', 'death'] as const;
export type EnemyClipRole = (typeof ENEMY_CLIP_ROLES)[number];
// The roles each species plays: idle and walk for its patrol, standing or moving, and one for each other phase it has.
export const SPECIES_CLIP_ROLES: Readonly<Record<EnemySpecies, readonly EnemyClipRole[]>> = {
  bird: ['idle', 'walk', 'windup', 'dive', 'recover', 'hurt', 'death'],
  'hollow-soldier': ['idle', 'walk', 'recover', 'hurt', 'death'],
  'hollow-archer': ['idle', 'walk', 'windup', 'recover', 'hurt', 'death'],
};
// `inPlaceStride`: a walk clip travelling less than this far forward each cycle, in model heights, walks in place.
export const ENEMY_MOTION = { sampleRate: 60, unit: 10_000, maxDuration: 10, maxClips: 32, maxTravel: 10_000_000, inPlaceStride: 0.05 } as const;

/** A clip's root motion: its length in seconds, and how far its top joint has travelled along the model's facing at each
 * sample, ENEMY_MOTION.sampleRate a second from 0, in ENEMY_MOTION.unit-ths of the model's bind-pose height. */
export interface EnemyClipMotion { readonly duration: number; readonly travel: readonly number[] }

// Each species' clip motion by role, from its model; null for a species drawn without one, which moves as its sprite
// does.
export type EnemyMotion = Readonly<Record<EnemySpecies, Readonly<Partial<Record<EnemyClipRole, EnemyClipMotion>>> | null>>;
export const NO_ENEMY_MOTION: EnemyMotion = Object.freeze({ bird: null, 'hollow-soldier': null, 'hollow-archer': null });

export function loopingRole(role: EnemyClipRole): boolean {
  return role === 'idle' || role === 'walk';
}

// Whether a species' model moves as its clips travel: ground enemies do, while birds are steered as they fly, their
// clips playing in place.
export function rootMotion(species: EnemySpecies): boolean {
  return species !== 'bird';
}

// The metres one bind-pose height of a species' model stands: the species' height, which its model is fitted to.
export function modelHeight(species: EnemySpecies): number {
  return ENEMY_SPECS[species].height;
}

// How fast a clip travels along the facing over its whole length, in metres per second for a model `height` metres
// tall; negative for one travelling backward.
export function clipSpeed(motion: EnemyClipMotion, height: number): number {
  return clipTravel(motion, motion.duration, false) * height / motion.duration;
}

// Whether a walk clip walks in place, travelling forward less than ENEMY_MOTION.inPlaceStride model heights a cycle.
export function walksInPlace(motion: EnemyClipMotion): boolean {
  return clipTravel(motion, motion.duration, false) < ENEMY_MOTION.inPlaceStride;
}

export function motionSamples(duration: number): number {
  return Math.ceil(duration * ENEMY_MOTION.sampleRate - 1e-9) + 1;
}

export function validateEnemyClipMotion(value: unknown, label: string): EnemyClipMotion {
  const data = exactRecord(value, ['duration', 'travel'], label);
  const duration = data.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > ENEMY_MOTION.maxDuration) {
    throw new ProjectError(`${label} duration must be greater than 0 and at most ${ENEMY_MOTION.maxDuration} seconds.`);
  }
  const travel = data.travel;
  if (!Array.isArray(travel)) throw new ProjectError(`${label} travel must be an array.`);
  const expected = motionSamples(duration);
  if (travel.length !== expected) throw new ProjectError(`${label} travel must contain ${expected} samples.`);
  if (travel[0] !== 0) throw new ProjectError(`${label} travel must start at 0.`);
  const values = travel.map((entry, at) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || Math.abs(entry) > ENEMY_MOTION.maxTravel) {
      throw new ProjectError(`${label} travel sample ${at} must be a whole number between ${-ENEMY_MOTION.maxTravel} and ${ENEMY_MOTION.maxTravel}.`);
    }
    return entry;
  });
  return Object.freeze({ duration, travel: Object.freeze(values) });
}

export function clipTravel(motion: EnemyClipMotion, time: number, loop: boolean): number {
  if (time <= 0 || !Number.isFinite(time)) return 0;
  const end = motion.travel[motion.travel.length - 1] ?? 0;
  if (loop) {
    const cycles = Math.floor(time / motion.duration);
    const remainder = time - cycles * motion.duration;
    return (cycles * end + sampleTravel(motion, remainder)) / ENEMY_MOTION.unit;
  }
  return sampleTravel(motion, Math.min(time, motion.duration)) / ENEMY_MOTION.unit;
}

function sampleTravel(motion: EnemyClipMotion, time: number): number {
  if (time <= 0) return 0;
  const last = motion.travel.length - 1;
  if (time >= motion.duration || last <= 0) return motion.travel[last] ?? 0;
  const scaled = time * ENEMY_MOTION.sampleRate;
  const at = Math.min(Math.floor(scaled), last - 1);
  const startTime = at / ENEMY_MOTION.sampleRate;
  const endTime = Math.min((at + 1) / ENEMY_MOTION.sampleRate, motion.duration);
  const span = endTime - startTime;
  if (span <= 0) return motion.travel[at] ?? 0;
  const mix = (time - startTime) / span;
  return (motion.travel[at] ?? 0) + ((motion.travel[at + 1] ?? 0) - (motion.travel[at] ?? 0)) * mix;
}
