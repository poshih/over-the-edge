import { Chain, Vec2, World } from 'planck';
import { DEFAULT_TUNING, PHYSICS, RIG } from './config';
import type { Point, PracticeId, Tuning } from './config';
import { COURSE, practiceById, SUMMIT } from './course';
import { createPlayer, destroyPlayer, drivePlayer, tunePlayer } from './player';
import type { MotorCommand, PartKind, PlayerRig } from './player';
import { angleDifference, clamp } from './math';

export interface PartPose extends Point {
  id: string;
  kind: PartKind;
  angle: number;
  vertices: readonly Point[];
  collides: boolean;
}

export interface PhysicsFrame {
  parts: PartPose[];
  cursor: Point;
}

const IDLE_COMMAND: MotorCommand = { angularError: 0, extensionError: 0, angularSpeed: 0, linearSpeed: 0 };

export class Simulation {
  readonly world: World;
  private rig: PlayerRig;
  private tuning: Tuning;
  private cursor: Point;
  private previous: PhysicsFrame;
  private current: PhysicsFrame;
  private command = { ...IDLE_COMMAND };
  private elapsed = 0;
  private pointerSpeed = 0;
  private bestHeight = 0;
  private practice: PracticeId = 'start';
  private disposed = false;

  constructor(tuning: Readonly<Tuning> = DEFAULT_TUNING) {
    this.tuning = { ...tuning };
    this.world = new World(new Vec2(0, -PHYSICS.gravity));
    this.world.setContinuousPhysics(true);
    for (const terrain of COURSE) {
      const body = this.world.createBody();
      body.createFixture(new Chain(terrain.vertices.map((point) => new Vec2(point.x, point.y)), true), {
        friction: PHYSICS.terrainFriction,
        restitution: 0,
        filterCategoryBits: PHYSICS.terrainCategory,
        filterMaskBits: PHYSICS.playerCategory | PHYSICS.toolCategory,
      });
    }
    this.rig = createPlayer(this.world, practiceById(this.practice), this.tuning);
    this.cursor = { ...this.rig.head.getPosition() };
    this.current = this.capture();
    this.previous = this.current;
  }

  setTuning(tuning: Readonly<Tuning>): void {
    this.ensureLive();
    this.tuning = { ...tuning };
    tunePlayer(this.rig, this.tuning);
    // Existing contacts cache mixed material values independently of fixtures.
    for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
      contact.resetFriction();
    }
  }

  reset(practice: PracticeId): void {
    this.ensureLive();
    destroyPlayer(this.world, this.rig);
    this.practice = practice;
    this.rig = createPlayer(this.world, practiceById(practice), this.tuning);
    this.cursor = { ...this.rig.head.getPosition() };
    this.elapsed = 0;
    this.bestHeight = Math.max(0, this.rig.root.getPosition().y + RIG.potBottom);
    this.pointerSpeed = 0;
    this.command = { ...IDLE_COMMAND };
    this.current = this.capture();
    this.previous = this.current;
  }

  step(pointerDelta: Point): void {
    this.ensureLive();
    if (!Number.isFinite(pointerDelta.x) || !Number.isFinite(pointerDelta.y)) {
      throw new Error('Pointer movement must be finite.');
    }
    this.previous = this.current;
    this.cursor.x += pointerDelta.x;
    this.cursor.y += pointerDelta.y;
    this.pointerSpeed += (Math.hypot(pointerDelta.x, pointerDelta.y) / PHYSICS.dt - this.pointerSpeed) *
      (1 - Math.exp(-PHYSICS.pointerSpeedResponse * PHYSICS.dt));
    if (this.headContactCount() > 0) {
      const settling = 1 - Math.exp(-this.tuning.cursorRelaxation * PHYSICS.dt *
        clamp(1 - this.pointerSpeed / PHYSICS.cursorSettlingSpeed, 0, 1));
      const tip = this.rig.head.getPosition();
      this.cursor.x += (tip.x - this.cursor.x) * settling;
      this.cursor.y += (tip.y - this.cursor.y) * settling;
    }
    const pivot = this.rig.root.getWorldPoint(RIG.shoulder);
    const dx = this.cursor.x - pivot.x;
    const dy = this.cursor.y - pivot.y;
    const distance = Math.hypot(dx, dy);
    if (distance > RIG.maxReach) {
      this.cursor.x = pivot.x + dx * RIG.maxReach / distance;
      this.cursor.y = pivot.y + dy * RIG.maxReach / distance;
    }
    this.command = drivePlayer(this.rig, this.cursor, this.tuning);
    this.world.step(PHYSICS.dt, PHYSICS.velocityIterations, PHYSICS.positionIterations);
    this.elapsed += PHYSICS.dt;
    this.bestHeight = Math.max(this.bestHeight, this.rig.root.getPosition().y + RIG.potBottom);
    this.current = this.capture();
  }

  frame(alpha: number): PhysicsFrame {
    return {
      parts: this.current.parts.map((part, index) => {
        const previous = this.previous.parts[index];
        return {
          ...part,
          x: previous.x + (part.x - previous.x) * alpha,
          y: previous.y + (part.y - previous.y) * alpha,
          angle: previous.angle + angleDifference(part.angle, previous.angle) * alpha,
        };
      }),
      cursor: {
        x: this.previous.cursor.x + (this.current.cursor.x - this.previous.cursor.x) * alpha,
        y: this.previous.cursor.y + (this.current.cursor.y - this.previous.cursor.y) * alpha,
      },
    };
  }

  snapshot() {
    const root = this.rig.root.getPosition();
    let contacts = 0;
    for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
      if (contact.isTouching()) contacts++;
    }
    const hingeTorque = this.rig.hinge.getMotorTorque(1 / PHYSICS.dt);
    const sliderForce = this.rig.slider.getMotorForce(1 / PHYSICS.dt);
    return {
      practice: this.practice,
      time: this.elapsed,
      root: { x: root.x, y: root.y, angle: this.rig.root.getAngle() },
      tip: { ...this.rig.head.getPosition() },
      cursor: { ...this.cursor },
      rootVelocity: { ...this.rig.root.getLinearVelocity() },
      potAngle: this.rig.pot.getAngle(),
      extension: this.rig.slider.getJointTranslation(),
      height: Math.max(0, root.y + RIG.potBottom),
      bestHeight: this.bestHeight,
      contacts,
      headContacts: this.headContactCount(),
      maxReach: RIG.maxReach,
      hingeTorque,
      sliderForce,
      hingeLoad: Math.abs(hingeTorque) / this.tuning.hingeTorque,
      sliderLoad: Math.abs(sliderForce) / this.tuning.sliderForce,
      command: { ...this.command },
      tuning: { ...this.tuning },
      bodyProperties: Object.fromEntries(this.rig.parts.map(({ id, body }) =>
        [id, { mass: body.getMass(), inertia: body.getInertia() }] as const)),
      bodyCount: this.world.getBodyCount(),
      jointCount: this.world.getJointCount(),
      summit: root.x >= SUMMIT.xMin && root.x <= SUMMIT.xMax &&
        root.y + RIG.potBottom >= SUMMIT.y - SUMMIT.arrivalTolerance,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    destroyPlayer(this.world, this.rig);
    for (let body = this.world.getBodyList(); body;) {
      const next = body.getNext();
      this.world.destroyBody(body);
      body = next;
    }
    this.disposed = true;
  }

  private capture(): PhysicsFrame {
    return {
      parts: this.rig.parts.map((part) => {
        const position = part.body.getPosition();
        const angle = part.body.getAngle();
        const velocity = part.body.getLinearVelocity();
        if (![position.x, position.y, angle, velocity.x, velocity.y, part.body.getAngularVelocity()].every(Number.isFinite)) {
          throw new Error(`Non-finite physics state on ${part.id}. Simulation stopped.`);
        }
        const fixture = part.body.getFixtureList();
        return {
          id: part.id, kind: part.kind, x: position.x, y: position.y, angle, vertices: part.vertices,
          collides: fixture !== null && fixture.getFilterMaskBits() !== 0,
        };
      }),
      cursor: { ...this.cursor },
    };
  }

  private headContactCount(): number {
    let count = 0;
    for (let edge = this.rig.head.getContactList(); edge; edge = edge.next) {
      if (edge.contact.isTouching()) count++;
    }
    return count;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed physics simulation.');
  }
}
