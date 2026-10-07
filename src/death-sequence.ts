import type { HurtCause } from './hazards';

export type DeathKind = 'health' | 'fall';

// Borrowed until the next placement; copy the cause's fields to keep them.
export type DeathInfo =
  | { readonly kind: 'health'; readonly cause: Readonly<HurtCause> }
  | { readonly kind: 'fall' };

// Reused presentation input. The engine owns the fixed-step clock and the return to play.
export interface DeathFrame {
  readonly elapsed: number;
  // The game settings' death.wait, captured at entry; independent of the HUD fade.
  readonly duration: number;
  readonly poseProgress: number;
  readonly reducedMotion: boolean;
}

export const DEATH_POSE_SECONDS = 0.65;

export type DeathSequenceErrorCode = 'placement-failed' | 'placement-changed';

export class DeathSequenceError extends Error {
  readonly code: DeathSequenceErrorCode;

  constructor(code: DeathSequenceErrorCode) {
    super(code === 'placement-failed'
      ? 'The death sequence requested Reset, but the player was not placed anew.'
      : 'The player was placed anew without cancelling the active death sequence.');
    this.name = 'DeathSequenceError';
    this.code = code;
  }
}
