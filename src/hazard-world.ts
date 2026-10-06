import { DynamicTree, Vec2 } from 'planck';
import type { AABBValue, Body, Fixture, World } from 'planck';
import { PHYSICS } from './config';
import type { Point } from './config';
import { AXE, axeAngle, axeBlade, axeReach, HURT_BOX, SHOOTER } from './hazards';
import type { Bounds } from './hazards';
import { isTrapObject } from './level';
import type { AxeObject, LevelChange, ShooterObject, TrapObject } from './level';

export interface ProjectilePose extends Readonly<Point> {
  // The direction it flies; its position is its tip.
  readonly angle: number;
}

export interface HazardHooks {
  // The hammer head, which blocks projectiles.
  readonly shield: () => Fixture;
  readonly isTerrain: (body: Body) => boolean;
  // Terrain stops projectiles only from outside, so a muzzle set into a wall shoots out of it.
  readonly insideTerrain: (body: Body, point: Readonly<Point>) => boolean;
  // Whether a hit would hurt the player now; traps pass through a player who cannot be hurt.
  readonly vulnerable: () => boolean;
  // A hit: its damage, the velocity it adds to the player, and the trap that dealt it.
  readonly hurt: (damage: number, push: Readonly<Point>, source: 'projectile' | 'axe', trap: string) => void;
}

interface Shooter {
  object: ShooterObject;
  // When it fires next, in run time.
  next: number;
}

interface Axe {
  readonly object: AxeObject;
  readonly proxy: number;
  // The latest pass through the obstacle line that hit the player, counted in half periods from the offset.
  pass: number;
}

interface Projectile {
  x: number;
  y: number;
  // Where it was before the latest step, for drawing between steps.
  fromX: number;
  fromY: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly angle: number;
  readonly speed: number;
  readonly damage: number;
  // The trap that fired it.
  readonly trap: string;
  travelled: number;
}

// The frame of a level with nothing in flight, shared so idle frames allocate nothing.
const NO_PROJECTILES: readonly ProjectilePose[] = Object.freeze([]);

// The first shot of `shooter` at or after `time`.
function shotFrom(shooter: ShooterObject, time: number): number {
  if (time <= shooter.delay) return shooter.delay;
  return shooter.delay + Math.ceil((time - shooter.delay) / shooter.interval) * shooter.interval;
}

// Where along `start` + t `delta`, t in [0, 1], the segment lies between `min` and `max` on one axis.
function slab(start: number, delta: number, min: number, max: number, span: { near: number; far: number }): boolean {
  if (delta === 0) return start >= min && start <= max;
  const t0 = (min - start) / delta;
  const t1 = (max - start) / delta;
  span.near = Math.max(span.near, Math.min(t0, t1));
  span.far = Math.min(span.far, Math.max(t0, t1));
  return span.near <= span.far;
}

function overlaps(a: Readonly<Bounds>, b: Readonly<Bounds>): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * The level's traps, stepped with the physics. Shooters fire on a schedule, kept in a heap so only due shots cost a
 * step anything; their projectiles fly straight, each step a ray against the terrain and the hammer head, until they
 * hit the player, are blocked or have flown their range. Axes hurt the player when the blade crosses the character's
 * depth over it; an index of where each blade can reach finds the few near the player.
 */
export class HazardWorld {
  private readonly world: World;
  private readonly hooks: HazardHooks;
  private readonly shooters = new Map<string, Shooter>();
  private readonly axes = new Map<string, Axe>();
  private readonly axeIndex = new DynamicTree<string>();
  // Shooters by their next shot, earliest first.
  private schedule: Shooter[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly box: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private readonly blade: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private readonly query: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  private readonly nearby: Axe[] = [];
  private readonly span = { near: 0, far: 1 };
  private readonly rayFrom = new Vec2();
  private readonly rayTo = new Vec2();
  private rayStop = 1;
  private disposed = false;

  constructor(world: World, objects: readonly TrapObject[], hooks: HazardHooks) {
    this.world = world;
    this.hooks = hooks;
    for (const object of objects) this.add(object, 0);
    this.reschedule();
  }

  get count(): number {
    return this.shooters.size + this.axes.size;
  }

  apply(change: LevelChange, time: number): void {
    this.ensureLive();
    if (change.kind === 'replace') {
      for (const id of [...this.shooters.keys(), ...this.axes.keys()]) this.remove(id);
      for (const object of change.level.objects) if (isTrapObject(object)) this.add(object, time);
      this.reset(time);
      return;
    }
    const removed = new Set(change.remove);
    for (const object of change.upsert) removed.add(object.id);
    let edited = false;
    for (const id of removed) edited = this.remove(id) || edited;
    for (const object of change.upsert) {
      if (!isTrapObject(object)) continue;
      this.add(object, time);
      edited = true;
    }
    if (edited) this.reschedule();
  }

  // A new run: no projectiles fly, and every shooter waits for its first shot.
  reset(time: number): void {
    this.ensureLive();
    this.projectiles.length = 0;
    for (const shooter of this.shooters.values()) shooter.next = shotFrom(shooter.object, time);
    for (const axe of this.axes.values()) axe.pass = -Infinity;
    this.reschedule();
  }

  // After the physics step that ended at `time`, with the player's root at `root`.
  afterStep(time: number, root: Readonly<Point>): void {
    this.ensureLive();
    if (this.count === 0 && this.projectiles.length === 0) return;
    const vulnerable = this.hooks.vulnerable();
    this.box.minX = root.x - HURT_BOX.halfWidth;
    this.box.maxX = root.x + HURT_BOX.halfWidth;
    this.box.minY = root.y + HURT_BOX.bottom;
    this.box.maxY = root.y + HURT_BOX.top;
    this.fly(vulnerable);
    this.fire(time, root);
    if (vulnerable && this.hooks.vulnerable()) this.swing(time, root);
  }

  frame(alpha: number): readonly ProjectilePose[] {
    if (this.projectiles.length === 0) return NO_PROJECTILES;
    return this.projectiles.map((shot) => ({
      x: shot.fromX + (shot.x - shot.fromX) * alpha, y: shot.fromY + (shot.y - shot.fromY) * alpha, angle: shot.angle,
    }));
  }

  inspect() {
    return {
      shooters: [...this.shooters.values()].map(({ object, next }) => ({ id: object.id, next })),
      axes: [...this.axes.values()].map(({ object, pass }) => ({ id: object.id, pass })),
      projectiles: this.projectiles.length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.shooters.keys(), ...this.axes.keys()]) this.remove(id);
    this.projectiles.length = 0;
    this.schedule = [];
    this.disposed = true;
  }

  private add(object: TrapObject, time: number): void {
    if (object.kind === 'shooter') {
      this.shooters.set(object.id, { object, next: shotFrom(object, time) });
      return;
    }
    const reach = axeReach(object, HURT_BOX.halfDepth);
    const proxy = this.axeIndex.createProxy(
      { lowerBound: { x: reach.minX, y: reach.minY }, upperBound: { x: reach.maxX, y: reach.maxY } }, object.id);
    this.axes.set(object.id, { object, proxy, pass: -Infinity });
  }

  private remove(id: string): boolean {
    const axe = this.axes.get(id);
    if (axe !== undefined) {
      this.axeIndex.destroyProxy(axe.proxy);
      this.axes.delete(id);
      return true;
    }
    return this.shooters.delete(id);
  }

  private fly(vulnerable: boolean): void {
    for (let index = 0; index < this.projectiles.length;) {
      const shot = this.projectiles[index];
      shot.fromX = shot.x;
      shot.fromY = shot.y;
      const distance = Math.min(shot.speed * PHYSICS.dt, SHOOTER.range - shot.travelled);
      const toX = shot.x + shot.directionX * distance;
      const toY = shot.y + shot.directionY * distance;
      this.rayFrom.set(shot.x, shot.y);
      this.rayTo.set(toX, toY);
      this.rayStop = 1;
      if (distance > 0) this.world.rayCast(this.rayFrom, this.rayTo, this.stopRay);
      if (vulnerable && this.enters(shot.x, shot.y, toX - shot.x, toY - shot.y)) {
        // Only the first hit of a step hurts: the player then cannot be hurt for a while.
        vulnerable = false;
        this.hooks.hurt(shot.damage, {
          x: shot.directionX * SHOOTER.push, y: shot.directionY * SHOOTER.push + SHOOTER.lift,
        }, 'projectile', shot.trap);
        this.discard(index);
        continue;
      }
      if (this.rayStop < 1 || shot.travelled + distance >= SHOOTER.range) {
        this.discard(index);
        continue;
      }
      shot.x = toX;
      shot.y = toY;
      shot.travelled += distance;
      index++;
    }
  }

  // Whether the path from (x, y) along (dx, dy) enters the character before anything along the ray stops it.
  private enters(x: number, y: number, dx: number, dy: number): boolean {
    const span = this.span;
    span.near = 0;
    span.far = this.rayStop;
    return slab(x, dx, this.box.minX, this.box.maxX, span) && slab(y, dy, this.box.minY, this.box.maxY, span);
  }

  private fire(time: number, root: Readonly<Point>): void {
    while (this.schedule.length > 0 && this.schedule[0].next <= time) {
      const shooter = this.schedule[0];
      const { object } = shooter;
      if (this.projectiles.length < SHOOTER.projectiles &&
        (root.x - object.x) ** 2 + (root.y - object.y) ** 2 <= SHOOTER.range ** 2) {
        const directionX = Math.cos(object.angle);
        const directionY = Math.sin(object.angle);
        this.projectiles.push({
          x: object.x, y: object.y, fromX: object.x, fromY: object.y, directionX, directionY,
          angle: object.angle, speed: object.speed, damage: object.damage, trap: object.id, travelled: 0,
        });
      }
      // Strictly later, so each shooter fires at most once a step and the loop ends.
      const next = shotFrom(object, time);
      shooter.next = next > time ? next : next + object.interval;
      this.sink(0);
    }
  }

  private swing(time: number, root: Readonly<Point>): void {
    if (this.axes.size === 0) return;
    this.query.lowerBound.x = this.box.minX;
    this.query.lowerBound.y = this.box.minY;
    this.query.upperBound.x = this.box.maxX;
    this.query.upperBound.y = this.box.maxY;
    this.nearby.length = 0;
    this.axeIndex.query(this.query, this.collect);
    for (const axe of this.nearby) {
      const { object } = axe;
      if (!axeBlade(object, axeAngle(object, time), HURT_BOX.halfDepth, this.blade) || !overlaps(this.blade, this.box)) continue;
      // The blade is near the line only around a crossing, so the nearest crossing names this pass.
      const pass = Math.round(2 * (time - object.offset) / object.period);
      if (pass === axe.pass) continue;
      axe.pass = pass;
      this.hooks.hurt(object.damage, { x: (root.x < object.x ? -1 : 1) * AXE.push, y: AXE.lift }, 'axe', object.id);
      break;
    }
    this.nearby.length = 0;
  }

  private readonly collect = (node: number): boolean => {
    const axe = this.axes.get(this.axeIndex.getUserData(node));
    if (axe !== undefined) this.nearby.push(axe);
    return true;
  };

  // The nearest terrain or hammer head along the ray; everything else lets projectiles through.
  private readonly stopRay = (fixture: Fixture, _point: Vec2, _normal: Vec2, fraction: number): number => {
    if (fixture !== this.hooks.shield()) {
      const body = fixture.getBody();
      if (!this.hooks.isTerrain(body) || this.hooks.insideTerrain(body, this.rayFrom)) return -1;
    }
    this.rayStop = fraction;
    return fraction;
  };

  private discard(index: number): void {
    const last = this.projectiles.pop();
    if (last !== undefined && index < this.projectiles.length) this.projectiles[index] = last;
  }

  private reschedule(): void {
    this.schedule = [...this.shooters.values()];
    for (let index = (this.schedule.length >> 1) - 1; index >= 0; index--) this.sink(index);
  }

  private sink(index: number): void {
    const heap = this.schedule;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let first = index;
      if (left < heap.length && heap[left].next < heap[first].next) first = left;
      if (right < heap.length && heap[right].next < heap[first].next) first = right;
      if (first === index) return;
      [heap[index], heap[first]] = [heap[first], heap[index]];
      index = first;
    }
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use disposed hazards.');
  }
}
