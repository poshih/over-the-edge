import type { Object3D } from 'three';
import { AxeView } from './axe-view';
import { BonfireView } from './bonfire-view';
import { Disposal } from './disposal';
import type { EnemyArtSettings } from './enemy-art-data';
import type { EnemyEvent, EnemyPose } from './enemy-types';
import { EnemyView } from './enemy-view';
import { FlagView } from './flag-view';
import type { HammerHead } from './hammer-head';
import type { ProjectilePose } from './hazard-world';
import { isPlatformObject } from './level';
import type { AxeObject, BonfireObject, LevelObject, PlatformObject, PoolObject, ShooterObject, TriggerObject } from './level';
import type { PhantomPose, PhantomTool } from './phantom-format';
import { PoolView } from './pool-view';
import { PlatformView } from './platform-view';
import type { PlatformFrame, PlatformPose } from './platform-world';
import { ProjectileView, ShooterView } from './shooter-view';
import { SwitchView } from './switch-view';
import { UpdraftView } from './updraft-view';
import { call0, call1, call2, createInstance, instanceContract, isObject3D, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';

// How the level's objects of each kind look, replaced or wrapped by runtime facets (docs/runtime-plugins.md):
// the engine's own looks below are the defaults, built on the same contract.

// What a look adds to each of the view's passes, drawn each over the last: the course, behind the actors; the actors;
// and the front, over the actors, for what stands in front of the obstacle line. They are the look's for its whole life.
// The front pass runs only while some look's front is visible, so a look hides its front while it shows nothing.
export interface LookPasses {
  readonly course?: Object3D;
  readonly actors?: Object3D;
  readonly front?: Object3D;
}

// How every level object of one kind looks.
export interface ObjectLook<T extends LevelObject> {
  readonly passes: LookPasses;
  // The level's objects of its kind: all of them when the level loads, and again whenever any of them changes.
  set(objects: readonly T[]): void;
  // Called every frame only while this look's kind has objects, with the run's time in seconds; draw only what changed.
  update(time: number): void;
  dispose(): void;
  // What the game's diagnostics report about it.
  inspect?(): unknown;
}

export interface BonfireLook extends ObjectLook<BonfireObject> {
  // The bonfires the player has reached this run, which burn: called whenever they change.
  setLit(ids: readonly string[]): void;
}

export interface SwitchLook extends ObjectLook<TriggerObject> {
  setPressed(ids: readonly string[]): void;
}

export interface PlatformLook {
  readonly passes: LookPasses;
  // Authored platforms at load and only when they change; never mutate them. Retain existing IDs' drawn positions.
  set(objects: readonly PlatformObject[]): void;
  // Only changed drawn poses, not membership. The array and poses are borrowed until the next frame.
  update(changes: readonly PlatformPose[], time: number): void;
  dispose(): void;
  inspect?(): unknown;
}

export interface ProjectileLook {
  readonly passes: LookPasses;
  // Called every frame while the level has shooters or projectiles fly, plus one final empty update when both end.
  // Each projectile has its tip at its position and flies along its angle.
  // The array and poses are borrowed until the next frame; copy any values kept.
  update(projectiles: readonly ProjectilePose[], time: number): void;
  dispose(): void;
  inspect?(): unknown;
}

// An aggregate look: event-driven membership, and only the active poses each drawn frame. Collider visuals stand
// on the obstacle line and draw in actors; course/front passes may add scenery behind/in front of them.
export interface EnemyLook {
  readonly passes: LookPasses;
  apply(event: EnemyEvent): void;
  // The array and its poses are pooled, borrowed until the next frame. Copy individual values kept.
  update(poses: readonly EnemyPose[], time: number): void;
  setArt(art: EnemyArtSettings): void;
  dispose(): void;
  inspect?(): unknown;
}
export type EnemyLookFactory = (art: EnemyArtSettings) => EnemyLook;

// One stable slot in engine-owned playback. Values, pose and tool are reused and read-only to a look.
export interface PhantomFigureFrame {
  readonly visible: boolean;
  readonly pose: Readonly<PhantomPose>;
  readonly tool: Readonly<PhantomTool>;
  readonly handleLength: number;
  // The engine's fade factor, 0..1; the look supplies its own base opacity.
  readonly opacity: number;
  // A new recording or a discontinuous seek resets the drawing's history. Pauses also have dt = 0, but are not fresh.
  readonly fresh: boolean;
  readonly dt: number;
}

export interface PhantomLook {
  // Characters draw in actors, never hidden by the course. Playback owns this root's visibility.
  readonly root: Object3D;
  // Every slot, including hidden ones, while at least one shows. Head is the current rig settings' outline,
  // as in SceneFrame.rig.head, not the recorded player's or a library hammer's own.
  draw(figures: readonly PhantomFigureFrame[], head: HammerHead): void;
  dispose(): void;
}
// The total number of stable slots, including the playback's held figure, is fixed for the look's lifetime.
export type PhantomLookFactory = (options: { readonly figures: number }) => PhantomLook;

export interface ObjectLooks {
  // Triggers marked with a flag, and with an updraft.
  readonly flag: () => ObjectLook<TriggerObject>;
  readonly updraft: () => ObjectLook<TriggerObject>;
  readonly switch: () => SwitchLook;
  readonly bonfire: () => BonfireLook;
  readonly platform: () => PlatformLook;
  readonly shooter: () => ObjectLook<ShooterObject>;
  readonly projectile: () => ProjectileLook;
  readonly axe: () => ObjectLook<AxeObject>;
  // Pools of lava, and of swamp.
  readonly lava: () => ObjectLook<PoolObject>;
  readonly swamp: () => ObjectLook<PoolObject>;
}
export interface Looks extends ObjectLooks {
  readonly enemies: EnemyLookFactory;
  readonly phantoms: PhantomLookFactory;
}
export type LookName = keyof Looks;
type PlacedLookName = Exclude<keyof ObjectLooks, 'projectile' | 'platform'>;

function lookFactory<T extends (...args: never[]) => unknown>(value: unknown): T {
  if (typeof value !== 'function') throw new TypeError('A look must be a factory.');
  return value as T;
}

export const LOOKS = Object.freeze({
  flag: slotPoint('looks.flag', 'runtime', lookFactory<ObjectLooks['flag']>),
  updraft: slotPoint('looks.updraft', 'runtime', lookFactory<ObjectLooks['updraft']>),
  switch: slotPoint('looks.switch', 'runtime', lookFactory<ObjectLooks['switch']>),
  bonfire: slotPoint('looks.bonfire', 'runtime', lookFactory<ObjectLooks['bonfire']>),
  platform: slotPoint('looks.platform', 'runtime', lookFactory<ObjectLooks['platform']>),
  shooter: slotPoint('looks.shooter', 'runtime', lookFactory<ObjectLooks['shooter']>),
  projectile: slotPoint('looks.projectile', 'runtime', lookFactory<ObjectLooks['projectile']>),
  axe: slotPoint('looks.axe', 'runtime', lookFactory<ObjectLooks['axe']>),
  lava: slotPoint('looks.lava', 'runtime', lookFactory<ObjectLooks['lava']>),
  swamp: slotPoint('looks.swamp', 'runtime', lookFactory<ObjectLooks['swamp']>),
  enemies: slotPoint('looks.enemies', 'runtime', lookFactory<EnemyLookFactory>),
  phantoms: slotPoint('looks.phantoms', 'runtime', lookFactory<PhantomLookFactory>),
});

// An engine view of one kind of object, as a look.
function viewLook<T extends LevelObject>(view: {
  readonly root: Object3D;
  setObjects(objects: readonly LevelObject[]): void;
  update(time: number): void;
  dispose(): void;
  inspect(): unknown;
}, front?: Object3D): ObjectLook<T> {
  return {
    passes: { course: view.root, front },
    set: (objects) => view.setObjects(objects),
    update: (time) => view.update(time),
    dispose: () => view.dispose(),
    inspect: () => view.inspect(),
  };
}

// The engine's level-object looks. Phantom consumers import their default from phantom-view, so releases without
// phantoms include neither their drawing nor playback. A game may wrap a look rather than draw it anew.
export const DEFAULT_LOOKS: Omit<Looks, 'phantoms'> = Object.freeze({
  flag: () => viewLook<TriggerObject>(new FlagView()),
  updraft: () => viewLook<TriggerObject>(new UpdraftView()),
  switch: (): SwitchLook => {
    const view = new SwitchView();
    return { ...viewLook<TriggerObject>(view), setPressed: (ids) => view.setPressed(ids) };
  },
  bonfire: (): BonfireLook => {
    const view = new BonfireView();
    return { ...viewLook<BonfireObject>(view), setLit: (ids) => view.setLit(ids) };
  },
  platform: () => new PlatformView(),
  shooter: () => viewLook<ShooterObject>(new ShooterView()),
  projectile: (): ProjectileLook => {
    const view = new ProjectileView();
    return { passes: { actors: view.root }, update: (projectiles) => view.update(projectiles), dispose: () => view.dispose(), inspect: () => view.inspect() };
  },
  axe: () => {
    const view = new AxeView();
    return viewLook<AxeObject>(view, view.front);
  },
  lava: () => {
    const view = new PoolView('lava');
    return viewLook<PoolObject>(view, view.front);
  },
  swamp: () => {
    const view = new PoolView('swamp');
    return viewLook<PoolObject>(view, view.front);
  },
  enemies: (art: EnemyArtSettings) => new EnemyView(art),
});

// The level objects each look draws.
const SELECTED: Readonly<Record<PlacedLookName, (object: LevelObject) => boolean>> = {
  flag: (object) => object.kind === 'trigger' && object.marker === 'flag',
  updraft: (object) => object.kind === 'trigger' && object.marker === 'updraft',
  switch: (object) => object.kind === 'trigger' && object.marker === 'switch',
  bonfire: (object) => object.kind === 'bonfire',
  shooter: (object) => object.kind === 'shooter',
  axe: (object) => object.kind === 'axe',
  lava: (object) => object.kind === 'pool' && object.liquid === 'lava',
  swamp: (object) => object.kind === 'pool' && object.liquid === 'swamp',
};

function validLookPasses(look: object): boolean {
  const passes: unknown = Reflect.get(look, 'passes');
  return typeof passes === 'object' && passes !== null &&
    (['course', 'actors', 'front'] as const).every((pass) => {
      const group: unknown = Reflect.get(passes, pass);
      return group === undefined || isObject3D(group);
    });
}

const OBJECT_LOOK_CONTRACT = instanceContract({
  returns: 'three.js passes, set(objects), update(time), dispose() and, when given, inspect()',
  methods: ['set', 'update', 'dispose'],
  optional: ['inspect'],
  check: validLookPasses,
});
const LOOK_CONTRACTS = Object.freeze({
  flag: OBJECT_LOOK_CONTRACT,
  updraft: OBJECT_LOOK_CONTRACT,
  switch: instanceContract({
    ...OBJECT_LOOK_CONTRACT,
    returns: 'three.js passes, set(objects), setPressed(ids), update(time), dispose() and, when given, inspect()',
    methods: ['set', 'setPressed', 'update', 'dispose'],
  }),
  bonfire: instanceContract({
    ...OBJECT_LOOK_CONTRACT,
    returns: 'three.js passes, set(objects), setLit(ids), update(time), dispose() and, when given, inspect()',
    methods: ['set', 'setLit', 'update', 'dispose'],
  }),
  platform: instanceContract({
    ...OBJECT_LOOK_CONTRACT,
    returns: 'three.js passes, set(objects), update(changes, time), dispose() and, when given, inspect()',
  }),
  shooter: OBJECT_LOOK_CONTRACT,
  projectile: instanceContract({
    ...OBJECT_LOOK_CONTRACT,
    returns: 'three.js passes, update(projectiles, time), dispose() and, when given, inspect()',
    methods: ['update', 'dispose'],
  }),
  axe: OBJECT_LOOK_CONTRACT,
  lava: OBJECT_LOOK_CONTRACT,
  swamp: OBJECT_LOOK_CONTRACT,
  enemies: instanceContract({
    ...OBJECT_LOOK_CONTRACT,
    returns: 'three.js passes, apply(event), update(poses, time), setArt(art), dispose() and, when given, inspect()',
    methods: ['apply', 'update', 'setArt', 'dispose'],
  }),
  phantoms: instanceContract({
    returns: 'a three.js root, draw(figures, head) and dispose()',
    methods: ['draw', 'dispose'],
    root: true,
  }),
});

function sameObjects(a: readonly LevelObject[], b: readonly LevelObject[]): boolean {
  return a.length === b.length && a.every((object, index) => object === b[index]);
}

interface Placed {
  readonly name: PlacedLookName;
  readonly look: Attributed<ObjectLook<LevelObject>>;
  // The objects it was last given; null before the level loads.
  objects: readonly LevelObject[] | null;
}
const NO_PROJECTILES: readonly ProjectilePose[] = Object.freeze([]);

/**
 * The looks of the level's objects in one view, composed once from the runtime session.
 * Each gets its kind's objects when the level loads and again only when one of them changes.
 */
export class LevelLooks {
  private readonly enemies: Attributed<EnemyLook>;
  private readonly placed: readonly Placed[];
  private readonly bonfire: Attributed<BonfireLook>;
  private readonly switch: Attributed<SwitchLook>;
  private readonly platform: Attributed<PlatformLook>;
  private platformObjects: readonly PlatformObject[] | null = null;
  private readonly projectile: Attributed<ProjectileLook>;
  private readonly passList: readonly LookPasses[];
  private fronts: readonly Object3D[] = [];
  private active: readonly Placed[] = [];
  private hasShooters = false;
  private hasEnemies = false;
  private hasPlatforms = false;
  private projectileActive = false;

  constructor(plugins: RuntimePlugins, objects: readonly LevelObject[], art: EnemyArtSettings) {
    const factories = {
      flag: plugins.slot(LOOKS.flag, DEFAULT_LOOKS.flag),
      updraft: plugins.slot(LOOKS.updraft, DEFAULT_LOOKS.updraft),
      switch: plugins.slot(LOOKS.switch, DEFAULT_LOOKS.switch),
      bonfire: plugins.slot(LOOKS.bonfire, DEFAULT_LOOKS.bonfire),
      platform: plugins.slot(LOOKS.platform, DEFAULT_LOOKS.platform),
      shooter: plugins.slot(LOOKS.shooter, DEFAULT_LOOKS.shooter),
      projectile: plugins.slot(LOOKS.projectile, DEFAULT_LOOKS.projectile),
      axe: plugins.slot(LOOKS.axe, DEFAULT_LOOKS.axe),
      lava: plugins.slot(LOOKS.lava, DEFAULT_LOOKS.lava),
      swamp: plugins.slot(LOOKS.swamp, DEFAULT_LOOKS.swamp),
      enemies: plugins.slot(LOOKS.enemies, DEFAULT_LOOKS.enemies),
    };
    const createEnemies = factories.enemies.value;
    const created: Attributed<{ dispose(): void }>[] = [];
    const build = <L extends { dispose(): void }>(name: LookName, factory: Attributed<unknown>, create: () => L): Attributed<L> => {
      const look = createInstance<L>(LOOK_CONTRACTS[name], factory, create);
      created.push(look);
      return look;
    };
    try {
      this.enemies = build('enemies', factories.enemies, () => createEnemies(art));
      this.bonfire = build('bonfire', factories.bonfire, factories.bonfire.value);
      this.switch = build('switch', factories.switch, factories.switch.value);
      this.platform = build('platform', factories.platform, factories.platform.value);
      this.projectile = build('projectile', factories.projectile, factories.projectile.value);
      this.placed = (['flag', 'updraft', 'switch', 'bonfire', 'shooter', 'axe', 'lava', 'swamp'] as const).map((name): Placed => {
        if (name === 'bonfire') return { name, look: this.bonfire, objects: null };
        if (name === 'switch') return { name, look: this.switch, objects: null };
        const factory = factories[name];
        return { name, look: build<ObjectLook<LevelObject>>(name, factory, factory.value), objects: null };
      });
      this.passList = Object.freeze([
        this.enemies.value.passes, ...this.placed.map(({ look }) => look.value.passes), this.platform.value.passes, this.projectile.value.passes,
      ]);
      this.setLevel(objects);
    } catch (error) {
      for (let index = created.length - 1; index >= 0; index--) call0(created[index]!, 'dispose');
      throw error;
    }
  }

  // Every look's passes, for the view to add to its own.
  passes(): readonly LookPasses[] {
    return this.passList;
  }

  // The level's objects, when it loads and after each edit: every look gets its own at load, even none, and then only
  // when they change.
  setLevel(objects: readonly LevelObject[]): void {
    for (const placed of this.placed) {
      const next = objects.filter(SELECTED[placed.name]);
      if (placed.objects !== null && sameObjects(placed.objects, next)) continue;
      placed.objects = next;
      call1(placed.look, 'set', next);
    }
    const platforms = objects.filter(isPlatformObject);
    if (this.platformObjects === null || !sameObjects(this.platformObjects, platforms)) {
      this.platformObjects = platforms;
      call1(this.platform, 'set', platforms);
    }
    this.active = this.placed.filter(placed => placed.objects!.length > 0);
    this.hasShooters = this.active.some(placed => placed.name === 'shooter');
    this.hasEnemies = objects.some(object => object.kind === 'enemy');
    this.hasPlatforms = platforms.length > 0;
    const passes = this.active.map(({ look }) => look.value.passes);
    if (this.hasEnemies) passes.push(this.enemies.value.passes);
    if (this.hasPlatforms) passes.push(this.platform.value.passes);
    this.fronts = passes.flatMap(({ front }) => front === undefined ? [] : [front]);
  }

  setLit(ids: readonly string[]): void {
    call1(this.bonfire, 'setLit', ids);
  }

  setPressedSwitches(ids: readonly string[]): void {
    call1(this.switch, 'setPressed', ids);
  }

  applyEnemy(event: EnemyEvent): void {
    call1(this.enemies, 'apply', event);
  }

  setEnemyArt(art: EnemyArtSettings): void {
    call1(this.enemies, 'setArt', art);
  }

  inspectEnemies(): unknown {
    return this.enemies.value.inspect === undefined ? null : call0(this.enemies, 'inspect') ?? null;
  }

  update(time: number, projectiles: readonly ProjectilePose[], enemies: readonly EnemyPose[], platforms: PlatformFrame): void {
    for (const { look } of this.active) call1(look, 'update', time);
    if (this.hasPlatforms) {
      const revision = platforms.revision;
      call2(this.platform, 'update', platforms.changes, time);
      platforms.acknowledge(revision);
    }
    if (this.hasEnemies) call2(this.enemies, 'update', enemies, time);
    if (this.hasShooters || projectiles.length > 0) {
      call2(this.projectile, 'update', projectiles, time);
      this.projectileActive = true;
    } else if (this.projectileActive) {
      call2(this.projectile, 'update', NO_PROJECTILES, time);
      this.projectileActive = false;
    }
  }

  // Whether some look draws in front of the obstacle line now.
  drawsFront(): boolean {
    for (const front of this.fronts) if (front.visible) return true;
    return this.projectileActive && this.projectile.value.passes.front?.visible === true;
  }

  inspect() {
    return Object.fromEntries([
      ...this.placed.map(({ name, look }) => [name, look.value.inspect === undefined ? null : call0(look, 'inspect') ?? null] as const),
      ['platform', this.platform.value.inspect === undefined ? null : call0(this.platform, 'inspect') ?? null] as const,
      ['projectile', this.projectile.value.inspect === undefined ? null : call0(this.projectile, 'inspect') ?? null] as const,
    ]);
  }

  dispose(): void {
    const disposal = new Disposal();
    for (const passes of this.passes()) {
      for (const pass of ['course', 'actors', 'front'] as const) disposal.run(() => passes[pass]?.removeFromParent());
    }
    for (const { look } of this.placed) disposal.run(() => call0(look, 'dispose'));
    disposal.run(() => call0(this.platform, 'dispose'));
    disposal.run(() => call0(this.projectile, 'dispose'));
    disposal.run(() => call0(this.enemies, 'dispose'));
    disposal.finish();
  }
}

// Playback creates a look only when needed, using the factory resolved by its phantom consumer.
export function createPhantomLook(factory: Attributed<PhantomLookFactory>, figures: number): Attributed<PhantomLook> {
  const create = factory.value;
  return createInstance(LOOK_CONTRACTS.phantoms, factory, () => create({ figures }));
}
