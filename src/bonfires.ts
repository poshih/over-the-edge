import { DynamicTree } from 'planck';
import type { AABBValue } from 'planck';
import type { Point } from './config';
import { BONFIRE } from './hazards';
import { isBonfireObject } from './level';
import type { BonfireObject, LevelChange } from './level';

// A bonfire that burns: the run seconds the player lit it at, and those it goes out at, when reaching it lights it
// again.
export interface BurningBonfire {
  readonly id: string;
  readonly litAt: number;
  readonly outAt: number;
}

export interface BonfireState {
  // The bonfires that burn now.
  readonly burning: readonly BurningBonfire[];
  // The one lit last, burning or not, where a fallen player comes back; null before any.
  readonly current: string | null;
}

interface Bonfire {
  readonly object: BonfireObject;
  readonly proxy: number;
}

/**
 * The level's bonfires through a run. The player's foot lights one as it comes within reach of its base; it burns a
 * while, then goes out, and only then does coming within reach again light it. The one lit last is where a fallen
 * player comes back. An index of their reach finds the one the foot is at, if any.
 */
export class Bonfires {
  private readonly index = new DynamicTree<string>();
  private readonly records = new Map<string, Bonfire>();
  private readonly burning = new Map<string, BurningBonfire>();
  private listeners: readonly ((state: BonfireState) => void)[] = [];
  private current: string | null = null;
  // When the next burning bonfire goes out, in run seconds; Infinity while none burns.
  private nextOut = Infinity;
  // The bonfire whose reach the foot was in at the last step, or null: one lights only as the foot comes into its reach,
  // so standing at a bonfire lights it once, not again each time it goes out.
  private reached: string | null = null;
  // While a reach query runs: the foot, and the bonfire nearest it within reach.
  private readonly query: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  private readonly foot = { x: 0, y: 0 };
  private nearest: Bonfire | null = null;
  private nearestDistance = Infinity;

  constructor(objects: readonly BonfireObject[]) {
    for (const object of objects) this.add(object);
  }

  // The bonfire a fallen player comes back at, or null when none has been lit.
  currentBonfire(): BonfireObject | null {
    return this.current === null ? null : this.records.get(this.current)?.object ?? null;
  }

  // After each step, alive or dying, at run time `time`: puts out every bonfire whose time is up.
  advance(time: number): void {
    if (time < this.nextOut) return;
    for (const [id, fire] of this.burning) if (fire.outAt <= time) this.burning.delete(id);
    this.schedule();
    this.emit();
  }

  // After each step while the player lives, with their foot, the jar's base: lights the bonfire the foot has just come
  // within reach of, unless it burns already, to burn `burnTime` seconds from run time `time`. Returns the bonfire lit,
  // or null. While the foot stays within reach of the bonfire it was at, it reaches no other, even where their reaches
  // overlap.
  touch(foot: Readonly<Point>, burnTime: number, time: number): BonfireObject | null {
    const at = this.reached === null ? undefined : this.records.get(this.reached);
    if (at !== undefined && Math.hypot(foot.x - at.object.x, foot.y - at.object.y) <= BONFIRE.reach) return null;
    const bonfire = this.nearestTo(foot);
    this.reached = bonfire === null ? null : bonfire.object.id;
    if (bonfire === null || this.burning.has(bonfire.object.id)) return null;
    const id = bonfire.object.id;
    this.burning.set(id, Object.freeze({ id, litAt: time, outAt: time + burnTime }));
    this.nextOut = Math.min(this.nextOut, time + burnTime);
    this.current = id;
    this.emit();
    return bonfire.object;
  }

  // A player placed anew with their foot at `foot` is already at any bonfire within reach there, so it lights only once
  // they leave its reach and come back: returning at a bonfire after a death lights none.
  place(foot: Readonly<Point>): void {
    const bonfire = this.nearestTo(foot);
    this.reached = bonfire === null ? null : bonfire.object.id;
  }

  // A new run: every bonfire is out, and none has been lit.
  reset(): void {
    if (this.current === null && this.burning.size === 0) return;
    this.burning.clear();
    this.nextOut = Infinity;
    this.current = null;
    this.emit();
  }

  // A resumed run's bonfire, out: where a fallen player comes back. An ID the level does not have restores none.
  restore(id: string | null): void {
    const current = id !== null && this.records.has(id) ? id : null;
    if (current === this.current) return;
    this.current = current;
    this.emit();
  }

  apply(change: LevelChange): void {
    if (change.kind === 'replace') {
      for (const id of [...this.records.keys()]) this.remove(id);
      for (const object of change.level.objects) if (isBonfireObject(object)) this.add(object);
      this.burning.clear();
      this.nextOut = Infinity;
      this.current = null;
      this.reached = null;
      this.emit();
      return;
    }
    let changed = false;
    for (const id of [...change.remove, ...change.upsert.map((object) => object.id)]) {
      if (!this.records.has(id)) continue;
      this.remove(id);
      changed = true;
    }
    for (const object of change.upsert) {
      if (!isBonfireObject(object)) continue;
      this.add(object);
      changed = true;
    }
    // A bonfire that moved burns on; one deleted, or turned into something else, goes out.
    for (const id of this.burning.keys()) if (!this.records.has(id)) this.burning.delete(id);
    this.schedule();
    if (this.current !== null && !this.records.has(this.current)) this.current = null;
    if (this.reached !== null && !this.records.has(this.reached)) this.reached = null;
    if (changed) this.emit();
  }

  // Calls `listener` with the state now and after every change. Returns its removal.
  subscribe(listener: (state: BonfireState) => void): () => void {
    if (!this.listeners.includes(listener)) this.listeners = [...this.listeners, listener];
    listener(this.state());
    return () => {
      if (this.listeners.includes(listener)) this.listeners = this.listeners.filter(registered => registered !== listener);
    };
  }

  state(): BonfireState {
    return { burning: Object.freeze([...this.burning.values()]), current: this.current };
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) this.remove(id);
    this.listeners = [];
  }

  private add(object: BonfireObject): void {
    const proxy = this.index.createProxy({
      lowerBound: { x: object.x - BONFIRE.reach, y: object.y - BONFIRE.reach },
      upperBound: { x: object.x + BONFIRE.reach, y: object.y + BONFIRE.reach },
    }, object.id);
    this.records.set(object.id, { object, proxy });
  }

  private remove(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.index.destroyProxy(record.proxy);
    this.records.delete(id);
  }

  private schedule(): void {
    this.nextOut = Infinity;
    for (const fire of this.burning.values()) this.nextOut = Math.min(this.nextOut, fire.outAt);
  }

  // The bonfire nearest `foot` within reach of its base, or null.
  private nearestTo(foot: Readonly<Point>): Bonfire | null {
    if (this.records.size === 0) return null;
    this.foot.x = foot.x;
    this.foot.y = foot.y;
    this.query.lowerBound.x = this.query.upperBound.x = foot.x;
    this.query.lowerBound.y = this.query.upperBound.y = foot.y;
    this.nearest = null;
    this.nearestDistance = Infinity;
    this.index.query(this.query, this.visit);
    const nearest = this.nearest;
    this.nearest = null;
    return nearest;
  }

  private readonly visit = (node: number): boolean => {
    const record = this.records.get(this.index.getUserData(node));
    if (record === undefined) return true;
    const distance = Math.hypot(this.foot.x - record.object.x, this.foot.y - record.object.y);
    if (distance <= BONFIRE.reach && distance < this.nearestDistance) {
      this.nearest = record;
      this.nearestDistance = distance;
    }
    return true;
  };

  private emit(): void {
    if (this.listeners.length === 0) return;
    const state = this.state();
    const listeners = this.listeners;
    for (let index = 0; index < listeners.length; index++) listeners[index]!(state);
  }
}
