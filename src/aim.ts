import type { Point } from './config';
import { clampLength } from './math';

/**
 * The hammer's aim, relative to the shoulder hinge it pivots on. The cursor is where input has moved;
 * the target is where the hinge and slider motors drive the head. The target never leaves the target
 * radius, and follows the cursor with slack: it holds while the cursor moves within the dead zone
 * around it, and moves only as far as it must to keep the cursor inside that dead zone. The cursor can
 * therefore go at most the dead zone beyond the target radius.
 */
export interface Aim {
  readonly cursor: Point;
  readonly target: Point;
}

/** An aim at `point`, with the cursor on the target, inside the target radius. */
export function aimAt(point: Readonly<Point>, radius: number): Aim {
  const target = clampLength(point, radius);
  return { cursor: { ...target }, target };
}

/** The aim after input moves the cursor by `delta`; movement beyond the cursor's reach is discarded. */
export function moveAim(aim: Aim, delta: Readonly<Point>, radius: number, deadZone: number): Aim {
  const cursor = clampLength({ x: aim.cursor.x + delta.x, y: aim.cursor.y + delta.y }, radius + deadZone);
  return { cursor, target: followCursor(aim.target, cursor, radius, deadZone) };
}

/** The aim within a new target radius and dead zone: the target moves straight in, the cursor into its dead zone. */
export function limitAim(aim: Aim, radius: number, deadZone: number): Aim {
  const target = clampLength(aim.target, radius);
  const offset = clampLength({ x: aim.cursor.x - target.x, y: aim.cursor.y - target.y }, deadZone);
  return { cursor: { x: target.x + offset.x, y: target.y + offset.y }, target };
}

// The point nearest `target` that is within `radius` of the hinge and within `deadZone` of `cursor`.
// The cursor is within `radius + deadZone` of the hinge, so such points exist.
function followCursor(target: Readonly<Point>, cursor: Readonly<Point>, radius: number, deadZone: number): Point {
  const dx = target.x - cursor.x;
  const dy = target.y - cursor.y;
  const gap = Math.hypot(dx, dy);
  if (gap <= deadZone) return { x: target.x, y: target.y };
  // The nearest point of the dead zone: its edge, on the old target's side.
  const edge = { x: cursor.x + dx / gap * deadZone, y: cursor.y + dy / gap * deadZone };
  const distance = Math.hypot(cursor.x, cursor.y);
  if (Math.hypot(edge.x, edge.y) <= radius || distance === 0) return clampLength(edge, radius);
  // Beyond the target radius: the nearest allowed point is one of the two where the dead zone's edge
  // crosses the target radius, so the target slides around the radius as the cursor sweeps past it.
  const along = (radius * radius - deadZone * deadZone + distance * distance) / (2 * distance);
  const across = Math.sqrt(Math.max(0, radius * radius - along * along));
  const ux = cursor.x / distance;
  const uy = cursor.y / distance;
  const first = { x: ux * along - uy * across, y: uy * along + ux * across };
  const second = { x: ux * along + uy * across, y: uy * along - ux * across };
  return Math.hypot(first.x - target.x, first.y - target.y) <= Math.hypot(second.x - target.x, second.y - target.y)
    ? first : second;
}
