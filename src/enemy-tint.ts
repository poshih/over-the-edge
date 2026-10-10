import { ENEMY_BEHAVIOR } from './enemy-types';

// How enemies warn and flash, as pixel art and as models alike: a windup, a bird's before its dive or an archer's draw,
// pulses toward the warning colour, and a hurt enemy flashes white, fading as its hurt passes.
export const ENEMY_TINT = {
  warningColor: 0xffae53, warningPulseHz: 5, warningMinimum: 0.3, warningAmplitude: 0.4, hurtFlash: 0.9,
} as const;

// How far toward the warning colour an enemy `age` seconds into its windup is, 0 to 1.
export function warningTint(age: number): number {
  return ENEMY_TINT.warningMinimum +
    ENEMY_TINT.warningAmplitude * (0.5 + 0.5 * Math.sin(age * ENEMY_TINT.warningPulseHz * Math.PI * 2));
}

// How far toward white an enemy `age` seconds into its hurt is, 0 to 1.
export function hurtTint(age: number): number {
  const progress = Math.min(Math.max(age / ENEMY_BEHAVIOR.hurtSeconds, 0), 1);
  return (1 - progress * progress * (3 - 2 * progress)) * ENEMY_TINT.hurtFlash;
}
