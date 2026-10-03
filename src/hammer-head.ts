// The hammer head's collision outline: one convex polygon around the head's centre, where the handle ends. Head-local
// metres: x runs along the handle, away from the butt, and y across it. The game settings hold the default hammer's
// head, and each model-library hammer carries its own. DOM-free, and its imports carry extensions, like the rig's, so
// Node scripts that validate profiles can load it.
import { RIG } from './config.ts';
import type { Point } from './config.ts';

// Counter-clockwise vertices, each rounded to the millimetre.
export type HammerHead = readonly Readonly<Point>[];

export const HAMMER_HEAD_LIMITS = {
  // Planck's polygons hold at most 12 vertices.
  vertices: { min: 3, max: 12 },
  // Every vertex lies within this distance of the head's centre.
  reach: 0.6,
  // Shorter edges collapse in the physics; smaller heads slip through terrain.
  edge: 0.02,
  area: 0.004,
  // The handle's end lies at least this far inside the outline.
  inset: 0.01,
} as const;

export class HammerHeadError extends Error {}

function millimetres(value: number): number {
  // Adding zero turns a rounded -0 into 0.
  return Math.round(value * 1000) / 1000 + 0;
}

function cross(a: Readonly<Point>, b: Readonly<Point>, c: Readonly<Point>): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * A head outline as stored: 3-12 vertices, counter-clockwise and strictly convex, every edge at least 2 cm long,
 * within reach of the head's centre and holding it at least 1 cm inside. Coordinates round to the millimetre.
 */
export function validateHammerHead(value: unknown): HammerHead {
  const { vertices, reach, edge, area, inset } = HAMMER_HEAD_LIMITS;
  if (!Array.isArray(value) || value.length < vertices.min || value.length > vertices.max) {
    throw new HammerHeadError(`A hammer head outline has ${vertices.min}-${vertices.max} points.`);
  }
  const points = value.map((item: unknown) => {
    const x = typeof item === 'object' && item !== null ? Reflect.get(item, 'x') : undefined;
    const y = typeof item === 'object' && item !== null ? Reflect.get(item, 'y') : undefined;
    if (typeof item !== 'object' || item === null || Object.keys(item).length !== 2 || typeof x !== 'number' || typeof y !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new HammerHeadError('Each hammer head point is { "x", "y" } in metres.');
    }
    const point = Object.freeze({ x: millimetres(x), y: millimetres(y) });
    if (Math.hypot(point.x, point.y) > reach) throw new HammerHeadError(`Hammer head points lie within ${reach} m of the head's centre.`);
    return point;
  });
  let twiceArea = 0;
  // The angle the outline turns through around the centre: once round for a simple outline.
  let winding = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const c = points[(index + 2) % points.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < edge) throw new HammerHeadError(`Hammer head edges are at least ${edge * 100} cm long.`);
    if (cross(a, b, c) <= 0) throw new HammerHeadError('A hammer head outline turns counter-clockwise and bulges outward at every point.');
    twiceArea += a.x * b.y - b.x * a.y;
    winding += Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    // How far inside this edge the head's centre lies.
    const depth = (a.x * b.y - a.y * b.x) / Math.hypot(b.x - a.x, b.y - a.y);
    if (depth < inset) throw new HammerHeadError(`A hammer head holds the handle's end at least ${inset * 100} cm inside.`);
  }
  if (Math.abs(winding - 2 * Math.PI) > 1e-6) throw new HammerHeadError('A hammer head outline goes round its centre once, without crossing itself.');
  if (twiceArea / 2 < area) throw new HammerHeadError(`A hammer head covers at least ${area * 10000} cm².`);
  return Object.freeze(points);
}

// The built-in sledge: the head every game starts with.
export const DEFAULT_HAMMER_HEAD: HammerHead = validateHammerHead(RIG.headVertices);

// The farthest the head reaches from its centre.
export function hammerHeadRadius(head: HammerHead): number {
  return Math.max(...head.map((point) => Math.hypot(point.x, point.y)));
}

// How far the head reaches back down the handle from its centre.
export function hammerHeadBack(head: HammerHead): number {
  return -Math.min(...head.map((point) => point.x));
}

export function sameHammerHead(left: HammerHead, right: HammerHead): boolean {
  return left === right || left.length === right.length && left.every((point, index) => point.x === right[index]!.x && point.y === right[index]!.y);
}
