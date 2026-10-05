import type { Object3D } from 'three';
import { AxeView } from './axe-view';
import { BonfireView } from './bonfire-view';
import { FlagView } from './flag-view';
import type { ProjectilePose } from './hazard-world';
import type { AxeObject, BonfireObject, LevelObject, PoolObject, ShooterObject, TriggerObject } from './level';
import { PoolView } from './pool-view';
import { ProjectileView, ShooterView } from './shooter-view';
import { UpdraftView } from './updraft-view';

// How the level's objects of each kind look, and the contract a game's module (GAME_MODULE) replaces any of them with:
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
  // Called every frame with the run's time, in seconds; draw only what changed.
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
  // Called every frame with the projectiles in flight, each with its tip at its position and flying along its angle.
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
export const LOOKS = ['flag', 'updraft', 'bonfire', 'shooter', 'projectile', 'axe', 'lava', 'swamp'] as const satisfies readonly LookName[];

// The looks a game draws its own way; the others keep the engine's.
export type Looks = Readonly<Partial<ObjectLooks>>;

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

// The looks a game's module supplies, checked where the module is loaded: only the engine's looks, each a factory, or
// undefined for the engine's. A factory may be a method of the object, its own or inherited; it is called on its object.
export function validateLooks(value: unknown): Looks {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`The game's module must supply looks as an object of look factories: ${LOOKS.join(', ')}.`);
  }
  for (const name of Object.keys(value)) {
    if (!(LOOKS as readonly string[]).includes(name)) {
      throw new TypeError(`The game's module supplies looks.${name}, but the looks are ${LOOKS.join(', ')}.`);
    }
  }
  const looks: Partial<Record<LookName, () => unknown>> = {};
  for (const name of LOOKS) {
    const factory: unknown = Reflect.get(value, name);
    if (factory === undefined) continue;
    if (typeof factory !== 'function') throw new TypeError(`The game's module must supply looks.${name} as a look factory.`);
    looks[name] = () => Reflect.apply(factory, value, []);
  }
  return Object.freeze(looks as Looks);
}

// Builds `name`'s look, checking what the factory returns.
function create<L>(name: LookName, factory: () => L): L {
  const look: unknown = factory();
  const method = (key: string): boolean => typeof Reflect.get(look as object, key) === 'function';
  const passes: unknown = typeof look === 'object' && look !== null ? Reflect.get(look, 'passes') : undefined;
  const valid = typeof passes === 'object' && passes !== null &&
    (['course', 'actors', 'front'] as const).every((pass) => {
      const group: unknown = Reflect.get(passes, pass);
      return group === undefined || (typeof group === 'object' && group !== null && Reflect.get(group, 'isObject3D') === true);
    }) &&
    method('update') && method('dispose') && (name === 'projectile' || method('set')) && (name !== 'bonfire' || method('setLit'));
  if (!valid) {
    throw new TypeError(`The ${name} look must return its passes, as three.js objects, and ${
      name === 'projectile' ? 'update and dispose' : name === 'bonfire' ? 'set, setLit, update and dispose' : 'set, update and dispose'}.`);
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

/**
 * The looks of the level's objects in one view: the game's own where its module supplies them, the engine's otherwise.
 * Each gets its kind's objects when the level loads and again only when one of them changes.
 */
export class LevelLooks {
  private readonly placed: readonly Placed[];
  private readonly bonfire: BonfireLook;
  private readonly projectile: ProjectileLook;
  private readonly fronts: readonly Object3D[];

  constructor(looks: Looks, objects: readonly LevelObject[]) {
    const factories: ObjectLooks = { ...DEFAULT_LOOKS, ...looks };
    this.bonfire = create('bonfire', factories.bonfire);
    this.projectile = create('projectile', factories.projectile);
    this.placed = (['flag', 'updraft', 'bonfire', 'shooter', 'axe', 'lava', 'swamp'] as const).map((name): Placed => {
      const factory: () => ObjectLook<LevelObject> = factories[name];
      return { name, look: name === 'bonfire' ? this.bonfire : create(name, factory), objects: null };
    });
    this.fronts = this.passes().flatMap(({ front }) => front === undefined ? [] : [front]);
    this.setLevel(objects);
  }

  // Every look's passes, for the view to add to its own.
  passes(): readonly LookPasses[] {
    return [...this.placed.map(({ look }) => look.passes), this.projectile.passes];
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
  }

  setLit(ids: readonly string[]): void {
    this.bonfire.setLit(ids);
  }

  update(time: number, projectiles: readonly ProjectilePose[]): void {
    for (const { look } of this.placed) look.update(time);
    this.projectile.update(projectiles, time);
  }

  // Whether some look draws in front of the obstacle line now.
  drawsFront(): boolean {
    for (const front of this.fronts) if (front.visible) return true;
    return false;
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
