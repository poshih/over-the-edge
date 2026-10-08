// The jar's collision outline: one convex polygon around the player's root, which it holds, in root-local metres: x
// runs right and y up. The game settings hold it; the jar's drawing, its bottom, its hurt box and its buoyancy follow
// it. DOM-free, and its imports carry extensions, like the rig's, so Node scripts that validate settings can load it.
import { RIG } from './config.ts';
import type { Point } from './config.ts';

// Counter-clockwise vertices, each rounded to the millimetre.
export type PotOutline = readonly Readonly<Point>[];

export const POT_OUTLINE_LIMITS = {
  // Planck's polygons hold at most 12 vertices.
  vertices: { min: 3, max: 12 },
  // Every vertex lies within this distance of the root.
  reach: 1,
  // Shorter edges collapse in the physics; smaller jars slip through terrain.
  edge: 0.02,
  area: 0.05,
  // The root lies at least this far inside the outline.
  inset: 0.05,
  // The jar's top stays at least this far below the shoulder hinge, where the hammer turns and the body rises.
  shoulder: 0.1,
} as const;

export class PotOutlineError extends Error {}

function millimetres(value: number): number {
  // Adding zero turns a rounded -0 into 0.
  return Math.round(value * 1000) / 1000 + 0;
}

// The highest the jar may reach, above the root.
export const POT_OUTLINE_TOP = millimetres(RIG.shoulder.y - POT_OUTLINE_LIMITS.shoulder);

function cross(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Point>): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * A jar outline as stored: 3-12 vertices, counter-clockwise and strictly convex, every edge at least 2 cm long, within
 * reach of the root, holding it at least 5 cm inside and staying 10 cm below the shoulder hinge. Coordinates round to
 * the millimetre.
 */
export function validatePotOutline(value: unknown): PotOutline {
  const { vertices, reach, edge, area, inset } = POT_OUTLINE_LIMITS;
  if (!Array.isArray(value) || value.length < vertices.min || value.length > vertices.max) {
    throw new PotOutlineError(`A jar outline has ${vertices.min}-${vertices.max} points.`);
  }
  const points = value.map((item: unknown) => {
    const x = typeof item === 'object' && item !== null ? Reflect.get(item, 'x') : undefined;
    const y = typeof item === 'object' && item !== null ? Reflect.get(item, 'y') : undefined;
    if (typeof item !== 'object' || item === null || Object.keys(item).length !== 2 || typeof x !== 'number' || typeof y !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new PotOutlineError('Each jar point is { "x", "y" } in metres.');
    }
    const point = Object.freeze({ x: millimetres(x), y: millimetres(y) });
    if (Math.hypot(point.x, point.y) > reach) throw new PotOutlineError(`Jar points lie within ${reach} m of the player's root.`);
    if (point.y > POT_OUTLINE_TOP) {
      throw new PotOutlineError(`The jar stays ${POT_OUTLINE_LIMITS.shoulder * 100} cm below the shoulder hinge, at most ${
        POT_OUTLINE_TOP} m above the root.`);
    }
    return point;
  });
  let twiceArea = 0;
  // The angle the outline turns through around the root: once round for a simple outline.
  let winding = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const c = points[(index + 2) % points.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < edge) throw new PotOutlineError(`Jar edges are at least ${edge * 100} cm long.`);
    if (cross(a, b, c) <= 0) throw new PotOutlineError('A jar outline turns counter-clockwise and bulges outward at every point.');
    twiceArea += a.x * b.y - b.x * a.y;
    winding += Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    // How far inside this edge the root lies.
    const depth = (a.x * b.y - a.y * b.x) / Math.hypot(b.x - a.x, b.y - a.y);
    if (depth < inset) throw new PotOutlineError(`A jar holds the player's root at least ${inset * 100} cm inside.`);
  }
  if (Math.abs(winding - 2 * Math.PI) > 1e-6) throw new PotOutlineError('A jar outline goes round the root once, without crossing itself.');
  if (twiceArea / 2 < area) throw new PotOutlineError(`A jar covers at least ${area * 10000} cm².`);
  return Object.freeze(points);
}

// The built-in jar: the one every game starts with.
export const DEFAULT_POT_OUTLINE: PotOutline = validatePotOutline([
  { x: -0.2, y: -0.48 }, { x: 0.2, y: -0.48 },
  { x: 0.44, y: -0.29 }, { x: 0.5, y: 0.12 },
  { x: 0.43, y: 0.32 }, { x: -0.43, y: 0.32 },
  { x: -0.5, y: 0.12 }, { x: -0.44, y: -0.29 },
]);

/** What the rest of the game measures from a jar outline. */
export interface PotMeasures {
  // The lowest and highest points' heights about the root: the jar's base and its top, where the body rises from it.
  readonly bottom: number;
  readonly top: number;
  // The farthest it reaches either side of the root, and from the root.
  readonly halfWidth: number;
  readonly radius: number;
  // Square metres: the player's volume, which liquids' buoyancy and drag are set against.
  readonly area: number;
}

export function potMeasures(outline: PotOutline): PotMeasures {
  let twiceArea = 0;
  for (let index = 0; index < outline.length; index++) {
    const a = outline[index]!, b = outline[(index + 1) % outline.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return Object.freeze({
    bottom: Math.min(...outline.map((point) => point.y)),
    top: Math.max(...outline.map((point) => point.y)),
    halfWidth: Math.max(...outline.map((point) => Math.abs(point.x))),
    radius: Math.max(...outline.map((point) => Math.hypot(point.x, point.y))),
    area: twiceArea / 2,
  });
}

/** Where the outline crosses the height `y` between its bottom and top: its left and right edges, written to `out`. */
export function potSpan(outline: PotOutline, y: number, out: { left: number; right: number }): { left: number; right: number } {
  let left = Infinity, right = -Infinity;
  for (let index = 0; index < outline.length; index++) {
    const a = outline[index]!, b = outline[(index + 1) % outline.length]!;
    const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y);
    if (y < low || y > high) continue;
    if (a.y === b.y) {
      left = Math.min(left, a.x, b.x);
      right = Math.max(right, a.x, b.x);
      continue;
    }
    const x = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  out.left = left;
  out.right = right;
  return out;
}

export function samePotOutline(left: PotOutline, right: PotOutline): boolean {
  return left === right || left.length === right.length && left.every((point, index) => point.x === right[index]!.x && point.y === right[index]!.y);
}
