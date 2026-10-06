import type { HurtCause } from './hazards';
import { PluginError } from './plugins/kernel';

export type DeathKind = 'health' | 'fall';

// Borrowed until the next placement; copy the cause's fields to keep them.
export type DeathInfo =
  | { readonly kind: 'health'; readonly cause: Readonly<HurtCause> }
  | { readonly kind: 'fall' };

// Reused presentation input. The engine owns the fixed-step clock and the return to play.
export interface DeathFrame {
  readonly elapsed: number;
  readonly duration: number;
  readonly poseProgress: number;
  readonly reducedMotion: boolean;
}

export const DEATH_POSE_SECONDS = 0.65;

export class DeathSequenceError extends Error {
  readonly code = 'placement-failed';

  constructor() {
    super('The death sequence requested Reset, but the player was not placed anew.');
    this.name = 'DeathSequenceError';
  }
}

export function checkDeathCallback(result: unknown, plugin: string | null, point: string, method: string): void {
  if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
    typeof Reflect.get(result, 'then') === 'function') {
    throw new PluginError('invalid-contribution',
      `Plugin "${plugin ?? 'engine'}": "${point}" ${method} must finish synchronously, not return a promise.`, plugin, point);
  }
}

export function deathPluginFailure(error: unknown, plugin: string | null, point: string, method: string): unknown {
  if (error instanceof PluginError && error.plugin === plugin && error.point === point) return error;
  return new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed "${point}" ${method}.`,
    plugin, point, { cause: error });
}
