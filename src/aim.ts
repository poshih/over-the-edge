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

/** Moves `aim`'s cursor by `delta` in place; movement beyond the cursor's reach is discarded. */
export function moveAim(aim: Aim, delta: Readonly<Point>, radius: number, deadZone: number): void {
  const cursor = aim.cursor;
  cursor.x += delta.x;
  cursor.y += delta.y;
  clampLength(cursor, radius + deadZone, cursor);
  followCursor(aim.target, cursor, radius, deadZone);
}

/** Limits `aim` in place: the target moves straight into the new radius, the cursor into its dead zone. */
export function limitAim(aim: Aim, radius: number, deadZone: number): void {
  const target = clampLength(aim.target, radius, aim.target);
  const cursor = aim.cursor;
  cursor.x -= target.x;
  cursor.y -= target.y;
  clampLength(cursor, deadZone, cursor);
  cursor.x = target.x + cursor.x;
  cursor.y = target.y + cursor.y;
}

/**
 * Moves `aim`'s target by (dx, dy) in place, staying inside the target radius, and its cursor as far, keeping its
 * place in the dead zone. The return to the hammer and a target that does not wholly follow the character move it so.
 */
export function shiftAim(aim: Aim, dx: number, dy: number, radius: number): void {
  const target = aim.target;
  const fromX = target.x, fromY = target.y;
  target.x += dx;
  target.y += dy;
  clampLength(target, radius, target);
  aim.cursor.x = aim.cursor.x + target.x - fromX;
  aim.cursor.y = aim.cursor.y + target.y - fromY;
}

/** Eases `aim` in place `blend` (0-1) of the way toward `point`, as the return to the hammer does. */
export function returnAim(aim: Aim, point: Readonly<Point>, blend: number, radius: number): void {
  shiftAim(aim, (point.x - aim.target.x) * blend, (point.y - aim.target.y) * blend, radius);
}

// The point nearest `target` that is within `radius` of the hinge and within `deadZone` of `cursor`.
// The cursor is within `radius + deadZone` of the hinge, so such points exist.
function followCursor(target: Point, cursor: Readonly<Point>, radius: number, deadZone: number): void {
  const dx = target.x - cursor.x;
  const dy = target.y - cursor.y;
  const gap = Math.hypot(dx, dy);
  if (gap <= deadZone) return;
  // The nearest point of the dead zone: its edge, on the old target's side.
  const edgeX = cursor.x + dx / gap * deadZone, edgeY = cursor.y + dy / gap * deadZone;
  const distance = Math.hypot(cursor.x, cursor.y);
  if (Math.hypot(edgeX, edgeY) <= radius || distance === 0) {
    target.x = edgeX; target.y = edgeY;
    clampLength(target, radius, target);
    return;
  }
  // Beyond the target radius: the nearest allowed point is one of the two where the dead zone's edge
  // crosses the target radius, so the target slides around the radius as the cursor sweeps past it.
  const along = (radius * radius - deadZone * deadZone + distance * distance) / (2 * distance);
  const across = Math.sqrt(Math.max(0, radius * radius - along * along));
  const ux = cursor.x / distance;
  const uy = cursor.y / distance;
  const firstX = ux * along - uy * across, firstY = uy * along + ux * across;
  const secondX = ux * along + uy * across, secondY = uy * along - ux * across;
  if (Math.hypot(firstX - target.x, firstY - target.y) <= Math.hypot(secondX - target.x, secondY - target.y)) {
    target.x = firstX; target.y = firstY;
  } else {
    target.x = secondX; target.y = secondY;
  }
}
