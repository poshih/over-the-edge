import type { Object3D } from 'three';
import { AxeView } from './axe-view';
import { BonfireView } from './bonfire-view';
import { FlagView } from './flag-view';
import type { ProjectilePose } from './hazard-world';
import type { AxeObject, BonfireObject, LevelObject, PoolObject, ShooterObject, TriggerObject } from './level';
import { PoolView } from './pool-view';
import { ProjectileView, ShooterView } from './shooter-view';
import { UpdraftView } from './updraft-view';
import { PluginError, slotPoint } from './plugins/kernel';
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

export interface ProjectileLook {
  readonly passes: LookPasses;
  // Called every frame while the level has shooters or projectiles fly, plus one final empty update when both end.
  // Each projectile has its tip at its position and flies along its angle.
  update(projectiles: readonly ProjectilePose[], time: number): void;
  dispose(): void;
  inspect?(): unknown;
}

export interface ObjectLooks {
  // Triggers marked with a flag, and with an updraft.
  readonly flag: () => ObjectLook<TriggerObject>;
  readonly updraft: () => ObjectLook<TriggerObject>;
  readonly bonfire: () => BonfireLook;
  readonly shooter: () => ObjectLook<ShooterObject>;
  readonly projectile: () => ProjectileLook;
  readonly axe: () => ObjectLook<AxeObject>;
  // Pools of lava, and of swamp.
  readonly lava: () => ObjectLook<PoolObject>;
  readonly swamp: () => ObjectLook<PoolObject>;
}
export type LookName = keyof ObjectLooks;

function lookFactory<T extends () => unknown>(value: unknown): T {
  if (typeof value !== 'function') throw new TypeError('An object look must be a factory.');
  return value as T;
}

export const LOOKS = Object.freeze({
  flag: slotPoint('looks.flag', 'runtime', lookFactory<ObjectLooks['flag']>),
  updraft: slotPoint('looks.updraft', 'runtime', lookFactory<ObjectLooks['updraft']>),
  bonfire: slotPoint('looks.bonfire', 'runtime', lookFactory<ObjectLooks['bonfire']>),
  shooter: slotPoint('looks.shooter', 'runtime', lookFactory<ObjectLooks['shooter']>),
  projectile: slotPoint('looks.projectile', 'runtime', lookFactory<ObjectLooks['projectile']>),
  axe: slotPoint('looks.axe', 'runtime', lookFactory<ObjectLooks['axe']>),
  lava: slotPoint('looks.lava', 'runtime', lookFactory<ObjectLooks['lava']>),
  swamp: slotPoint('looks.swamp', 'runtime', lookFactory<ObjectLooks['swamp']>),
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

// The engine's looks. A game may wrap one to add to it rather than draw it anew.
export const DEFAULT_LOOKS: ObjectLooks = Object.freeze({
  flag: () => viewLook<TriggerObject>(new FlagView()),
  updraft: () => viewLook<TriggerObject>(new UpdraftView()),
  bonfire: (): BonfireLook => {
    const view = new BonfireView();
    return { ...viewLook<BonfireObject>(view), setLit: (ids) => view.setLit(ids) };
  },
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
});

// The level objects each look draws.
const SELECTED: Readonly<Record<Exclude<LookName, 'projectile'>, (object: LevelObject) => boolean>> = {
  flag: (object) => object.kind === 'trigger' && object.marker === 'flag',
  updraft: (object) => object.kind === 'trigger' && object.marker === 'updraft',
  bonfire: (object) => object.kind === 'bonfire',
  shooter: (object) => object.kind === 'shooter',
  axe: (object) => object.kind === 'axe',
  lava: (object) => object.kind === 'pool' && object.liquid === 'lava',
  swamp: (object) => object.kind === 'pool' && object.liquid === 'swamp',
};

// Builds `name`'s look, checking what the factory returns.
function create<L>(name: LookName, factory: () => L, plugins: RuntimePlugins): L {
  const point = LOOKS[name];
  const plugin = plugins.owner(point);
  let look: unknown;
  try { look = factory(); } catch (error) {
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${point.id}".`, plugin, point.id, { cause: error });
  }
  const method = (key: string): boolean => typeof Reflect.get(look as object, key) === 'function';
  const passes: unknown = typeof look === 'object' && look !== null ? Reflect.get(look, 'passes') : undefined;
  const valid = typeof passes === 'object' && passes !== null &&
    (['course', 'actors', 'front'] as const).every((pass) => {
      const group: unknown = Reflect.get(passes, pass);
      return group === undefined || (typeof group === 'object' && group !== null && Reflect.get(group, 'isObject3D') === true);
    }) &&
    method('update') && method('dispose') && (name === 'projectile' || method('set')) && (name !== 'bonfire' || method('setLit'));
  if (!valid) {
    throw new PluginError('invalid-contribution', `Plugin "${plugin ?? 'engine'}": the ${name} look must return its passes, as three.js objects, and ${
      name === 'projectile' ? 'update and dispose' : name === 'bonfire' ? 'set, setLit, update and dispose' : 'set, update and dispose'}.`, plugin, point.id);
  }
  return look as L;
}

function sameObjects(a: readonly LevelObject[], b: readonly LevelObject[]): boolean {
  return a.length === b.length && a.every((object, index) => object === b[index]);
}

interface Placed {
  readonly name: Exclude<LookName, 'projectile'>;
  readonly look: ObjectLook<LevelObject>;
  // The objects it was last given; null before the level loads.
  objects: readonly LevelObject[] | null;
}
const NO_PROJECTILES: readonly ProjectilePose[] = Object.freeze([]);

/**
 * The looks of the level's objects in one view, composed once from the runtime session.
 * Each gets its kind's objects when the level loads and again only when one of them changes.
 */
export class LevelLooks {
  private readonly placed: readonly Placed[];
  private readonly bonfire: BonfireLook;
  private readonly projectile: ProjectileLook;
  private readonly passList: readonly LookPasses[];
  private fronts: readonly Object3D[] = [];
  private active: readonly Placed[] = [];
  private hasShooters = false;
  private projectileActive = false;

  constructor(plugins: RuntimePlugins, objects: readonly LevelObject[]) {
    const factories: ObjectLooks = {
      flag: plugins.slot(LOOKS.flag, DEFAULT_LOOKS.flag),
      updraft: plugins.slot(LOOKS.updraft, DEFAULT_LOOKS.updraft),
      bonfire: plugins.slot(LOOKS.bonfire, DEFAULT_LOOKS.bonfire),
      shooter: plugins.slot(LOOKS.shooter, DEFAULT_LOOKS.shooter),
      projectile: plugins.slot(LOOKS.projectile, DEFAULT_LOOKS.projectile),
      axe: plugins.slot(LOOKS.axe, DEFAULT_LOOKS.axe),
      lava: plugins.slot(LOOKS.lava, DEFAULT_LOOKS.lava),
      swamp: plugins.slot(LOOKS.swamp, DEFAULT_LOOKS.swamp),
    };
    const created: { dispose(): void }[] = [];
    const build = <L extends { dispose(): void }>(name: LookName, factory: () => L): L => {
      const look = create(name, factory, plugins);
      created.push(look);
      return look;
    };
    try {
      this.bonfire = build('bonfire', factories.bonfire);
      this.projectile = build('projectile', factories.projectile);
      this.placed = (['flag', 'updraft', 'bonfire', 'shooter', 'axe', 'lava', 'swamp'] as const).map((name): Placed => {
        const factory: () => ObjectLook<LevelObject> = factories[name];
        return { name, look: name === 'bonfire' ? this.bonfire : build(name, factory), objects: null };
      });
      this.passList = Object.freeze([...this.placed.map(({ look }) => look.passes), this.projectile.passes]);
      this.setLevel(objects);
    } catch (error) {
      for (let index = created.length - 1; index >= 0; index--) created[index]!.dispose();
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
      placed.look.set(next);
    }
    this.active = this.placed.filter(placed => placed.objects!.length > 0);
    this.hasShooters = this.active.some(placed => placed.name === 'shooter');
    const passes = this.active.map(({ look }) => look.passes);
    this.fronts = passes.flatMap(({ front }) => front === undefined ? [] : [front]);
  }

  setLit(ids: readonly string[]): void {
    this.bonfire.setLit(ids);
  }

  update(time: number, projectiles: readonly ProjectilePose[]): void {
    for (const { look } of this.active) look.update(time);
    if (this.hasShooters || projectiles.length > 0) {
      this.projectile.update(projectiles, time);
      this.projectileActive = true;
    } else if (this.projectileActive) {
      this.projectile.update(NO_PROJECTILES, time);
      this.projectileActive = false;
    }
  }

  // Whether some look draws in front of the obstacle line now.
  drawsFront(): boolean {
    for (const front of this.fronts) if (front.visible) return true;
    return this.projectileActive && this.projectile.passes.front?.visible === true;
  }

  inspect() {
    return Object.fromEntries([
      ...this.placed.map(({ name, look }) => [name, look.inspect?.() ?? null] as const),
      ['projectile', this.projectile.inspect?.() ?? null] as const,
    ]);
  }

  dispose(): void {
    for (const passes of this.passes()) {
      for (const group of [passes.course, passes.actors, passes.front]) group?.removeFromParent();
    }
    for (const { look } of this.placed) look.dispose();
    this.projectile.dispose();
  }
}
