import { PHYSICS } from './config';
import type { PlayerSpawn, Point } from './config';
import type { AxeObject, StartObject } from './level';

// What hurts the player, and the bonfires that bring a fallen player back. Traps never collide: they hurt the
// character as it is drawn, the pot and the body standing in it, and knock it away.

export const HAZARD_LIMITS = { bonfires: 32, traps: 128 } as const;

// What hurt the player: an enemy's bump, a trap's or an archer's projectile, an axe's blade or a lava pool. Swamp
// never hurts.
export const HURT_SOURCES = ['enemy', 'projectile', 'axe', 'lava'] as const;
export type HurtSource = (typeof HURT_SOURCES)[number];

// What flies: a trap's bolt, straight, or an archer's arrow, falling as it flies.
export const PROJECTILE_KINDS = ['bolt', 'arrow'] as const;
export type ProjectileKind = (typeof PROJECTILE_KINDS)[number];

// A hit's cause: its source and the ID of the level object that dealt it, for a projectile the trap or archer that
// fired it; where it struck, in world metres; and the velocity it knocked the player with, in m/s, none for lava.
export interface HurtCause {
  readonly source: HurtSource;
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly pushX: number;
  readonly pushY: number;
}

export interface ProjectileBlock {
  // The ID of the level object that fired the projectile: a projectile trap or an archer.
  readonly id: string;
  // Where the bolt struck the hammer head, in world metres.
  readonly x: number;
  // Where the bolt struck the hammer head, in world metres.
  readonly y: number;
  // The projectile's unit flight direction, x component.
  readonly directionX: number;
  // The projectile's unit flight direction, y component.
  readonly directionY: number;
  // The head's outward unit surface normal at the strike, x component.
  readonly normalX: number;
  // The head's outward unit surface normal at the strike, y component.
  readonly normalY: number;
}

export const BONFIRE = {
  // The player's foot lights a bonfire this near its base.
  reach: 1.5,
  // A fallen player comes back with the jar's base this high above the bonfire's base, clear of the ground it stands on.
  spawnClearance: 0.17,
  // The drawn fire, standing on its base.
  width: 1.2, height: 1.3,
} as const;

export const SHOOTER = {
  // A trap's bolt flies at most this far, and a trap fires only while the player's root is this near it.
  range: 40,
  // Projectiles in flight at once across the level, traps' bolts and archers' arrows alike; a shot is skipped while
  // they all fly.
  projectiles: 256,
  // The drawn trap, its muzzle on its position facing along its angle: how far its body reaches back, and its height.
  length: 0.9, height: 0.7,
  // The drawn projectile, its tip on its position.
  boltLength: 0.55, boltRadius: 0.05,
} as const;

export const ARROW = {
  // An arrow flies at most this far along its falling arc, in m.
  range: 80,
  // How fast an arrow falls, as everything else does, in m/s².
  gravity: PHYSICS.gravity,
  // The drawn arrow, its tip on its position: its length and its shaft's radius.
  length: 0.75, radius: 0.022,
} as const;

export const SHOOTER_FIELDS = {
  interval: { label: 'Shot interval', min: 0.5, max: 20, step: 0.1, unit: 's' },
  delay: { label: 'First shot', min: 0, max: 20, step: 0.1, unit: 's' },
  speed: { label: 'Projectile speed', min: 2, max: 30, step: 0.5, unit: 'm/s' },
  damage: { label: 'Damage', min: 1, max: 1000, step: 1, unit: 'HP' },
} as const;

export const AXE = {
  // The widest swing either side of hanging straight down, in radians.
  amplitude: 1.1,
  // The blade lies in the plane of its swing, its curved edge below leading the cut, so it is edge-on to the camera: its
  // width runs across the obstacle line, toward the camera and away, its height along the haft, centred the axe's
  // length below the pivot, and its thickness along the line.
  bladeWidth: 1.3, bladeHeight: 0.7, bladeThickness: 0.06,
} as const;

export const AXE_FIELDS = {
  length: { label: 'Length', min: 1.5, max: 12, step: 0.1, unit: 'm' },
  period: { label: 'Swing period', min: 1, max: 12, step: 0.1, unit: 's' },
  offset: { label: 'Swing offset', min: 0, max: 12, step: 0.1, unit: 's' },
  damage: { label: 'Damage', min: 1, max: 1000, step: 1, unit: 'HP' },
} as const;

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// An axe swings in and out of the view, turning about the obstacle line's direction through its pivot: positive
// angles carry the blade away from the camera. It hangs straight down, through the line, at its offset and every
// half period after.
export function axeAngle(axe: Pick<AxeObject, 'period' | 'offset'>, time: number): number {
  return AXE.amplitude * Math.sin(2 * Math.PI * (time - axe.offset) / axe.period);
}

// The part of the blade within `halfDepth` of the obstacle line at `angle`, as the camera sees it, written to `out`;
// false when the whole blade is further from the line.
// The blade's corners, in order around it: along the haft (-1 nearer the pivot), and across the obstacle line.
const BLADE_ALONG = [-1, -1, 1, 1] as const;
const BLADE_ACROSS = [-1, 1, 1, -1] as const;

export function axeBlade(axe: AxeObject, angle: number, halfDepth: number, out: Bounds): boolean {
  // The blade turns in the plane across the line, so what lies within reach of the line is its rectangle clipped to the
  // slab |z| <= halfDepth: the corners inside it and where its sides cross the slab's faces.
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let minY = Infinity;
  let maxY = -Infinity;
  let lastY = 0;
  let lastZ = 0;
  for (let index = 0; index <= BLADE_ALONG.length; index++) {
    const corner = index % BLADE_ALONG.length;
    const along = axe.length + BLADE_ALONG[corner]! * AXE.bladeHeight / 2;
    const across = BLADE_ACROSS[corner]! * AXE.bladeWidth / 2;
    // Hanging at (0, -along, across) from the pivot, turned about the x axis as the axes' shader turns it.
    const y = -along * cos - across * sin;
    const z = -along * sin + across * cos;
    if (index > 0) {
      for (let face = -1; face <= 1; face += 2) {
        const bound = face * halfDepth;
        if ((lastZ - bound) * (z - bound) >= 0) continue;
        const crossing = lastY + (y - lastY) * (bound - lastZ) / (z - lastZ);
        minY = Math.min(minY, crossing);
        maxY = Math.max(maxY, crossing);
      }
    }
    if (index < BLADE_ALONG.length && Math.abs(z) <= halfDepth) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    lastY = y;
    lastZ = z;
  }
  if (minY > maxY) return false;
  out.minX = axe.x - AXE.bladeThickness / 2;
  out.maxX = axe.x + AXE.bladeThickness / 2;
  out.minY = axe.y + minY;
  out.maxY = axe.y + maxY;
  return true;
}

// Everywhere the blade passes within `halfDepth` of the obstacle line.
export function axeReach(axe: AxeObject, halfDepth: number): Bounds {
  const near = axe.length - AXE.bladeHeight / 2;
  const far = axe.length + AXE.bladeHeight / 2;
  const across = AXE.bladeWidth / 2;
  // Swung further than this, even the blade's corner nearest the line is beyond the slab.
  const steepest = Math.min(AXE.amplitude, Math.atan2(across, near) + Math.asin(Math.min(1, halfDepth / Math.hypot(near, across))));
  return {
    minX: axe.x - AXE.bladeThickness / 2, maxX: axe.x + AXE.bladeThickness / 2,
    minY: axe.y - Math.hypot(far, across), maxY: axe.y - near * Math.cos(steepest) + across * Math.sin(steepest),
  };
}

// Where a fallen player comes back at a bonfire, holding the hammer as at the level's start. `jarBottom` is the jar's base
// below the player's root (negative).
export function bonfireSpawn(bonfire: Readonly<Point>, start: Pick<StartObject, 'angle' | 'reach'>, jarBottom: number): PlayerSpawn {
  return { position: { x: bonfire.x, y: bonfire.y + BONFIRE.spawnClearance - jarBottom }, angle: start.angle, reach: start.reach };
}
