import {
  Box, Polygon, PrismaticJoint, RevoluteJoint, Vec2, WeldJoint,
} from 'planck';
import type { Body, Joint, World } from 'planck';
import { PHYSICS, RIG } from './config';
import type { PlayerSpawn, Point, Tuning } from './config';
import { angleDifference, clamp, clampLength, transformPoint } from './math';
import type { LaunchSettings } from './trigger-events';

export type PartKind = 'root' | 'pot' | 'carrier' | 'slider' | 'handle' | 'head';

export interface PlayerPart {
  id: string;
  kind: PartKind;
  body: Body;
  vertices: readonly Point[];
}

export interface PlayerRig {
  parts: PlayerPart[];
  root: Body;
  pot: Body;
  carrier: Body;
  sliderBody: Body;
  head: Body;
  hinge: RevoluteJoint;
  slider: PrismaticJoint;
  welds: WeldJoint[];
}

export interface MotorCommand {
  angularError: number;
  extensionError: number;
  angularSpeed: number;
  linearSpeed: number;
}

const LAUNCH_SOLVER_ITERATIONS = 32;
const SMALL_DRAG_RATIO = 0.001;

function clearAirRise(speed: number, damping: number): number {
  const ratio = damping * speed / PHYSICS.gravity;
  // The series avoids cancellation near zero drag, including the drag-free limit.
  const factor = ratio < SMALL_DRAG_RATIO
    ? 0.5 - ratio / 3 + ratio * ratio / 4 - ratio ** 3 / 5
    : (ratio - Math.log1p(ratio)) / (ratio * ratio);
  return speed * speed / PHYSICS.gravity * factor;
}

function launchSpeed(height: number, damping: number): number {
  let low = Math.sqrt(2 * PHYSICS.gravity * height);
  let high = low + 2 * damping * height;
  for (let iteration = 0; iteration < LAUNCH_SOLVER_ITERATIONS; iteration++) {
    const speed = (low + high) / 2;
    if (clearAirRise(speed, damping) < height) low = speed;
    else high = speed;
  }
  return (low + high) / 2;
}

export function launchPlayer(rig: PlayerRig, settings: LaunchSettings, tuning: Readonly<Tuning>) {
  let mass = 0;
  let momentum = 0;
  for (const part of rig.parts) {
    const partMass = part.body.getMass();
    mass += partMass;
    momentum += partMass * part.body.getLinearVelocity().y;
  }
  if (mass <= 0) throw new Error('The player rig must have positive mass to launch.');
  const speed = launchSpeed(settings.height, tuning.bodyDamping) * settings.strength;
  const delta = Math.max(0, speed - momentum / mass);
  changePlayerVelocity(rig, { x: 0, y: delta });
  return { speed, impulse: mass * delta, mass };
}

export function changePlayerVelocity(rig: PlayerRig, delta: Readonly<Point>): void {
  // Equal velocity changes preserve relative motion without kicking individual joints.
  for (const part of rig.parts) {
    const mass = part.body.getMass();
    part.body.applyLinearImpulse(new Vec2(delta.x * mass, delta.y * mass), part.body.getWorldCenter());
  }
}

function attach<T extends Joint>(world: World, joint: T): T {
  const attached = world.createJoint(joint);
  if (!attached) throw new Error('Cannot construct a player joint while the physics world is stepping.');
  return attached;
}

function setMass(body: Body, mass: number): void {
  const data = { mass: 0, center: new Vec2(), I: 0 };
  body.getMassData(data);
  if (data.mass <= 0) throw new Error('Player bodies must have positive mass before tuning.');
  data.I *= mass / data.mass;
  data.mass = mass;
  body.setMassData(data);
}

export function createPlayer(world: World, spawn: PlayerSpawn, tuning: Readonly<Tuning>): PlayerRig {
  const parts: PlayerPart[] = [];
  const movingBody = (id: string, kind: PartKind, position: Point, angle: number, vertices: readonly Point[]): Body => {
    const body = world.createDynamicBody({
      position: new Vec2(position.x, position.y),
      angle,
      bullet: true,
      allowSleep: false,
      fixedRotation: kind === 'root',
    });
    parts.push({ id, kind, body, vertices });
    return body;
  };
  const root = movingBody('root', 'root', spawn.position, 0, []);
  const pot = movingBody('pot', 'pot', spawn.position, 0, RIG.potVertices);
  pot.createFixture(new Polygon(RIG.potVertices.map((point) => new Vec2(point.x, point.y))), {
    density: 1,
    friction: PHYSICS.potFriction,
    restitution: 0,
    filterCategoryBits: PHYSICS.playerCategory,
    filterMaskBits: PHYSICS.terrainCategory | PHYSICS.enemyCategory,
  });
  attach(world, new RevoluteJoint({
    bodyA: root,
    bodyB: pot,
    localAnchorA: new Vec2(),
    localAnchorB: new Vec2(),
    referenceAngle: 0,
    enableLimit: true,
    lowerAngle: -RIG.potAngleLimit,
    upperAngle: RIG.potAngleLimit,
    collideConnected: false,
  }));

  const shoulder = root.getWorldPoint(RIG.shoulder);
  const carrier = movingBody('carrier', 'carrier', shoulder, spawn.angle, []);
  const hinge = attach(world, new RevoluteJoint({
    bodyA: root,
    bodyB: carrier,
    localAnchorA: new Vec2(RIG.shoulder.x, RIG.shoulder.y),
    localAnchorB: new Vec2(),
    referenceAngle: 0,
    enableMotor: true,
    maxMotorTorque: tuning.hingeTorque,
    collideConnected: false,
  }));

  const alongHandle = (distance: number): Point =>
    transformPoint({ x: distance, y: 0 }, shoulder, spawn.angle);
  const sliderBody = movingBody('slider', 'slider', alongHandle(spawn.extension), spawn.angle, []);
  const slider = attach(world, new PrismaticJoint({
    bodyA: carrier,
    bodyB: sliderBody,
    localAnchorA: new Vec2(),
    localAnchorB: new Vec2(),
    localAxisA: new Vec2(1, 0),
    referenceAngle: 0,
    enableLimit: true,
    lowerTranslation: RIG.minExtension,
    upperTranslation: RIG.maxExtension,
    enableMotor: true,
    maxMotorForce: tuning.sliderForce,
    collideConnected: false,
  }));

  const welds: WeldJoint[] = [];
  let previous = sliderBody;
  for (let index = 0; index < RIG.handleSegments; index++) {
    const half = RIG.segmentLength / 2;
    const vertices = [
      { x: -half, y: -RIG.handleHalfWidth }, { x: half, y: -RIG.handleHalfWidth },
      { x: half, y: RIG.handleHalfWidth }, { x: -half, y: RIG.handleHalfWidth },
    ];
    const segment = movingBody(
      `handle-${index}`, 'handle',
      alongHandle(spawn.extension + (index + 0.5) * RIG.segmentLength),
      spawn.angle, vertices,
    );
    segment.createFixture(new Box(half, RIG.handleHalfWidth), {
      density: 1,
      filterCategoryBits: PHYSICS.toolCategory,
      // Retain shaft mass and inertia without producing collision contacts.
      filterMaskBits: 0,
    });
    welds.push(attach(world, new WeldJoint({
      bodyA: previous,
      bodyB: segment,
      localAnchorA: new Vec2(index === 0 ? 0 : half, 0),
      localAnchorB: new Vec2(-half, 0),
      referenceAngle: 0,
      frequencyHz: tuning.handleFrequency,
      dampingRatio: tuning.handleDamping,
      collideConnected: false,
    })));
    previous = segment;
  }
  const head = movingBody(
    'head', 'head', alongHandle(spawn.extension + RIG.handleLength),
    spawn.angle, RIG.headVertices,
  );
  head.createFixture(new Polygon(RIG.headVertices.map((point) => new Vec2(point.x, point.y))), {
    density: 1,
    friction: tuning.gripFriction,
    restitution: 0,
    filterCategoryBits: PHYSICS.toolCategory,
    filterMaskBits: PHYSICS.terrainCategory | PHYSICS.enemyCategory,
  });
  welds.push(attach(world, new WeldJoint({
    bodyA: previous,
    bodyB: head,
    localAnchorA: new Vec2(RIG.segmentLength / 2, 0),
    localAnchorB: new Vec2(),
    referenceAngle: 0,
    frequencyHz: tuning.handleFrequency,
    dampingRatio: tuning.handleDamping,
    collideConnected: false,
  })));
  const rig: PlayerRig = { parts, root, pot, carrier, sliderBody, head, hinge, slider, welds };
  tunePlayer(rig, tuning);
  return rig;
}

export function tunePlayer(rig: PlayerRig, tuning: Readonly<Tuning>): void {
  rig.hinge.setMaxMotorTorque(tuning.hingeTorque);
  rig.slider.setMaxMotorForce(tuning.sliderForce);
  setMass(rig.root, tuning.playerMass * PHYSICS.rootMassFraction);
  setMass(rig.pot, tuning.playerMass * (1 - PHYSICS.rootMassFraction));
  setMass(rig.head, tuning.hammerMass);
  for (const [body, mass] of [
    [rig.carrier, tuning.hingeCarrierMass],
    [rig.sliderBody, tuning.sliderCarriageMass],
  ] as const) {
    body.setMassData({ mass, center: new Vec2(), I: mass * PHYSICS.guideInertiaPerMass });
  }
  for (const part of rig.parts) {
    if (part.kind === 'handle') setMass(part.body, tuning.shaftMass / RIG.handleSegments);
    part.body.setLinearDamping(tuning.bodyDamping);
    part.body.setAngularDamping(tuning.bodyDamping);
    part.body.setAwake(true);
    for (let fixture = part.body.getFixtureList(); fixture; fixture = fixture.getNext()) {
      if (fixture.getFilterMaskBits() !== 0) {
        fixture.setFriction(part.kind === 'pot' ? PHYSICS.potFriction : tuning.gripFriction);
      }
    }
  }
  for (const weld of rig.welds) {
    weld.setFrequency(tuning.handleFrequency);
    weld.setDampingRatio(tuning.handleDamping);
  }
}

export function drivePlayer(rig: PlayerRig, cursor: Readonly<Point>, tuning: Readonly<Tuning>): MotorCommand {
  const pivot = rig.root.getWorldPoint(RIG.shoulder);
  const targetX = cursor.x - pivot.x;
  const targetY = cursor.y - pivot.y;
  const distance = Math.hypot(targetX, targetY);
  // The slider axis remains defined even when the head is at the hinge.
  const axisAngle = rig.carrier.getAngle();
  const angularError = distance <= PHYSICS.aimEpsilon
    ? 0 : angleDifference(Math.atan2(targetY, targetX), axisAngle);
  // Targets are hinge-relative and the radius is capped at the reach; clamp so any target maps into the workspace.
  const reachable = clampLength({ x: targetX, y: targetY }, RIG.maxReach);
  const projectedReach = clamp(
    reachable.x * Math.cos(axisAngle) + reachable.y * Math.sin(axisAngle), 0, RIG.maxReach,
  );
  const extensionError = projectedReach - RIG.handleLength - rig.slider.getJointTranslation();
  const angularSpeed = clamp(
    tuning.angleGain * angularError - tuning.angleDamping * rig.hinge.getJointSpeed(),
    -tuning.angularSpeed, tuning.angularSpeed,
  );
  const linearSpeed = clamp(
    tuning.extensionGain * extensionError - tuning.extensionDamping * rig.slider.getJointSpeed(),
    -tuning.linearSpeed, tuning.linearSpeed,
  );
  rig.hinge.setMotorSpeed(angularSpeed);
  rig.slider.setMotorSpeed(linearSpeed);
  return { angularError, extensionError, angularSpeed, linearSpeed };
}

export function destroyPlayer(world: World, rig: PlayerRig): void {
  for (const part of rig.parts) {
    if (!world.destroyBody(part.body)) throw new Error(`Could not remove player body ${part.id}.`);
  }
}
