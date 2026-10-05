import type { Tuning } from './config';

// Still liquid in a level's pools. A pool never collides: the player floats on it or sinks into it, slowed as it moves,
// and lava burns the character too. How much each liquid lifts, slows and burns is a game setting (Physics / Liquids),
// like a terrain surface's friction; a pool only places its liquid.

export const LIQUIDS = ['lava', 'swamp'] as const;
export type Liquid = (typeof LIQUIDS)[number];
export const LIQUID_LABELS: Readonly<Record<Liquid, string>> = { lava: 'Lava', swamp: 'Swamp' };

export const LIQUID_LIMITS = { pools: 64, minimumSize: 0.5, maximumSize: 1024 } as const;

// Each liquid's settings: its buoyancy, the share of the player's weight it holds up with the pot all under its
// surface, in percent; and its drag, the rate it then slows the player at, per second.
export const LIQUID_SETTINGS = {
  lava: { buoyancy: 'lavaBuoyancy', drag: 'lavaDrag' },
  swamp: { buoyancy: 'swampBuoyancy', drag: 'swampDrag' },
} as const satisfies Readonly<Record<Liquid, { readonly buoyancy: keyof Tuning; readonly drag: keyof Tuning }>>;
