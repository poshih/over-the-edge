import { Vec2 } from 'planck';
import type { Body, Fixture, World } from 'planck';
import type { Point } from './config';

export type PartKind = 'root' | 'pot' | 'shoulder' | 'slider' | 'handle' | 'head';

// Artwork follows a point on a body, not necessarily that body's origin. Several rigid parts can
// share one body; physical ownership, momentum and destruction must use PlayerBody instead.
export interface PlayerPart {
  readonly id: string;
  readonly kind: PartKind;
  readonly body: Body;
  readonly localPoint: Readonly<Point>;
  readonly vertices: readonly Point[];
  readonly fixture?: Fixture;
}

// A part that collides. The hammer head's fixture and outline change when the hammer's head does.
export interface PlayerContactPart extends PlayerPart {
  fixture: Fixture;
  vertices: readonly Point[];
}

export interface PlayerBody {
  readonly id: string;
  readonly body: Body;
}

export class PlayerRigError extends Error {
  constructor(message: string) { super(message); this.name = 'PlayerRigError'; }
}

export function playerBody(world: World, options: {
  readonly id: string;
  readonly position: Readonly<Point>;
  readonly angle: number;
  readonly fixedRotation: boolean;
}): PlayerBody {
  return { id: options.id, body: world.createDynamicBody({
    position: new Vec2(options.position.x, options.position.y), angle: options.angle,
    bullet: true, allowSleep: false, fixedRotation: options.fixedRotation,
  }) };
}

export function partPoint(part: PlayerPart, out: Point): Point {
  const origin = part.body.getPosition();
  const angle = part.body.getAngle();
  const cos = Math.cos(angle), sin = Math.sin(angle);
  out.x = origin.x + cos * part.localPoint.x - sin * part.localPoint.y;
  out.y = origin.y + sin * part.localPoint.x + cos * part.localPoint.y;
  return out;
}

export function partVelocity(part: PlayerPart, out: Point): Point {
  const center = part.body.getLocalCenter();
  const velocity = part.body.getLinearVelocity();
  const angle = part.body.getAngle(), speed = part.body.getAngularVelocity();
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const x = part.localPoint.x - center.x, y = part.localPoint.y - center.y;
  out.x = velocity.x - speed * (sin * x + cos * y);
  out.y = velocity.y + speed * (cos * x - sin * y);
  return out;
}
