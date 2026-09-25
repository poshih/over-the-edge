import { Chain, Circle, Vec2, WorldManifold } from 'planck';
import type { Body, Contact, ContactImpulse, World } from 'planck';
import { PHYSICS } from './config';
import { geometryKey, ILLUSION, isTerrainObject, shapeVertices } from './level';
import type { LevelChange, TerrainObject, TerrainEvent } from './level';

export class TerrainWorld {
  private readonly world: World;
  private readonly getPot: () => Body;
  private readonly objects = new Map<string, TerrainObject>();
  private readonly bodies = new Map<string, Body>();
  private readonly ids = new Map<Body, string>();
  private readonly candidates = new Set<string>();
  private readonly fading = new Map<string, number>();
  private readonly disappeared = new Set<string>();
  private readonly listeners = new Set<(event: TerrainEvent) => void>();
  private readonly manifold = new WorldManifold();
  private disposed = false;

  constructor(world: World, objects: readonly TerrainObject[], getPot: () => Body) {
    this.world = world;
    this.getPot = getPot;
    this.ensureMutable();
    for (const object of objects) {
      if (this.objects.has(object.id)) throw new Error(`Duplicate terrain ID: ${object.id}.`);
      this.upsert(object);
    }
    this.world.on('post-solve', this.onPostSolve);
  }

  apply(change: LevelChange): void {
    this.ensureMutable();
    if (change.kind === 'replace') {
      const terrain = change.level.objects.filter(isTerrainObject);
      const retained = new Set(terrain.map((object) => object.id));
      for (const id of this.objects.keys()) {
        if (!retained.has(id)) this.remove(id);
      }
      for (const object of terrain) this.upsert(object);
      this.emit({ type: 'reset', objects: [...this.objects.values()] });
      return;
    }
    const removed = new Set(change.remove.filter((id) => this.objects.has(id)));
    for (const object of change.upsert) {
      if (object.kind !== 'terrain' && this.objects.has(object.id)) removed.add(object.id);
    }
    const terrain = change.upsert.filter(isTerrainObject);
    const removals = new Set(removed);
    for (const object of terrain) {
      const previous = this.objects.get(object.id);
      if (previous && geometryKey(previous.shape) !== geometryKey(object.shape)) removals.add(object.id);
    }
    for (const id of removed) this.remove(id);
    for (const object of terrain) this.upsert(object);
    // Release replaced render templates before allocating any new template in this edit.
    for (const id of removals) this.emit({ type: 'remove', id });
    for (const object of terrain) this.emit({ type: 'upsert', object });
  }

  reset(): void {
    this.ensureMutable();
    const restored = new Set([...this.fading.keys(), ...this.disappeared]);
    for (const id of this.disappeared) this.createBody(this.object(id));
    this.candidates.clear();
    this.fading.clear();
    this.disappeared.clear();
    for (const id of restored) this.emit({ type: 'upsert', object: this.object(id) });
  }

  advance(time: number): void {
    this.ensureMutable();
    if (!Number.isFinite(time) || time < 0) throw new Error('Terrain time must be finite and nonnegative.');
    for (const id of this.candidates) {
      this.fading.set(id, time);
      this.emit({ type: 'fade', id, startedAt: time });
    }
    this.candidates.clear();
    for (const [id, startedAt] of this.fading) {
      if (time < startedAt + ILLUSION.fadeSeconds) continue;
      this.destroyBody(id);
      this.fading.delete(id);
      this.disappeared.add(id);
      this.emit({ type: 'disappear', id });
    }
  }

  subscribe(listener: (event: TerrainEvent) => void): () => void {
    this.ensureMutable();
    this.listeners.add(listener);
    listener({ type: 'reset', objects: [...this.objects.values()] });
    for (const [id, startedAt] of this.fading) listener({ type: 'fade', id, startedAt });
    for (const id of this.disappeared) listener({ type: 'disappear', id });
    return () => { this.listeners.delete(listener); };
  }

  inspect() {
    this.ensureLive();
    return {
      objectCount: this.objects.size,
      bodyCount: this.bodies.size,
      fixtureCount: this.bodies.size,
      fading: [...this.fading].map(([id, startedAt]) => ({ id, startedAt })),
      disappeared: [...this.disappeared],
    };
  }

  isIllusion(body: Body): boolean {
    const id = this.ids.get(body);
    return id !== undefined && this.object(id).illusion;
  }

  dispose(): void {
    if (this.disposed) return;
    this.ensureMutable();
    this.world.off('post-solve', this.onPostSolve);
    this.listeners.clear();
    for (const id of this.bodies.keys()) this.destroyBody(id);
    this.objects.clear();
    this.candidates.clear();
    this.fading.clear();
    this.disappeared.clear();
    this.disposed = true;
  }

  private readonly onPostSolve = (contact: Contact, impulse: ContactImpulse): void => {
    const a = contact.getFixtureA().getBody();
    const b = contact.getFixtureB().getBody();
    const pot = this.getPot();
    if (a !== pot && b !== pot) return;
    const terrain = a === pot ? b : a;
    const id = this.ids.get(terrain);
    if (id === undefined || !this.object(id).illusion || this.fading.has(id) || this.candidates.has(id)) return;
    const manifold = contact.getWorldManifold(this.manifold);
    if (!manifold || manifold.normal.y * (terrain === a ? 1 : -1) < ILLUSION.minimumTopNormal) return;
    const impulses = impulse.normalImpulses;
    const centerY = pot.getWorldCenter().y;
    for (let index = 0; index < manifold.pointCount && index < impulses.length; index++) {
      if (impulses[index] > 0 && manifold.points[index].y < centerY) {
        // World.step owns the lock; only advance may publish or remove terrain.
        this.candidates.add(id);
        return;
      }
    }
  };

  private upsert(object: TerrainObject): void {
    const previous = this.objects.get(object.id);
    const body = this.bodies.get(object.id);
    this.objects.set(object.id, object);
    if (body) {
      if (!previous) throw new Error(`Terrain body has no authored object: ${object.id}.`);
      if (previous.x !== object.x || previous.y !== object.y || previous.angle !== object.angle) {
        body.setTransform(new Vec2(object.x, object.y), object.angle);
      }
      if (previous.width !== object.width || previous.height !== object.height ||
        geometryKey(previous.shape) !== geometryKey(object.shape)) {
        const fixture = body.getFixtureList();
        if (!fixture) throw new Error(`Terrain body has no fixture: ${object.id}.`);
        body.destroyFixture(fixture);
        this.createFixture(body, object);
      }
    } else {
      this.createBody(object);
    }
    this.candidates.delete(object.id);
    this.fading.delete(object.id);
    this.disappeared.delete(object.id);
  }

  private remove(id: string): void {
    this.object(id);
    if (this.bodies.has(id)) this.destroyBody(id);
    this.objects.delete(id);
    this.candidates.delete(id);
    this.fading.delete(id);
    this.disappeared.delete(id);
  }

  private createBody(object: TerrainObject): void {
    const body = this.world.createBody({ position: new Vec2(object.x, object.y), angle: object.angle });
    this.createFixture(body, object);
    this.bodies.set(object.id, body);
    this.ids.set(body, object.id);
  }

  private createFixture(body: Body, object: TerrainObject): void {
    const shape = object.shape.type === 'circle'
      ? new Circle(object.width / 2)
      : new Chain(shapeVertices(object.shape).map((vertex) =>
        new Vec2(vertex.x * object.width, vertex.y * object.height)), true);
    body.createFixture(shape, {
      friction: PHYSICS.terrainFriction,
      restitution: 0,
      filterCategoryBits: PHYSICS.terrainCategory,
      filterMaskBits: PHYSICS.playerCategory | PHYSICS.toolCategory | PHYSICS.enemyCategory,
    });
  }

  private destroyBody(id: string): void {
    const body = this.bodies.get(id);
    if (!body || !this.world.destroyBody(body)) throw new Error(`Could not remove terrain body: ${id}.`);
    this.bodies.delete(id);
    this.ids.delete(body);
  }

  private object(id: string): TerrainObject {
    const object = this.objects.get(id);
    if (!object) throw new Error(`Unknown terrain object: ${id}.`);
    return object;
  }

  private emit(event: TerrainEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private ensureMutable(): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Cannot mutate or publish terrain while the physics world is stepping.');
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed terrain world.');
  }
}
