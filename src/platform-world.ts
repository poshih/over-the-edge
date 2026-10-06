import { Box, Vec2 } from 'planck';
import type { Body, Fixture, World, WorldManifold } from 'planck';
import { PHYSICS } from './config';
import { isPlatformObject } from './level';
import type { LevelChange, PlatformObject } from './level';
import { sameSurfaceMaterials } from './surfaces';
import type { SurfaceMaterial, SurfaceMaterials } from './surfaces';
import type { PlatformDestination } from './trigger-events';

export const PLATFORM_RIDE = { awaySeconds: 0.3 } as const;
const RIDE_AWAY_STEPS = Math.ceil(PLATFORM_RIDE.awaySeconds / PHYSICS.dt);

export interface PlatformPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface PlatformRecord {
  object: PlatformObject;
  readonly body: Body;
  toEnd: boolean;
  arriving: boolean;
  arrivedAt: number;
  supportedAt: number;
  awaySteps: number;
  previousX: number;
  previousY: number;
  currentX: number;
  currentY: number;
  readonly pose: { id: string; x: number; y: number };
  readonly velocity: Vec2;
}

const NO_PLATFORMS: readonly PlatformPose[] = Object.freeze([]);

function applyMaterial(body: Body, material: SurfaceMaterial): void {
  for (let fixture = body.getFixtureList(); fixture !== null; fixture = fixture.getNext()) {
    fixture.setFriction(material.friction);
    fixture.setRestitution(material.restitution);
  }
}

function targetX(record: PlatformRecord): number {
  return record.object.x + (record.toEnd ? record.object.travelX : 0);
}

function targetY(record: PlatformRecord): number {
  return record.object.y + (record.toEnd ? record.object.travelY : 0);
}

// Kinematic terrain slabs. Their state belongs to the run, not to authored level data.
export class PlatformWorld {
  private readonly world: World;
  private readonly records = new Map<string, PlatformRecord>();
  private readonly bodies = new Map<Body, PlatformRecord>();
  private readonly moving = new Set<PlatformRecord>();
  private readonly arrived = new Set<PlatformRecord>();
  private readonly ridePlatforms: PlatformRecord[] = [];
  private readonly poses: { id: string; x: number; y: number }[] = [];
  private readonly position = new Vec2();
  private materials: SurfaceMaterials;
  private step = 0;
  private disposed = false;

  constructor(world: World, objects: readonly PlatformObject[], materials: SurfaceMaterials) {
    this.world = world;
    this.materials = materials;
    this.ensureMutable();
    for (const object of objects) this.add(object);
  }

  apply(change: LevelChange): void {
    this.ensureMutable();
    if (change.kind === 'replace') {
      const platforms = change.level.objects.filter(isPlatformObject);
      const retained = new Set(platforms.map((object) => object.id));
      for (const id of this.records.keys()) if (!retained.has(id)) this.remove(id);
      for (const object of platforms) this.upsert(object, true);
      return;
    }
    const removed = new Set(change.remove.filter((id) => this.records.has(id)));
    for (const object of change.upsert) {
      if (!isPlatformObject(object) && this.records.has(object.id)) removed.add(object.id);
    }
    for (const id of removed) this.remove(id);
    for (const object of change.upsert) if (isPlatformObject(object)) this.upsert(object, false);
  }

  reset(): void {
    this.ensureMutable();
    for (const record of this.records.values()) {
      record.toEnd = false;
      this.place(record, record.object.x, record.object.y);
    }
    this.resetRiders();
  }

  resetRiders(): void {
    this.ensureMutable();
    for (let index = 0; index < this.ridePlatforms.length; index++) {
      const record = this.ridePlatforms[index]!;
      record.supportedAt = -1;
      record.awaySteps = RIDE_AWAY_STEPS;
    }
  }

  move(id: string, to: PlatformDestination): void {
    this.ensureMutable();
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`Unknown platform: ${id}.`);
    let toEnd: boolean;
    switch (to) {
      case 'toggle': toEnd = !record.toEnd; break;
      case 'start': toEnd = false; break;
      case 'end': toEnd = true; break;
      default: throw new Error(`Unknown platform destination: ${to}.`);
    }
    if (record.toEnd === toEnd) return;
    record.toEnd = toEnd;
    record.arriving = false;
    if (this.arrived.has(record) && record.arrivedAt !== this.step) this.settlePose(record);
    this.arrived.delete(record);
    this.moving.add(record);
  }

  beforeStep(): void {
    this.ensureLive();
    this.step++;
    for (const record of this.moving) {
      record.previousX = record.currentX;
      record.previousY = record.currentY;
      const dx = targetX(record) - record.currentX;
      const dy = targetY(record) - record.currentY;
      const distance = Math.hypot(dx, dy);
      record.arriving = distance <= record.object.speed * PHYSICS.dt;
      const scale = record.arriving ? 1 / PHYSICS.dt : record.object.speed / distance;
      record.velocity.set(dx * scale, dy * scale);
      record.body.setLinearVelocity(record.velocity);
    }
  }

  afterStep(): void {
    this.ensureLive();
    for (const record of this.moving) {
      if (record.arriving) {
        this.stop(record, targetX(record), targetY(record));
        record.arrivedAt = this.step;
        this.arrived.add(record);
      } else {
        const position = record.body.getPosition();
        record.currentX = position.x;
        record.currentY = position.y;
      }
    }
  }

  board(pot: Fixture, manifold: WorldManifold, minimumTopNormal: number): void {
    this.ensureMutable();
    if (this.ridePlatforms.length === 0) return;
    const body = pot.getBody();
    for (let edge = body.getContactList(); edge; edge = edge.next) {
      if (edge.other === null) continue;
      const record = this.bodies.get(edge.other);
      if (record === undefined || !record.object.ride || this.moving.has(record) || record.arrivedAt === this.step) continue;
      const contact = edge.contact;
      if ((contact.getFixtureA() !== pot && contact.getFixtureB() !== pot) || !contact.isTouching() || !contact.isEnabled()) continue;
      const support = contact.getWorldManifold(manifold);
      if (!support || support.pointCount === 0) continue;
      const up = contact.getFixtureA().getBody() === body ? -support.normal.y : support.normal.y;
      if (up >= minimumTopNormal) record.supportedAt = this.step;
    }
    for (let index = 0; index < this.ridePlatforms.length; index++) {
      const record = this.ridePlatforms[index]!;
      if (this.moving.has(record) || record.arrivedAt === this.step) {
        // Travel cannot rearm boarding: a descending deck can briefly lose the pot's support contact.
        record.awaySteps = 0;
      } else if (record.supportedAt === this.step) {
        const boarded = record.awaySteps >= RIDE_AWAY_STEPS;
        record.awaySteps = 0;
        if (boarded) this.move(record.object.id, 'toggle');
      } else if (record.awaySteps < RIDE_AWAY_STEPS) {
        record.awaySteps++;
      }
    }
  }

  frame(alpha: number): readonly PlatformPose[] {
    this.ensureLive();
    if (this.poses.length === 0) return NO_PLATFORMS;
    for (const record of this.moving) this.interpolate(record, alpha);
    // Preserve the final moving step's interpolation, then settle its pose without stepping resting platforms.
    for (const record of this.arrived) {
      if (record.arrivedAt === this.step) this.interpolate(record, alpha);
      else {
        this.settlePose(record);
        this.arrived.delete(record);
      }
    }
    return this.poses;
  }

  isPlatform(body: Body): boolean {
    return this.bodies.has(body);
  }

  isInside(body: Body, point: Readonly<{ x: number; y: number }>): boolean {
    const record = this.bodies.get(body);
    if (record === undefined) return false;
    return Math.abs(point.x - record.currentX) <= record.object.width / 2 &&
      Math.abs(point.y - record.currentY) <= record.object.height / 2;
  }

  setMaterials(materials: SurfaceMaterials): void {
    this.ensureMutable();
    if (sameSurfaceMaterials(materials, this.materials)) return;
    this.materials = materials;
    for (const record of this.records.values()) applyMaterial(record.body, materials[record.object.surface]);
  }

  inspect() {
    return [...this.records.values()].map((record) => ({
      id: record.object.id, toEnd: record.toEnd, moving: this.moving.has(record), x: record.currentX, y: record.currentY,
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.ensureMutable();
    for (const id of this.records.keys()) this.remove(id);
    this.poses.length = 0;
    this.disposed = true;
  }

  private add(object: PlatformObject): void {
    if (this.records.has(object.id)) throw new Error(`Duplicate platform ID: ${object.id}.`);
    const body = this.world.createKinematicBody({ position: new Vec2(object.x, object.y), fixedRotation: true });
    this.createFixture(body, object);
    const record: PlatformRecord = {
      object, body, toEnd: false, arriving: false, arrivedAt: -1,
      supportedAt: -1, awaySteps: RIDE_AWAY_STEPS,
      previousX: object.x, previousY: object.y, currentX: object.x, currentY: object.y,
      pose: { id: object.id, x: object.x, y: object.y }, velocity: new Vec2(),
    };
    this.records.set(object.id, record);
    this.bodies.set(body, record);
    if (object.ride) this.ridePlatforms.push(record);
    this.poses.push(record.pose);
  }

  private upsert(object: PlatformObject, reset: boolean): void {
    const record = this.records.get(object.id);
    if (record === undefined) {
      this.add(object);
      return;
    }
    const previous = record.object;
    record.object = object;
    if (previous.ride !== object.ride) this.setRide(record, object.ride);
    if (reset || previous.ride !== object.ride) {
      record.supportedAt = -1;
      record.awaySteps = RIDE_AWAY_STEPS;
    }
    if (previous.width !== object.width || previous.height !== object.height) {
      for (let fixture = record.body.getFixtureList(); fixture !== null; fixture = record.body.getFixtureList()) {
        record.body.destroyFixture(fixture);
      }
      this.createFixture(record.body, object);
    } else if (previous.surface !== object.surface) {
      applyMaterial(record.body, this.materials[object.surface]);
      for (let edge = record.body.getContactList(); edge; edge = edge.next) {
        edge.contact.resetFriction();
        edge.contact.resetRestitution();
      }
    }
    if (reset) record.toEnd = false;
    if (reset || !this.moving.has(record)) this.place(record, targetX(record), targetY(record));
  }

  private createFixture(body: Body, object: PlatformObject): void {
    const material = this.materials[object.surface];
    body.createFixture(new Box(object.width / 2, object.height / 2), {
      friction: material.friction,
      restitution: material.restitution,
      filterCategoryBits: PHYSICS.terrainCategory,
      filterMaskBits: PHYSICS.playerCategory | PHYSICS.toolCategory | PHYSICS.enemyCategory,
    });
  }

  private setRide(record: PlatformRecord, ride: boolean): void {
    if (ride) this.ridePlatforms.push(record);
    else {
      const index = this.ridePlatforms.indexOf(record);
      if (index >= 0) this.ridePlatforms.splice(index, 1);
    }
  }

  private stop(record: PlatformRecord, x: number, y: number): void {
    record.body.setTransform(this.position.set(x, y), 0);
    record.velocity.setZero();
    record.body.setLinearVelocity(record.velocity);
    record.currentX = x;
    record.currentY = y;
    record.arriving = false;
    this.moving.delete(record);
  }

  private place(record: PlatformRecord, x: number, y: number): void {
    this.stop(record, x, y);
    this.settlePose(record);
    this.arrived.delete(record);
  }

  private settlePose(record: PlatformRecord): void {
    record.previousX = record.pose.x = record.currentX;
    record.previousY = record.pose.y = record.currentY;
  }

  private interpolate(record: PlatformRecord, alpha: number): void {
    record.pose.x = record.previousX + (record.currentX - record.previousX) * alpha;
    record.pose.y = record.previousY + (record.currentY - record.previousY) * alpha;
  }

  private remove(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    const index = this.poses.indexOf(record.pose);
    if (index < 0) throw new Error('Platform poses and bodies are inconsistent.');
    if (!this.world.destroyBody(record.body)) throw new Error(`Could not remove platform body: ${id}.`);
    this.records.delete(id);
    this.bodies.delete(record.body);
    this.moving.delete(record);
    this.arrived.delete(record);
    this.setRide(record, false);
    this.poses.splice(index, 1);
  }

  private ensureMutable(): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Cannot mutate platforms while the physics world is stepping.');
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed platform world.');
  }
}
