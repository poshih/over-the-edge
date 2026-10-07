import { Vec2, World, WorldManifold } from 'planck';
import { PHYSICS, RIG } from './config';
import type { PlayerSpawn, Point } from './config';
import { TUNING_FIELDS, validateGameSettings } from './game-settings';
import type { GameSettings } from './game-settings';
import { sameHammerHead } from './hammer-head';
import type { HammerHead } from './hammer-head';
import {
  isBonfireObject, isEnemyObject, isPoolObject, isTerrainObject, isTrapObject, levelFloor, levelHurts, levelSpawn, levelStart,
  isPlatformObject,
} from './level';
import type { LevelChange, LevelDefinition, TerrainEvent } from './level';
import { beginPlayerDeath, changePlayerVelocity, createPlayer, destroyPlayer, drivePlayer, launchPlayer, playerAnchor, tunePlayer } from './player';
import type { MotorCommand, PartKind, PlayerRig } from './player';
import { partPoint, partVelocity } from './player-bodies';
import { rigGeometry, sameRig } from './rig';
import type { RigGeometry } from './rig';
import { surfaceMaterials } from './surfaces';
import type { LaunchSettings, PlatformDestination } from './trigger-events';
import { angleDifference } from './math';
import { aimAt, limitAim, moveAim, returnAim, shiftAim } from './aim';
import type { Aim } from './aim';
import { TerrainWorld } from './terrain-world';
import { EnemyWorld } from './enemy-world';
import type { EnemyEvent, EnemyPose } from './enemy-types';
import { HazardWorld } from './hazard-world';
import type { ProjectilePose } from './hazard-world';
import { Bonfires } from './bonfires';
import type { BonfireState } from './bonfires';
import { bonfireSpawn } from './hazards';
import type { HurtCause, HurtSource, ProjectileBlock } from './hazards';
import { LiquidWorld } from './liquid-world';
import type { HealthReading } from './health-meter';
import { PlatformWorld } from './platform-world';
import type { PlatformFrame } from './platform-world';
import type { DeathKind } from './death-sequence';
import { PlayerDeathError, writeRagdollPose } from './player-ragdoll';
import { copyDeathPose, copyPoint, copyTransform, createDeathPose, interpolateDeathPose, interpolateTransform } from './player-pose';
import type { MutablePlayerFrameState, PlayerFrameState } from './player-pose';
import { validateCharacterFigure } from './character-figure';
import type { CharacterFigure } from './character-figure';
import { copyCause, impactStrength, IMPACTS } from './moments';
import type { MomentWriter, TerminalMoment } from './moments';

export interface PartPose extends Point {
  id: string;
  kind: PartKind;
  angle: number;
  vertices: readonly Point[];
  collides: boolean;
}

export interface PhysicsFrame {
  time: number;
  placement: number;
  parts: PartPose[];
  player: PlayerFrameState;
  cursor: Point;
  enemies: readonly EnemyPose[];
  projectiles: readonly ProjectilePose[];
  platforms: PlatformFrame;
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

interface PlayerFrame { time: number; parts: PartPose[]; player: MutablePlayerFrameState; cursorOffset: Point }

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
  private readonly platforms: PlatformWorld;
  private readonly bonfires: Bonfires;
  private readonly liquids: LiquidWorld;
  private readonly moments: MomentWriter;
  private level: LevelDefinition;
  private settings: GameSettings;
  private figure: CharacterFigure;
  // Where the current run started; a rebuilt rig restarts from here.
  private spawn: Readonly<PlayerSpawn>;
  // Hinge-relative: the cursor input moves, and the target the hammer drives toward.
  private aim: Aim;
  // When, in run time, input last moved the aim, or the player was placed; the return to the hammer waits on it.
  private lastAimInput = 0;
  private previous: PlayerFrame;
  private current: PlayerFrame;
  private interpolated: PlayerFrame;
  private readonly shownFrame: PhysicsFrame;
  private readonly deathCursor: Point = { x: 0, y: 0 };
  private readonly deathTarget: Point = { x: 0, y: 0 };
  private readonly deathAnchor: Point = { x: 0, y: 0 };
  private readonly command: MotorCommand = { ...IDLE_COMMAND };
  private elapsed = 0;
  private bestHeight = 0;
  // Damage points left, and until when in run time a hit cannot hurt.
  private health: number;
  private safeUntil = 0;
  // Whether the authored level has hurt sources, so HUD health shows; removed shooters can still have shots in flight.
  private hurts: boolean;
  private readonly healthReading = { current: 0, max: 0 };
  // What dealt the latest hit that took health: reused, and copied into hurt/death moments.
  private readonly cause: { -readonly [K in keyof HurtCause]: HurtCause[K] } = { source: 'enemy', id: '', x: 0, y: 0, pushX: 0, pushY: 0 };
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
  private readonly originScratch: Point = { x: 0, y: 0 };
  private readonly targetScratch: Point = { x: 0, y: 0 };
  private readonly footScratch: Point = { x: 0, y: 0 };
  private impactTracking = false;
  private headTouching = false;
  private lastImpactAt = -Infinity;
  private terminalRaised = false;
  // The hammer's own head when it is a library hammer, which overrides the settings' default head; null for the default.
  private hammerHead: HammerHead | null = null;

  constructor(settings: Readonly<GameSettings>, level: LevelDefinition, figure: Readonly<CharacterFigure>, moments: MomentWriter) {
    this.settings = validateGameSettings(settings);
    this.figure = validateCharacterFigure(figure);
    this.moments = moments;
    this.level = level;
    this.spawn = levelSpawn(level);
    this.voidY = this.outOfBoundsY(level);
    this.health = this.settings.physics.health;
    this.hurts = levelHurts(level);
    this.world = new World(new Vec2(0, -PHYSICS.gravity));
    this.world.setContinuousPhysics(true);
    this.terrain = new TerrainWorld(this.world, level.objects.filter(isTerrainObject), () => this.dying ? null : this.rig.pot,
      surfaceMaterials(this.settings.physics));
    this.platforms = new PlatformWorld(this.world, level.objects.filter(isPlatformObject), surfaceMaterials(this.settings.physics));
    this.rig = createPlayer(this.world, this.spawn, this.settings.physics, rigGeometry(this.settings.rig), this.settings.rig.head);
    this.preparePlayerFixtures();
    this.enemies = new EnemyWorld(this.world, level.objects.filter(isEnemyObject), this.settings.physics, {
      getPot: () => this.rig.pot,
      getHeadFixture: () => this.dying ? null : this.rig.tool.head.fixture,
      canBump: () => !this.dying,
      isTransientTerrain: (body) => this.terrain.isIllusion(body),
      insideTerrain: (terrain, point) => this.terrain.isInside(terrain, point),
      onHit: (id, x, y) => {
        const moment = this.moments.append('enemy-hit', this.placements, this.elapsed);
        moment.id = id;
        moment.x = x;
        moment.y = y;
      },
      onDefeat: (id, x, y, by) => {
        const moment = this.moments.append('enemy-defeat', this.placements, this.elapsed);
        moment.id = id;
        moment.x = x;
        moment.y = y;
        moment.by = by;
      },
      onBump: (delta, enemy, atX, atY) => {
        changePlayerVelocity(this.rig, delta);
        this.hurt(this.settings.physics.bumpDamage, 'enemy', enemy, atX, atY, delta.x, delta.y);
      },
    });
    this.hazards = new HazardWorld(this.world, level.objects.filter(isTrapObject), this.settings.physics, {
      shield: () => this.rig.tool.head.fixture,
      isTerrain: (body) => this.terrain.isTerrain(body) || this.platforms.isPlatform(body),
      insideTerrain: (terrain, point) => this.terrain.isInside(terrain, point) || this.platforms.isInside(terrain, point),
      vulnerable: () => this.vulnerable(),
      hurt: (damage, push, source, trap, atX, atY) => {
        this.hurt(damage, source, trap, atX, atY, push.x, push.y);
        changePlayerVelocity(this.rig, push);
      },
      block: (hit) => this.block(hit),
    });
    this.bonfires = new Bonfires(level.objects.filter(isBonfireObject));
    this.liquids = new LiquidWorld(level.objects.filter(isPoolObject));
    this.aim = this.initialAim();
    this.current = this.createPlayerFrame();
    this.previous = this.createPlayerFrame();
    this.interpolated = this.createPlayerFrame();
    this.capture(this.current);
    this.capture(this.previous);
    this.shownFrame = {
      time: this.elapsed, placement: this.placements, parts: this.interpolated.parts, player: this.interpolated.player,
      cursor: { x: 0, y: 0 }, enemies: [], projectiles: [],
      platforms: this.platforms.frameReading, rig: this.rig.geometry,
    };
  }

  gameSettings(): GameSettings { return this.settings; }

  get rigGeometry(): RigGeometry { return this.rig.geometry; }

  // Stores the figure for the next death only; an existing corpse keeps the proportions it was built with.
  setCharacterFigure(figure: Readonly<CharacterFigure>): void {
    this.ensureLive();
    this.figure = validateCharacterFigure(figure);
  }

  // The hammer's own head outline, or null for the settings' default head. The head changes in place, mid-run, so a
  // hammer swap never restarts the run.
  setHammerHead(head: HammerHead | null): void {
    this.ensureLive();
    this.hammerHead = head;
    if (!this.dying) this.applyHead();
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
      this.platforms.setMaterials(surfaceMaterials(next.physics));
      this.enemies.setTuning(next.physics);
      this.hazards.setTuning(next.physics);
    }
    let effect: SettingsEffect = 'applied';
    if (!sameRig(next.rig, previous.rig) || !this.rig.tool.acceptsTuning(next.physics)) {
      this.reset(this.spawn);
      effect = 'restarted';
    } else {
      if (!this.dying && !sameHammerHead(next.rig.head, previous.rig.head)) {
        this.rig = { ...this.rig, geometry: rigGeometry(next.rig) };
        this.applyHead();
      }
      if (!this.dying && (next.cursor.maxTargetRadius !== previous.cursor.maxTargetRadius || next.cursor.deadZone !== previous.cursor.deadZone)) {
        // A smaller radius pulls the target straight in; the cursor keeps to its dead zone.
        limitAim(this.aim, next.cursor.maxTargetRadius, next.cursor.deadZone);
        this.previous = { ...this.previous, cursorOffset: { ...this.aim.cursor } };
        this.current = { ...this.current, cursorOffset: { ...this.aim.cursor } };
      }
      if (tuned && this.rig.phase === 'alive') tunePlayer(this.rig, next.physics);
    }
    if (tuned) {
      // Reset cached mixed materials once, after every fixture update or rig rebuild.
      for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
        contact.resetFriction();
        contact.resetRestitution();
      }
    }
    return effect;
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
    this.platforms.apply(change);
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

  // Returns the level's objects to how the level places them: illusions back, platforms at their starts,
  // enemies home, no projectiles in flight and every bonfire out.
  restoreLevelObjects(): void {
    this.ensureLive();
    this.terrain.reset();
    this.platforms.reset();
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

  playerPosition(out: Point): Point {
    const root = playerAnchor(this.rig).getPosition();
    out.x = root.x; out.y = root.y + RIG.potBottom;
    return out;
  }

  // Writes the rig's current pose into `out`, allocating nothing, so it can be read every step.
  rigPose(out: RigPose): RigPose {
    const root = playerAnchor(this.rig).getPosition();
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

  private fellOutOfLevel(): boolean {
    return this.supported && this.voidY !== null && playerAnchor(this.rig).getPosition().y + RIG.potBottom < this.voidY;
  }

  private dead(): boolean {
    return this.health <= 0;
  }

  private terminal(): DeathKind | null {
    if (this.fellOutOfLevel()) return 'fall';
    return this.dead() ? 'health' : null;
  }

  // Physics constructs the corpse from its own rig state and the current character figure, once between steps.
  beginDeath(): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new PlayerDeathError('locked-world', 'Death must begin between physics steps.');
    if (this.rig.phase !== 'alive') throw new PlayerDeathError('repeated-entry', 'This placement is already dying.');
    const origin = this.cursorOrigin(this.rig.root.getPosition(), this.originScratch);
    this.deathCursor.x = origin.x + this.aim.cursor.x;
    this.deathCursor.y = origin.y + this.aim.cursor.y;
    this.deathTarget.x = origin.x + this.aim.target.x;
    this.deathTarget.y = origin.y + this.aim.target.y;
    const root = this.rig.root.getPosition();
    this.deathAnchor.x = root.x; this.deathAnchor.y = root.y;
    this.rig = beginPlayerDeath(this.world, this.rig, this.figure, this.settings.physics, this.settings.death);
    this.preparePlayerFixtures();
    this.current = this.createPlayerFrame();
    this.previous = this.createPlayerFrame();
    this.interpolated = this.createPlayerFrame();
    this.capture(this.current);
    this.capture(this.previous);
  }

  // The simulation's health, independent of HUD visibility. Reused and read-only: consume immediately, never retain it.
  readHealth(): HealthReading {
    this.ensureLive();
    this.healthReading.current = this.health;
    this.healthReading.max = this.settings.physics.health;
    return this.healthReading;
  }

  // Brings a fallen player back at the bonfire reached last, healed and unharmed for a moment, holding the hammer as
  // at the start. The run goes on: its clock, best height and level objects carry on. False, changing nothing, when
  // no bonfire has been reached.
  respawn(): boolean {
    this.ensureLive();
    const bonfire = this.bonfires.currentBonfire();
    if (bonfire === null) return false;
    this.placePlayer(bonfireSpawn(bonfire, levelStart(this.level)), bonfire.id);
    this.safeUntil = this.elapsed + this.settings.physics.respawnInvulnerability;
    return true;
  }

  // Track head contacts only while audio, effects or observers take impact moments.
  trackImpacts(enabled: boolean): void {
    this.ensureLive();
    this.impactTracking = enabled;
    this.lastImpactAt = -Infinity;
    this.headTouching = enabled && this.headContactCount() > 0;
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

  fireTrap(id: string, shots: number): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Trap bursts must execute after the physics step.');
    this.hazards.burst(id, shots, this.elapsed);
  }

  movePlatform(id: string, to: PlatformDestination): void {
    this.ensureLive();
    if (this.world.isLocked()) throw new Error('Platform moves must execute after the physics step.');
    this.platforms.move(id, to);
  }

  // The terminal moment this step raised, borrowed until the frame's journal drain.
  step(pointerDelta: Point): Readonly<TerminalMoment> | null {
    this.ensureLive();
    if (!Number.isFinite(pointerDelta.x) || !Number.isFinite(pointerDelta.y)) {
      throw new Error('Pointer movement must be finite.');
    }
    const buffer = this.previous;
    this.previous = this.current;
    this.current = buffer;
    let swinging = false;
    if (!this.dying && (pointerDelta.x !== 0 || pointerDelta.y !== 0)) {
      if (!Number.isFinite(this.aim.cursor.x + pointerDelta.x) || !Number.isFinite(this.aim.cursor.y + pointerDelta.y)) {
        throw new Error('Pointer target must remain finite.');
      }
      const previousY = this.aim.target.y;
      moveAim(this.aim, pointerDelta, this.settings.cursor.maxTargetRadius, this.settings.cursor.deadZone);
      this.lastAimInput = this.elapsed;
      // Input that lowers the target swings the hammer down.
      swinging = this.aim.target.y < previousY;
    } else if (!this.dying && this.returning()) {
      const { returnRate, returnOffsetX, returnOffsetY, maxTargetRadius } = this.settings.cursor;
      const origin = this.cursorOrigin(playerAnchor(this.rig).getPosition(), this.originScratch);
      const tip = partPoint(this.rig.tool.head, this.headPoint);
      const target = this.targetScratch;
      target.x = tip.x + returnOffsetX - origin.x; target.y = tip.y + returnOffsetY - origin.y;
      returnAim(this.aim, target,
        1 - Math.exp(-returnRate * PHYSICS.dt), maxTargetRadius);
    }
    const rig = this.rig;
    if (rig.phase === 'alive') {
      const origin = this.cursorOrigin(rig.root.getPosition(), this.originScratch);
      const target = this.worldPoint(origin, this.aim.target, this.targetScratch);
      drivePlayer(rig, target, this.settings.physics, swinging, this.command);
    }
    this.enemies.beforeStep(this.worldAnchor(), this.elapsed);
    const bath = this.liquids.push(this.rig, this.settings.physics);
    const velocity = this.impactTracking && !this.dying ? partVelocity(this.rig.tool.head, this.velocityScratch) : null;
    const approachX = velocity?.x ?? 0;
    const approachY = velocity?.y ?? 0;
    // Planck moves the body's own position vector, so keep where the root was.
    const root = playerAnchor(this.rig).getPosition();
    const rootX = root.x, rootY = root.y;
    this.platforms.beforeStep();
    this.world.step(PHYSICS.dt, PHYSICS.velocityIterations, PHYSICS.positionIterations);
    this.platforms.afterStep();
    if (!this.dying) this.lagCharacter(rootX, rootY);
    if (!this.dying && !this.supported) this.detectSupport();
    this.elapsed += PHYSICS.dt;
    if (this.impactTracking && !this.dying) {
      const touching = this.headContactCount() > 0;
      const speed = Math.hypot(approachX, approachY);
      if (touching && !this.headTouching && speed >= IMPACTS.minimumSpeed && this.elapsed - this.lastImpactAt >= IMPACTS.interval) {
        const fixture = this.rig.tool.head.fixture;
        for (let edge = fixture.getBody().getContactList(); edge; edge = edge.next) {
          const contact = edge.contact;
          if (contact.getFixtureA() !== fixture && contact.getFixtureB() !== fixture) continue;
          if (!contact.isTouching() || !contact.isEnabled()) continue;
          const manifold = contact.getWorldManifold(this.manifold);
          if (!manifold || manifold.pointCount === 0) continue;
          let x = 0, y = 0;
          for (let index = 0; index < manifold.pointCount; index++) {
            x += manifold.points[index]!.x;
            y += manifold.points[index]!.y;
          }
          const orientation = contact.getFixtureA() === fixture ? -1 : 1;
          const moment = this.moments.append('impact', this.placements, this.elapsed);
          moment.x = x / manifold.pointCount;
          moment.y = y / manifold.pointCount;
          moment.normalX = manifold.normal.x * orientation;
          moment.normalY = manifold.normal.y * orientation;
          moment.speed = speed;
          moment.strength = impactStrength(speed);
          this.lastImpactAt = this.elapsed;
          break;
        }
      }
      this.headTouching = touching;
    }
    this.terrain.advance(this.elapsed);
    this.enemies.afterStep(this.elapsed);
    this.hazards.afterStep(this.elapsed, this.worldAnchor());
    // Lava burns the character while the pot is in it; each burn, like any hit, leaves it unharmed for a second.
    if (bath?.liquid === 'lava') {
      const root = playerAnchor(this.rig).getPosition();
      this.hurt(this.settings.physics.lavaDamage, 'lava', bath.id, root.x, root.y, 0, 0);
    }
    if (!this.dying && this.terminal() === null) {
      this.platforms.board(this.rig.potFixture, this.manifold, SUPPORT_NORMAL);
      const foot = this.playerPosition(this.footScratch);
      const height = foot.y;
      const bonfire = this.bonfires.update(foot);
      if (bonfire !== null) {
        const moment = this.moments.append('bonfire', this.placements, this.elapsed);
        moment.id = bonfire.id;
        moment.x = bonfire.x;
        moment.y = bonfire.y;
      }
      this.bestHeight = Math.max(this.bestHeight, height);
    }
    this.capture(this.current);
    if (this.dying || this.terminalRaised) return null;
    const terminal = this.terminal();
    if (terminal === null) return null;
    this.terminalRaised = true;
    if (terminal === 'fall') return this.moments.append('fall', this.placements, this.elapsed);
    const moment = this.moments.append('death', this.placements, this.elapsed);
    copyCause(moment.cause, this.cause);
    return moment;
  }

  // Collapse the interpolation sources without changing physics; the next step starts from this endpoint.
  settleInterpolation(): void {
    this.ensureLive();
    const current = this.current, previous = this.previous;
    const player = previous.player, from = current.player;
    if (player.phase === 'alive' && from.phase === 'alive') {
      copyPoint(player.shoulder, from.shoulder);
    } else if (player.phase === 'dying' && from.phase === 'dying') {
      copyDeathPose(player.pose, from.pose);
    } else throw new PlayerDeathError('phase-mismatch', 'Player interpolation cannot settle across a placement or death phase.');
    copyTransform(player.centre, from.centre);
    previous.time = current.time;
    copyPoint(previous.cursorOffset, current.cursorOffset);
    for (let index = 0; index < current.parts.length; index++) {
      const part = current.parts[index]!, out = previous.parts[index]!;
      copyTransform(out, part);
      out.vertices = part.vertices; out.collides = part.collides;
    }
    this.enemies.settleInterpolation();
    this.hazards.settleInterpolation();
    this.platforms.settleInterpolation();
  }

  // The frame and every mutable member are borrowed until the next call. Consume immediately, never retain them.
  frame(alpha: number): PhysicsFrame {
    const shown = this.interpolated, parts = shown.parts;
    for (let index = 0; index < this.current.parts.length; index++) {
      const part = this.current.parts[index]!, previous = this.previous.parts[index]!, out = parts[index]!;
      out.x = previous.x + (part.x - previous.x) * alpha;
      out.y = previous.y + (part.y - previous.y) * alpha;
      out.angle = previous.angle + angleDifference(part.angle, previous.angle) * alpha;
      out.vertices = part.vertices; out.collides = part.collides;
    }
    const current = this.current.player, previous = this.previous.player, player = shown.player;
    interpolateTransform(player.centre, previous.centre, current.centre, alpha);
    if (player.phase === 'alive' && previous.phase === 'alive' && current.phase === 'alive') {
      player.shoulder.x = previous.shoulder.x + (current.shoulder.x - previous.shoulder.x) * alpha;
      player.shoulder.y = previous.shoulder.y + (current.shoulder.y - previous.shoulder.y) * alpha;
    } else if (player.phase !== 'alive' && previous.phase !== 'alive' && current.phase !== 'alive') {
      interpolateDeathPose(player.pose, previous.pose, current.pose, alpha);
    } else throw new PlayerDeathError('phase-mismatch', 'Player interpolation crossed a placement or death phase.');
    const frame = this.shownFrame, cursor = frame.cursor;
    frame.time = this.previous.time + (this.current.time - this.previous.time) * alpha;
    frame.placement = this.placements; frame.parts = parts; frame.player = player;
    if (this.dying) {
      cursor.x = this.deathCursor.x; cursor.y = this.deathCursor.y;
    } else {
      cursor.x = player.centre.x + RIG.shoulder.x + (this.previous.cursorOffset.x +
        (this.current.cursorOffset.x - this.previous.cursorOffset.x) * alpha);
      cursor.y = player.centre.y + RIG.shoulder.y + (this.previous.cursorOffset.y +
        (this.current.cursorOffset.y - this.previous.cursorOffset.y) * alpha);
    }
    frame.enemies = this.enemies.frame(alpha); frame.projectiles = this.hazards.frame(alpha);
    frame.platforms = this.platforms.frame(alpha); frame.rig = this.rig.geometry;
    return frame;
  }

  // HUD-only data: no allocations, contact walk, motor queries or plugin callbacks.
  writeHudFrame(out: { height: number; bestHeight: number; health: HealthReading | null }): void {
    const health = this.readHealth();
    out.height = Math.max(0, playerAnchor(this.rig).getPosition().y + RIG.potBottom);
    out.bestHeight = this.bestHeight;
    out.health = this.hurts ? health : null;
  }

  status() {
    this.ensureLive();
    const root = playerAnchor(this.rig).getPosition();
    let contacts = 0;
    for (let contact = this.world.getContactList(); contact; contact = contact.getNext()) {
      if (contact.isTouching() && contact.isEnabled()) contacts++;
    }
    const released = this.rig.phase === 'dying';
    const hingeTorque = this.rig.phase === 'dying' ? null : this.rig.drive.getMotorTorque(1 / PHYSICS.dt);
    const sliderForce = this.rig.phase === 'dying' ? null : this.rig.drive.getMotorForce(1 / PHYSICS.dt);
    // Loads are shares of the strength each motor had in the last step, downswing boost included.
    return {
      time: this.elapsed,
      height: Math.max(0, root.y + RIG.potBottom),
      bestHeight: this.bestHeight,
      contacts,
      phase: this.rig.phase,
      motors: released ? 'released' as const : 'driven' as const,
      hingeLoad: hingeTorque === null ? null : Math.abs(hingeTorque) / (this.settings.physics.hingeTorque * this.command.hingeBoost),
      sliderLoad: sliderForce === null ? null : Math.abs(sliderForce) / (this.settings.physics.sliderForce * this.command.sliderBoost),
      // Null in levels where nothing can hurt the player.
      health: this.hurts ? { current: this.health, max: this.settings.physics.health } : null,
    };
  }

  snapshot() {
    const status = this.status();
    const anchor = playerAnchor(this.rig), root = anchor.getPosition();
    const origin = this.cursorOrigin(root, { x: 0, y: 0 });
    return {
      ...status,
      player: { phase: this.rig.phase, centre: { x: root.x, y: root.y, angle: anchor.getAngle() } },
      tip: { ...partPoint(this.rig.tool.head, this.headPoint) },
      aim: this.rig.phase === 'dying' ? {
        state: 'captured' as const, cursor: { ...this.deathCursor }, target: { ...this.deathTarget },
      } : {
        state: 'driven' as const, cursor: this.worldPoint(origin, this.aim.cursor, { x: 0, y: 0 }), origin,
        cursorOffset: { ...this.aim.cursor }, target: this.worldPoint(origin, this.aim.target, { x: 0, y: 0 }), targetOffset: { ...this.aim.target },
      },
      playerVelocity: { ...anchor.getLinearVelocity() },
      potAngle: this.rig.pot.getAngle(),
      headContacts: this.headContactCount(),
      rig: this.rig.geometry,
      drive: this.rig.phase === 'dying' ? { state: 'released' as const } : {
        state: 'driven' as const, extension: this.rig.drive.getTranslation(),
        hingeTorque: this.rig.drive.getMotorTorque(1 / PHYSICS.dt), sliderForce: this.rig.drive.getMotorForce(1 / PHYSICS.dt),
        command: { ...this.command },
      },
      tuning: { ...this.settings.physics },
      bodyProperties: Object.fromEntries(this.rig.bodies.map(({ id, body }) =>
        [id, { mass: body.getMass(), inertia: body.getInertia() }] as const)),
      bodyCount: this.world.getBodyCount(),
      jointCount: this.world.getJointCount(),
      enemies: this.enemies.inspect(),
      hazards: this.hazards.inspect(),
      platforms: this.platforms.inspect(),
      bonfires: this.bonfires.state(),
      liquids: this.liquids.inspect(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.liquids.dispose();
    this.bonfires.dispose();
    this.hazards.dispose();
    this.platforms.dispose();
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

  private createPlayerFrame(): PlayerFrame {
    const rig = this.rig, centre = { x: 0, y: 0, angle: 0 };
    const player: MutablePlayerFrameState = rig.phase === 'alive'
      ? { phase: 'alive', centre, shoulder: { x: 0, y: 0 } }
      : { phase: 'dying', centre, pose: createDeathPose() };
    return { time: this.elapsed, player, cursorOffset: { x: 0, y: 0 }, parts: rig.parts.map(part => ({
      id: part.id, kind: part.kind, x: 0, y: 0, angle: 0, vertices: part.vertices, collides: false,
    })) };
  }

  private capture(out: PlayerFrame): void {
    out.time = this.elapsed;
    out.cursorOffset.x = this.aim.cursor.x; out.cursorOffset.y = this.aim.cursor.y;
    const anchor = playerAnchor(this.rig), centre = anchor.getPosition();
    out.player.centre.x = centre.x; out.player.centre.y = centre.y; out.player.centre.angle = anchor.getAngle();
    if (this.rig.phase === 'alive' && out.player.phase === 'alive') {
      out.player.shoulder.x = centre.x + RIG.shoulder.x; out.player.shoulder.y = centre.y + RIG.shoulder.y;
    } else if (this.rig.phase === 'dying' && out.player.phase === 'dying') {
      writeRagdollPose(this.rig.ragdoll, out.player.pose);
    } else throw new PlayerDeathError('phase-mismatch', 'A player snapshot has the wrong phase.');
    for (let index = 0; index < this.rig.parts.length; index++) {
      const part = this.rig.parts[index]!, target = out.parts[index]!;
      const position = partPoint(part, this.pointScratch);
      const angle = part.body.getAngle();
      const velocity = partVelocity(part, this.velocityScratch);
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(angle) ||
        !Number.isFinite(velocity.x) || !Number.isFinite(velocity.y) || !Number.isFinite(part.body.getAngularVelocity())) {
        throw new Error(`Non-finite physics state on ${part.id}. Simulation stopped.`);
      }
      target.x = position.x; target.y = position.y; target.angle = angle; target.vertices = part.vertices;
      target.collides = part.fixture !== undefined && part.fixture.getFilterMaskBits() !== 0;
    }
  }

  private preparePlayerFixtures(): void {
    for (const part of this.rig.parts) if (part.fixture !== undefined) this.terrain.prepareFixture(part.fixture);
  }

  // A new run from the run's spawn.
  private resetPlayer(): void {
    this.elapsed = 0;
    this.safeUntil = 0;
    this.placePlayer(this.spawn, null);
    this.bestHeight = Math.max(0, playerAnchor(this.rig).getPosition().y + RIG.potBottom);
  }

  // A new player at `spawn`, at full health.
  private placePlayer(spawn: Readonly<PlayerSpawn>, bonfire: string | null): void {
    destroyPlayer(this.world, this.rig);
    const geometry = sameRig(this.rig.geometry, this.settings.rig) && sameHammerHead(this.rig.geometry.head, this.settings.rig.head)
      ? this.rig.geometry : rigGeometry(this.settings.rig);
    this.rig = createPlayer(this.world, spawn, this.settings.physics, geometry, this.hammerHead ?? this.settings.rig.head);
    this.preparePlayerFixtures();
    this.platforms.resetRiders();
    this.supported = false;
    this.headTouching = false;
    this.lastImpactAt = -Infinity;
    this.terminalRaised = false;
    this.health = this.settings.physics.health;
    this.placements++;
    this.aim = this.initialAim();
    this.lastAimInput = this.elapsed;
    Object.assign(this.command, IDLE_COMMAND);
    this.current = this.createPlayerFrame();
    this.previous = this.createPlayerFrame();
    this.interpolated = this.createPlayerFrame();
    this.capture(this.current);
    this.capture(this.previous);
    const moment = this.moments.append('placed', this.placements, this.elapsed);
    moment.bonfire = bonfire;
  }

  private vulnerable(): boolean {
    return !this.dying && this.health > 0 && this.elapsed >= this.safeUntil;
  }

  private block(hit: Readonly<ProjectileBlock>): void {
    const moment = this.moments.append('block', this.placements, this.elapsed);
    moment.trap = hit.trap;
    moment.x = hit.x;
    moment.y = hit.y;
    moment.directionX = hit.directionX;
    moment.directionY = hit.directionY;
    moment.normalX = hit.normalX;
    moment.normalY = hit.normalY;
  }

  // Takes `damage` from the player's health, dealt by the level object `id` striking at (x, y) and knocking the player
  // with (pushX, pushY), unless a hit hurt it moments ago; each hit leaves it unharmed for a while.
  private hurt(damage: number, source: HurtSource, id: string, x: number, y: number, pushX: number, pushY: number): void {
    if (damage === 0 || !this.vulnerable()) return;
    this.health = Math.max(0, this.health - damage);
    this.safeUntil = this.elapsed + this.settings.physics.hurtInvulnerability;
    this.cause.source = source;
    this.cause.id = id;
    this.cause.x = x;
    this.cause.y = y;
    this.cause.pushX = pushX;
    this.cause.pushY = pushY;
    const moment = this.moments.append('hurt', this.placements, this.elapsed);
    copyCause(moment.cause, this.cause);
    moment.health = this.health;
    moment.max = this.settings.physics.health;
  }

  private outOfBoundsY(level: LevelDefinition): number | null {
    const floor = levelFloor(level);
    return floor === null ? null : floor - OUT_OF_BOUNDS_DEPTH;
  }

  // Auto-restart only arms once the pot or head stood on terrain, so a start with nothing beneath it
  // (or one inside rock that it drops out of) keeps falling instead of restarting in a loop.
  private detectSupport(): void {
    for (let index = 0; index < 2; index++) {
      const fixture = index === 0 ? this.rig.potFixture : this.rig.tool.head.fixture;
      const body = fixture.getBody();
      for (let edge = body.getContactList(); edge; edge = edge.next) {
        const contact = edge.contact;
        if (contact.getFixtureA() !== fixture && contact.getFixtureB() !== fixture) continue;
        if (edge.other === null || !contact.isTouching() || !contact.isEnabled() ||
          (!this.terrain.isTerrain(edge.other) && !this.platforms.isPlatform(edge.other))) continue;
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
    this.terrain.prepareFixture(this.rig.tool.head.fixture);
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

  // A cursor and target that follow only part of the character's movement stay behind, in the world, by the rest of
  // the step it just moved; the hinge is a fixed offset from the root, so the root's movement is the hinge's.
  private lagCharacter(fromX: number, fromY: number): void {
    const { followCharacter, maxTargetRadius } = this.settings.cursor;
    if (followCharacter >= 100) return;
    const root = playerAnchor(this.rig).getPosition();
    const lag = 1 - followCharacter / 100;
    const dx = (fromX - root.x) * lag, dy = (fromY - root.y) * lag;
    if (dx !== 0 || dy !== 0) shiftAim(this.aim, dx, dy, maxTargetRadius);
  }

  // Whether the target returns to the hammer this step: the settings turn it on, aiming has paused for the return
  // delay, and the head touches something. Input always comes first.
  private returning(): boolean {
    const { returnToHammer, returnDelay } = this.settings.cursor;
    return returnToHammer && this.elapsed - this.lastAimInput >= returnDelay && this.headContactCount() > 0;
  }

  // An attempt starts aiming at the hammer head, with the cursor on the target.
  private initialAim(): Aim {
    const origin = this.cursorOrigin(playerAnchor(this.rig).getPosition(), this.originScratch);
    const tip = partPoint(this.rig.tool.head, this.headPoint);
    return aimAt({ x: tip.x - origin.x, y: tip.y - origin.y }, this.settings.cursor.maxTargetRadius);
  }

  // Aim is hinge-relative like the hammer's reach; the root never rotates, so the hinge is a fixed offset.
  private cursorOrigin(root: Readonly<Point>, out: Point): Point {
    out.x = root.x + RIG.shoulder.x; out.y = root.y + RIG.shoulder.y;
    return out;
  }

  private worldPoint(origin: Readonly<Point>, offset: Readonly<Point>, out: Point): Point {
    out.x = origin.x + offset.x; out.y = origin.y + offset.y;
    return out;
  }

  private worldAnchor(): Readonly<Point> {
    return this.dying ? this.deathAnchor : playerAnchor(this.rig).getPosition();
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed physics simulation.');
  }

  private get dying(): boolean { return this.rig.phase !== 'alive'; }
}
