import { Vec2, World } from 'planck';
import { PHYSICS, RIG } from './config';
import type { PlayerSpawn, Point } from './config';
import { TUNING_FIELDS, validateGameSettings } from './game-settings';
import type { GameSettings } from './game-settings';
import { isEnemyObject, isTerrainObject, levelSpawn } from './level';
import type { LevelChange, LevelDefinition, TerrainEvent } from './level';
import { changePlayerVelocity, createPlayer, destroyPlayer, drivePlayer, launchPlayer, tunePlayer } from './player';
import type { MotorCommand, PartKind, PlayerRig } from './player';
import type { LaunchSettings } from './trigger-events';
import { angleDifference, clampLength } from './math';
import { TerrainWorld } from './terrain-world';
import { EnemyWorld } from './enemy-world';
import type { EnemyEvent, EnemyPose } from './enemy-types';

export interface PartPose extends Point {
  id: string;
  kind: PartKind;
  angle: number;
  vertices: readonly Point[];
  collides: boolean;
}

export interface PhysicsFrame {
  time: number;
  parts: PartPose[];
  cursor: Point;
  enemies: readonly EnemyPose[];
}

type PlayerFrame = Omit<PhysicsFrame, 'enemies' | 'cursor'> & { cursorOffset: Point };

const IDLE_COMMAND: MotorCommand = { angularError: 0, extensionError: 0, angularSpeed: 0, linearSpeed: 0 };

export class Simulation {
  readonly world: World;
  private rig: PlayerRig;
  private readonly terrain: TerrainWorld;
  private readonly enemies: EnemyWorld;
  private level: LevelDefinition;
  private settings: GameSettings;
  private cursorOffset: Point;
  private previous: PlayerFrame;
  private current: PlayerFrame;
  private command = { ...IDLE_COMMAND };
  private elapsed = 0;
  private bestHeight = 0;
  private disposed = false;

  constructor(settings: Readonly<GameSettings>, level: LevelDefinition) {
    this.settings = validateGameSettings(settings);
    this.level = level;
    this.world = new World(new Vec2(0, -PHYSICS.gravity));
    this.world.setContinuousPhysics(true);
    this.terrain = new TerrainWorld(this.world, level.objects.filter(isTerrainObject), () => this.rig.pot);
    this.rig = createPlayer(this.world, levelSpawn(level), this.settings.physics);
    this.enemies = new EnemyWorld(this.world, level.objects.filter(isEnemyObject), {
      getPot: () => this.rig.pot,
      getHead: () => this.rig.head,
      onBump: (delta) => changePlayerVelocity(this.rig, delta),
    });
    this.cursorOffset = this.initialCursorOffset();
    this.current = this.capture();
    this.previous = this.current;
  }

  gameSettings(): GameSettings { return this.settings; }

  setSettings(settings: Readonly<GameSettings>): void {
    this.ensureLive();
    const next = validateGameSettings(settings);
    const physicsChanged = TUNING_FIELDS.some((field) => next.physics[field.key] !== this.settings.physics[field.key]);
    const radiusChanged = next.cursor.maxRadius !== this.settings.cursor.maxRadius;
    this.settings = next;
    if (radiusChanged) {
      this.cursorOffset = clampLength(this.cursorOffset, next.cursor.maxRadius);
      this.previous = { ...this.previous, cursorOffset: clampLength(this.previous.cursorOffset, next.cursor.maxRadius) };
      this.current = { ...this.current, cursorOffset: { ...this.cursorOffset } };
    }
    if (physicsChanged) {
      tunePlayer(this.rig, next.physics);
      // Existing contacts cache mixed material values independently of fixtures.
      for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) contact.resetFriction();
    }
  }

  reset(spawn: Readonly<PlayerSpawn> = levelSpawn(this.level)): void {
    this.ensureLive();
    this.resetPlayer(spawn);
    this.restoreLevelObjects();
  }

  applyLevel(change: LevelChange): void {
    this.ensureLive();
    this.level = change.level;
    if (change.kind === 'replace') this.resetPlayer(levelSpawn(change.level));
    this.terrain.apply(change);
    this.enemies.apply(change, this.elapsed);
  }

  subscribeTerrain(listener: (event: TerrainEvent) => void): () => void {
    this.ensureLive();
    return this.terrain.subscribe(listener);
  }

  subscribeEnemies(listener: (event: EnemyEvent) => void): () => void {
    this.ensureLive();
    return this.enemies.subscribe(listener);
  }

  restoreLevelObjects(): void {
    this.ensureLive();
    this.terrain.reset();
    this.enemies.reset(this.elapsed);
  }

  terrainState() {
    this.ensureLive();
    return this.terrain.inspect();
  }

  enemyState() {
    this.ensureLive();
    return this.enemies.inspect();
  }

  get time(): number { return this.elapsed; }

  playerPosition(): Readonly<Point> {
    const root = this.rig.root.getPosition();
    return { x: root.x, y: root.y + RIG.potBottom };
  }

  launch(settings: LaunchSettings) {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Player launches must execute after the physics step.');
    if (!Number.isFinite(settings.height) || settings.height <= 0 ||
      !Number.isFinite(settings.strength) || settings.strength <= 0) {
      throw new Error('Player launch height and strength must be positive finite numbers.');
    }
    return launchPlayer(this.rig, settings, this.settings.physics);
  }

  step(pointerDelta: Point): void {
    this.ensureLive();
    if (!Number.isFinite(pointerDelta.x) || !Number.isFinite(pointerDelta.y)) {
      throw new Error('Pointer movement must be finite.');
    }
    this.previous = this.current;
    if (pointerDelta.x !== 0 || pointerDelta.y !== 0) {
      const x = this.cursorOffset.x + pointerDelta.x;
      const y = this.cursorOffset.y + pointerDelta.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Pointer target must remain finite.');
      this.cursorOffset = clampLength({ x, y }, this.settings.cursor.maxRadius);
    }
    this.command = drivePlayer(this.rig, this.worldCursor(this.rig.root.getPosition(), this.cursorOffset), this.settings.physics);
    this.enemies.beforeStep(this.rig.root.getPosition(), this.elapsed);
    this.world.step(PHYSICS.dt, PHYSICS.velocityIterations, PHYSICS.positionIterations);
    this.elapsed += PHYSICS.dt;
    this.terrain.advance(this.elapsed);
    this.enemies.afterStep(this.elapsed);
    this.bestHeight = Math.max(this.bestHeight, this.rig.root.getPosition().y + RIG.potBottom);
    this.current = this.capture();
  }

  frame(alpha: number): PhysicsFrame {
    const parts = this.current.parts.map((part, index) => {
      const previous = this.previous.parts[index];
      return {
        ...part,
        x: previous.x + (part.x - previous.x) * alpha,
        y: previous.y + (part.y - previous.y) * alpha,
        angle: previous.angle + angleDifference(part.angle, previous.angle) * alpha,
      };
    });
    const root = parts.find((part) => part.kind === 'root');
    if (!root) throw new Error('The physics frame is missing its character center.');
    return {
      time: this.previous.time + (this.current.time - this.previous.time) * alpha,
      parts,
      cursor: this.worldCursor(root, {
        x: this.previous.cursorOffset.x + (this.current.cursorOffset.x - this.previous.cursorOffset.x) * alpha,
        y: this.previous.cursorOffset.y + (this.current.cursorOffset.y - this.previous.cursorOffset.y) * alpha,
      }),
      enemies: this.enemies.frame(alpha),
    };
  }

  status() {
    this.ensureLive();
    const root = this.rig.root.getPosition();
    let contacts = 0;
    for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
      if (contact.isTouching()) contacts++;
    }
    const hingeTorque = this.rig.hinge.getMotorTorque(1 / PHYSICS.dt);
    const sliderForce = this.rig.slider.getMotorForce(1 / PHYSICS.dt);
    return {
      time: this.elapsed,
      height: Math.max(0, root.y + RIG.potBottom),
      bestHeight: this.bestHeight,
      contacts,
      hingeLoad: Math.abs(hingeTorque) / this.settings.physics.hingeTorque,
      sliderLoad: Math.abs(sliderForce) / this.settings.physics.sliderForce,
    };
  }

  snapshot() {
    const status = this.status();
    const root = this.rig.root.getPosition();
    return {
      ...status,
      root: { x: root.x, y: root.y, angle: this.rig.root.getAngle() },
      tip: { ...this.rig.head.getPosition() },
      cursor: this.worldCursor(root, this.cursorOffset),
      cursorOffset: { ...this.cursorOffset },
      rootVelocity: { ...this.rig.root.getLinearVelocity() },
      potAngle: this.rig.pot.getAngle(),
      extension: this.rig.slider.getJointTranslation(),
      headContacts: this.headContactCount(),
      maxReach: RIG.maxReach,
      hingeTorque: this.rig.hinge.getMotorTorque(1 / PHYSICS.dt),
      sliderForce: this.rig.slider.getMotorForce(1 / PHYSICS.dt),
      command: { ...this.command },
      tuning: { ...this.settings.physics },
      bodyProperties: Object.fromEntries(this.rig.parts.map(({ id, body }) =>
        [id, { mass: body.getMass(), inertia: body.getInertia() }] as const)),
      bodyCount: this.world.getBodyCount(),
      jointCount: this.world.getJointCount(),
      enemies: this.enemies.inspect(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.enemies.dispose();
    this.terrain.dispose();
    destroyPlayer(this.world, this.rig);
    for (let body = this.world.getBodyList(); body;) {
      const next = body.getNext();
      this.world.destroyBody(body);
      body = next;
    }
    this.disposed = true;
  }

  private capture(): PlayerFrame {
    return {
      time: this.elapsed,
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
      cursorOffset: { ...this.cursorOffset },
    };
  }

  private resetPlayer(spawn: PlayerSpawn): void {
    destroyPlayer(this.world, this.rig);
    this.rig = createPlayer(this.world, spawn, this.settings.physics);
    this.cursorOffset = this.initialCursorOffset();
    this.elapsed = 0;
    this.bestHeight = Math.max(0, this.rig.root.getPosition().y + RIG.potBottom);
    this.command = { ...IDLE_COMMAND };
    this.current = this.capture();
    this.previous = this.current;
  }

  private headContactCount(): number {
    let count = 0;
    for (let edge = this.rig.head.getContactList(); edge; edge = edge.next) {
      if (edge.contact.isTouching()) count++;
    }
    return count;
  }

  private initialCursorOffset(): Point {
    const center = this.rig.root.getPosition();
    const tip = this.rig.head.getPosition();
    return clampLength({ x: tip.x - center.x, y: tip.y - center.y }, this.settings.cursor.maxRadius);
  }

  private worldCursor(center: Readonly<Point>, offset: Readonly<Point>): Point {
    return { x: center.x + offset.x, y: center.y + offset.y };
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed physics simulation.');
  }
}
