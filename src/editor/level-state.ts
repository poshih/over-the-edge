import {
  DECORATION_LIMITS, geometryKey, LEVEL_LIMITS, LevelError, levelStart, TRIGGER_LIMITS, validateLevel, validateLevelMetadata, validateLevelObject,
} from '../level';
import type { LevelChange, LevelDefinition, LevelObject, StartObject } from '../level';
import { ENEMY_LIMITS } from '../enemy-types';
import { HAZARD_LIMITS } from '../hazards';
import { LIQUID_LIMITS } from '../liquids';

// What each kind of object counts toward: projectile traps and swinging axes share the traps' limit.
const TALLIES = {
  terrain: { limit: LEVEL_LIMITS.objects, noun: 'terrain objects' },
  triggers: { limit: TRIGGER_LIMITS.objects, noun: 'triggers' },
  enemies: { limit: ENEMY_LIMITS.objects, noun: 'enemies' },
  decorations: { limit: DECORATION_LIMITS.objects, noun: 'decorations' },
  bonfires: { limit: HAZARD_LIMITS.bonfires, noun: 'bonfires' },
  traps: { limit: HAZARD_LIMITS.traps, noun: 'traps' },
  pools: { limit: LIQUID_LIMITS.pools, noun: 'liquid pools' },
} as const;
type Tally = keyof typeof TALLIES;
type Counts = Record<Tally, number>;

function tally(object: LevelObject): Tally | null {
  switch (object.kind) {
    case 'start': return null;
    case 'terrain': return 'terrain';
    case 'trigger': return 'triggers';
    case 'enemy': return 'enemies';
    case 'decoration': return 'decorations';
    case 'bonfire': return 'bonfires';
    case 'shooter': case 'axe': return 'traps';
    case 'pool': return 'pools';
  }
}

function emptyCounts(): Counts {
  return { terrain: 0, triggers: 0, enemies: 0, decorations: 0, bonfires: 0, traps: 0, pools: 0 };
}

function checkCounts(counts: Readonly<Counts>): void {
  for (const [name, { limit, noun }] of Object.entries(TALLIES)) {
    if (counts[name as Tally] > limit) throw new LevelError(`A level supports up to ${limit} ${noun}.`);
  }
}

export interface LevelBatchEdit {
  readonly add?: readonly unknown[];
  readonly remove?: readonly string[];
  /** Replacement label list; omit to keep the current labels untouched. */
  readonly labels?: readonly unknown[];
}

export class LevelState {
  private current: LevelDefinition;
  private objects: Map<string, LevelObject>;
  private startObject: StartObject;
  private tallies: Counts = emptyCounts();
  private readonly geometryUse = new Map<string, number>();
  private readonly listeners = new Set<(change: LevelChange) => void>();

  constructor(level: LevelDefinition) {
    this.current = validateLevel(level);
    this.objects = new Map(this.current.objects.map((object) => [object.id, object]));
    this.startObject = levelStart(this.current);
    this.indexObjects();
  }

  definition(): LevelDefinition {
    return this.current;
  }

  object(id: string): LevelObject {
    const object = this.objects.get(id);
    if (!object) throw new LevelError(`Object "${id}" no longer exists.`);
    return object;
  }

  start(): StartObject { return this.startObject; }

  counts(): Readonly<Counts> & { readonly total: number } {
    return { ...this.tallies, total: this.objects.size };
  }

  upsert(value: unknown): void {
    const object = validateLevelObject(value);
    const previous = this.objects.get(object.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(object)) return;
    if ((object.kind === 'start') !== (previous?.kind === 'start')) {
      throw new LevelError('A level needs one start location. Move the existing start instead of replacing or duplicating it.');
    }
    const counts = { ...this.tallies };
    const added = tally(object);
    const replaced = previous === undefined ? null : tally(previous);
    if (added !== null) counts[added]++;
    if (replaced !== null) counts[replaced]--;
    checkCounts(counts);
    const nextKey = object.kind === 'terrain' ? geometryKey(object) : null;
    const previousKey = previous?.kind === 'terrain' ? geometryKey(previous) : null;
    const freed = previousKey !== null && previousKey !== nextKey && this.geometryUse.get(previousKey) === 1;
    const kinds = this.geometryUse.size + (nextKey !== null && !this.geometryUse.has(nextKey) ? 1 : 0) - (freed ? 1 : 0);
    if (kinds > LEVEL_LIMITS.geometryKinds) {
      throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct terrain collision shapes.`);
    }
    if (previousKey !== null) this.removeGeometry(previousKey);
    if (nextKey !== null) this.addGeometry(nextKey);
    if (object.kind === 'start') this.startObject = object;
    this.tallies = counts;
    this.objects.set(object.id, object);
    this.publish({ ...this.current, objects: Object.freeze([...this.objects.values()]) }, [object], []);
  }

  remove(id: string): void {
    const object = this.object(id);
    if (object.kind === 'start') throw new LevelError('A level needs its start location. Move it instead of deleting it.');
    if (object.kind === 'terrain') this.removeGeometry(geometryKey(object));
    const removed = tally(object);
    if (removed !== null) this.tallies = { ...this.tallies, [removed]: this.tallies[removed] - 1 };
    this.objects.delete(id);
    this.publish({ ...this.current, objects: Object.freeze([...this.objects.values()]) }, [], [id]);
  }

  /**
   * Adds new objects, removes existing ones and optionally replaces labels as one atomic change.
   * Everything is validated before the level changes, and listeners receive a single edit.
   */
  edit(batch: LevelBatchEdit): readonly LevelObject[] {
    const added = (batch.add ?? []).map(validateLevelObject);
    const metadata = batch.labels === undefined ? null : validateLevelMetadata({ labels: batch.labels });
    const removed = new Map<string, LevelObject>();
    for (const id of batch.remove ?? []) {
      const object = this.object(id);
      if (object.kind === 'start') throw new LevelError('A level needs its start location. Move it instead of deleting it.');
      removed.set(id, object);
    }
    const ids = new Set<string>();
    for (const object of added) {
      if (object.kind === 'start') throw new LevelError('A level needs one start location. Move the existing start instead of adding another.');
      if (this.objects.has(object.id) || ids.has(object.id)) throw new LevelError('Every object needs a unique ID.');
      ids.add(object.id);
    }
    const geometry = new Map(this.geometryUse);
    const counts = { ...this.tallies };
    const count = (object: LevelObject, change: 1 | -1): void => {
      const name = tally(object);
      if (name !== null) counts[name] += change;
      if (object.kind !== 'terrain') return;
      const key = geometryKey(object);
      const next = (geometry.get(key) ?? 0) + change;
      if (next === 0) geometry.delete(key);
      else geometry.set(key, next);
    };
    for (const object of removed.values()) count(object, -1);
    for (const object of added) count(object, 1);
    checkCounts(counts);
    if (geometry.size > LEVEL_LIMITS.geometryKinds) {
      throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct terrain collision shapes.`);
    }
    const labels = metadata !== null && JSON.stringify(metadata.labels) !== JSON.stringify(this.current.labels)
      ? metadata.labels : this.current.labels;
    if (added.length === 0 && removed.size === 0 && labels === this.current.labels) return [];
    for (const id of removed.keys()) this.objects.delete(id);
    for (const object of added) this.objects.set(object.id, object);
    this.tallies = counts;
    this.geometryUse.clear();
    for (const [key, count] of geometry) this.geometryUse.set(key, count);
    this.publish({ ...this.current, labels, objects: Object.freeze([...this.objects.values()]) }, added, [...removed.keys()]);
    return added;
  }

  metadata(value: Pick<LevelDefinition, 'labels'>): void {
    const metadata = validateLevelMetadata(value);
    if (JSON.stringify(metadata.labels) === JSON.stringify(this.current.labels)) return;
    this.publish({ ...this.current, ...metadata }, [], []);
  }

  replace(value: unknown): void {
    const level = validateLevel(value);
    const next = new Map(level.objects.map((object) => [object.id, object]));
    const remove = [...this.objects.keys()].filter((id) => !next.has(id));
    const upsert = level.objects.filter((object) => JSON.stringify(this.objects.get(object.id)) !== JSON.stringify(object));
    this.objects = next;
    this.current = level;
    this.startObject = levelStart(level);
    this.indexObjects();
    this.emit({ kind: 'replace', level, upsert, remove });
  }

  /**
   * Adopts another version of this level as one incremental edit: only objects that differ are
   * upserted or removed, so an open playtest continues instead of restarting as it does for replace().
   */
  merge(value: unknown): void {
    const level = validateLevel(value);
    const next = new Map(level.objects.map((object) => [object.id, object]));
    const remove = [...this.objects.keys()].filter((id) => !next.has(id));
    const upsert = level.objects.filter((object) => JSON.stringify(this.objects.get(object.id)) !== JSON.stringify(object));
    if (remove.length === 0 && upsert.length === 0 && JSON.stringify(level.labels) === JSON.stringify(this.current.labels)) return;
    this.objects = next;
    this.current = level;
    this.startObject = levelStart(level);
    this.indexObjects();
    this.emit({ kind: 'edit', level, upsert, remove });
  }

  subscribe(listener: (change: LevelChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(level: LevelDefinition, upsert: readonly LevelObject[], remove: readonly string[]): void {
    this.current = Object.freeze(level);
    this.emit({ kind: 'edit', level: this.current, upsert, remove });
  }

  private emit(change: LevelChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private addGeometry(key: string): void {
    const count = this.geometryUse.get(key);
    this.geometryUse.set(key, count === undefined ? 1 : count + 1);
  }

  private indexObjects(): void {
    this.geometryUse.clear();
    this.tallies = emptyCounts();
    for (const object of this.objects.values()) {
      if (object.kind === 'terrain') this.addGeometry(geometryKey(object));
      const name = tally(object);
      if (name !== null) this.tallies[name]++;
    }
  }

  private removeGeometry(key: string): void {
    const count = this.geometryUse.get(key);
    if (count === undefined) throw new Error('Level geometry reference counts are inconsistent.');
    if (count === 1) this.geometryUse.delete(key);
    else this.geometryUse.set(key, count - 1);
  }
}
