import { Polygon, RevoluteJoint, Vec2 } from 'planck';
import type { Body, World } from 'planck';
import { ARM_SIDES } from './character';
import type { ArmSide } from './character';
import type { CharacterFigure } from './character-figure';
import { PHYSICS } from './config';
import type { Point, Tuning } from './config';
import type { DeathSettings } from './game-settings';
import { playerBody } from './player-bodies';
import type { PlayerBody, PlayerPart } from './player-bodies';
import { PLAYER_FIGURE } from './player-figure-data';
import type { DeathPose, ReadonlyDeathPose, Transform2 } from './player-pose';

export type PlayerDeathErrorCode = 'locked-world' | 'repeated-entry' | 'construction-failed' | 'phase-mismatch';
export class PlayerDeathError extends Error {
  readonly code: PlayerDeathErrorCode;
  constructor(code: PlayerDeathErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'PlayerDeathError'; this.code = code;
  }
}

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
// `waist` is the jar's top above the root, where the torso joins it.
export function createRagdoll(world: World, pot: Body, root: Body, entry: ReadonlyDeathPose,
  figure: Readonly<CharacterFigure>, tuning: Readonly<Tuning>, settings: Readonly<DeathSettings>, waist: number): PhysicalRagdoll {
  const bodies: PlayerBody[] = [], parts: PlayerPart[] = [];
  const mass = root.getMass(), velocity = root.getLinearVelocity();
  const create = (id: string, kind: PlayerPart['kind'], transform: Readonly<Transform2>,
    vertices: readonly Point[], share: number): Body => {
    const owned = playerBody(world, { id, position: transform, angle: transform.angle, fixedRotation: false, allowSleep: true });
    bodies.push(owned);
    const body = owned.body;
    const fixture = body.createFixture(new Polygon(vertices.map(point => new Vec2(point.x, point.y))), {
      density: 1, friction: settings.friction, restitution: 0,
      filterCategoryBits: PHYSICS.playerCategory, filterMaskBits: PHYSICS.terrainCategory,
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
    const angle = Math.atan2(dy, dx), half = Math.hypot(dx, dy) / 2;
    // Only the polygon needs a minimum span; body endpoints and joint anchors keep the figure's true lengths.
    const body = create(id, kind, { x: from.x + dx / 2, y: from.y + dy / 2, angle },
      capsule(Math.max(half, 0.02), radius), share);
    return { body, half };
  };
  try {
    const { chest, helmet } = PLAYER_FIGURE;
    const torso = create('torso', 'torso', entry.torso,
      ellipse(0, chest.y, chest.radius * chest.scale[0], chest.radius * chest.scale[1]), MASS_SHARES.torso);
    const head = create('character-head', 'character-head', entry.head,
      ellipse(0, 0, helmet.radius, helmet.radius * helmet.scaleY), MASS_SHARES.head);
    join(pot, torso, worldPoint(entry.torso, { x: 0, y: waist }), LIMITS.waist);
    join(torso, head, worldPoint(entry.torso, figure.neck), LIMITS.neck);
    const arms = {} as Record<ArmSide, PhysicalArm>;
    for (const side of ARM_SIDES) {
      const pose = entry.arms[side];
      const upper = segment(`${side}-upper-arm`, 'upper-arm', pose.shoulder, pose.elbow, PLAYER_FIGURE.elbow, MASS_SHARES.upper);
      const forearm = segment(`${side}-forearm`, 'forearm', pose.elbow, pose.hand, PLAYER_FIGURE.hand, MASS_SHARES.forearm);
      join(torso, upper.body, pose.shoulder, LIMITS.shoulder);
      join(upper.body, forearm.body, pose.elbow, LIMITS.elbow);
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
  for (let index = 0; index < ARM_SIDES.length; index++) {
    const side = ARM_SIDES[index]!;
    const arm = ragdoll.arms[side], pose = out.arms[side];
    endpoint(arm.upper, -1, pose.shoulder); endpoint(arm.upper, 1, pose.elbow);
    endpoint(arm.forearm, 1, pose.hand); pose.hand.angle = arm.forearm.body.getAngle();
  }
}
