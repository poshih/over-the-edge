import type { Tuning } from './config';

// The surfaces terrain can have, Rock by default. Each surface's bounciness is a game setting (Physics / Materials).
// A contact bounces as much as the bouncier of its two sides, Planck's rule, and only when they meet faster than
// Settings.velocityThreshold (1 m/s), so resting contacts stay still.
export const SURFACES = ['rock', 'wood', 'metal', 'ice', 'rubber'] as const;
export type Surface = (typeof SURFACES)[number];
export const DEFAULT_SURFACE: Surface = 'rock';

export const SURFACE_LABELS: Readonly<Record<Surface, string>> = {
  rock: 'Rock', wood: 'Wood', metal: 'Metal', ice: 'Ice', rubber: 'Rubber',
};

// Each surface's bounciness setting, in percent.
export const SURFACE_BOUNCINESS: Readonly<Record<Surface, keyof Tuning>> = {
  rock: 'rockBounciness', wood: 'woodBounciness', metal: 'metalBounciness', ice: 'iceBounciness', rubber: 'rubberBounciness',
};

// Each surface's restitution, its bounciness as a fraction.
export type SurfaceRestitution = Readonly<Record<Surface, number>>;

export function surfaceRestitution(tuning: Readonly<Tuning>): SurfaceRestitution {
  return Object.freeze(Object.fromEntries(SURFACES.map((surface) => [surface, tuning[SURFACE_BOUNCINESS[surface]] / 100]))) as SurfaceRestitution;
}

export function sameSurfaceRestitution(left: SurfaceRestitution, right: SurfaceRestitution): boolean {
  return SURFACES.every((surface) => left[surface] === right[surface]);
}

export function isSurface(value: unknown): value is Surface {
  return (SURFACES as readonly unknown[]).includes(value);
}
