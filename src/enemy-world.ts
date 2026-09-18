import { Box, Circle, DynamicTree, Vec2, WorldManifold } from 'planck';
import type { Body, Contact, World } from 'planck';
import { PHYSICS } from './config';
import type { Point } from './config';
import { ENEMY_BEHAVIOR, ENEMY_DIRECTION, ENEMY_LIMITS, ENEMY_SPECS } from './enemy-types';
import type { EnemyEvent, EnemyFacing, EnemyPhase, EnemyPose } from './enemy-types';
import { isEnemyObject } from './level';
import type { EnemyObject, LevelChange } from './level';
import { clamp } from './math';

interface EnemyRecord {
  object: EnemyObject;
  body: Body | null;
  proxy: number | null;
  previous: Point;
  current: Point;
  facing: EnemyFacing;
  phase: EnemyPhase;
  changedAt: number;
  health: number;
  lastHitAt: number;
  nextDecisionAt: number;
  desiredX: number;
  target: Point | null;
  defeatedBy: 'hammer' | 'fall' | null;
}

interface EnemyCallbacks {
  readonly getPot: () => Body;
  readonly getHead: () => Body;
  readonly onBump: (velocityChange: Readonly<Point>) => void;
}

const ENEMY_FRICTION = 0.15;

function distanceSquared(a: Readonly<Point>, b: Readonly<Point>): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function wakeBounds(position: Readonly<Point>) {
  return {
    lowerBound: { x: position.x - ENEMY_BEHAVIOR.wakeDistance, y: position.y - ENEMY_BEHAVIOR.wakeDistance },
    upperBound: { x: position.x + ENEMY_BEHAVIOR.wakeDistance, y: position.y + ENEMY_BEHAVIOR.wakeDistance },
  };
}

export class EnemyWorld {
  private readonly world: World;
  private readonly callbacks: EnemyCallbacks;
  private readonly records = new Map<string, EnemyRecord>();
  private readonly bodies = new Map<Body, EnemyRecord>();
  private readonly active = new Set<EnemyRecord>();
  private readonly dying = new Set<EnemyRecord>();
  private readonly index = new DynamicTree<string>();
  private readonly hits = new Set<EnemyRecord>();
  private readonly bumps = new Set<EnemyRecord>();
  private readonly obstacles = new Set<EnemyRecord>();
  private readonly listeners = new Set<(event: EnemyEvent) => void>();
  private readonly force = new Vec2();
  private readonly zero = new Vec2();
  private readonly manifold = new WorldManifold();
  private queryPosition: Point | null = null;
  private time = 0;
  private nextBumpAt = 0;
  private activeUpdates = 0;
  private decisions = 0;
  private queries = 0;
  private bumpCount = 0;
  private disposed = false;

  constructor(world: World, objects: readonly EnemyObject[], callbacks: EnemyCallbacks) {
    this.world = world;
    this.callbacks = callbacks;
    this.ensureMutable();
    for (const object of objects) this.createRecord(object);
    world.on('begin-contact', this.onBeginContact);
    world.on('pre-solve', this.onPreSolve);
  }

  apply(change: LevelChange, time: number): void {
    this.ensureMutable();
    this.time = time;
    if (change.kind === 'replace') {
      const objects = change.level.objects.filter(isEnemyObject);
      const retained = new Set(objects.map((object) => object.id));
      for (const [id, record] of this.records) if (!retained.has(id)) this.removeRecord(record);
      for (const object of objects) {
        const previous = this.records.get(object.id);
        if (previous && previous.object.species !== object.species) this.removeRecord(previous);
        const record = this.records.get(object.id);
        if (record) record.object = object;
        else this.createRecord(object);
      }
      this.reset(time);
      return;
    }
    const removed = new Set(change.remove);
    for (const object of change.upsert) {
      const previous = this.records.get(object.id);
      if (previous && (!isEnemyObject(object) || previous.object.species !== object.species)) removed.add(object.id);
    }
    for (const id of removed) {
      const record = this.records.get(id);
      if (!record) continue;
      this.removeRecord(record);
      this.emit({ type: 'remove', id });
    }
    for (const object of change.upsert) {
      if (!isEnemyObject(object)) continue;
      let record = this.records.get(object.id);
      if (record) {
        record.object = object;
        this.resetRecord(record);
      } else record = this.createRecord(object);
      this.emit({ type: 'upsert', pose: this.pose(record) });
    }
    this.queryPosition = null;
  }

  reset(time: number): void {
    this.ensureMutable();
    this.time = time;
    for (const record of this.records.values()) this.resetRecord(record);
    this.hits.clear();
    this.bumps.clear();
    this.obstacles.clear();
    this.nextBumpAt = time;
    this.queryPosition = null;
    this.bumpCount = 0;
    this.emit({ type: 'reset', poses: [...this.records.values()].map((record) => this.pose(record)) });
  }

  beforeStep(player: Readonly<Point>, time: number): void {
    this.ensureMutable();
    this.time = time;
    this.wakeNearby(player);
    for (const record of this.active) {
      record.previous.x = record.current.x;
      record.previous.y = record.current.y;
      if (distanceSquared(record.current, player) > ENEMY_BEHAVIOR.sleepDistance ** 2) {
        this.sleep(record);
        continue;
      }
      this.activeUpdates++;
      if (record.phase === 'hurt') {
        if (time - record.changedAt < ENEMY_BEHAVIOR.hurtSeconds) {
          this.drive(record, 0, record.object.species === 'bird' ? 0 : null);
          continue;
        }
        this.transition(record, record.object.species === 'bird' ? 'recover' : 'patrol');
      }
      if (record.object.species === 'bird') this.fly(record, player);
      else this.walk(record);
    }
  }

  afterStep(time: number): void {
    this.ensureMutable();
    this.time = time;
    for (const record of this.active) {
      const body = this.body(record);
      const position = body.getPosition();
      const velocity = body.getLinearVelocity();
      if (![position.x, position.y, velocity.x, velocity.y].every(Number.isFinite)) {
        throw new Error(`Non-finite physics state on enemy "${record.object.id}".`);
      }
      record.current.x = position.x;
      record.current.y = position.y;
      if (position.y < record.object.y - ENEMY_BEHAVIOR.fallenDistance) this.defeat(record, 'fall');
    }
    // Contacts only enqueue identities while World.step is locked. Resolve hits before bumps.
    for (const record of this.hits) {
      if (record.health === 0 || time - record.lastHitAt < ENEMY_BEHAVIOR.hitSeconds) continue;
      record.lastHitAt = time;
      record.health--;
      if (record.health === 0) this.defeat(record, 'hammer');
      else this.transition(record, 'hurt');
    }
    for (const record of this.obstacles) {
      if (record.health === 0) continue;
      if (record.object.species === 'bird') {
        if (record.phase === 'dive') this.transition(record, 'recover');
        else if (record.phase === 'patrol') this.face(record, -ENEMY_DIRECTION[record.facing]);
      } else {
        this.face(record, -ENEMY_DIRECTION[record.facing]);
        record.desiredX = ENEMY_DIRECTION[record.facing] * record.object.speed;
      }
    }
    this.resolveBump();
    this.hits.clear();
    this.bumps.clear();
    this.obstacles.clear();
    for (const record of this.dying) {
      if (time < record.changedAt + ENEMY_BEHAVIOR.deathSeconds) continue;
      this.dying.delete(record);
      this.emit({ type: 'remove', id: record.object.id });
    }
  }

  frame(alpha: number): readonly EnemyPose[] {
    this.ensureLive();
    const poses: EnemyPose[] = [];
    for (const record of this.active) poses.push(this.pose(record, alpha));
    return poses;
  }

  subscribe(listener: (event: EnemyEvent) => void): () => void {
    this.ensureMutable();
    this.listeners.add(listener);
    listener({
      type: 'reset',
      poses: [...this.records.values()].filter((record) => record.health > 0 || this.dying.has(record))
        .map((record) => this.pose(record)),
    });
    return () => { this.listeners.delete(listener); };
  }

  inspect() {
    this.ensureLive();
    return {
      objectCount: this.records.size, bodyCount: this.bodies.size,
      activeCount: this.active.size, fadingCount: this.dying.size,
      activeUpdates: this.activeUpdates, decisions: this.decisions, queries: this.queries, bumps: this.bumpCount,
      enemies: [...this.records.values()].map((record) => ({
        ...this.pose(record), health: record.health, maxHealth: ENEMY_SPECS[record.object.species].health,
        active: this.active.has(record), defeatedBy: record.defeatedBy,
        velocity: record.body ? { ...record.body.getLinearVelocity() } : { x: 0, y: 0 },
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.ensureMutable();
    this.world.off('begin-contact', this.onBeginContact);
    this.world.off('pre-solve', this.onPreSolve);
    this.listeners.clear();
    for (const record of this.records.values()) this.removeRecord(record);
    this.disposed = true;
  }

  private readonly onBeginContact = (contact: Contact): void => {
    const a = contact.getFixtureA().getBody();
    const b = contact.getFixtureB().getBody();
    const record = this.bodies.get(a) ?? this.bodies.get(b);
    if (!record) return;
    const other = a === record.body ? b : a;
    if (other === this.callbacks.getHead()) {
      const manifold = contact.getWorldManifold(this.manifold);
      if (!manifold || manifold.pointCount === 0) throw new Error('A hammer impact needs a solid contact manifold.');
      const head = other.getLinearVelocityFromWorldPoint(manifold.points[0]);
      const enemy = this.body(record).getLinearVelocityFromWorldPoint(manifold.points[0]);
      const orientation = a === record.body ? -1 : 1;
      const speed = ((head.x - enemy.x) * manifold.normal.x + (head.y - enemy.y) * manifold.normal.y) * orientation;
      if (speed >= ENEMY_BEHAVIOR.hitSpeed) this.hits.add(record);
    } else if (other === this.callbacks.getPot()) this.bumps.add(record);
    else if (record.object.species === 'bird') {
      const fixture = a === record.body ? contact.getFixtureB() : contact.getFixtureA();
      if ((fixture.getFilterCategoryBits() & PHYSICS.terrainCategory) !== 0) this.obstacles.add(record);
    }
  };

  private readonly onPreSolve = (contact: Contact): void => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    const record = this.bodies.get(a.getBody()) ?? this.bodies.get(b.getBody());
    if (!record || !contact.isTouching()) return;
    const other = a.getBody() === record.body ? b : a;
    if ((other.getFilterCategoryBits() & PHYSICS.terrainCategory) === 0) return;
    if (record.object.species === 'bird') {
      if (record.phase === 'dive') this.obstacles.add(record);
    } else if (record.phase === 'patrol' && record.desiredX !== 0) {
      const manifold = contact.getWorldManifold(this.manifold);
      if (!manifold || manifold.pointCount === 0) return;
      const towardTerrain = a.getBody() === record.body ? 1 : -1;
      if (manifold.normal.x * towardTerrain * Math.sign(record.desiredX) >= ENEMY_BEHAVIOR.minimumWallNormal) {
        this.obstacles.add(record);
      }
    }
  };

  private wakeNearby(player: Readonly<Point>): void {
    if (this.records.size === 0 || this.queryPosition &&
      distanceSquared(player, this.queryPosition) < ENEMY_BEHAVIOR.queryMovement ** 2) return;
    this.queryPosition = { ...player };
    this.queries++;
    this.index.query({ lowerBound: player, upperBound: player }, (node) => {
      const record = this.records.get(this.index.getUserData(node));
      if (!record) throw new Error('The enemy activation index is inconsistent.');
      if (!this.active.has(record) && distanceSquared(record.current, player) <= ENEMY_BEHAVIOR.wakeDistance ** 2) {
        this.createCollider(record);
        record.nextDecisionAt = this.time;
        this.active.add(record);
      }
      return true;
    });
  }

  private sleep(record: EnemyRecord): void {
    this.destroyBody(record);
    this.active.delete(record);
    this.transition(record, 'patrol');
    if (record.proxy === null) throw new Error('A living enemy must have an activation proxy.');
    this.index.moveProxy(record.proxy, wakeBounds(record.current), this.zero);
    this.emit({ type: 'upsert', pose: this.pose(record) });
  }

  private fly(record: EnemyRecord, player: Readonly<Point>): void {
    const object = record.object;
    const age = this.time - record.changedAt;
    if (record.phase === 'windup') {
      if (age < ENEMY_BEHAVIOR.birdWindupSeconds) { this.drive(record, 0, 0); return; }
      this.transition(record, 'dive');
    }
    if (record.phase === 'dive') {
      if (record.target === null) throw new Error('A diving bird needs its telegraphed target.');
      const dx = record.target.x - record.current.x;
      const dy = record.target.y - record.current.y;
      const distance = Math.hypot(dx, dy);
      if (distance > ENEMY_BEHAVIOR.birdReturnTolerance && this.time - record.changedAt < ENEMY_BEHAVIOR.birdDiveSeconds) {
        this.face(record, dx);
        this.drive(record, dx / distance * ENEMY_BEHAVIOR.birdDiveSpeed, dy / distance * ENEMY_BEHAVIOR.birdDiveSpeed);
        return;
      }
      this.transition(record, 'recover');
    }
    if (record.phase === 'recover') {
      const dx = object.x - record.current.x;
      const dy = object.y - record.current.y;
      const distance = Math.hypot(dx, dy);
      if (this.time - record.changedAt < ENEMY_BEHAVIOR.birdRecoverSeconds) {
        const scale = distance > ENEMY_BEHAVIOR.birdReturnTolerance ? ENEMY_BEHAVIOR.birdReturnSpeed / distance : 0;
        this.face(record, dx);
        this.drive(record, dx * scale, dy * scale);
        return;
      }
      this.transition(record, 'patrol');
    }
    if (distanceSquared(record.current, player) <= ENEMY_BEHAVIOR.birdSight ** 2 &&
      distanceSquared(object, player) <= (object.patrolDistance + ENEMY_BEHAVIOR.birdSight) ** 2) {
      record.target = { ...player };
      this.face(record, player.x - record.current.x);
      this.transition(record, 'windup');
      this.drive(record, 0, 0);
      return;
    }
    this.turnAtPatrolEdge(record);
    const horizontal = object.patrolDistance === 0
      ? clamp((object.x - record.current.x) * ENEMY_BEHAVIOR.birdHeightGain, -object.speed, object.speed)
      : ENEMY_DIRECTION[record.facing] * object.speed;
    const vertical = clamp((object.y - record.current.y) * ENEMY_BEHAVIOR.birdHeightGain,
      -ENEMY_BEHAVIOR.birdReturnSpeed, ENEMY_BEHAVIOR.birdReturnSpeed);
    this.drive(record, horizontal, vertical);
  }

  private walk(record: EnemyRecord): void {
    if (record.phase === 'recover') {
      if (this.time - record.changedAt < ENEMY_BEHAVIOR.bumpSeconds) { this.drive(record, 0, null); return; }
      this.transition(record, 'patrol');
    }
    if (this.time >= record.nextDecisionAt) {
      this.decisions++;
      record.nextDecisionAt = this.time + ENEMY_BEHAVIOR.decisionSeconds;
      const object = record.object;
      record.desiredX = 0;
      if (object.speed > 0 && object.patrolDistance > 0) {
        this.turnAtPatrolEdge(record);
        let clear = this.groundAhead(record, ENEMY_DIRECTION[record.facing]);
        if (!clear) {
          this.face(record, -ENEMY_DIRECTION[record.facing]);
          clear = this.groundAhead(record, ENEMY_DIRECTION[record.facing]);
        }
        if (clear) record.desiredX = ENEMY_DIRECTION[record.facing] * object.speed;
      }
    }
    this.drive(record, record.desiredX, null);
  }

  private groundAhead(record: EnemyRecord, direction: number): boolean {
    const collider = ENEMY_SPECS[record.object.species].collider;
    if (collider.type !== 'box') throw new Error('Ground patrol probes need a ground enemy collider.');
    const ahead = record.current.x + direction * (collider.halfWidth + ENEMY_BEHAVIOR.ledgeAhead);
    const foot = record.current.y - collider.halfHeight;
    let found = false;
    this.world.rayCast({ x: ahead, y: foot + ENEMY_BEHAVIOR.probeRise }, { x: ahead, y: foot - ENEMY_BEHAVIOR.ledgeDepth }, (fixture) => {
      if ((fixture.getFilterCategoryBits() & PHYSICS.terrainCategory) === 0) return -1;
      found = true;
      return 0;
    });
    return found;
  }

  private turnAtPatrolEdge(record: EnemyRecord): void {
    const offset = record.current.x - record.object.x;
    if (offset >= record.object.patrolDistance - ENEMY_BEHAVIOR.patrolTolerance) record.facing = 'left';
    else if (offset <= -record.object.patrolDistance + ENEMY_BEHAVIOR.patrolTolerance) record.facing = 'right';
  }

  private face(record: EnemyRecord, dx: number): void {
    if (Math.abs(dx) > ENEMY_BEHAVIOR.patrolTolerance) record.facing = dx < 0 ? 'left' : 'right';
  }

  private drive(record: EnemyRecord, x: number, y: number | null): void {
    const body = this.body(record);
    const velocity = body.getLinearVelocity();
    const dx = x - velocity.x;
    const dy = y === null ? 0 : y - velocity.y;
    if (dx === 0 && dy === 0) return;
    const scale = body.getMass() * Math.min(1 / PHYSICS.dt, ENEMY_SPECS[record.object.species].acceleration / Math.hypot(dx, dy));
    this.force.set(dx * scale, dy * scale);
    body.applyForceToCenter(this.force, true);
  }

  private resolveBump(): void {
    if (this.bumps.size === 0 || this.time < this.nextBumpAt) return;
    const player = this.callbacks.getPot().getWorldCenter();
    let nearest: EnemyRecord | null = null;
    let distance = Infinity;
    for (const record of this.bumps) {
      if (record.health === 0 || record.phase === 'hurt' || record.phase === 'recover') continue;
      const candidate = distanceSquared(record.current, player);
      if (candidate < distance) { nearest = record; distance = candidate; }
    }
    if (nearest === null) return;
    const dx = player.x - nearest.current.x;
    const direction = dx === 0 ? ENEMY_DIRECTION[nearest.facing] : Math.sign(dx);
    this.nextBumpAt = this.time + ENEMY_BEHAVIOR.bumpSeconds;
    this.bumpCount++;
    this.transition(nearest, 'recover');
    this.callbacks.onBump({ x: direction * ENEMY_BEHAVIOR.bumpSpeed, y: ENEMY_BEHAVIOR.bumpLift });
  }

  private transition(record: EnemyRecord, phase: EnemyPhase): void {
    record.phase = phase;
    record.changedAt = this.time;
    if (phase !== 'windup' && phase !== 'dive') record.target = null;
  }

  private defeat(record: EnemyRecord, reason: 'hammer' | 'fall'): void {
    record.health = 0;
    record.defeatedBy = reason;
    this.transition(record, 'dead');
    this.destroyCollider(record);
    this.dying.add(record);
    this.emit({ type: 'upsert', pose: this.pose(record) });
  }

  private createRecord(object: EnemyObject): EnemyRecord {
    if (this.records.has(object.id)) throw new Error(`Duplicate enemy ID: ${object.id}.`);
    if (this.records.size >= ENEMY_LIMITS.objects) throw new Error('Enemy capacity exceeded.');
    const record: EnemyRecord = {
      object, body: null, proxy: null, previous: { x: object.x, y: object.y }, current: { x: object.x, y: object.y },
      facing: object.facing, phase: 'patrol', changedAt: this.time, health: ENEMY_SPECS[object.species].health,
      lastHitAt: -Infinity, nextDecisionAt: this.time, desiredX: 0, target: null, defeatedBy: null,
    };
    this.records.set(object.id, record);
    this.resetRecord(record);
    return record;
  }

  private resetRecord(record: EnemyRecord): void {
    this.active.delete(record);
    this.dying.delete(record);
    this.hits.delete(record);
    this.bumps.delete(record);
    this.obstacles.delete(record);
    const object = record.object;
    record.current.x = record.previous.x = object.x;
    record.current.y = record.previous.y = object.y;
    record.facing = object.facing;
    record.health = ENEMY_SPECS[object.species].health;
    record.lastHitAt = -Infinity;
    record.nextDecisionAt = this.time;
    record.desiredX = 0;
    record.defeatedBy = null;
    this.transition(record, 'patrol');
    this.destroyBody(record);
    if (record.proxy === null) record.proxy = this.index.createProxy(wakeBounds(object), object.id);
    else this.index.moveProxy(record.proxy, wakeBounds(object), this.zero);
  }

  private createCollider(record: EnemyRecord): void {
    if (record.body !== null) throw new Error('Cannot allocate a second collider for an enemy.');
    const spec = ENEMY_SPECS[record.object.species];
    const collider = spec.collider;
    const shape = collider.type === 'circle' ? new Circle(collider.radius) : new Box(collider.halfWidth, collider.halfHeight);
    const area = collider.type === 'circle' ? Math.PI * collider.radius ** 2 : 4 * collider.halfWidth * collider.halfHeight;
    const body = this.world.createDynamicBody({
      position: record.current, fixedRotation: true, bullet: true,
      gravityScale: record.object.species === 'bird' ? 0 : 1,
    });
    body.createFixture(shape, {
      density: spec.mass / area, friction: ENEMY_FRICTION, restitution: 0,
      filterCategoryBits: PHYSICS.enemyCategory,
      filterMaskBits: PHYSICS.terrainCategory | PHYSICS.playerCategory | PHYSICS.toolCategory,
    });
    record.body = body;
    this.bodies.set(body, record);
  }

  private destroyCollider(record: EnemyRecord): void {
    this.active.delete(record);
    if (record.proxy !== null) {
      this.index.destroyProxy(record.proxy);
      record.proxy = null;
    }
    this.destroyBody(record);
  }

  private destroyBody(record: EnemyRecord): void {
    const body = record.body;
    if (body === null) return;
    this.bodies.delete(body);
    record.body = null;
    if (!this.world.destroyBody(body)) throw new Error(`Could not remove enemy body "${record.object.id}".`);
  }

  private removeRecord(record: EnemyRecord): void {
    this.destroyCollider(record);
    this.dying.delete(record);
    this.hits.delete(record);
    this.bumps.delete(record);
    this.obstacles.delete(record);
    this.records.delete(record.object.id);
  }

  private body(record: EnemyRecord): Body {
    if (record.body === null) throw new Error(`Active enemy "${record.object.id}" has no body.`);
    return record.body;
  }

  private pose(record: EnemyRecord, alpha = 1): EnemyPose {
    const velocity = this.active.has(record) ? this.body(record).getLinearVelocity() : null;
    return {
      id: record.object.id, species: record.object.species,
      x: record.previous.x + (record.current.x - record.previous.x) * alpha,
      y: record.previous.y + (record.current.y - record.previous.y) * alpha, facing: record.facing,
      phase: record.phase, changedAt: record.changedAt,
      moving: velocity !== null && Math.hypot(velocity.x, velocity.y) > ENEMY_BEHAVIOR.movingSpeed,
    };
  }

  private emit(event: EnemyEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private ensureMutable(): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Cannot mutate or publish enemies while the physics world is stepping.');
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed enemy world.');
  }
}
