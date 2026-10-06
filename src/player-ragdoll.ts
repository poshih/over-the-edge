import { Polygon, RevoluteJoint, Vec2 } from 'planck';
import type { Body, World } from 'planck';
import { ARM_SIDES } from './character';
import type { ArmSide } from './character';
import { PHYSICS } from './config';
import type { Point, Tuning } from './config';
import type { DeathSettings } from './game-settings';
import { playerBody } from './player-bodies';
import type { PlayerBody, PlayerPart } from './player-bodies';
import { PLAYER_FIGURE } from './player-figure-data';
import type { DeathPose, DeathSeed, Transform2 } from './player-pose';
import { validDeathPose, validHeadFacing } from './player-pose';

export type PlayerDeathErrorCode = 'locked-world' | 'stale-seed' | 'repeated-entry' | 'invalid-seed' |
  'construction-failed' | 'phase-mismatch';
export class PlayerDeathError extends Error {
  readonly code: PlayerDeathErrorCode;
  constructor(code: PlayerDeathErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'PlayerDeathError'; this.code = code;
  }
}

const MINIMUM_SEGMENT = 0.04;
const MASS_SHARES = { torso: 0.60, head: 0.16, upper: 0.08, forearm: 0.04 } as const;
const LIMITS = { waist: 110, neck: 65, shoulder: 170, elbow: 150 } as const;
const ORIGIN = Object.freeze({ x: 0, y: 0 });

interface Segment {
  readonly body: Body;
  readonly half: number;
}
interface PhysicalArm { readonly upper: Segment; readonly forearm: Segment }
export interface PhysicalRagdoll {
  readonly bodies: readonly PlayerBody[];
  readonly parts: readonly PlayerPart[];
  readonly torso: Body;
  readonly head: Body;
  readonly arms: Readonly<Record<ArmSide, PhysicalArm>>;
}

function finitePoint(value: unknown): value is Readonly<Point> {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Point;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
export function validateDeathSeed(seed: DeathSeed, placement: number, time: number): void {
  if (seed === null || typeof seed !== 'object' || !validDeathPose(seed.pose) || !validHeadFacing(seed.headFacing) ||
    !finitePoint(seed.centre) || typeof seed.layout !== 'object' || seed.layout === null ||
    !finitePoint(seed.layout.waist) || !finitePoint(seed.layout.neck)) {
    throw new PlayerDeathError('invalid-seed', 'A death seed must contain the complete character layout, pose and facial quaternion.');
  }
  if (seed.placement !== placement || seed.time !== time) {
    throw new PlayerDeathError('stale-seed', 'The death seed must belong to the terminal step of this placement.');
  }
  const pose = seed.pose;
  let valid = finitePoint(seed.centre) && Number.isFinite(seed.centre.angle) &&
    finitePoint(seed.layout.waist) && finitePoint(seed.layout.neck) &&
    Math.hypot(seed.layout.waist.x, seed.layout.waist.y) <= 32 && Math.hypot(seed.layout.neck.x, seed.layout.neck.y) <= 32 &&
    Math.hypot(pose.torso.x - seed.centre.x, pose.torso.y - seed.centre.y) <= 32 &&
    Math.hypot(pose.head.x - pose.torso.x, pose.head.y - pose.torso.y) <= 32 &&
    (seed.direction === -1 || seed.direction === 1);
  for (const side of ARM_SIDES) {
    const arm = pose.arms[side];
    valid = valid && finitePoint(arm.shoulder) && finitePoint(arm.elbow) && finitePoint(arm.hand) && Number.isFinite(arm.hand.angle) &&
      Math.hypot(arm.elbow.x - arm.shoulder.x, arm.elbow.y - arm.shoulder.y) <= 32 &&
      Math.hypot(arm.hand.x - arm.elbow.x, arm.hand.y - arm.elbow.y) <= 32 &&
      Math.hypot(arm.shoulder.x - pose.torso.x, arm.shoulder.y - pose.torso.y) <= 32;
  }
  if (!valid) throw new PlayerDeathError('invalid-seed', 'A death seed needs finite, bounded character joints and a unit facial quaternion.');
}

function ellipse(x: number, y: number, rx: number, ry: number): Point[] {
  return Array.from({ length: 8 }, (_, index) => ({
    x: x + Math.cos(index * Math.PI / 4) * rx, y: y + Math.sin(index * Math.PI / 4) * ry,
  }));
}
function capsule(half: number, radius: number): Point[] {
  return [
    { x: -half - radius, y: -radius / 2 }, { x: -half, y: -radius },
    { x: half, y: -radius }, { x: half + radius, y: -radius / 2 },
    { x: half + radius, y: radius / 2 }, { x: half, y: radius },
    { x: -half, y: radius }, { x: -half - radius, y: radius / 2 },
  ];
}
function worldPoint(frame: Readonly<Transform2>, local: Readonly<Point>): Point {
  const cos = Math.cos(frame.angle), sin = Math.sin(frame.angle);
  return { x: frame.x + cos * local.x - sin * local.y, y: frame.y + sin * local.x + cos * local.y };
}

// Construction is once, between world steps. Provisional bodies own their joints and are rolled
// back together if construction fails; the live assembly is untouched until this returns.
export function createRagdoll(world: World, pot: Body, root: Body, seed: DeathSeed,
  tuning: Readonly<Tuning>, settings: Readonly<DeathSettings>): PhysicalRagdoll {
  const bodies: PlayerBody[] = [], parts: PlayerPart[] = [];
  const mass = root.getMass(), velocity = root.getLinearVelocity();
  const create = (id: string, kind: PlayerPart['kind'], transform: Readonly<Transform2>,
    vertices: readonly Point[], share: number): Body => {
    const owned = playerBody(world, { id, position: transform, angle: transform.angle, fixedRotation: false, allowSleep: true });
    bodies.push(owned);
    const body = owned.body;
    const fixture = body.createFixture(new Polygon(vertices.map(point => new Vec2(point.x, point.y))), {
      density: 1, friction: settings.friction, restitution: 0,
      filterCategoryBits: PHYSICS.playerCategory, filterMaskBits: PHYSICS.terrainCategory | PHYSICS.enemyCategory,
    });
    const data = { mass: 0, center: new Vec2(), I: 0 };
    body.getMassData(data);
    if (data.mass <= 0 || data.I <= 0) throw new PlayerDeathError('construction-failed', `Corpse body "${id}" has no mass or inertia.`);
    data.I *= mass * share / data.mass; data.mass = mass * share;
    body.setMassData(data);
    body.setLinearVelocity(velocity);
    body.setAngularVelocity(0);
    body.setLinearDamping(tuning.bodyDamping);
    body.setAngularDamping(settings.angularDamping);
    parts.push({ id, kind, body, localPoint: ORIGIN, vertices, fixture });
    return body;
  };
  const join = (a: Body, b: Body, anchor: Readonly<Point>, limit: number): void => {
    const angle = limit * Math.PI / 180;
    const joint = world.createJoint(new RevoluteJoint({
      bodyA: a, bodyB: b, localAnchorA: a.getLocalPoint(anchor), localAnchorB: b.getLocalPoint(anchor),
      referenceAngle: b.getAngle() - a.getAngle(), enableLimit: true, lowerAngle: -angle, upperAngle: angle,
      enableMotor: false, collideConnected: false,
    }));
    if (joint === null) throw new PlayerDeathError('construction-failed', 'Could not attach a passive corpse joint.');
  };
  const segment = (id: string, kind: 'upper-arm' | 'forearm', from: Readonly<Point>, to: Readonly<Point>,
    radius: number, share: number): Segment => {
    const dx = to.x - from.x, dy = to.y - from.y;
    // An end-on 3D segment has a deliberately bounded course-plane projection, not a degenerate
    // collider. atan2(0, 0) defines the entry's +X projection when both components vanish.
    const angle = Math.atan2(dy, dx), half = Math.max(MINIMUM_SEGMENT, Math.hypot(dx, dy)) / 2;
    const body = create(id, kind, { x: from.x + half * Math.cos(angle), y: from.y + half * Math.sin(angle), angle },
      capsule(half, radius), share);
    return { body, half };
  };
  try {
    const { chest, helmet } = PLAYER_FIGURE;
    const torso = create('torso', 'torso', seed.pose.torso,
      ellipse(0, chest.y, chest.radius * chest.scale[0], chest.radius * chest.scale[1]), MASS_SHARES.torso);
    const head = create('character-head', 'character-head', seed.pose.head,
      ellipse(0, 0, helmet.radius, helmet.radius * helmet.scaleY), MASS_SHARES.head);
    join(pot, torso, worldPoint(seed.pose.torso, seed.layout.waist), LIMITS.waist);
    join(torso, head, worldPoint(seed.pose.torso, seed.layout.neck), LIMITS.neck);
    const arms = {} as Record<ArmSide, PhysicalArm>;
    for (const side of ARM_SIDES) {
      const pose = seed.pose.arms[side];
      const upper = segment(`${side}-upper-arm`, 'upper-arm', pose.shoulder, pose.elbow, PLAYER_FIGURE.elbow, MASS_SHARES.upper);
      const elbow = upper.body.getWorldPoint({ x: upper.half, y: 0 });
      // Carry the forearm's captured vector to the normalised elbow, so a short projection can
      // move the wrist by at most two minimum segments, without moving the jar or tool.
      const hand = { x: elbow.x + pose.hand.x - pose.elbow.x, y: elbow.y + pose.hand.y - pose.elbow.y };
      const forearm = segment(`${side}-forearm`, 'forearm', elbow, hand, PLAYER_FIGURE.hand, MASS_SHARES.forearm);
      join(torso, upper.body, pose.shoulder, LIMITS.shoulder);
      join(upper.body, forearm.body, elbow, LIMITS.elbow);
      arms[side] = { upper, forearm };
    }
    return { bodies, parts, torso, head, arms };
  } catch (error) {
    const failures: PlayerDeathError[] = [];
    for (let index = bodies.length - 1; index >= 0; index--) {
      const owned = bodies[index]!;
      if (!world.destroyBody(owned.body)) failures.push(new PlayerDeathError('construction-failed', `Could not remove provisional corpse body "${owned.id}".`));
    }
    if (failures.length > 0) {
      throw new PlayerDeathError('construction-failed', 'Corpse construction and cleanup failed.',
        { cause: new AggregateError([error, ...failures], 'Failed corpse construction.') });
    }
    if (error instanceof PlayerDeathError) throw error;
    throw new PlayerDeathError('construction-failed', 'Could not construct the passive corpse.', { cause: error });
  }
}

function endpoint(segment: Segment, sign: -1 | 1, out: Point): void {
  const origin = segment.body.getPosition(), angle = segment.body.getAngle();
  out.x = origin.x + sign * segment.half * Math.cos(angle);
  out.y = origin.y + sign * segment.half * Math.sin(angle);
}
function transform(body: Body, out: Transform2): void {
  const position = body.getPosition(); out.x = position.x; out.y = position.y; out.angle = body.getAngle();
}
export function writeRagdollPose(ragdoll: PhysicalRagdoll, out: DeathPose): void {
  transform(ragdoll.torso, out.torso); transform(ragdoll.head, out.head);
  for (const side of ARM_SIDES) {
    const arm = ragdoll.arms[side], pose = out.arms[side];
    endpoint(arm.upper, -1, pose.shoulder); endpoint(arm.upper, 1, pose.elbow);
    endpoint(arm.forearm, 1, pose.hand); pose.hand.angle = arm.forearm.body.getAngle();
  }
}
