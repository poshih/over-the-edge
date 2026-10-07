import { DynamicTree, Vec2 } from 'planck';
import type { AABBValue, Body, Fixture, World } from 'planck';
import { PHYSICS, RIG } from './config';
import type { Point, Tuning } from './config';
import { axeAngle, axeBlade, axeReach, SHOOTER } from './hazards';
import type { Bounds, ProjectileBlock } from './hazards';
import { isTrapObject } from './level';
import type { AxeObject, LevelChange, ShooterObject, TrapObject } from './level';

export interface ProjectilePose extends Readonly<Point> {
  // The direction it flies; its position is its tip.
  readonly angle: number;
}

export interface HazardHooks {
  // The hammer head blocks projectiles even when released; this is obstruction, not vulnerability.
  readonly shield: () => Fixture;
  readonly isTerrain: (body: Body) => boolean;
  // Terrain stops projectiles only from outside, so a muzzle set into a wall shoots out of it.
  readonly insideTerrain: (body: Body, point: Readonly<Point>) => boolean;
  // Whether a hit would hurt the player now; traps pass through a player who cannot be hurt.
  readonly vulnerable: () => boolean;
  // A hit: its damage, borrowed velocity change, the trap that dealt it and where it struck, in world metres.
  readonly hurt: (damage: number, push: Readonly<Point>, source: 'projectile' | 'axe', trap: string, atX: number, atY: number) => void;
  // A projectile stopped by the hammer head, held or released. Borrowed: copy what is kept.
  readonly block: (hit: Readonly<ProjectileBlock>) => void;
}

interface Shooter {
  object: ShooterObject;
  // When its timer fires next, in run time.
  next: number;
  // Triggered shots still owed, and when the next one fires.
  burstShots: number;
  burstNext: number;
}

interface Axe {
  readonly object: AxeObject;
  proxy: number;
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
  private tuning: Readonly<Tuning>;
  private readonly shooters = new Map<string, Shooter>();
  private readonly axes = new Map<string, Axe>();
  private readonly axeIndex = new DynamicTree<string>();
  // Shooters by their next shot, earliest first.
  private schedule: Shooter[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly posePool: { -readonly [K in keyof ProjectilePose]: ProjectilePose[K] }[] = [];
  // One array per populated length keeps its backing storage even after empty frames.
  private readonly framePosePool: ProjectilePose[][] = [[]];
  private readonly box: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private readonly blade: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private readonly push: Point = { x: 0, y: 0 };
  private readonly query: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  private readonly nearby: Axe[] = [];
  private readonly span = { near: 0, far: 1 };
  private readonly rayFrom = new Vec2();
  private readonly rayTo = new Vec2();
  private rayStop = 1;
  private rayShield = false;
  private readonly rayBlock: { -readonly [K in keyof ProjectileBlock]: ProjectileBlock[K] } = {
    trap: '', x: 0, y: 0, directionX: 0, directionY: 0, normalX: 0, normalY: 0,
  };
  private disposed = false;

  constructor(world: World, objects: readonly TrapObject[], tuning: Readonly<Tuning>, hooks: HazardHooks) {
    this.world = world;
    this.hooks = hooks;
    this.tuning = tuning;
    for (const object of objects) this.add(object, 0);
    this.reschedule();
  }

  get count(): number {
    return this.shooters.size + this.axes.size;
  }

  setTuning(tuning: Readonly<Tuning>): void {
    this.ensureLive();
    const depthChanged = tuning.hurtDepth !== this.tuning.hurtDepth;
    this.tuning = tuning;
    if (!depthChanged) return;
    for (const axe of this.axes.values()) {
      this.axeIndex.destroyProxy(axe.proxy);
      axe.proxy = this.indexAxe(axe.object);
    }
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
    for (const shooter of this.shooters.values()) {
      shooter.next = shooter.object.firing === 'timer' ? shotFrom(shooter.object, time) : Infinity;
      shooter.burstShots = 0;
      shooter.burstNext = Infinity;
    }
    for (const axe of this.axes.values()) axe.pass = -Infinity;
    this.reschedule();
  }

  // After the physics step that ended at `time`, with the player's root at `root`.
  afterStep(time: number, root: Readonly<Point>): void {
    this.ensureLive();
    if (this.count === 0 && this.projectiles.length === 0) return;
    const vulnerable = this.hooks.vulnerable();
    this.box.minX = root.x - this.tuning.hurtWidth / 2;
    this.box.maxX = root.x + this.tuning.hurtWidth / 2;
    this.box.minY = root.y + RIG.potBottom;
    this.box.maxY = this.box.minY + this.tuning.hurtHeight;
    this.fly(vulnerable);
    this.fire(time, root);
    if (vulnerable && this.hooks.vulnerable()) this.swing(time, root);
  }

  frame(alpha: number): readonly ProjectilePose[] {
    const count = this.projectiles.length;
    while (this.posePool.length < count) {
      this.posePool.push({ x: 0, y: 0, angle: 0 });
      this.framePosePool.push(this.posePool.slice());
    }
    const poses = this.framePosePool[count]!;
    for (let index = 0; index < count; index++) {
      const shot = this.projectiles[index]!;
      const pose = this.posePool[index]!;
      pose.x = shot.fromX + (shot.x - shot.fromX) * alpha;
      pose.y = shot.fromY + (shot.y - shot.fromY) * alpha;
      pose.angle = shot.angle;
    }
    return poses;
  }

  inspect() {
    return {
      shooters: [...this.shooters.values()].map(({ object, next }) => ({ id: object.id, next })),
      axes: [...this.axes.values()].map(({ object, pass }) => ({ id: object.id, pass })),
      projectiles: this.projectiles.length,
    };
  }

  burst(id: string, shots: number, time: number): void {
    this.ensureLive();
    if (!Number.isInteger(shots) || shots < 1) throw new Error('Trap burst shots must be a positive whole number.');
    const shooter = this.shooters.get(id);
    if (shooter === undefined) throw new Error(`Unknown projectile trap: ${id}.`);
    if (shooter.burstShots === 0) shooter.burstNext = time + shooter.object.delay;
    shooter.burstShots += shots;
    this.reschedule();
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
      this.shooters.set(object.id, {
        object, next: object.firing === 'timer' ? shotFrom(object, time) : Infinity,
        burstShots: 0, burstNext: Infinity,
      });
      return;
    }
    this.axes.set(object.id, { object, proxy: this.indexAxe(object), pass: -Infinity });
  }

  private indexAxe(object: AxeObject): number {
    const reach = axeReach(object, this.tuning.hurtDepth / 2);
    return this.axeIndex.createProxy(
      { lowerBound: { x: reach.minX, y: reach.minY }, upperBound: { x: reach.maxX, y: reach.maxY } }, object.id);
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
      this.rayShield = false;
      if (distance > 0) this.world.rayCast(this.rayFrom, this.rayTo, this.stopRay);
      if (vulnerable && this.enters(shot.x, shot.y, toX - shot.x, toY - shot.y)) {
        // It strikes where its path enters the character.
        const along = this.span.near;
        this.push.x = shot.directionX * this.tuning.projectilePush;
        this.push.y = shot.directionY * this.tuning.projectilePush + this.tuning.projectileLift;
        this.hooks.hurt(shot.damage, this.push, 'projectile', shot.trap, shot.x + (toX - shot.x) * along, shot.y + (toY - shot.y) * along);
        vulnerable = this.hooks.vulnerable();
        this.discard(index);
        continue;
      }
      if (this.rayStop < 1 || shot.travelled + distance >= SHOOTER.range) {
        if (this.rayStop < 1 && this.rayShield) {
          this.rayBlock.trap = shot.trap;
          this.rayBlock.directionX = shot.directionX;
          this.rayBlock.directionY = shot.directionY;
          this.hooks.block(this.rayBlock);
        }
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
    while (this.schedule.length > 0 && this.due(this.schedule[0]) <= time) {
      const shooter = this.schedule[0];
      const { object } = shooter;
      const timerDue = shooter.next <= time;
      const burstDue = shooter.burstNext <= time;
      this.shoot(shooter, root);
      // Advance every due schedule strictly later, so each shooter fires at most once a step and the loop ends.
      if (burstDue) {
        shooter.burstShots--;
        shooter.burstNext = shooter.burstShots > 0 ? time + object.interval : Infinity;
      }
      if (timerDue) {
        const next = shotFrom(object, time);
        shooter.next = next > time ? next : next + object.interval;
      }
      this.sink(0);
    }
  }

  private shoot(shooter: Shooter, root: Readonly<Point>): void {
    const { object } = shooter;
    if (this.projectiles.length >= SHOOTER.projectiles ||
      (root.x - object.x) ** 2 + (root.y - object.y) ** 2 > SHOOTER.range ** 2) return;
    const directionX = Math.cos(object.angle);
    const directionY = Math.sin(object.angle);
    this.projectiles.push({
      x: object.x, y: object.y, fromX: object.x, fromY: object.y, directionX, directionY,
      angle: object.angle, speed: object.speed, damage: object.damage, trap: object.id, travelled: 0,
    });
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
      if (!axeBlade(object, axeAngle(object, time), this.tuning.hurtDepth / 2, this.blade) || !overlaps(this.blade, this.box)) continue;
      // The blade is near the line only around a crossing, so the nearest crossing names this pass.
      const pass = Math.round(2 * (time - object.offset) / object.period);
      if (pass === axe.pass) continue;
      axe.pass = pass;
      // It strikes in the middle of where the blade meets the character, and knocks the character away from there.
      const atX = (Math.max(this.blade.minX, this.box.minX) + Math.min(this.blade.maxX, this.box.maxX)) / 2;
      const atY = (Math.max(this.blade.minY, this.box.minY) + Math.min(this.blade.maxY, this.box.maxY)) / 2;
      this.push.x = (root.x < atX ? -1 : 1) * this.tuning.axePush;
      this.push.y = this.tuning.axeLift;
      this.hooks.hurt(object.damage, this.push, 'axe', object.id, atX, atY);
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
  private readonly stopRay = (fixture: Fixture, point: Vec2, normal: Vec2, fraction: number): number => {
    const shield = fixture === this.hooks.shield();
    if (!shield) {
      const body = fixture.getBody();
      if (!this.hooks.isTerrain(body) || this.hooks.insideTerrain(body, this.rayFrom)) return -1;
    }
    if (fraction > this.rayStop) return this.rayStop;
    this.rayStop = fraction;
    this.rayShield = shield;
    // Planck may reuse the callback vectors; keep only their scalar fields.
    this.rayBlock.x = point.x;
    this.rayBlock.y = point.y;
    this.rayBlock.normalX = normal.x;
    this.rayBlock.normalY = normal.y;
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
      if (left < heap.length && this.due(heap[left]) < this.due(heap[first])) first = left;
      if (right < heap.length && this.due(heap[right]) < this.due(heap[first])) first = right;
      if (first === index) return;
      [heap[index], heap[first]] = [heap[first], heap[index]];
      index = first;
    }
  }

  private due(shooter: Shooter): number {
    return Math.min(shooter.next, shooter.burstNext);
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use disposed hazards.');
  }
}
