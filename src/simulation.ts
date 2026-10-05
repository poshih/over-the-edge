import { Vec2, World, WorldManifold } from 'planck';
import { PHYSICS, RIG } from './config';
import type { PlayerSpawn, Point } from './config';
import { CURSOR_RETURN_IDLE_SECONDS, TUNING_FIELDS, validateGameSettings } from './game-settings';
import type { GameSettings } from './game-settings';
import { sameHammerHead } from './hammer-head';
import type { HammerHead } from './hammer-head';
import {
  isBonfireObject, isEnemyObject, isPoolObject, isTerrainObject, isTrapObject, levelFloor, levelHurts, levelSpawn, levelStart,
} from './level';
import type { LevelChange, LevelDefinition, TerrainEvent } from './level';
import { changePlayerVelocity, createPlayer, destroyPlayer, drivePlayer, launchPlayer, tunePlayer } from './player';
import type { MotorCommand, PartKind, PlayerRig } from './player';
import { partPoint, partVelocity } from './player-bodies';
import { rigGeometry, sameRig } from './rig';
import type { RigGeometry } from './rig';
import { surfaceMaterials } from './surfaces';
import type { LaunchSettings } from './trigger-events';
import { angleDifference } from './math';
import { aimAt, limitAim, moveAim, returnAim } from './aim';
import type { Aim } from './aim';
import { TerrainWorld } from './terrain-world';
import { EnemyWorld } from './enemy-world';
import { ENEMY_BEHAVIOR } from './enemy-types';
import type { EnemyEvent, EnemyPose } from './enemy-types';
import { HazardWorld } from './hazard-world';
import type { ProjectilePose } from './hazard-world';
import { Bonfires } from './bonfires';
import type { BonfireState } from './bonfires';
import { bonfireSpawn, HEALTH } from './hazards';
import { LiquidWorld } from './liquid-world';
import type { HealthReading } from './health-meter';

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
  projectiles: readonly ProjectilePose[];
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

type PlayerFrame = Omit<PhysicsFrame, 'enemies' | 'projectiles' | 'cursor' | 'rig'> & { cursorOffset: Point };

const IDLE_COMMAND: MotorCommand = {
  angularError: 0, extensionError: 0, angularSpeed: 0, linearSpeed: 0, hingeBoost: 1, sliderBoost: 1,
};
// Falling this far below the lowest terrain or launch zone ends the attempt.
const OUT_OF_BOUNDS_DEPTH = 20;
// A contact counts as standing on terrain when it pushes the player at least this steeply upward.
const SUPPORT_NORMAL = 0.5;

export class Simulation {
  readonly world: World;
  private rig: PlayerRig;
  private readonly terrain: TerrainWorld;
  private readonly enemies: EnemyWorld;
  private readonly hazards: HazardWorld;
  private readonly bonfires: Bonfires;
  private readonly liquids: LiquidWorld;
  private level: LevelDefinition;
  private settings: GameSettings;
  // Where the current run started; a rebuilt rig restarts from here.
  private spawn: Readonly<PlayerSpawn>;
  // Hinge-relative: the cursor input moves, and the target the hammer drives toward.
  private aim: Aim;
  // When, in run time, input last moved the aim, or the player was placed; the return to the hammer waits on it.
  private lastAimInput = 0;
  private previous: PlayerFrame;
  private current: PlayerFrame;
  private command = { ...IDLE_COMMAND };
  private elapsed = 0;
  private bestHeight = 0;
  // Damage points left, and until when in run time a hit cannot hurt.
  private health: number;
  private safeUntil = 0;
  // Whether the authored level has hurt sources, so HUD health shows; removed shooters can still have shots in flight.
  private hurts: boolean;
  private readonly healthReading = { current: 0, max: 0 };
  // Whether a hit hurt the player, who survived it, since takeHurt last looked.
  private hurtTaken = false;
  // How many times the player has been placed: at every restart and every return to a bonfire.
  private placements = 0;
  private disposed = false;
  private voidY: number | null;
  private supported = false;
  private readonly manifold = new WorldManifold();
  private readonly headPoint = new Vec2();
  private readonly buttPoint = new Vec2();
  private readonly pointScratch = new Vec2();
  private readonly velocityScratch = new Vec2();
  private impactTracking = false;
  private headTouching = false;
  private impactSpeed = 0;
  // The hammer's own head when it is a library hammer, which overrides the settings' default head; null for the default.
  private hammerHead: HammerHead | null = null;

  constructor(settings: Readonly<GameSettings>, level: LevelDefinition) {
    this.settings = validateGameSettings(settings);
    this.level = level;
    this.spawn = levelSpawn(level);
    this.voidY = this.outOfBoundsY(level);
    this.health = this.settings.physics.health;
    this.hurts = levelHurts(level);
    this.world = new World(new Vec2(0, -PHYSICS.gravity));
    this.world.setContinuousPhysics(true);
    this.terrain = new TerrainWorld(this.world, level.objects.filter(isTerrainObject), () => this.rig.pot,
      surfaceMaterials(this.settings.physics));
    this.rig = createPlayer(this.world, this.spawn, this.settings.physics, rigGeometry(this.settings.rig), this.settings.rig.head);
    this.enemies = new EnemyWorld(this.world, level.objects.filter(isEnemyObject), {
      getPot: () => this.rig.pot,
      getHeadFixture: () => this.rig.tool.head.fixture,
      isTransientTerrain: (body) => this.terrain.isIllusion(body),
      insideTerrain: (terrain, point) => this.terrain.isInside(terrain, point),
      onBump: (delta) => {
        changePlayerVelocity(this.rig, delta);
        this.hurt(ENEMY_BEHAVIOR.bumpDamage);
      },
    });
    this.hazards = new HazardWorld(this.world, level.objects.filter(isTrapObject), {
      shield: () => this.rig.tool.head.fixture,
      isTerrain: (body) => this.terrain.isTerrain(body),
      insideTerrain: (terrain, point) => this.terrain.isInside(terrain, point),
      vulnerable: () => this.vulnerable(),
      hurt: (damage, push) => {
        this.hurt(damage);
        changePlayerVelocity(this.rig, push);
      },
    });
    this.bonfires = new Bonfires(level.objects.filter(isBonfireObject));
    this.liquids = new LiquidWorld(level.objects.filter(isPoolObject));
    this.aim = this.initialAim();
    this.current = this.capture();
    this.previous = this.current;
  }

  gameSettings(): GameSettings { return this.settings; }

  get rigGeometry(): RigGeometry { return this.rig.geometry; }

  // The hammer's own head outline, or null for the settings' default head. The head changes in place, mid-run, so a
  // hammer swap never restarts the run.
  setHammerHead(head: HammerHead | null): void {
    this.ensureLive();
    this.hammerHead = head;
    this.applyHead();
  }

  // A rig is never rebuilt in place, except its head: other new rig settings rebuild the player and restart the run.
  setSettings(settings: Readonly<GameSettings>): SettingsEffect {
    this.ensureLive();
    const next = validateGameSettings(settings);
    const previous = this.settings;
    this.settings = next;
    const tuned = TUNING_FIELDS.some((field) => next.physics[field.key] !== previous.physics[field.key]);
    this.health = Math.min(this.health, next.physics.health);
    if (tuned) {
      // The terrain outlives a rebuilt player, so it takes new surfaces either way.
      this.terrain.setMaterials(surfaceMaterials(next.physics));
      // Existing contacts cache mixed material values independently of fixtures.
      for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
        contact.resetFriction();
        contact.resetRestitution();
      }
    }
    if (!sameRig(next.rig, previous.rig) || !this.rig.tool.acceptsTuning(next.physics)) {
      this.reset(this.spawn);
      return 'restarted';
    }
    if (!sameHammerHead(next.rig.head, previous.rig.head)) {
      this.rig = { ...this.rig, geometry: rigGeometry(next.rig) };
      this.applyHead();
    }
    if (next.cursor.maxTargetRadius !== previous.cursor.maxTargetRadius || next.cursor.deadZone !== previous.cursor.deadZone) {
      // A smaller radius pulls the target straight in; the cursor keeps to its dead zone.
      this.aim = limitAim(this.aim, next.cursor.maxTargetRadius, next.cursor.deadZone);
      this.previous = { ...this.previous, cursorOffset: { ...this.aim.cursor } };
      this.current = { ...this.current, cursorOffset: { ...this.aim.cursor } };
    }
    if (tuned) {
      tunePlayer(this.rig, next.physics);
      for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
        contact.resetFriction();
        contact.resetRestitution();
      }
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
    this.hurts = levelHurts(change.level);
    if (change.kind === 'replace') {
      this.spawn = levelSpawn(change.level);
      this.resetPlayer();
    }
    this.terrain.apply(change);
    this.enemies.apply(change, this.elapsed);
    this.hazards.apply(change, this.elapsed);
    this.bonfires.apply(change);
    this.liquids.apply(change);
  }

  subscribeTerrain(listener: (event: TerrainEvent) => void): () => void {
    this.ensureLive();
    return this.terrain.subscribe(listener);
  }

  subscribeEnemies(listener: (event: EnemyEvent) => void): () => void {
    this.ensureLive();
    return this.enemies.subscribe(listener);
  }

  subscribeBonfires(listener: (state: BonfireState) => void): () => void {
    this.ensureLive();
    return this.bonfires.subscribe(listener);
  }

  // Returns the level's objects to how the level places them: illusions back, enemies home, no projectiles in flight
  // and every bonfire out.
  restoreLevelObjects(): void {
    this.ensureLive();
    this.terrain.reset();
    this.enemies.reset(this.elapsed);
    this.hazards.reset(this.elapsed);
    this.bonfires.reset();
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

  // Changes whenever the player is placed anew: at every restart and every return to a bonfire.
  get placement(): number { return this.placements; }

  playerPosition(): Readonly<Point> {
    const root = this.rig.root.getPosition();
    return { x: root.x, y: root.y + RIG.potBottom };
  }

  // Writes the rig's current pose into `out`, allocating nothing, so it can be read every step.
  rigPose(out: RigPose): RigPose {
    const root = this.rig.root.getPosition();
    const tip = partPoint(this.rig.tool.head, this.headPoint);
    const butt = partPoint(this.rig.tool.butt, this.buttPoint);
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

  dead(): boolean {
    return this.health <= 0;
  }

  // The simulation's health, independent of HUD visibility. Reused and read-only: consume immediately, never retain it.
  readHealth(): HealthReading {
    this.ensureLive();
    this.healthReading.current = this.health;
    this.healthReading.max = this.settings.physics.health;
    return this.healthReading;
  }

  // Whether a hit hurt the player, who survived it, since the previous call.
  takeHurt(): boolean {
    const taken = this.hurtTaken;
    this.hurtTaken = false;
    return taken;
  }

  // Brings a fallen player back at the bonfire reached last, healed and unharmed for a moment, holding the hammer as
  // at the start. The run goes on: its clock, best height and level objects carry on. False, changing nothing, when
  // no bonfire has been reached.
  respawn(): boolean {
    this.ensureLive();
    const bonfire = this.bonfires.currentBonfire();
    if (bonfire === null) return false;
    this.placePlayer(bonfireSpawn(bonfire, levelStart(this.level)));
    this.safeUntil = this.elapsed + HEALTH.respawnSeconds;
    return true;
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
      this.lastAimInput = this.elapsed;
      // Input that lowers the target swings the hammer down.
      swinging = this.aim.target.y < previousY;
    } else if (this.returning()) {
      const { returnRate, returnOffsetX, returnOffsetY, maxTargetRadius } = this.settings.cursor;
      const origin = this.cursorOrigin(this.rig.root.getPosition());
      const tip = partPoint(this.rig.tool.head, this.headPoint);
      this.aim = returnAim(this.aim, { x: tip.x + returnOffsetX - origin.x, y: tip.y + returnOffsetY - origin.y },
        1 - Math.exp(-returnRate * PHYSICS.dt), maxTargetRadius);
    }
    this.command = drivePlayer(
      this.rig, this.worldPoint(this.cursorOrigin(this.rig.root.getPosition()), this.aim.target), this.settings.physics, { swinging },
    );
    this.enemies.beforeStep(this.rig.root.getPosition(), this.elapsed);
    const bath = this.liquids.push(this.rig, this.settings.physics);
    const velocity = this.impactTracking ? partVelocity(this.rig.tool.head, this.velocityScratch) : null;
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
    this.hazards.afterStep(this.elapsed, this.rig.root.getPosition());
    // Lava burns the character while the pot is in it; each burn, like any hit, leaves it unharmed for a second.
    if (bath === 'lava') this.hurt(this.settings.physics.lavaDamage);
    const foot = this.playerPosition();
    this.bonfires.update(foot);
    this.bestHeight = Math.max(this.bestHeight, foot.y);
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
      projectiles: this.hazards.frame(alpha),
      rig: this.rig.geometry,
    };
  }

  // HUD-only data: no allocations, contact walk, motor queries or plugin callbacks.
  writeHudFrame(out: { height: number; bestHeight: number; health: HealthReading | null }): void {
    const health = this.readHealth();
    out.height = Math.max(0, this.rig.root.getPosition().y + RIG.potBottom);
    out.bestHeight = this.bestHeight;
    out.health = this.hurts ? health : null;
  }

  status() {
    this.ensureLive();
    const root = this.rig.root.getPosition();
    let contacts = 0;
    for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
      if (contact.isTouching() && contact.isEnabled()) contacts++;
    }
    const hingeTorque = this.rig.drive.getMotorTorque(1 / PHYSICS.dt);
    const sliderForce = this.rig.drive.getMotorForce(1 / PHYSICS.dt);
    // Loads are shares of the strength each motor had in the last step, downswing boost included.
    return {
      time: this.elapsed,
      height: Math.max(0, root.y + RIG.potBottom),
      bestHeight: this.bestHeight,
      contacts,
      hingeLoad: Math.abs(hingeTorque) / (this.settings.physics.hingeTorque * this.command.hingeBoost),
      sliderLoad: Math.abs(sliderForce) / (this.settings.physics.sliderForce * this.command.sliderBoost),
      // Null in levels where nothing can hurt the player.
      health: this.hurts ? { current: this.health, max: this.settings.physics.health } : null,
    };
  }

  snapshot() {
    const status = this.status();
    const root = this.rig.root.getPosition();
    const origin = this.cursorOrigin(root);
    return {
      ...status,
      root: { x: root.x, y: root.y, angle: this.rig.root.getAngle() },
      tip: { ...partPoint(this.rig.tool.head, this.headPoint) },
      cursor: this.worldPoint(origin, this.aim.cursor),
      cursorOrigin: origin,
      cursorOffset: { ...this.aim.cursor },
      target: this.worldPoint(origin, this.aim.target),
      targetOffset: { ...this.aim.target },
      rootVelocity: { ...this.rig.root.getLinearVelocity() },
      potAngle: this.rig.pot.getAngle(),
      extension: this.rig.drive.getTranslation(),
      headContacts: this.headContactCount(),
      rig: this.rig.geometry,
      hingeTorque: this.rig.drive.getMotorTorque(1 / PHYSICS.dt),
      sliderForce: this.rig.drive.getMotorForce(1 / PHYSICS.dt),
      command: { ...this.command },
      tuning: { ...this.settings.physics },
      bodyProperties: Object.fromEntries(this.rig.bodies.map(({ id, body }) =>
        [id, { mass: body.getMass(), inertia: body.getInertia() }] as const)),
      bodyCount: this.world.getBodyCount(),
      jointCount: this.world.getJointCount(),
      enemies: this.enemies.inspect(),
      hazards: this.hazards.inspect(),
      bonfires: this.bonfires.state(),
      liquids: this.liquids.inspect(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.liquids.dispose();
    this.bonfires.dispose();
    this.hazards.dispose();
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
        const position = partPoint(part, this.pointScratch);
        const angle = part.body.getAngle();
        const velocity = partVelocity(part, this.velocityScratch);
        if (![position.x, position.y, angle, velocity.x, velocity.y, part.body.getAngularVelocity()].every(Number.isFinite)) {
          throw new Error(`Non-finite physics state on ${part.id}. Simulation stopped.`);
        }
        return {
          id: part.id, kind: part.kind, x: position.x, y: position.y, angle, vertices: part.vertices,
          collides: part.fixture !== undefined && part.fixture.getFilterMaskBits() !== 0,
        };
      }),
      cursorOffset: { ...this.aim.cursor },
    };
  }

  // A new run from the run's spawn.
  private resetPlayer(): void {
    this.elapsed = 0;
    this.safeUntil = 0;
    this.placePlayer(this.spawn);
    this.bestHeight = Math.max(0, this.rig.root.getPosition().y + RIG.potBottom);
  }

  // A new player at `spawn`, at full health.
  private placePlayer(spawn: Readonly<PlayerSpawn>): void {
    destroyPlayer(this.world, this.rig);
    const geometry = sameRig(this.rig.geometry, this.settings.rig) && sameHammerHead(this.rig.geometry.head, this.settings.rig.head)
      ? this.rig.geometry : rigGeometry(this.settings.rig);
    this.rig = createPlayer(this.world, spawn, this.settings.physics, geometry, this.hammerHead ?? this.settings.rig.head);
    this.supported = false;
    this.headTouching = false;
    this.impactSpeed = 0;
    this.health = this.settings.physics.health;
    this.hurtTaken = false;
    this.placements++;
    this.aim = this.initialAim();
    this.lastAimInput = this.elapsed;
    this.command = { ...IDLE_COMMAND };
    this.current = this.capture();
    this.previous = this.current;
  }

  private vulnerable(): boolean {
    return this.health > 0 && this.elapsed >= this.safeUntil;
  }

  // Takes `damage` from the player's health, unless a hit hurt it moments ago; each hit leaves it unharmed for a while.
  private hurt(damage: number): void {
    if (!this.vulnerable()) return;
    this.health = Math.max(0, this.health - damage);
    this.safeUntil = this.elapsed + HEALTH.hurtSeconds;
    this.hurtTaken = this.health > 0;
  }

  private outOfBoundsY(level: LevelDefinition): number | null {
    const floor = levelFloor(level);
    return floor === null ? null : floor - OUT_OF_BOUNDS_DEPTH;
  }

  // Auto-restart only arms once the pot or head stood on terrain, so a start with nothing beneath it
  // (or one inside rock that it drops out of) keeps falling instead of restarting in a loop.
  private detectSupport(): void {
    for (const fixture of [this.rig.potFixture, this.rig.tool.head.fixture]) {
      const body = fixture.getBody();
      for (let edge = body.getContactList(); edge; edge = edge.next) {
        const contact = edge.contact;
        if (contact.getFixtureA() !== fixture && contact.getFixtureB() !== fixture) continue;
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

  private applyHead(): void {
    const head = this.hammerHead ?? this.settings.rig.head;
    if (sameHammerHead(this.rig.tool.head.vertices, head)) return;
    this.rig.tool.setHead(head, this.settings.physics);
    // The frames captured since the last step show it too, so a paused game draws the new head.
    const outline = (frame: PlayerFrame): PlayerFrame =>
      ({ ...frame, parts: frame.parts.map((part) => part.kind === 'head' ? { ...part, vertices: head } : part) });
    this.current = outline(this.current);
    this.previous = outline(this.previous);
  }

  private headContactCount(): number {
    let count = 0;
    const fixture = this.rig.tool.head.fixture;
    for (let edge = fixture.getBody().getContactList(); edge; edge = edge.next) {
      const contact = edge.contact;
      if (contact.getFixtureA() !== fixture && contact.getFixtureB() !== fixture) continue;
      if (contact.isTouching() && contact.isEnabled()) count++;
    }
    return count;
  }

  // Whether the target returns to the hammer this step: the settings turn it on, aiming has paused, and the head
  // touches something. Input always comes first.
  private returning(): boolean {
    return this.settings.cursor.returnToHammer && this.elapsed - this.lastAimInput >= CURSOR_RETURN_IDLE_SECONDS &&
      this.headContactCount() > 0;
  }

  // An attempt starts aiming at the hammer head, with the cursor on the target.
  private initialAim(): Aim {
    const origin = this.cursorOrigin(this.rig.root.getPosition());
    const tip = partPoint(this.rig.tool.head, this.headPoint);
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
