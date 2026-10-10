import { Box, Vec2 } from 'planck';
import type { Body, Fixture, World, WorldManifold } from 'planck';
import { PHYSICS } from './config';
import { isPlatformObject } from './level';
import type { LevelChange, PlatformObject } from './level';
import { sameSurfaceMaterials } from './surfaces';
import type { Surface, SurfaceMaterial, SurfaceMaterials } from './surfaces';
import type { PlatformDestination } from './trigger-events';

const PLATFORM_RIDE = { awaySeconds: 0.3 } as const;
const RIDE_AWAY_STEPS = Math.ceil(PLATFORM_RIDE.awaySeconds / PHYSICS.dt);

export interface PlatformPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface PlatformFrame {
  readonly changes: readonly PlatformPose[];
  readonly revision: number;
  // Only the drawing consumer acknowledges a sample; diagnostics and camera samples leave changes pending.
  acknowledge(revision: number): void;
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
  drawnX: number;
  drawnY: number;
  movingSlot: number;
  arrivedSlot: number;
  riderSlot: number;
  drawSlot: number;
  readonly velocity: Vec2;
}

type ActiveSlot = 'movingSlot' | 'arrivedSlot' | 'riderSlot' | 'drawSlot';

// Packed sets reserve their storage on content changes, not when a step activates a platform.
class ActivePlatforms {
  private readonly entries: (PlatformRecord | undefined)[] = [];
  private readonly slot: ActiveSlot;
  count = 0;

  constructor(slot: ActiveSlot) {
    this.slot = slot;
  }

  reserve(capacity: number): void {
    if (this.entries.length < capacity) this.entries.length = capacity;
  }

  at(index: number): PlatformRecord {
    return this.entries[index]!;
  }

  has(record: PlatformRecord): boolean {
    return record[this.slot] >= 0;
  }

  add(record: PlatformRecord): void {
    if (this.has(record)) return;
    record[this.slot] = this.count;
    this.entries[this.count++] = record;
  }

  delete(record: PlatformRecord): void {
    const slot = record[this.slot];
    if (slot < 0) return;
    const last = this.entries[--this.count]!;
    if (slot < this.count) {
      this.entries[slot] = last;
      last[this.slot] = slot;
    }
    this.entries[this.count] = undefined;
    record[this.slot] = -1;
  }

  clear(): void {
    for (let index = 0; index < this.count; index++) {
      this.entries[index]![this.slot] = -1;
      this.entries[index] = undefined;
    }
    this.count = 0;
  }
}

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
  private readonly moving = new ActivePlatforms('movingSlot');
  private readonly arrived = new ActivePlatforms('arrivedSlot');
  private readonly riders = new ActivePlatforms('riderSlot');
  private readonly drawing = new ActivePlatforms('drawSlot');
  private readonly changeScratch: PlatformPose[] = [];
  // Allocated on content changes, so changing the delta length never reallocates a frame array.
  private readonly changeBuffers: PlatformPose[][] = [[]];
  private readonly drawnFrame = {
    changes: this.changeBuffers[0]!,
    revision: 0,
    acknowledge: (revision: number): void => this.acknowledgeFrame(revision),
  };
  private rideCount = 0;
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
    this.riders.clear();
    for (const record of this.records.values()) {
      if (!record.object.ride) continue;
      record.supportedAt = -1;
      record.awaySteps = RIDE_AWAY_STEPS;
      if (this.moving.has(record) || record.arrivedAt === this.step) this.riders.add(record);
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
    this.drawing.add(record);
    if (record.object.ride) this.riders.add(record);
  }

  beforeStep(): void {
    this.ensureLive();
    this.step++;
    for (let index = 0; index < this.moving.count; index++) {
      const record = this.moving.at(index);
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
    for (let index = 0; index < this.moving.count;) {
      const record = this.moving.at(index);
      if (record.arriving) {
        this.stop(record, targetX(record), targetY(record));
        record.arrivedAt = this.step;
        this.arrived.add(record);
      } else {
        const position = record.body.getPosition();
        record.currentX = position.x;
        record.currentY = position.y;
        index++;
      }
    }
  }

  board(pot: Fixture, manifold: WorldManifold, minimumTopNormal: number): void {
    this.ensureMutable();
    if (this.rideCount === 0) return;
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
      if (up >= minimumTopNormal) {
        record.supportedAt = this.step;
        this.riders.add(record);
      }
    }
    for (let index = 0; index < this.riders.count;) {
      const record = this.riders.at(index);
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
      if (record.awaySteps >= RIDE_AWAY_STEPS) this.riders.delete(record);
      else index++;
    }
  }

  // Borrow the last reading without sampling or consuming pending changes.
  get frameReading(): PlatformFrame {
    this.ensureLive();
    return this.drawnFrame;
  }

  // Retain moving and unacknowledged draws; settling an arrival must not consume its final pose change.
  settleInterpolation(): void {
    this.ensureLive();
    for (let index = 0; index < this.drawing.count; index++) {
      this.settlePose(this.drawing.at(index));
    }
    this.arrived.clear();
  }

  frame(alpha: number): PlatformFrame {
    this.ensureLive();
    let count = 0;
    for (let index = 0; index < this.drawing.count;) {
      const record = this.drawing.at(index);
      if (this.moving.has(record) || (this.arrived.has(record) && record.arrivedAt === this.step)) {
        this.interpolate(record, alpha);
      } else {
        // Preserve the final moving step's interpolation until a later step has settled it.
        this.arrived.delete(record);
        record.previousX = record.pose.x = record.currentX;
        record.previousY = record.pose.y = record.currentY;
      }
      const changed = record.pose.x !== record.drawnX || record.pose.y !== record.drawnY;
      if (changed) this.changeScratch[count++] = record.pose;
      if (!changed && !this.moving.has(record) && !this.arrived.has(record)) this.drawing.delete(record);
      else index++;
    }
    const changes = this.changeBuffers[count]!;
    for (let index = 0; index < count; index++) changes[index] = this.changeScratch[index]!;
    this.drawnFrame.changes = changes;
    this.drawnFrame.revision++;
    return this.drawnFrame;
  }

  isPlatform(body: Body): boolean {
    return this.bodies.has(body);
  }

  // What a platform body is made of; null for any other body.
  surface(body: Body): Surface | null {
    return this.bodies.get(body)?.object.surface ?? null;
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
    this.drawnFrame.changes = this.changeBuffers[0]!;
    this.changeScratch.length = 0;
    this.changeBuffers.length = 1;
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
      pose: { id: object.id, x: object.x, y: object.y }, drawnX: object.x, drawnY: object.y,
      movingSlot: -1, arrivedSlot: -1, riderSlot: -1, drawSlot: -1, velocity: new Vec2(),
    };
    this.records.set(object.id, record);
    this.bodies.set(body, record);
    this.moving.reserve(this.records.size);
    this.arrived.reserve(this.records.size);
    this.riders.reserve(this.records.size);
    this.drawing.reserve(this.records.size);
    if (this.changeScratch.length < this.records.size) {
      this.changeScratch.push(record.pose);
      this.changeBuffers.push(new Array<PlatformPose>(this.records.size));
    }
    if (object.ride) this.rideCount++;
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
    this.syncRider(record);
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
    if (ride) this.rideCount++;
    else {
      this.rideCount--;
      this.riders.delete(record);
    }
  }

  private syncRider(record: PlatformRecord): void {
    if (record.object.ride && (this.moving.has(record) || record.arrivedAt === this.step ||
      record.supportedAt === this.step || record.awaySteps < RIDE_AWAY_STEPS)) this.riders.add(record);
    else this.riders.delete(record);
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
    if (x === record.drawnX && y === record.drawnY) this.drawing.delete(record);
  }

  private settlePose(record: PlatformRecord): void {
    record.previousX = record.currentX;
    record.previousY = record.currentY;
    this.drawing.add(record);
  }

  private interpolate(record: PlatformRecord, alpha: number): void {
    record.pose.x = record.previousX + (record.currentX - record.previousX) * alpha;
    record.pose.y = record.previousY + (record.currentY - record.previousY) * alpha;
  }

  private acknowledgeFrame(revision: number): void {
    this.ensureLive();
    // A reentrant sample invalidates the older acknowledgement, not its pending changes.
    if (revision !== this.drawnFrame.revision) return;
    const { changes } = this.drawnFrame;
    for (let index = 0; index < changes.length; index++) {
      const pose = changes[index]!;
      const record = this.records.get(pose.id);
      if (record === undefined || record.pose !== pose) continue;
      record.drawnX = pose.x;
      record.drawnY = pose.y;
      if (!this.moving.has(record) && !this.arrived.has(record)) {
        if (record.currentX === record.drawnX && record.currentY === record.drawnY) this.drawing.delete(record);
        else this.drawing.add(record);
      }
    }
  }

  private remove(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    if (!this.world.destroyBody(record.body)) throw new Error(`Could not remove platform body: ${id}.`);
    this.records.delete(id);
    this.bodies.delete(record.body);
    this.moving.delete(record);
    this.arrived.delete(record);
    this.riders.delete(record);
    this.drawing.delete(record);
    if (record.object.ride) this.rideCount--;
  }

  private ensureMutable(): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Cannot mutate platforms while the physics world is stepping.');
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed platform world.');
  }
}
