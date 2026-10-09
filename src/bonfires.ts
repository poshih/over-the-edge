import { Box, DynamicTree, testOverlap } from 'planck';
import type { Fixture, TransformValue } from 'planck';
import { BONFIRE } from './hazards';
import { isBonfireObject } from './level';
import type { BonfireObject, LevelChange } from './level';

// A bonfire that burns: the run seconds the hammer lit it at, and those it goes out at, when the hammer can light it
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
  // Where its fire stands, centred above its base.
  readonly fire: TransformValue;
}

// A bonfire's fire about its centre: the hammer head lights the bonfire anywhere within.
const FIRE = new Box(BONFIRE.width / 2, BONFIRE.height / 2);

/**
 * The level's bonfires through a run. The hammer head lights one by passing through its fire fast enough; it burns a
 * while, then goes out, and only then can the hammer light it again. The one lit last is where a fallen player comes
 * back. An index of their fires finds those the head is in, if any.
 */
export class Bonfires {
  private readonly index = new DynamicTree<string>();
  private readonly records = new Map<string, Bonfire>();
  private readonly burning = new Map<string, BurningBonfire>();
  private listeners: readonly ((state: BonfireState) => void)[] = [];
  private current: string | null = null;
  // When the next burning bonfire goes out, in run seconds; Infinity while none burns.
  private nextOut = Infinity;
  // While a strike query runs: the hammer head and its centre, and the unlit bonfire nearest it whose fire it is in.
  private head: Fixture | null = null;
  private readonly headCentre = { x: 0, y: 0 };
  private struck: Bonfire | null = null;
  private struckDistance = Infinity;

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

  // After each step while the player lives, with the hammer head's fixture and its speed in m/s: lights the bonfire
  // nearest the head whose fire the head is in, unless it burns already or the head is slower than `strikeSpeed`, to
  // burn `burnTime` seconds from run time `time`. Returns the bonfire lit, or null.
  strike(head: Fixture, speed: number, strikeSpeed: number, burnTime: number, time: number): BonfireObject | null {
    if (this.burning.size === this.records.size || speed < strikeSpeed) return null;
    // Where the head swept through this step.
    const bounds = head.getAABB(0);
    this.headCentre.x = (bounds.lowerBound.x + bounds.upperBound.x) / 2;
    this.headCentre.y = (bounds.lowerBound.y + bounds.upperBound.y) / 2;
    this.head = head;
    this.struck = null;
    this.struckDistance = Infinity;
    try {
      this.index.query(bounds, this.visit);
    } finally {
      this.head = null;
    }
    const bonfire = this.struck;
    this.struck = null;
    if (bonfire === null) return null;
    const id = bonfire.object.id;
    this.burning.set(id, Object.freeze({ id, litAt: time, outAt: time + burnTime }));
    this.nextOut = Math.min(this.nextOut, time + burnTime);
    this.current = id;
    this.emit();
    return bonfire.object;
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
      lowerBound: { x: object.x - BONFIRE.width / 2, y: object.y },
      upperBound: { x: object.x + BONFIRE.width / 2, y: object.y + BONFIRE.height },
    }, object.id);
    this.records.set(object.id, { object, proxy, fire: { p: { x: object.x, y: object.y + BONFIRE.height / 2 }, q: { s: 0, c: 1 } } });
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

  private readonly visit = (node: number): boolean => {
    const record = this.records.get(this.index.getUserData(node));
    const head = this.head;
    if (record === undefined || head === null || this.burning.has(record.object.id)) return true;
    const distance = Math.hypot(this.headCentre.x - record.fire.p.x, this.headCentre.y - record.fire.p.y);
    if (distance < this.struckDistance && testOverlap(FIRE, 0, head.getShape(), 0, record.fire, head.getBody().getTransform())) {
      this.struck = record;
      this.struckDistance = distance;
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
