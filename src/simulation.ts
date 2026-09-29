import { Vec2, World, WorldManifold } from 'planck';
import { PHYSICS, RIG } from './config';
import type { PlayerSpawn, Point } from './config';
import { TUNING_FIELDS, validateGameSettings } from './game-settings';
import type { GameSettings } from './game-settings';
import { isEnemyObject, isTerrainObject, levelFloor, levelSpawn } from './level';
import type { LevelChange, LevelDefinition, TerrainEvent } from './level';
import { changePlayerVelocity, createPlayer, destroyPlayer, drivePlayer, launchPlayer, tunePlayer } from './player';
import type { MotorCommand, PartKind, PlayerRig } from './player';
import { rigGeometry, sameRig } from './rig';
import type { RigGeometry } from './rig';
import type { LaunchSettings } from './trigger-events';
import { angleDifference } from './math';
import { aimAt, limitAim, moveAim } from './aim';
import type { Aim } from './aim';
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
  // The geometry of the rig these parts belong to; replaced only when the rig settings change.
  rig: RigGeometry;
}

// Settings apply to the running player, except a new rig, which rebuilds it and restarts the run.
export type SettingsEffect = 'applied' | 'restarted';

// Where the rig is: the character's centre, the pot's angle, the hammer head's centre and the handle's butt.
export interface RigPose {
  x: number;
  y: number;
  pot: number;
  tipX: number;
  tipY: number;
  buttX: number;
  buttY: number;
}

type PlayerFrame = Omit<PhysicsFrame, 'enemies' | 'cursor' | 'rig'> & { cursorOffset: Point };

const IDLE_COMMAND: MotorCommand = {
  angularError: 0, extensionError: 0, angularSpeed: 0, linearSpeed: 0, hingeBoost: 1, sliderBoost: 1,
};
// Falling this far below the lowest terrain or launch zone restarts the attempt.
const OUT_OF_BOUNDS_DEPTH = 20;
// A contact counts as standing on terrain when it pushes the player at least this steeply upward.
const SUPPORT_NORMAL = 0.5;

export class Simulation {
  readonly world: World;
  private rig: PlayerRig;
  private readonly terrain: TerrainWorld;
  private readonly enemies: EnemyWorld;
  private level: LevelDefinition;
  private settings: GameSettings;
  // Where the current run started; a rebuilt rig restarts from here.
  private spawn: Readonly<PlayerSpawn>;
  // Hinge-relative: the cursor input moves, and the target the hammer drives toward.
  private aim: Aim;
  private previous: PlayerFrame;
  private current: PlayerFrame;
  private command = { ...IDLE_COMMAND };
  private elapsed = 0;
  private bestHeight = 0;
  private disposed = false;
  private voidY: number | null;
  private supported = false;
  private readonly manifold = new WorldManifold();
  private impactTracking = false;
  private headTouching = false;
  private impactSpeed = 0;

  constructor(settings: Readonly<GameSettings>, level: LevelDefinition) {
    this.settings = validateGameSettings(settings);
    this.level = level;
    this.spawn = levelSpawn(level);
    this.voidY = this.outOfBoundsY(level);
    this.world = new World(new Vec2(0, -PHYSICS.gravity));
    this.world.setContinuousPhysics(true);
    this.terrain = new TerrainWorld(this.world, level.objects.filter(isTerrainObject), () => this.rig.pot);
    this.rig = createPlayer(this.world, this.spawn, this.settings.physics, rigGeometry(this.settings.rig));
    this.enemies = new EnemyWorld(this.world, level.objects.filter(isEnemyObject), {
      getPot: () => this.rig.pot,
      getHead: () => this.rig.head,
      isTransientTerrain: (body) => this.terrain.isIllusion(body),
      insideTerrain: (terrain, point) => this.terrain.isInside(terrain, point),
      onBump: (delta) => changePlayerVelocity(this.rig, delta),
    });
    this.aim = this.initialAim();
    this.current = this.capture();
    this.previous = this.current;
  }

  gameSettings(): GameSettings { return this.settings; }

  get rigGeometry(): RigGeometry { return this.rig.geometry; }

  // A rig is never changed in place: new rig settings rebuild the player and restart the run.
  setSettings(settings: Readonly<GameSettings>): SettingsEffect {
    this.ensureLive();
    const next = validateGameSettings(settings);
    const previous = this.settings;
    this.settings = next;
    if (!sameRig(next.rig, previous.rig)) {
      this.reset(this.spawn);
      return 'restarted';
    }
    if (next.cursor.maxTargetRadius !== previous.cursor.maxTargetRadius || next.cursor.deadZone !== previous.cursor.deadZone) {
      // A smaller radius pulls the target straight in; the cursor keeps to its dead zone.
      this.aim = limitAim(this.aim, next.cursor.maxTargetRadius, next.cursor.deadZone);
      this.previous = { ...this.previous, cursorOffset: { ...this.aim.cursor } };
      this.current = { ...this.current, cursorOffset: { ...this.aim.cursor } };
    }
    if (TUNING_FIELDS.some((field) => next.physics[field.key] !== previous.physics[field.key])) {
      tunePlayer(this.rig, next.physics);
      // Existing contacts cache mixed material values independently of fixtures.
      for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) contact.resetFriction();
    }
    return 'applied';
  }

  reset(spawn: Readonly<PlayerSpawn> = levelSpawn(this.level)): void {
    this.ensureLive();
    this.spawn = spawn;
    this.resetPlayer();
    this.restoreLevelObjects();
  }

  applyLevel(change: LevelChange): void {
    this.ensureLive();
    this.level = change.level;
    this.voidY = this.outOfBoundsY(change.level);
    if (change.kind === 'replace') {
      this.spawn = levelSpawn(change.level);
      this.resetPlayer();
    }
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

  // Writes the rig's current pose into `out`, allocating nothing, so it can be read every step.
  rigPose(out: RigPose): RigPose {
    const root = this.rig.root.getPosition();
    const tip = this.rig.head.getPosition();
    const butt = this.rig.sliderBody.getPosition();
    out.x = root.x;
    out.y = root.y;
    out.pot = this.rig.pot.getAngle();
    out.tipX = tip.x;
    out.tipY = tip.y;
    out.buttX = butt.x;
    out.buttY = butt.y;
    return out;
  }

  fellOutOfLevel(): boolean {
    return this.supported && this.voidY !== null && this.rig.root.getPosition().y + RIG.potBottom < this.voidY;
  }

  // Impact sounds need the hammer head's approach speed whenever it starts touching something.
  trackImpacts(enabled: boolean): void {
    this.ensureLive();
    this.impactTracking = enabled;
    this.impactSpeed = 0;
    this.headTouching = enabled && this.headContactCount() > 0;
  }

  // The fastest hammer-head impact since the previous call, in m/s; 0 when there was none.
  takeImpact(): number {
    const speed = this.impactSpeed;
    this.impactSpeed = 0;
    return speed;
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
    let swinging = false;
    if (pointerDelta.x !== 0 || pointerDelta.y !== 0) {
      if (!Number.isFinite(this.aim.cursor.x + pointerDelta.x) || !Number.isFinite(this.aim.cursor.y + pointerDelta.y)) {
        throw new Error('Pointer target must remain finite.');
      }
      const previousY = this.aim.target.y;
      this.aim = moveAim(this.aim, pointerDelta, this.settings.cursor.maxTargetRadius, this.settings.cursor.deadZone);
      // Input that lowers the target swings the hammer down.
      swinging = this.aim.target.y < previousY;
    }
    this.command = drivePlayer(
      this.rig, this.worldPoint(this.cursorOrigin(this.rig.root.getPosition()), this.aim.target), this.settings.physics, swinging,
    );
    this.enemies.beforeStep(this.rig.root.getPosition(), this.elapsed);
    const velocity = this.impactTracking ? this.rig.head.getLinearVelocity() : null;
    const approachX = velocity?.x ?? 0;
    const approachY = velocity?.y ?? 0;
    this.world.step(PHYSICS.dt, PHYSICS.velocityIterations, PHYSICS.positionIterations);
    if (!this.supported) this.detectSupport();
    if (this.impactTracking) {
      const touching = this.headContactCount() > 0;
      if (touching && !this.headTouching) this.impactSpeed = Math.max(this.impactSpeed, Math.hypot(approachX, approachY));
      this.headTouching = touching;
    }
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
      cursor: this.worldPoint(this.cursorOrigin(root), {
        x: this.previous.cursorOffset.x + (this.current.cursorOffset.x - this.previous.cursorOffset.x) * alpha,
        y: this.previous.cursorOffset.y + (this.current.cursorOffset.y - this.previous.cursorOffset.y) * alpha,
      }),
      enemies: this.enemies.frame(alpha),
      rig: this.rig.geometry,
    };
  }

  status() {
    this.ensureLive();
    const root = this.rig.root.getPosition();
    let contacts = 0;
    for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
      if (contact.isTouching() && contact.isEnabled()) contacts++;
    }
    const hingeTorque = this.rig.hinge.getMotorTorque(1 / PHYSICS.dt);
    const sliderForce = this.rig.slider.getMotorForce(1 / PHYSICS.dt);
    // Loads are shares of the strength each motor had in the last step, downswing boost included.
    return {
      time: this.elapsed,
      height: Math.max(0, root.y + RIG.potBottom),
      bestHeight: this.bestHeight,
      contacts,
      hingeLoad: Math.abs(hingeTorque) / (this.settings.physics.hingeTorque * this.command.hingeBoost),
      sliderLoad: Math.abs(sliderForce) / (this.settings.physics.sliderForce * this.command.sliderBoost),
    };
  }

  snapshot() {
    const status = this.status();
    const root = this.rig.root.getPosition();
    const origin = this.cursorOrigin(root);
    return {
      ...status,
      root: { x: root.x, y: root.y, angle: this.rig.root.getAngle() },
      tip: { ...this.rig.head.getPosition() },
      cursor: this.worldPoint(origin, this.aim.cursor),
      cursorOrigin: origin,
      cursorOffset: { ...this.aim.cursor },
      target: this.worldPoint(origin, this.aim.target),
      targetOffset: { ...this.aim.target },
      rootVelocity: { ...this.rig.root.getLinearVelocity() },
      potAngle: this.rig.pot.getAngle(),
      extension: this.rig.slider.getJointTranslation(),
      headContacts: this.headContactCount(),
      rig: this.rig.geometry,
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
      cursorOffset: { ...this.aim.cursor },
    };
  }

  private resetPlayer(): void {
    destroyPlayer(this.world, this.rig);
    const geometry = sameRig(this.rig.geometry, this.settings.rig) ? this.rig.geometry : rigGeometry(this.settings.rig);
    this.rig = createPlayer(this.world, this.spawn, this.settings.physics, geometry);
    this.supported = false;
    this.headTouching = false;
    this.impactSpeed = 0;
    this.aim = this.initialAim();
    this.elapsed = 0;
    this.bestHeight = Math.max(0, this.rig.root.getPosition().y + RIG.potBottom);
    this.command = { ...IDLE_COMMAND };
    this.current = this.capture();
    this.previous = this.current;
  }

  private outOfBoundsY(level: LevelDefinition): number | null {
    const floor = levelFloor(level);
    return floor === null ? null : floor - OUT_OF_BOUNDS_DEPTH;
  }

  // Auto-restart only arms once the pot or head stood on terrain, so a start with nothing beneath it
  // (or one inside rock that it drops out of) keeps falling instead of restarting in a loop.
  private detectSupport(): void {
    for (const body of [this.rig.pot, this.rig.head]) {
      for (let edge = body.getContactList(); edge; edge = edge.next) {
        const contact = edge.contact;
        if (edge.other === null || !contact.isTouching() || !contact.isEnabled() || !this.terrain.isTerrain(edge.other)) continue;
        const manifold = contact.getWorldManifold(this.manifold);
        if (!manifold || manifold.pointCount === 0) continue;
        // The manifold normal points from fixture A to fixture B; support pushes the player upward.
        const up = contact.getFixtureA().getBody() === body ? -manifold.normal.y : manifold.normal.y;
        if (up >= SUPPORT_NORMAL) {
          this.supported = true;
          return;
        }
      }
    }
  }

  private headContactCount(): number {
    let count = 0;
    for (let edge = this.rig.head.getContactList(); edge; edge = edge.next) {
      if (edge.contact.isTouching() && edge.contact.isEnabled()) count++;
    }
    return count;
  }

  // An attempt starts aiming at the hammer head, with the cursor on the target.
  private initialAim(): Aim {
    const origin = this.cursorOrigin(this.rig.root.getPosition());
    const tip = this.rig.head.getPosition();
    return aimAt({ x: tip.x - origin.x, y: tip.y - origin.y }, this.settings.cursor.maxTargetRadius);
  }

  // Aim is hinge-relative like the hammer's reach; the root never rotates, so the hinge is a fixed offset.
  private cursorOrigin(root: Readonly<Point>): Point {
    return { x: root.x + RIG.shoulder.x, y: root.y + RIG.shoulder.y };
  }

  private worldPoint(origin: Readonly<Point>, offset: Readonly<Point>): Point {
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed physics simulation.');
  }
}
