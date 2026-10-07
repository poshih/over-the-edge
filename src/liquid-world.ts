import { DynamicTree, PolygonShape } from 'planck';
import type { AABBValue, Body, Fixture } from 'planck';
import { PHYSICS, RIG } from './config';
import type { Tuning } from './config';
import { isPoolObject, polygonArea } from './level';
import type { LevelChange, PoolObject } from './level';
import { LIQUID_SETTINGS } from './liquids';
import type { PlayerRig } from './player';
import type { PlayerBody } from './player-bodies';

interface Pool {
  readonly object: PoolObject;
  readonly proxy: number;
  // The liquid's box; its top is the surface.
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

// The pot's area: the player's volume, which each liquid's buoyancy and drag are set against.
const POT_AREA = Math.abs(polygonArea(RIG.potVertices));
// A fixture's outline clipped to a pool: at most planck's 12 points, and one more for each side of the box.
const MAX_POINTS = 16;
// Less than this, in square metres, under the surface is touching it, not in the liquid.
const MIN_AREA = 1e-6;

// Keeps the part of the convex outline `from` (`count` points as x, y pairs) on the inner side of `limit` along
// `axis` (0 for x, 1 for y): at or below it when `sign` is 1, at or above it when -1. Writes it to `to`; returns its
// points.
function clip(from: Float64Array, count: number, to: Float64Array, axis: 0 | 1, limit: number, sign: 1 | -1): number {
  let written = 0;
  for (let index = 0; index < count; index++) {
    const next = index + 1 === count ? 0 : index + 1;
    const a = (from[2 * index + axis] - limit) * sign;
    const b = (from[2 * next + axis] - limit) * sign;
    if (a <= 0) {
      to[2 * written] = from[2 * index];
      to[2 * written + 1] = from[2 * index + 1];
      written++;
    }
    if ((a <= 0) !== (b <= 0)) {
      const t = a / (a - b);
      to[2 * written] = from[2 * index] + (from[2 * next] - from[2 * index]) * t;
      to[2 * written + 1] = from[2 * index + 1] + (from[2 * next + 1] - from[2 * index + 1]) * t;
      written++;
    }
  }
  return written;
}

/**
 * The level's liquid pools as physics: each step, the pot, the player's body in the liquid, is held up by the liquid it
 * displaces, at the centre of what is under the surface, and every part of the player under it is slowed where it
 * moves, as a thick liquid slows it. Parts are the fixtures' outlines clipped to the pool, so a tilted pot floats tilted
 * and a hammer swept through the liquid pushes against it. Only the pot floats, so a liquid's buoyancy is exactly the
 * share of the player's weight it holds up with the pot under, wherever the hammer is. An index of the pools finds the
 * few the player is near; elsewhere a step costs one query.
 */
export class LiquidWorld {
  private readonly index = new DynamicTree<string>();
  private readonly pools = new Map<string, Pool>();
  private readonly query: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  private readonly nearby: (Pool | undefined)[] = [];
  private nearbyCount = 0;
  private readonly points = new Float64Array(MAX_POINTS * 2);
  private readonly clipped = new Float64Array(MAX_POINTS * 2);
  // The part of the latest fixture under the surface: its area, its centroid, and its polar moment about it.
  private area = 0;
  private centerX = 0;
  private centerY = 0;
  private moment = 0;
  private readonly vector = { x: 0, y: 0 };
  private readonly point = { x: 0, y: 0 };
  private disposed = false;

  constructor(objects: readonly PoolObject[]) {
    for (const object of objects) this.add(object);
  }

  apply(change: LevelChange): void {
    this.ensureLive();
    if (change.kind === 'replace') {
      for (const id of [...this.pools.keys()]) this.remove(id);
      for (const object of change.level.objects) if (isPoolObject(object)) this.add(object);
      return;
    }
    for (const id of change.remove) this.remove(id);
    for (const object of change.upsert) {
      this.remove(object.id);
      if (isPoolObject(object)) this.add(object);
    }
  }

  // Before each physics step: lifts and slows the player's parts in liquid. Returns the pool the pot is in, lava
  // before swamp, or null.
  push(rig: PlayerRig, tuning: Readonly<Tuning>): PoolObject | null {
    this.ensureLive();
    if (this.pools.size === 0) return null;
    if (rig.phase === 'dying') {
      const bath = this.pushSubject(rig.characterBodies, rig.potFixture, rig.characterMass, tuning);
      this.pushSubject(rig.tool.bodies, null, rig.toolMass, tuning);
      return bath;
    }
    let mass = 0;
    for (let index = 0; index < rig.bodies.length; index++) mass += rig.bodies[index]!.body.getMass();
    return this.pushSubject(rig.bodies, rig.potFixture, mass, tuning);
  }

  // A detached tool has its own indexed region and drag reference mass; only the corpse's pot
  // supplies buoyancy. Never span the empty distance between the two subjects with one query.
  private pushSubject(bodies: readonly PlayerBody[], potFixture: Fixture | null, mass: number,
    tuning: Readonly<Tuning>): PoolObject | null {
    const { lowerBound, upperBound } = this.query;
    lowerBound.x = lowerBound.y = Infinity;
    upperBound.x = upperBound.y = -Infinity;
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!.body;
      for (let fixture = body.getFixtureList(); fixture !== null; fixture = fixture.getNext()) {
        const bounds = fixture.getAABB(0);
        lowerBound.x = Math.min(lowerBound.x, bounds.lowerBound.x);
        lowerBound.y = Math.min(lowerBound.y, bounds.lowerBound.y);
        upperBound.x = Math.max(upperBound.x, bounds.upperBound.x);
        upperBound.y = Math.max(upperBound.y, bounds.upperBound.y);
      }
    }
    if (lowerBound.x > upperBound.x) return null;
    this.nearbyCount = 0;
    this.index.query(this.query, this.collect);
    if (this.nearbyCount === 0) return null;
    let bath: PoolObject | null = null;
    for (let index = 0; index < this.nearbyCount; index++) {
      const pool = this.nearby[index]!;
      const { liquid } = pool.object;
      const settings = LIQUID_SETTINGS[liquid];
      // A square metre of the pot under the surface: its share of the player's buoyancy, and of its drag, which slows
      // the hammer alike.
      const lift = tuning[settings.buoyancy] / 100 * mass * PHYSICS.gravity / POT_AREA;
      const thickness = tuning[settings.drag] * mass / POT_AREA;
      for (let part = 0; part < bodies.length; part++) {
        const body = bodies[part]!.body;
        for (let fixture = body.getFixtureList(); fixture !== null; fixture = fixture.getNext()) {
          if (!this.submerge(fixture, pool)) continue;
          const pot = fixture === potFixture;
          this.press(body, pot ? lift : 0, thickness);
          if (pot && bath?.liquid !== 'lava') bath = pool.object;
        }
      }
    }
    for (let index = 0; index < this.nearbyCount; index++) this.nearby[index] = undefined;
    this.nearbyCount = 0;
    return bath;
  }

  inspect() {
    return { pools: this.pools.size };
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.pools.keys()]) this.remove(id);
    this.disposed = true;
  }

  private add(object: PoolObject): void {
    const minX = object.x - object.width / 2;
    const maxX = object.x + object.width / 2;
    const minY = object.y - object.height / 2;
    const maxY = object.y + object.height / 2;
    const proxy = this.index.createProxy({ lowerBound: { x: minX, y: minY }, upperBound: { x: maxX, y: maxY } }, object.id);
    this.pools.set(object.id, { object, proxy, minX, maxX, minY, maxY });
    if (this.nearby.length < this.pools.size) this.nearby.length = this.pools.size;
  }

  private remove(id: string): void {
    const pool = this.pools.get(id);
    if (pool === undefined) return;
    this.index.destroyProxy(pool.proxy);
    this.pools.delete(id);
  }

  private readonly collect = (node: number): boolean => {
    const pool = this.pools.get(this.index.getUserData(node));
    if (pool !== undefined) this.nearby[this.nearbyCount++] = pool;
    return true;
  };

  // Clips `fixture`'s outline to `pool` and measures what lies in it; false when nothing does.
  private submerge(fixture: Fixture, pool: Pool): boolean {
    const shape = fixture.getShape();
    if (!(shape instanceof PolygonShape)) return false;
    const bounds = fixture.getAABB(0);
    if (bounds.upperBound.x <= pool.minX || bounds.lowerBound.x >= pool.maxX ||
      bounds.upperBound.y <= pool.minY || bounds.lowerBound.y >= pool.maxY) return false;
    const { p, q } = fixture.getBody().getTransform();
    const points = this.points;
    for (let index = 0; index < shape.m_count; index++) {
      const vertex = shape.m_vertices[index];
      points[2 * index] = p.x + q.c * vertex.x - q.s * vertex.y;
      points[2 * index + 1] = p.y + q.s * vertex.x + q.c * vertex.y;
    }
    let count = clip(points, shape.m_count, this.clipped, 0, pool.maxX, 1);
    count = clip(this.clipped, count, points, 0, pool.minX, -1);
    count = clip(points, count, this.clipped, 1, pool.maxY, 1);
    count = clip(this.clipped, count, points, 1, pool.minY, -1);
    if (count < 3) return false;
    this.measure(count);
    return this.area > 0;
  }

  // The area of the outline in `points`, its centroid and its polar moment about the centroid.
  private measure(count: number): void {
    const points = this.points;
    // About the first point, so the sums stay small far from the origin.
    const originX = points[0];
    const originY = points[1];
    let doubled = 0;
    let sumX = 0;
    let sumY = 0;
    let moment = 0;
    for (let index = 0; index < count; index++) {
      const next = index + 1 === count ? 0 : index + 1;
      const x1 = points[2 * index] - originX;
      const y1 = points[2 * index + 1] - originY;
      const x2 = points[2 * next] - originX;
      const y2 = points[2 * next + 1] - originY;
      const cross = x1 * y2 - x2 * y1;
      doubled += cross;
      sumX += (x1 + x2) * cross;
      sumY += (y1 + y2) * cross;
      moment += cross * (x1 * x1 + x1 * x2 + x2 * x2 + y1 * y1 + y1 * y2 + y2 * y2);
    }
    if (Math.abs(doubled) / 2 < MIN_AREA) {
      this.area = 0;
      return;
    }
    const x = sumX / (3 * doubled);
    const y = sumY / (3 * doubled);
    this.area = Math.abs(doubled) / 2;
    this.centerX = originX + x;
    this.centerY = originY + y;
    this.moment = Math.max(0, Math.abs(moment) / 12 - this.area * (x * x + y * y));
  }

  // Holds `body` up by the liquid its measured part displaces, `lift` newtons a square metre, at the part's centroid;
  // and slows that part as `thickness` newtons a square metre per m/s would, though never past standing still, so thick
  // liquids stay steady at any step.
  private press(body: Body, lift: number, thickness: number): void {
    this.point.x = this.centerX;
    this.point.y = this.centerY;
    const center = body.getWorldCenter();
    if (lift > 0) {
      this.vector.x = 0;
      this.vector.y = lift * this.area;
      // Planck's point-force helper allocates; apply its identical force and torque separately.
      body.applyForceToCenter(this.vector, true);
      body.applyTorque((this.point.x - center.x) * this.vector.y - (this.point.y - center.y) * this.vector.x, true);
    }
    const mass = body.getMass();
    if (mass <= 0 || thickness <= 0) return;
    const velocity = body.getLinearVelocity();
    const spin = body.getAngularVelocity();
    const share = mass * (1 - Math.exp(-thickness * this.area * PHYSICS.dt / mass));
    this.vector.x = -share * (velocity.x - spin * (this.centerY - center.y));
    this.vector.y = -share * (velocity.y + spin * (this.centerX - center.x));
    body.applyLinearImpulse(this.vector, this.point, true);
    const local = body.getLocalCenter();
    const inertia = body.getInertia() - mass * (local.x * local.x + local.y * local.y);
    if (inertia <= 0) return;
    const turn = 1 - Math.exp(-thickness * this.moment * PHYSICS.dt / inertia);
    body.applyAngularImpulse(-body.getAngularVelocity() * inertia * turn, true);
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use disposed liquid pools.');
  }
}
