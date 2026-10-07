import { Polygon, RevoluteJoint, Vec2 } from 'planck';
import type { Body, Fixture, Joint, World } from 'planck';
import { PHYSICS, RIG } from './config';
import type { PlayerSpawn, Point, Tuning } from './config';
import { angleDifference, clamp, clampLength } from './math';
import type { HammerHead } from './hammer-head';
import { HammerJoint } from './hammer-joint';
import { partPoint, playerBody, PlayerRigError } from './player-bodies';
import type { PlayerBody, PlayerPart } from './player-bodies';
import { createPlayerTool, releasePlayerTool } from './player-tool';
import type { PlayerTool } from './player-tool';
import { createRagdoll, PlayerDeathError } from './player-ragdoll';
import type { PhysicalRagdoll } from './player-ragdoll';
import { createDeathPose } from './player-pose';
import { writeCorpseEntry } from './character-figure';
import type { CharacterFigure, CorpseReading } from './character-figure';
import { headGripMargin } from './grips';
import type { DeathSettings } from './game-settings';
import type { RigGeometry } from './rig';
import type { LaunchSettings } from './trigger-events';

export type { PartKind, PlayerPart } from './player-bodies';

interface PlayerOwned {
  readonly geometry: RigGeometry;
  readonly parts: readonly PlayerPart[];
  readonly bodies: readonly PlayerBody[];
  readonly pot: Body;
  readonly potFixture: Fixture;
  readonly tool: PlayerTool;
}
export interface AlivePlayerRig extends PlayerOwned {
  readonly phase: 'alive';
  readonly root: Body;
  readonly potJoint: RevoluteJoint;
  readonly drive: HammerJoint;
}
export interface DyingPlayerRig extends PlayerOwned {
  readonly phase: 'dying';
  readonly ragdoll: PhysicalRagdoll;
  readonly characterBodies: readonly PlayerBody[];
  readonly characterMass: number;
  readonly toolMass: number;
}
export type PlayerRig = AlivePlayerRig | DyingPlayerRig;

// The jar remains the gameplay anchor after its fixtureless live root has been removed.
export function playerAnchor(rig: PlayerRig): Body {
  return rig.phase === 'dying' ? rig.pot : rig.root;
}

const corpseEntry = createDeathPose();
const corpseRoot: Point = { x: 0, y: 0 }, corpseButt: Point = { x: 0, y: 0 }, corpseHead: Point = { x: 0, y: 0 };
const corpseReading: { -readonly [K in keyof CorpseReading]: CorpseReading[K] } = {
  root: corpseRoot, butt: corpseButt, head: corpseHead, headMargin: 0,
};

export function beginPlayerDeath(world: World, rig: AlivePlayerRig, figure: Readonly<CharacterFigure>,
  tuning: Readonly<Tuning>, death: Readonly<DeathSettings>): DyingPlayerRig {
  if (world.isLocked()) throw new PlayerDeathError('locked-world', 'Death must begin between physics steps.');
  const root = rig.root.getPosition();
  corpseRoot.x = root.x; corpseRoot.y = root.y;
  partPoint(rig.tool.butt, corpseButt); partPoint(rig.tool.head, corpseHead);
  corpseReading.headMargin = headGripMargin(rig.tool.head.vertices);
  writeCorpseEntry(figure, corpseReading, corpseEntry);
  const ragdoll = createRagdoll(world, rig.pot, rig.root, corpseEntry, figure, tuning, death);
  world.destroyJoint(rig.drive);
  world.destroyJoint(rig.potJoint);
  if (!world.destroyBody(rig.root)) throw new PlayerDeathError('construction-failed', 'Could not remove the live character root.');
  rig.potFixture.setFilterMaskBits(PHYSICS.terrainCategory);
  releasePlayerTool(rig.tool, death.friction);
  rig.pot.setSleepingAllowed(true);
  rig.pot.setAwake(true);
  const retained = rig.bodies.filter(owned => owned.body !== rig.root);
  const characterBodies = [retained.find(owned => owned.body === rig.pot)!, ...ragdoll.bodies];
  let characterMass = 0, toolMass = 0;
  for (const { body } of characterBodies) characterMass += body.getMass();
  for (const { body } of rig.tool.bodies) toolMass += body.getMass();
  return {
    phase: 'dying', geometry: rig.geometry, pot: rig.pot, potFixture: rig.potFixture, tool: rig.tool,
    bodies: [...retained, ...ragdoll.bodies],
    parts: [...rig.parts.filter(part => part.body !== rig.root), ...ragdoll.parts],
    ragdoll, characterBodies, characterMass, toolMass,
  };
}

export interface MotorCommand {
  angularError: number;
  extensionError: number;
  angularSpeed: number;
  linearSpeed: number;
  // How much stronger than their tuned strength the hinge and slider are: above 1 during a downswing.
  hingeBoost: number;
  sliderBoost: number;
}

const LAUNCH_SOLVER_ITERATIONS = 32;
const SMALL_DRAG_RATIO = 0.001;
const ORIGIN = Object.freeze({ x: 0, y: 0 });

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
  for (const { body } of rig.bodies) {
    const partMass = body.getMass();
    mass += partMass;
    momentum += partMass * body.getLinearVelocity().y;
  }
  if (mass <= 0) throw new PlayerRigError('The player rig must have positive mass to launch.');
  const speed = launchSpeed(settings.height, tuning.bodyDamping) * settings.strength;
  const delta = Math.max(0, speed - momentum / mass);
  changePlayerVelocity(rig, { x: 0, y: delta });
  return { speed, impulse: mass * delta, mass };
}

const velocityImpulse = new Vec2();

export function changePlayerVelocity(rig: PlayerRig, delta: Readonly<Point>): void {
  // Each physical body receives this once, even when several visual parts share it.
  for (let index = 0; index < rig.bodies.length; index++) {
    const body = rig.bodies[index]!.body;
    const mass = body.getMass();
    velocityImpulse.set(delta.x * mass, delta.y * mass);
    body.applyLinearImpulse(velocityImpulse, body.getWorldCenter());
  }
}

function attach<T extends Joint>(world: World, joint: T): T {
  const attached = world.createJoint(joint);
  if (!attached) throw new PlayerRigError('Cannot construct a player joint while the physics world is stepping.');
  return attached;
}

function setMass(body: Body, mass: number): void {
  const data = { mass: 0, center: new Vec2(), I: 0 };
  body.getMassData(data);
  if (data.mass <= 0) throw new PlayerRigError('Player bodies must have positive mass before tuning.');
  data.I *= mass / data.mass;
  data.mass = mass;
  body.setMassData(data);
}

// `head` is the hammer's head outline: the rig's default, or a library hammer's own.
export function createPlayer(world: World, spawn: PlayerSpawn, tuning: Readonly<Tuning>, geometry: RigGeometry, head: HammerHead): AlivePlayerRig {
  const rootOwned = playerBody(world, { id: 'root', position: spawn.position, angle: 0, fixedRotation: true });
  const potOwned = playerBody(world, { id: 'pot', position: spawn.position, angle: 0, fixedRotation: false });
  const root = rootOwned.body, pot = potOwned.body;
  const potFixture = pot.createFixture(new Polygon(RIG.potVertices.map((point) => new Vec2(point.x, point.y))), {
    density: 1, friction: tuning.potFriction, restitution: tuning.potBounciness / 100,
    filterCategoryBits: PHYSICS.playerCategory,
    filterMaskBits: PHYSICS.terrainCategory | PHYSICS.enemyCategory,
  });
  const potJoint = attach(world, new RevoluteJoint({ bodyA: root, bodyB: pot,
    localAnchorA: new Vec2(), localAnchorB: new Vec2(), referenceAngle: 0,
    enableLimit: true, lowerAngle: -RIG.potAngleLimit, upperAngle: RIG.potAngleLimit,
    collideConnected: false }));
  const shoulder = root.getWorldPoint(RIG.shoulder);
  const extension = clamp(spawn.reach, geometry.minReach, geometry.maxReach) - geometry.handleLength;
  const tool = createPlayerTool({ world, shoulder, angle: spawn.angle, extension, geometry, tuning, head });
  const drive = attach(world, new HammerJoint({ bodyA: root, bodyB: tool.driveBody,
    localAnchorA: RIG.shoulder, lowerTranslation: geometry.minExtension, upperTranslation: geometry.maxExtension,
    maxMotorTorque: tuning.hingeTorque, maxMotorForce: tuning.sliderForce }));
  const rig: AlivePlayerRig = { phase: 'alive', geometry, root, pot, potFixture, potJoint, tool, drive,
    bodies: [rootOwned, potOwned, ...tool.bodies], parts: [
      { id: 'root', kind: 'root', body: root, localPoint: ORIGIN, vertices: [] },
      { id: 'pot', kind: 'pot', body: pot, localPoint: ORIGIN, vertices: RIG.potVertices, fixture: potFixture },
      { id: 'shoulder', kind: 'shoulder', body: root, localPoint: RIG.shoulder, vertices: [] },
      ...tool.parts,
    ] };
  tunePlayer(rig, tuning);
  return rig;
}

export function tunePlayer(rig: AlivePlayerRig, tuning: Readonly<Tuning>): void {
  if (!rig.tool.acceptsTuning(tuning)) throw new PlayerRigError('Rebuild the rig when changing between rigid and compliant handles.');
  rig.drive.setMotorLimits({ torque: tuning.hingeTorque, force: tuning.sliderForce });
  // A carrier at the shoulder translates exactly with the fixed-rotation root. Preserve its real
  // mass here, including COM, while PlayerTool preserves its rotor inertia at the driven body.
  const rootMass = tuning.playerMass * PHYSICS.rootMassFraction + tuning.hingeCarrierMass;
  rig.root.setMassData({ mass: rootMass,
    center: new Vec2(RIG.shoulder.x * tuning.hingeCarrierMass / rootMass,
      RIG.shoulder.y * tuning.hingeCarrierMass / rootMass), I: 0 });
  setMass(rig.pot, tuning.playerMass * (1 - PHYSICS.rootMassFraction));
  rig.tool.tune(tuning);
  for (const { body } of rig.bodies) {
    body.setLinearDamping(tuning.bodyDamping);
    body.setAngularDamping(tuning.bodyDamping);
    body.setAwake(true);
  }
  rig.potFixture.setFriction(tuning.potFriction);
  rig.potFixture.setRestitution(tuning.potBounciness / 100);
  rig.tool.head.fixture.setFriction(tuning.gripFriction);
  rig.tool.head.fixture.setRestitution(tuning.hammerBounciness / 100);
}

// How directly a motor speeds the head up downward, from 0 to 1: its requested speed, and the change it
// makes to the joint's speed, must both move the head down along `down` (unit length at most).
function downswing(requested: number, current: number, down: number): number {
  return Math.sign(requested) === Math.sign(requested - current) ? Math.max(0, Math.sign(requested) * down) : 0;
}

// Synchronous motor scratch: the drive calls no callbacks and the joint copies these numeric inputs.
const motorTarget: Point = { x: 0, y: 0 }, motorReach: Point = { x: 0, y: 0 };
const motorLimits = { torque: 0, force: 0 };
const motorSpeeds = { angular: 0, linear: 0 };

// Only input can swing the hammer down: corrections holding a hang keep their tuned strength.
export function drivePlayer(rig: AlivePlayerRig, target: Readonly<Point>, tuning: Readonly<Tuning>, swinging: boolean, out: MotorCommand): void {
  const transform = rig.root.getTransform();
  const pivotX = transform.q.c * RIG.shoulder.x - transform.q.s * RIG.shoulder.y + transform.p.x;
  const pivotY = transform.q.s * RIG.shoulder.x + transform.q.c * RIG.shoulder.y + transform.p.y;
  const targetX = target.x - pivotX, targetY = target.y - pivotY;
  const distance = Math.hypot(targetX, targetY);
  const axisAngle = rig.drive.getAngle();
  const angularError = distance <= PHYSICS.aimEpsilon
    ? 0 : angleDifference(Math.atan2(targetY, targetX), axisAngle);
  const { minReach, maxReach, handleLength } = rig.geometry;
  motorTarget.x = targetX; motorTarget.y = targetY;
  const reachable = clampLength(motorTarget, maxReach, motorReach);
  const projectedReach = clamp(reachable.x * Math.cos(axisAngle) + reachable.y * Math.sin(axisAngle), minReach, maxReach);
  const extensionError = projectedReach - handleLength - rig.drive.getTranslation();
  const hingeSpeed = rig.drive.getAngularSpeed(), sliderSpeed = rig.drive.getLinearSpeed();
  const angularSpeed = clamp(tuning.angleGain * angularError - tuning.angleDamping * hingeSpeed,
    -tuning.angularSpeed, tuning.angularSpeed);
  const linearSpeed = clamp(tuning.extensionGain * extensionError - tuning.extensionDamping * sliderSpeed,
    -tuning.linearSpeed, tuning.linearSpeed);
  const hingeBoost = swinging ? 1 + (tuning.hingeDownswingBoost - 1) * downswing(angularSpeed, hingeSpeed, -Math.cos(axisAngle)) : 1;
  const sliderBoost = swinging ? 1 + (tuning.sliderDownswingBoost - 1) * downswing(linearSpeed, sliderSpeed, -Math.sin(axisAngle)) : 1;
  motorLimits.torque = tuning.hingeTorque * hingeBoost; motorLimits.force = tuning.sliderForce * sliderBoost;
  motorSpeeds.angular = angularSpeed; motorSpeeds.linear = linearSpeed;
  rig.drive.setMotorLimits(motorLimits);
  rig.drive.setMotorSpeeds(motorSpeeds);
  out.angularError = angularError; out.extensionError = extensionError;
  out.angularSpeed = angularSpeed; out.linearSpeed = linearSpeed;
  out.hingeBoost = hingeBoost; out.sliderBoost = sliderBoost;
}

export function destroyPlayer(world: World, rig: PlayerRig): void {
  for (const { id, body } of rig.bodies) {
    if (!world.destroyBody(body)) throw new PlayerRigError(`Could not remove player body ${id}.`);
  }
}
