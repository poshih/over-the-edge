import { Box, Circle, DynamicTree, Vec2, WorldManifold } from 'planck';
import type { AABBValue, Body, Contact, Fixture, Vec2Value, World } from 'planck';
import { aimArc } from './ballistics';
import type { Launch } from './ballistics';
import { PHYSICS } from './config';
import type { Point, Tuning } from './config';
import { clipSpeed, clipTravel, loopingRole, modelHeight, rootMotion, walksInPlace } from './enemy-motion-data';
import type { EnemyClipRole, EnemyMotion } from './enemy-motion-data';
import { ENEMY_BEHAVIOR, ENEMY_DIRECTION, ENEMY_LIMITS, ENEMY_SPECS } from './enemy-types';
import type { EnemyEvent, EnemyFacing, EnemyPhase, EnemyPose, EnemySpecies } from './enemy-types';
import { ARROW } from './hazards';
import { isEnemyObject } from './level';
import type { EnemyObject, LevelChange } from './level';
import { clamp } from './math';

// Where a hammer-head strike landed, in world metres, and the contact's unit normal there, toward the head.
interface Strike {
  x: number;
  y: number;
  normalX: number;
  normalY: number;
}

interface EnemyRecord {
  object: EnemyObject;
  body: Body | null;
  proxy: number | null;
  previous: Point;
  current: Point;
  facing: EnemyFacing;
  phase: EnemyPhase;
  changedAt: number;
  // Hit points left and the species' health at the last reset or spawn.
  health: number;
  maxHealth: number;
  // The fastest hammer-head strike this step, as closing speed in m/s; 0 without one. `struck` is where it landed.
  strike: number;
  readonly struck: Strike;
  lastHitAt: number;
  nextDecisionAt: number;
  desiredX: number;
  readonly target: Point;
  hasTarget: boolean;
  defeatedBy: 'hammer' | 'fall' | null;
  // The clip it plays and since when, in simulation seconds.
  role: EnemyClipRole;
  roleAt: number;
  // Where a corpse whose death clip travels began it.
  deathX: number;
}

interface EnemyCallbacks {
  readonly getPot: () => Body;
  // Null while the hammer cannot hurt enemies; its physical contacts still resolve.
  readonly getHeadFixture: () => Fixture | null;
  readonly canBump: () => boolean;
  readonly isTransientTerrain: (body: Body) => boolean;
  readonly insideTerrain: (terrain: Body, point: Vec2Value) => boolean;
  // A bump: borrowed velocity change, the enemy that dealt it and where they met, in world metres.
  readonly onBump: (velocityChange: Readonly<Point>, enemy: string, atX: number, atY: number) => void;
  // A hit the enemy survives: where the head struck, borrowed, the hit points it lost and has left, and its maximum.
  readonly onHit: (enemy: string, species: EnemySpecies, x: number, y: number, strike: Readonly<Strike>, damage: number,
    health: number, max: number) => void;
  // A defeat: the hammer's killing strike, borrowed, or null for a fall, and the hit points it took, all the enemy had left.
  readonly onDefeat: (enemy: string, species: EnemySpecies, x: number, y: number, by: 'hammer' | 'fall',
    strike: Readonly<Strike> | null, damage: number, max: number) => void;
  // Whether an arrow loosed from (x, y) at (velocityX, velocityY), in m/s, flies on for `seconds`, within its range and
  // with no terrain in its way.
  readonly clearShot: (x: number, y: number, velocityX: number, velocityY: number, seconds: number) => boolean;
  // An archer looses an arrow from (x, y) at (velocityX, velocityY), in m/s.
  readonly shoot: (enemy: string, x: number, y: number, velocityX: number, velocityY: number) => void;
}

const ENEMY_FRICTION = 0.15;
// The settings each species takes its health, armor, mass and acceleration from.
const SPECIES_TUNING = {
  bird: { health: 'birdHealth', armor: 'birdArmor', mass: 'birdMass', acceleration: 'birdAcceleration' },
  'hollow-soldier': { health: 'soldierHealth', armor: 'soldierArmor', mass: 'soldierMass', acceleration: 'soldierAcceleration' },
  'hollow-archer': { health: 'archerHealth', armor: 'archerArmor', mass: 'archerMass', acceleration: 'archerAcceleration' },
} as const satisfies Readonly<Record<EnemySpecies, Readonly<Record<'health' | 'armor' | 'mass' | 'acceleration', keyof Tuning>>>>;
type MutableEnemyPose = { -readonly [K in keyof EnemyPose]: EnemyPose[K] };
// The clip each phase but patrol plays; a patrol idles or walks.
const PHASE_ROLES = {
  windup: 'windup', dive: 'dive', recover: 'recover', hurt: 'hurt', dead: 'death',
} as const satisfies Readonly<Record<Exclude<EnemyPhase, 'patrol'>, EnemyClipRole>>;

function emptyPose(): MutableEnemyPose {
  return {
    id: '', species: 'bird', x: 0, y: 0, facing: 'right', phase: 'patrol', changedAt: 0, moving: false, health: 0, maxHealth: 0,
    clip: 'idle', clipTime: 0,
  };
}

// The hit points a hammer-head strike closing at `speed` m/s takes: the full hammer damage at the full-damage speed and
// above, proportionally less below it, and at least 1.
function strikeDamage(speed: number, tuning: Readonly<Tuning>): number {
  return Math.max(1, Math.round(tuning.hammerDamage * Math.min(1, speed / tuning.hammerFullSpeed)));
}

function distanceSquared(a: Readonly<Point>, b: Readonly<Point>): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function wakeBounds(position: Readonly<Point>, out: AABBValue): AABBValue {
  out.lowerBound.x = position.x - ENEMY_BEHAVIOR.wakeDistance;
  out.lowerBound.y = position.y - ENEMY_BEHAVIOR.wakeDistance;
  out.upperBound.x = position.x + ENEMY_BEHAVIOR.wakeDistance;
  out.upperBound.y = position.y + ENEMY_BEHAVIOR.wakeDistance;
  return out;
}

function pointVelocity(body: Body, point: Vec2Value, out: Point): Point {
  const center = body.getWorldCenter(), velocity = body.getLinearVelocity();
  const spin = body.getAngularVelocity();
  out.x = velocity.x + -spin * (point.y - center.y);
  out.y = velocity.y + spin * (point.x - center.x);
  return out;
}

export class EnemyWorld {
  private readonly world: World;
  private readonly callbacks: EnemyCallbacks;
  private tuning: Readonly<Tuning>;
  private motion: EnemyMotion;
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
  private readonly bumpVelocity: Point = { x: 0, y: 0 };
  private readonly zero = new Vec2();
  private readonly manifold = new WorldManifold();
  private readonly headVelocity = new Vec2();
  private readonly enemyVelocity = new Vec2();
  private readonly probeFrom = new Vec2();
  private readonly probeTo = new Vec2();
  private readonly launch: Launch = { velocityX: 0, velocityY: 0, seconds: 0 };
  private groundFound = false;
  private stepPlayer: Readonly<Point> = this.zero;
  // The jar's bottom below the player's root, where the hurt box starts.
  private playerBottom = 0;
  private beforeTime = 0;
  private afterTime = 0;
  private bumpPlayer: Readonly<Point> = this.zero;
  private nearestBump: EnemyRecord | null = null;
  private bumpDistance = Infinity;
  private emittedEvent: EnemyEvent | null = null;
  private readonly framePool = Array.from({ length: ENEMY_LIMITS.objects }, emptyPose);
  private readonly framePosePool = Array.from({ length: ENEMY_LIMITS.objects + 1 }, (_, count) => this.framePool.slice(0, count));
  private frameAlpha = 1;
  private frameCount = 0;
  private readonly queryPosition: Point = { x: 0, y: 0 };
  private hasQueryPosition = false;
  private readonly wakeQuery: AABBValue = { lowerBound: this.queryPosition, upperBound: this.queryPosition };
  private readonly wakeBox: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  private time = 0;
  private nextBumpAt = 0;
  private activeUpdates = 0;
  private decisions = 0;
  private queries = 0;
  private bumpCount = 0;
  private disposed = false;

  constructor(world: World, objects: readonly EnemyObject[], tuning: Readonly<Tuning>, motion: EnemyMotion,
    callbacks: EnemyCallbacks) {
    this.world = world;
    this.callbacks = callbacks;
    this.tuning = tuning;
    this.motion = motion;
    this.ensureMutable();
    for (const object of objects) this.createRecord(object);
    world.on('begin-contact', this.onBeginContact);
    world.on('pre-solve', this.onPreSolve);
  }

  setTuning(tuning: Readonly<Tuning>): void {
    this.ensureMutable();
    const previous = this.tuning;
    this.tuning = tuning;
    for (const [body, record] of this.bodies) {
      const species = record.object.species;
      const mass = SPECIES_TUNING[species].mass;
      if (previous[mass] === tuning[mass]) continue;
      const fixture = body.getFixtureList();
      if (fixture === null) throw new Error(`Enemy "${record.object.id}" has no collider.`);
      fixture.setDensity(this.density(species));
      body.resetMassData();
      body.setAwake(true);
    }
  }

  // Each species' model motion, from the next step; a species without a model moves as its sprite does.
  setMotion(motion: EnemyMotion): void {
    this.ensureMutable();
    this.motion = motion;
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
    this.hasQueryPosition = false;
  }

  reset(time: number): void {
    this.ensureMutable();
    this.time = time;
    for (const record of this.records.values()) this.resetRecord(record);
    this.hits.clear();
    this.bumps.clear();
    this.obstacles.clear();
    this.nextBumpAt = time;
    this.hasQueryPosition = false;
    this.bumpCount = 0;
    this.emit({ type: 'reset', poses: [...this.records.values()].map((record) => this.pose(record)) });
  }

  // `player` is the player's root and `bottom` its jar's bottom below it.
  beforeStep(player: Readonly<Point>, time: number, bottom: number): void {
    this.ensureMutable();
    this.time = time;
    this.playerBottom = bottom;
    this.wakeNearby(player);
    const previousPlayer = this.stepPlayer, previousTime = this.beforeTime;
    this.stepPlayer = player;
    this.beforeTime = time;
    try { this.active.forEach(this.driveActive); }
    finally { this.stepPlayer = previousPlayer; this.beforeTime = previousTime; }
  }

  private readonly driveActive = (record: EnemyRecord): void => {
    record.previous.x = record.current.x;
    record.previous.y = record.current.y;
    if (distanceSquared(record.current, this.stepPlayer) > ENEMY_BEHAVIOR.sleepDistance ** 2) {
      // Distant enemies get no AI; gravity-bound ones sleep only after they settle.
      if (this.canSleep(record)) this.sleep(record);
      return;
    }
    this.activeUpdates++;
    if (record.phase === 'hurt') {
      if (this.beforeTime - record.changedAt < ENEMY_BEHAVIOR.hurtSeconds) {
        if (record.object.species === 'bird') this.drive(record, 0, 0);
        else this.stride(record, 0);
        return;
      }
      this.transition(record, record.object.species === 'bird' ? 'recover' : 'patrol');
    }
    const species = record.object.species;
    if (species === 'bird') this.fly(record, this.stepPlayer);
    else if (species === 'hollow-archer') this.archer(record, this.stepPlayer);
    else this.walk(record);
  };

  afterStep(time: number): void {
    this.ensureMutable();
    this.time = time;
    const previousTime = this.afterTime;
    this.afterTime = time;
    try {
      this.active.forEach(this.captureActive);
      // Contacts only enqueue identities while World.step is locked. Resolve hits before bumps.
      this.hits.forEach(this.resolveHit);
      this.obstacles.forEach(this.resolveObstacle);
      this.resolveBump();
      this.hits.clear();
      this.bumps.clear();
      this.obstacles.clear();
      this.dying.forEach(this.advanceDying);
    } finally { this.afterTime = previousTime; }
  }

  private readonly captureActive = (record: EnemyRecord): void => {
    const body = this.body(record);
    const position = body.getPosition();
    const velocity = body.getLinearVelocity();
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) ||
      !Number.isFinite(velocity.x) || !Number.isFinite(velocity.y)) {
      throw new Error(`Non-finite physics state on enemy "${record.object.id}".`);
    }
    record.current.x = position.x;
    record.current.y = position.y;
    if (position.y < record.object.y - ENEMY_BEHAVIOR.fallenDistance) this.defeat(record, 'fall');
  };

  private readonly resolveHit = (record: EnemyRecord): void => {
    const speed = record.strike;
    record.strike = 0;
    if (record.health === 0 || this.afterTime - record.lastHitAt < ENEMY_BEHAVIOR.hitSeconds) return;
    record.lastHitAt = this.afterTime;
    const damage = strikeDamage(speed, this.tuning);
    // A model moving as its clips travel turns to face the strike, so its hurt or death carries it away from the hammer,
    // and walks on that way.
    if (this.travels(record) && record.struck.normalX !== 0) {
      record.facing = record.struck.normalX < 0 ? 'left' : 'right';
      record.desiredX = ENEMY_DIRECTION[record.facing] * Math.abs(record.desiredX);
    }
    if (damage >= record.health) {
      this.defeat(record, 'hammer');
      return;
    }
    record.health -= damage;
    this.transition(record, 'hurt');
    this.callbacks.onHit(record.object.id, record.object.species, record.current.x, record.current.y, record.struck,
      damage, record.health, record.maxHealth);
  };

  private readonly resolveObstacle = (record: EnemyRecord): void => {
    // A model struck this step keeps facing the strike, which its hurt carries it away from.
    if (record.health === 0 || (this.travels(record) && record.phase !== 'patrol')) return;
    if (record.object.species === 'bird') {
      if (record.phase === 'dive') this.transition(record, 'recover');
      else if (record.phase === 'patrol') this.face(record, -ENEMY_DIRECTION[record.facing]);
    } else {
      this.face(record, -ENEMY_DIRECTION[record.facing]);
      record.desiredX = ENEMY_DIRECTION[record.facing] * record.object.speed;
    }
  };

  // A corpse travels as its model's death clip does, and goes when that clip ends; a sprite's once it has dissolved.
  private readonly advanceDying = (record: EnemyRecord): void => {
    const species = record.object.species;
    const death = this.motion[species]?.death;
    const age = this.afterTime - record.changedAt;
    record.previous.x = record.current.x;
    record.previous.y = record.current.y;
    if (death !== undefined && rootMotion(species)) {
      record.current.x = record.deathX + ENEMY_DIRECTION[record.facing] * clipTravel(death, age, false) * modelHeight(species);
    }
    if (age < (death?.duration ?? ENEMY_BEHAVIOR.deathSeconds)) return;
    this.dying.delete(record);
    if (this.listeners.size > 0) this.emit({ type: 'remove', id: record.object.id });
  };

  settleInterpolation(): void {
    this.ensureLive();
    this.active.forEach(this.settlePose);
    this.dying.forEach(this.settlePose);
  }

  private readonly settlePose = (record: EnemyRecord): void => {
    record.previous.x = record.current.x;
    record.previous.y = record.current.y;
  };

  // The active enemies and the corpses still shown. The array and every pose are pooled and borrowed until the next
  // frame().
  frame(alpha: number): readonly EnemyPose[] {
    this.ensureLive();
    this.frameAlpha = alpha;
    this.frameCount = 0;
    this.active.forEach(this.writeFramePose);
    this.dying.forEach(this.writeFramePose);
    return this.framePosePool[this.frameCount]!;
  }

  // A cached visitor also avoids creating a Set iterator on each drawn frame.
  private readonly writeFramePose = (record: EnemyRecord): void => {
    const pose = this.framePool[this.frameCount++]!;
    this.writePose(record, pose, this.frameAlpha);
  };

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
        ...this.pose(record), health: record.health, maxHealth: record.maxHealth,
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
    const otherFixture = a === record.body ? contact.getFixtureB() : contact.getFixtureA();
    if (otherFixture === this.callbacks.getHeadFixture()) {
      const manifold = contact.getWorldManifold(this.manifold);
      if (!manifold || manifold.pointCount === 0) throw new Error('A hammer impact needs a solid contact manifold.');
      const head = pointVelocity(other, manifold.points[0], this.headVelocity);
      const enemy = pointVelocity(this.body(record), manifold.points[0], this.enemyVelocity);
      const orientation = a === record.body ? -1 : 1;
      const speed = ((head.x - enemy.x) * manifold.normal.x + (head.y - enemy.y) * manifold.normal.y) * orientation;
      // A strike no faster than the species' armor glances off. Of several contacts in one step, the fastest counts.
      if (speed > this.tuning[SPECIES_TUNING[record.object.species].armor] && speed > record.strike) {
        record.strike = speed;
        const struck = record.struck;
        struck.x = struck.y = 0;
        for (let index = 0; index < manifold.pointCount; index++) {
          struck.x += manifold.points[index]!.x;
          struck.y += manifold.points[index]!.y;
        }
        struck.x /= manifold.pointCount;
        struck.y /= manifold.pointCount;
        struck.normalX = -manifold.normal.x * orientation;
        struck.normalY = -manifold.normal.y * orientation;
        this.hits.add(record);
      }
    } else if (other === this.callbacks.getPot()) this.bumps.add(record);
    else if (record.object.species === 'bird') {
      // Begin-contact fires before TerrainWorld's pre-solve can disable interior contacts.
      if ((otherFixture.getFilterCategoryBits() & PHYSICS.terrainCategory) !== 0 &&
        !this.callbacks.insideTerrain(other, this.body(record).getWorldCenter())) this.obstacles.add(record);
    }
  };

  private readonly onPreSolve = (contact: Contact): void => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    const record = this.bodies.get(a.getBody()) ?? this.bodies.get(b.getBody());
    if (!record || !contact.isTouching()) return;
    const other = a.getBody() === record.body ? b : a;
    if ((other.getFilterCategoryBits() & PHYSICS.terrainCategory) === 0) return;
    // Interior contacts are disabled by TerrainWorld and must not steer enemies.
    if (this.callbacks.insideTerrain(other.getBody(), this.body(record).getWorldCenter())) return;
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
    if (this.records.size === 0 || this.hasQueryPosition &&
      distanceSquared(player, this.queryPosition) < ENEMY_BEHAVIOR.queryMovement ** 2) return;
    this.queryPosition.x = player.x; this.queryPosition.y = player.y;
    this.hasQueryPosition = true;
    this.queries++;
    this.index.query(this.wakeQuery, this.wakeEnemy);
  }

  private readonly wakeEnemy = (node: number): boolean => {
    const record = this.records.get(this.index.getUserData(node));
    if (!record) throw new Error('The enemy activation index is inconsistent.');
    if (!this.active.has(record) && distanceSquared(record.current, this.queryPosition) <= ENEMY_BEHAVIOR.wakeDistance ** 2) {
      this.createCollider(record);
      record.nextDecisionAt = this.time;
      this.active.add(record);
    }
    return true;
  };

  private sleep(record: EnemyRecord): void {
    this.destroyBody(record);
    this.active.delete(record);
    // It decides afresh when it wakes; asleep, it stands.
    record.desiredX = 0;
    this.transition(record, 'patrol');
    this.faceAuthored(record);
    if (record.proxy === null) throw new Error('A living enemy must have an activation proxy.');
    this.index.moveProxy(record.proxy, wakeBounds(record.current, this.wakeBox), this.zero);
    this.emitPose(record);
  }

  private canSleep(record: EnemyRecord): boolean {
    if (record.object.species === 'bird') return true;
    const body = this.body(record);
    // Planck only sleeps settled bodies, so a falling or sliding soldier stays simulated
    // until it lands or falls far enough below home to be defeated.
    if (body.isAwake()) return false;
    for (let edge = body.getContactList(); edge; edge = edge.next) {
      // Keep the sleeping body on vanishing terrain: removing that support wakes it to fall.
      if (edge.other !== null && edge.contact.isTouching() && edge.contact.isEnabled() &&
        this.callbacks.isTransientTerrain(edge.other)) return false;
    }
    return true;
  }

  private fly(record: EnemyRecord, player: Readonly<Point>): void {
    const object = record.object;
    const age = this.time - record.changedAt;
    if (record.phase === 'windup') {
      if (age < ENEMY_BEHAVIOR.birdWindupSeconds) { this.drive(record, 0, 0); return; }
      this.transition(record, 'dive');
    }
    if (record.phase === 'dive') {
      if (!record.hasTarget) throw new Error('A diving bird needs its telegraphed target.');
      const dx = record.target.x - record.current.x;
      const dy = record.target.y - record.current.y;
      const distance = Math.hypot(dx, dy);
      if (distance > ENEMY_BEHAVIOR.birdReturnTolerance && this.time - record.changedAt < ENEMY_BEHAVIOR.birdDiveSeconds) {
        this.face(record, dx);
        this.drive(record, dx / distance * this.tuning.birdDiveSpeed, dy / distance * this.tuning.birdDiveSpeed);
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
    if (distanceSquared(record.current, player) <= this.tuning.birdSight ** 2 &&
      distanceSquared(object, player) <= (object.patrolDistance + this.tuning.birdSight) ** 2) {
      record.target.x = player.x; record.target.y = player.y;
      record.hasTarget = true;
      this.face(record, player.x - record.current.x);
      this.transition(record, 'windup');
      this.drive(record, 0, 0);
      return;
    }
    if (object.patrolDistance === 0) this.faceAuthored(record);
    else this.turnAtPatrolEdge(record);
    const horizontal = object.patrolDistance === 0
      ? clamp((object.x - record.current.x) * ENEMY_BEHAVIOR.birdHeightGain, -object.speed, object.speed)
      : ENEMY_DIRECTION[record.facing] * object.speed;
    const vertical = clamp((object.y - record.current.y) * ENEMY_BEHAVIOR.birdHeightGain,
      -ENEMY_BEHAVIOR.birdReturnSpeed, ENEMY_BEHAVIOR.birdReturnSpeed);
    this.drive(record, horizontal, vertical);
  }

  private walk(record: EnemyRecord): void {
    if (record.phase === 'recover') {
      if (this.time - record.changedAt < ENEMY_BEHAVIOR.bumpSeconds) { this.stride(record, 0); return; }
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
      } else this.faceAuthored(record);
    }
    this.play(record, record.desiredX === 0 ? 'idle' : 'walk');
    this.stride(record, record.desiredX);
  }

  // An archer walks its patrol as a soldier does until it has a shot at the player, then stands, turned to the player,
  // and draws. At the end of the draw it aims again and looses, then reloads, or walks on if it has lost its shot.
  private archer(record: EnemyRecord, player: Readonly<Point>): void {
    const age = this.time - record.changedAt;
    if (record.phase === 'windup') {
      this.face(record, player.x - record.current.x);
      this.stride(record, 0);
      if (age < ENEMY_BEHAVIOR.archerDrawSeconds) return;
      if (this.aim(record, player)) {
        this.callbacks.shoot(record.object.id, record.current.x, record.current.y + ENEMY_BEHAVIOR.archerBowHeight,
          this.launch.velocityX, this.launch.velocityY);
        this.transition(record, 'recover');
      } else this.transition(record, 'patrol');
      return;
    }
    if (record.phase === 'recover') {
      if (age < ENEMY_BEHAVIOR.archerReloadSeconds) { this.stride(record, 0); return; }
      this.transition(record, 'patrol');
    }
    if (this.time >= record.nextDecisionAt && this.aim(record, player)) {
      this.decisions++;
      record.nextDecisionAt = this.time + ENEMY_BEHAVIOR.decisionSeconds;
      record.desiredX = 0;
      this.face(record, player.x - record.current.x);
      this.transition(record, 'windup');
      this.stride(record, 0);
      return;
    }
    this.walk(record);
  }

  // Whether an archer has a shot at the middle of the player's hurt box: a player within its sight whom an arrow can
  // reach within its range, along an arc clear of terrain, the low one or else the high one. Leaves the launch in
  // `launch`.
  private aim(record: EnemyRecord, player: Readonly<Point>): boolean {
    if (distanceSquared(record.current, player) > this.tuning.archerSight ** 2) return false;
    const x = record.current.x;
    const y = record.current.y + ENEMY_BEHAVIOR.archerBowHeight;
    const dx = player.x - x;
    const dy = player.y + this.playerBottom + this.tuning.hurtHeight / 2 - y;
    return this.clearArc(x, y, dx, dy, false) || this.clearArc(x, y, dx, dy, true);
  }

  private clearArc(x: number, y: number, dx: number, dy: number, high: boolean): boolean {
    const launch = this.launch;
    return aimArc(dx, dy, this.tuning.arrowSpeed, ARROW.gravity, high, launch) &&
      this.callbacks.clearShot(x, y, launch.velocityX, launch.velocityY, launch.seconds);
  }

  private groundAhead(record: EnemyRecord, direction: number): boolean {
    const collider = ENEMY_SPECS[record.object.species].collider;
    if (collider.type !== 'box') throw new Error('Ground patrol probes need a ground enemy collider.');
    const ahead = record.current.x + direction * (collider.halfWidth + ENEMY_BEHAVIOR.ledgeAhead);
    const foot = record.current.y - collider.halfHeight;
    this.probeFrom.set(ahead, foot + ENEMY_BEHAVIOR.probeRise);
    this.probeTo.set(ahead, foot - ENEMY_BEHAVIOR.ledgeDepth);
    this.groundFound = false;
    this.world.rayCast(this.probeFrom, this.probeTo, this.probeGround);
    return this.groundFound;
  }

  private readonly probeGround = (fixture: Fixture): number => {
    if ((fixture.getFilterCategoryBits() & PHYSICS.terrainCategory) === 0) return -1;
    this.groundFound = true;
    return 0;
  };

  private turnAtPatrolEdge(record: EnemyRecord): void {
    const offset = record.current.x - record.object.x;
    if (offset >= record.object.patrolDistance - ENEMY_BEHAVIOR.patrolTolerance) record.facing = 'left';
    else if (offset <= -record.object.patrolDistance + ENEMY_BEHAVIOR.patrolTolerance) record.facing = 'right';
  }

  // Enemies without a patrol face their authored direction whenever they patrol: a hovering bird, or an archer that
  // turned to shoot.
  private faceAuthored(record: EnemyRecord): void {
    if (record.object.patrolDistance === 0) record.facing = record.object.facing;
  }

  private face(record: EnemyRecord, dx: number): void {
    if (Math.abs(dx) > ENEMY_BEHAVIOR.patrolTolerance) record.facing = dx < 0 ? 'left' : 'right';
  }

  // Whether the enemy moves as its model's clips travel: a ground enemy with a model.
  private travels(record: EnemyRecord): boolean {
    const species = record.object.species;
    return rootMotion(species) && this.motion[species] !== null;
  }

  // Drives a ground enemy along its facing as far as its model's clip travels over this step; without a model, or while
  // its walk walks in place, toward `speed` m/s, as a sprite moves.
  private stride(record: EnemyRecord, speed: number): void {
    const species = record.object.species;
    const motion = this.motion[species]?.[record.role];
    if (motion === undefined || (record.role === 'walk' && walksInPlace(motion))) {
      this.drive(record, speed, null);
      return;
    }
    const rate = this.clipRate(record);
    const loop = loopingRole(record.role);
    const from = (this.time - record.roleAt) * rate;
    const travelled = clipTravel(motion, from + PHYSICS.dt * rate, loop) - clipTravel(motion, from, loop);
    this.drive(record, ENEMY_DIRECTION[record.facing] * travelled * modelHeight(species) / PHYSICS.dt, null);
  }

  // How fast the enemy's clip plays: a model's walk at the rate that travels at its Patrol speed; every other clip, and
  // a walk in place, at its own pace.
  private clipRate(record: EnemyRecord): number {
    const species = record.object.species;
    if (record.role !== 'walk' || !rootMotion(species)) return 1;
    const walk = this.motion[species]?.walk;
    return walk === undefined || walksInPlace(walk) ? 1 : record.object.speed / clipSpeed(walk, modelHeight(species));
  }

  // Plays `role` from now, unless the enemy plays it already.
  private play(record: EnemyRecord, role: EnemyClipRole): void {
    if (record.role === role) return;
    record.role = role;
    record.roleAt = this.time;
  }

  private drive(record: EnemyRecord, x: number, y: number | null): void {
    const body = this.body(record);
    const velocity = body.getLinearVelocity();
    const dx = x - velocity.x;
    const dy = y === null ? 0 : y - velocity.y;
    if (dx === 0 && dy === 0) return;
    const acceleration = this.tuning[SPECIES_TUNING[record.object.species].acceleration];
    const scale = body.getMass() * Math.min(1 / PHYSICS.dt, acceleration / Math.hypot(dx, dy));
    this.force.set(dx * scale, dy * scale);
    body.applyForceToCenter(this.force, true);
  }

  private resolveBump(): void {
    if (!this.callbacks.canBump() || this.bumps.size === 0 || this.time < this.nextBumpAt) return;
    const player = this.callbacks.getPot().getWorldCenter();
    const nearest = this.findBump(player);
    if (nearest === null) return;
    const dx = player.x - nearest.current.x;
    const direction = dx === 0 ? ENEMY_DIRECTION[nearest.facing] : Math.sign(dx);
    this.nextBumpAt = this.time + ENEMY_BEHAVIOR.bumpSeconds;
    this.bumpCount++;
    this.transition(nearest, 'recover');
    this.bumpVelocity.x = direction * this.tuning.bumpSpeed;
    this.bumpVelocity.y = this.tuning.bumpLift;
    this.callbacks.onBump(this.bumpVelocity, nearest.object.id,
      (player.x + nearest.current.x) / 2, (player.y + nearest.current.y) / 2);
  }

  private findBump(player: Readonly<Point>): EnemyRecord | null {
    this.bumpPlayer = player;
    this.nearestBump = null;
    this.bumpDistance = Infinity;
    try {
      this.bumps.forEach(this.chooseBump);
      const nearest = this.nearestBump;
      return nearest;
    } finally {
      this.nearestBump = null;
      this.bumpPlayer = this.zero;
    }
  }

  private readonly chooseBump = (record: EnemyRecord): void => {
    if (record.health === 0 || record.phase === 'hurt' || record.phase === 'recover') return;
    const candidate = distanceSquared(record.current, this.bumpPlayer);
    if (candidate < this.bumpDistance) { this.nearestBump = record; this.bumpDistance = candidate; }
  };

  private transition(record: EnemyRecord, phase: EnemyPhase): void {
    record.phase = phase;
    record.changedAt = this.time;
    // Each phase plays its clip from the start.
    record.role = phase === 'patrol' ? this.patrolRole(record) : PHASE_ROLES[phase];
    record.roleAt = this.time;
    if (phase !== 'windup' && phase !== 'dive') record.hasTarget = false;
    // Accepted surviving hits enter hurt once, after World.step unlocks. Publish the same pose snapshot as other upserts.
    if (phase === 'hurt') this.emitPose(record);
  }

  // A patrol walks while it moves and idles while it stands: a ground enemy as its last decision chose, a bird as its
  // patrol flies it.
  private patrolRole(record: EnemyRecord): EnemyClipRole {
    const object = record.object;
    const moving = object.species === 'bird' ? object.patrolDistance > 0 && object.speed > 0 : record.desiredX !== 0;
    return moving ? 'walk' : 'idle';
  }

  private defeat(record: EnemyRecord, reason: 'hammer' | 'fall'): void {
    const damage = record.health;
    record.health = 0;
    record.defeatedBy = reason;
    record.deathX = record.current.x;
    this.transition(record, 'dead');
    this.destroyCollider(record);
    this.dying.add(record);
    this.emitPose(record);
    this.callbacks.onDefeat(record.object.id, record.object.species, record.current.x, record.current.y, reason,
      reason === 'hammer' ? record.struck : null, damage, record.maxHealth);
  }

  private createRecord(object: EnemyObject): EnemyRecord {
    if (this.records.has(object.id)) throw new Error(`Duplicate enemy ID: ${object.id}.`);
    if (this.records.size >= ENEMY_LIMITS.objects) throw new Error('Enemy capacity exceeded.');
    const record: EnemyRecord = {
      object, body: null, proxy: null, previous: { x: object.x, y: object.y }, current: { x: object.x, y: object.y },
      facing: object.facing, phase: 'patrol', changedAt: this.time, health: 0, maxHealth: 0, strike: 0,
      struck: { x: 0, y: 0, normalX: 0, normalY: 0 },
      lastHitAt: -Infinity, nextDecisionAt: this.time, desiredX: 0, target: { x: 0, y: 0 }, hasTarget: false, defeatedBy: null,
      role: 'idle', roleAt: this.time, deathX: object.x,
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
    record.health = record.maxHealth = this.tuning[SPECIES_TUNING[object.species].health];
    record.strike = 0;
    record.lastHitAt = -Infinity;
    record.nextDecisionAt = this.time;
    record.desiredX = 0;
    record.defeatedBy = null;
    this.transition(record, 'patrol');
    this.destroyBody(record);
    if (record.proxy === null) record.proxy = this.index.createProxy(wakeBounds(object, this.wakeBox), object.id);
    else this.index.moveProxy(record.proxy, wakeBounds(object, this.wakeBox), this.zero);
  }

  private createCollider(record: EnemyRecord): void {
    if (record.body !== null) throw new Error('Cannot allocate a second collider for an enemy.');
    const collider = ENEMY_SPECS[record.object.species].collider;
    const shape = collider.type === 'circle' ? new Circle(collider.radius) : new Box(collider.halfWidth, collider.halfHeight);
    const body = this.world.createDynamicBody({
      position: record.current, fixedRotation: true, bullet: true,
      gravityScale: record.object.species === 'bird' ? 0 : 1,
    });
    body.createFixture(shape, {
      density: this.density(record.object.species), friction: ENEMY_FRICTION, restitution: 0,
      filterCategoryBits: PHYSICS.enemyCategory,
      filterMaskBits: PHYSICS.terrainCategory | PHYSICS.playerCategory | PHYSICS.toolCategory,
    });
    record.body = body;
    this.bodies.set(body, record);
  }

  private density(species: EnemySpecies): number {
    const collider = ENEMY_SPECS[species].collider;
    const area = collider.type === 'circle' ? Math.PI * collider.radius ** 2 : 4 * collider.halfWidth * collider.halfHeight;
    const mass = this.tuning[SPECIES_TUNING[species].mass];
    return mass / area;
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

  private pose(record: EnemyRecord): EnemyPose {
    const pose = emptyPose();
    this.writePose(record, pose, 1);
    return pose;
  }

  private writePose(record: EnemyRecord, pose: MutableEnemyPose, alpha: number): void {
    const velocity = this.active.has(record) ? this.body(record).getLinearVelocity() : null;
    pose.id = record.object.id;
    pose.species = record.object.species;
    pose.x = record.previous.x + (record.current.x - record.previous.x) * alpha;
    pose.y = record.previous.y + (record.current.y - record.previous.y) * alpha;
    pose.facing = record.facing;
    pose.phase = record.phase;
    pose.changedAt = record.changedAt;
    pose.moving = velocity !== null && Math.hypot(velocity.x, velocity.y) > ENEMY_BEHAVIOR.movingSpeed;
    pose.health = record.health;
    pose.maxHealth = record.maxHealth;
    pose.clip = record.role;
    // The frame shows the state `alpha` of the way through the last step.
    pose.clipTime = Math.max(0, this.time - (1 - alpha) * PHYSICS.dt - record.roleAt) * this.clipRate(record);
  }

  private emit(event: EnemyEvent): void {
    const previous = this.emittedEvent;
    this.emittedEvent = event;
    try { this.listeners.forEach(this.publishEvent); }
    finally { this.emittedEvent = previous; }
  }

  private readonly publishEvent = (listener: (event: EnemyEvent) => void): void => {
    listener(this.emittedEvent!);
  };

  private emitPose(record: EnemyRecord): void {
    if (this.listeners.size > 0) this.emit({ type: 'upsert', pose: this.pose(record) });
  }

  private ensureMutable(): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Cannot mutate or publish enemies while the physics world is stepping.');
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed enemy world.');
  }
}
