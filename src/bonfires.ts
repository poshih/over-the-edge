import { DynamicTree } from 'planck';
import type { AABBValue } from 'planck';
import type { Point } from './config';
import { BONFIRE } from './hazards';
import { isBonfireObject } from './level';
import type { BonfireObject, LevelChange } from './level';

export interface BonfireState {
  // The bonfires reached this run, which burn.
  readonly lit: readonly string[];
  // The one reached last, where a fallen player comes back; null before any.
  readonly current: string | null;
}

interface Bonfire {
  readonly object: BonfireObject;
  readonly proxy: number;
}

/**
 * The level's bonfires through a run. Each lights when the player's foot comes within reach of its base, and the one
 * reached last is where a fallen player comes back. An index of their reach finds the one the player is at, if any.
 */
export class Bonfires {
  private readonly index = new DynamicTree<string>();
  private readonly records = new Map<string, Bonfire>();
  private readonly lit = new Set<string>();
  private readonly listeners = new Set<(state: BonfireState) => void>();
  private readonly query: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  private current: string | null = null;
  // The nearest bonfire in reach of `foot`, while a query runs.
  private readonly foot = { x: 0, y: 0 };
  private nearest: string | null = null;
  private nearestDistance = Infinity;

  constructor(objects: readonly BonfireObject[]) {
    for (const object of objects) this.add(object);
  }

  // The bonfire a fallen player comes back at, or null when none has been reached.
  currentBonfire(): BonfireObject | null {
    return this.current === null ? null : this.records.get(this.current)?.object ?? null;
  }

  // After each step, with the player's foot.
  update(foot: Readonly<Point>): BonfireObject | null {
    if (this.records.size === 0) return null;
    this.foot.x = foot.x;
    this.foot.y = foot.y;
    this.query.lowerBound.x = this.query.upperBound.x = foot.x;
    this.query.lowerBound.y = this.query.upperBound.y = foot.y;
    this.nearest = null;
    this.nearestDistance = Infinity;
    this.index.query(this.query, this.visit);
    if (this.nearest === null || this.nearest === this.current) return null;
    const bonfire = this.records.get(this.nearest);
    if (bonfire === undefined) throw new Error('The bonfire reach index is inconsistent.');
    this.current = this.nearest;
    this.lit.add(this.nearest);
    this.emit();
    return bonfire.object;
  }

  // A new run: every bonfire is out.
  reset(): void {
    if (this.current === null && this.lit.size === 0) return;
    this.lit.clear();
    this.current = null;
    this.emit();
  }

  apply(change: LevelChange): void {
    if (change.kind === 'replace') {
      for (const id of [...this.records.keys()]) this.remove(id);
      for (const object of change.level.objects) if (isBonfireObject(object)) this.add(object);
      this.lit.clear();
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
    // A bonfire that moved stays lit; one deleted, or turned into something else, goes out.
    for (const id of this.lit) if (!this.records.has(id)) this.lit.delete(id);
    if (this.current !== null && !this.records.has(this.current)) this.current = null;
    if (changed) this.emit();
  }

  // Calls `listener` with the state now and after every change. Returns its removal.
  subscribe(listener: (state: BonfireState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => { this.listeners.delete(listener); };
  }

  state(): BonfireState {
    return { lit: [...this.lit], current: this.current };
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) this.remove(id);
    this.listeners.clear();
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

  private readonly visit = (node: number): boolean => {
    const id = this.index.getUserData(node);
    const record = this.records.get(id);
    if (record === undefined) return true;
    const distance = Math.hypot(this.foot.x - record.object.x, this.foot.y - record.object.y);
    if (distance <= BONFIRE.reach && distance < this.nearestDistance) {
      this.nearest = id;
      this.nearestDistance = distance;
    }
    return true;
  };

  private emit(): void {
    const state = this.state();
    for (const listener of [...this.listeners]) listener(state);
  }
}
