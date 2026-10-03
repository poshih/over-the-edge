import type { Tuning } from './config';

// The surfaces terrain can have, Rock by default. Each surface's friction and bounciness are game settings (Physics /
// Materials). A contact's friction is the geometric mean of its two sides', and it bounces as much as the bouncier
// side, Planck's rules, only when they meet faster than Settings.velocityThreshold (1 m/s), so resting contacts stay still.
export const SURFACES = ['rock', 'wood', 'metal', 'ice', 'rubber'] as const;
export type Surface = (typeof SURFACES)[number];
export const DEFAULT_SURFACE: Surface = 'rock';

export const SURFACE_LABELS: Readonly<Record<Surface, string>> = {
  rock: 'Rock', wood: 'Wood', metal: 'Metal', ice: 'Ice', rubber: 'Rubber',
};

// Each surface's settings: its friction coefficient and its bounciness, in percent.
export const SURFACE_SETTINGS: Readonly<Record<Surface, { readonly friction: keyof Tuning; readonly bounciness: keyof Tuning }>> = {
  rock: { friction: 'rockFriction', bounciness: 'rockBounciness' },
  wood: { friction: 'woodFriction', bounciness: 'woodBounciness' },
  metal: { friction: 'metalFriction', bounciness: 'metalBounciness' },
  ice: { friction: 'iceFriction', bounciness: 'iceBounciness' },
  rubber: { friction: 'rubberFriction', bounciness: 'rubberBounciness' },
};

// A surface's contact material: its friction coefficient and its restitution, its bounciness as a fraction.
export interface SurfaceMaterial {
  readonly friction: number;
  readonly restitution: number;
}

export type SurfaceMaterials = Readonly<Record<Surface, SurfaceMaterial>>;

export function surfaceMaterials(tuning: Readonly<Tuning>): SurfaceMaterials {
  return Object.freeze(Object.fromEntries(SURFACES.map((surface) => [surface, Object.freeze({
    friction: tuning[SURFACE_SETTINGS[surface].friction],
    restitution: tuning[SURFACE_SETTINGS[surface].bounciness] / 100,
  })]))) as SurfaceMaterials;
}

export function sameSurfaceMaterials(left: SurfaceMaterials, right: SurfaceMaterials): boolean {
  return SURFACES.every((surface) =>
    left[surface].friction === right[surface].friction && left[surface].restitution === right[surface].restitution);
}

export function isSurface(value: unknown): value is Surface {
  return (SURFACES as readonly unknown[]).includes(value);
}
