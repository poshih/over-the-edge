import {
  DECORATION_LIMITS, geometryKey, LEVEL_LIMITS, LevelError, levelStart, PLATFORM_LIMITS, TRIGGER_LIMITS,
  validateLevel, validateLevelLabels, validateLevelMetadata, validateLevelObject, validateTriggerTargets,
} from '../level';
import type { LevelChange, LevelDefinition, LevelLabel, LevelObject, StartObject, TriggerObject } from '../level';
import { NO_DECORATION_ART } from '../decoration-art';
import type { DecorationArt } from '../decoration-art';
import { unknownDecorationModels } from '../decoration-models';
import { ENEMY_LIMITS } from '../enemy-types';
import { HAZARD_LIMITS } from '../hazards';
import { LIQUID_LIMITS } from '../liquids';
import type { Command } from './document/history';
import type { ChangeCause, LevelDelta, ProjectDocument, SectionChange, StepInfo } from './document/project-document';

// What each kind of object counts toward: projectile traps and swinging axes share the traps' limit.
const TALLIES = {
  terrain: { limit: LEVEL_LIMITS.objects, noun: 'terrain objects' },
  triggers: { limit: TRIGGER_LIMITS.objects, noun: 'triggers' },
  enemies: { limit: ENEMY_LIMITS.objects, noun: 'enemies' },
  decorations: { limit: DECORATION_LIMITS.objects, noun: 'decorations' },
  bonfires: { limit: HAZARD_LIMITS.bonfires, noun: 'bonfires' },
  traps: { limit: HAZARD_LIMITS.traps, noun: 'traps' },
  pools: { limit: LIQUID_LIMITS.pools, noun: 'liquid pools' },
  platforms: { limit: PLATFORM_LIMITS.objects, noun: 'platforms' },
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
    case 'platform': return 'platforms';
  }
}

function emptyCounts(): Counts {
  return { terrain: 0, triggers: 0, enemies: 0, decorations: 0, bonfires: 0, traps: 0, pools: 0, platforms: 0 };
}

function checkCounts(counts: Readonly<Counts>): void {
  for (const [name, { limit, noun }] of Object.entries(TALLIES)) {
    if (counts[name as Tally] > limit) throw new LevelError(`A level supports up to ${limit} ${noun}.`);
  }
}

// Counts `object` into (1) or out of (-1) `counts` and `geometry`, the uses of each terrain collision shape.
function count(counts: Counts, geometry: Map<string, number>, object: LevelObject, change: 1 | -1): void {
  const name = tally(object);
  if (name !== null) counts[name] += change;
  if (object.kind !== 'terrain') return;
  const key = geometryKey(object);
  const uses = (geometry.get(key) ?? 0) + change;
  if (uses < 0) throw new Error('Level geometry reference counts are inconsistent.');
  if (uses === 0) geometry.delete(key);
  else geometry.set(key, uses);
}

function removeTriggerTargets(objects: Iterable<LevelObject>, removed: ReadonlySet<string>): TriggerObject[] {
  const upsert: TriggerObject[] = [];
  if (removed.size === 0) return upsert;
  for (const object of objects) {
    if (object.kind !== 'trigger' || removed.has(object.id)) continue;
    const events = object.events.filter((event) => event.type === 'fire-trap' ? !removed.has(event.trap)
      : event.type === 'move-platform' ? !removed.has(event.platform) : true);
    if (events.length !== object.events.length) {
      upsert.push(Object.freeze({ ...object, events: Object.freeze(events) }));
    }
  }
  return upsert;
}

// `labels`, or the level's own when they are equal, so unchanged labels keep their identity.
function keptLabels(labels: readonly LevelLabel[], level: LevelDefinition): readonly LevelLabel[] {
  return JSON.stringify(labels) === JSON.stringify(level.labels) ? level.labels : labels;
}

// The change from `before` to a frozen copy of it with `next`'s name, labels and objects.
function sectionChange(before: LevelDefinition, next: Pick<LevelDefinition, 'name' | 'labels' | 'objects'>,
  delta: LevelDelta): SectionChange<'level'> {
  const after = Object.freeze({ ...before, name: next.name, labels: next.labels, objects: next.objects });
  return { section: 'level', before, after, delta };
}

export interface LevelBatchEdit {
  readonly add?: readonly unknown[];
  readonly remove?: readonly string[];
  /** Replacement label list; omit to keep the current labels untouched. */
  readonly labels?: readonly unknown[];
}

export class LevelState {
  private readonly document: ProjectDocument;
  private readonly unsubscribe: () => void;
  private readonly objects = new Map<string, LevelObject>();
  private startObject: StartObject;
  private readonly tallies = emptyCounts();
  private readonly geometryUse = new Map<string, number>();
  // The course artwork whose models the level may place besides the decoration library's.
  private decorationArt: () => DecorationArt = () => NO_DECORATION_ART;

  // Follows the document's level: from each change's delta in O(changed), in full when a project opens. Construct it
  // before any other subscriber to the level, so its indexes are current when they hear a change.
  constructor(document: ProjectDocument) {
    this.document = document;
    this.startObject = this.index(document.get('level'));
    this.unsubscribe = document.subscribe('level', (change, cause) => this.follow(change, cause));
  }

  definition(): LevelDefinition {
    return this.document.get('level');
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

  /**
   * Keeps the level to decorations something draws: the decoration library's models and those `art` maps. Every change
   * that would place another is refused, as saves and releases refuse it.
   */
  drawDecorationsWith(art: () => DecorationArt): void {
    this.decorationArt = art;
  }

  /** Refuses decorations among `objects` whose model nothing draws, with the message a save gives. */
  checkDecorations(objects: readonly LevelObject[]): void {
    const unknown = unknownDecorationModels({ objects }, this.decorationArt());
    if (unknown.length > 0) throw new LevelError(unknown.slice(0, 8).join(' ') + (unknown.length > 8 ? ` (${unknown.length - 8} more)` : ''));
  }

  // Checks a whole level as replace() does, for a project to open with: the frozen definition, or throws LevelError.
  check(value: unknown): LevelDefinition {
    const level = validateLevel(value);
    this.checkDecorations(level.objects);
    return level;
  }

  // Change builders: each checks against the current level and returns the change it would make, or null when nothing
  // would change. They throw LevelError and change nothing, not even the indexes, which follow the document.
  upsert(value: unknown): SectionChange<'level'> | null {
    const object = validateLevelObject(value);
    const previous = this.objects.get(object.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(object)) return null;
    if (object.kind === 'decoration') this.checkDecorations([object]);
    if ((object.kind === 'start') !== (previous?.kind === 'start')) {
      throw new LevelError('A level needs one start location. Move the existing start instead of replacing or duplicating it.');
    }
    const lookup = (id: string): LevelObject | undefined => id === object.id ? object : this.objects.get(id);
    if (object.kind === 'trigger') validateTriggerTargets(object, lookup);
    if (previous !== undefined && previous.kind !== object.kind) {
      for (const trigger of this.definition().objects) {
        if (trigger.kind === 'trigger' && trigger.id !== object.id) validateTriggerTargets(trigger, lookup);
      }
    }
    this.checkLimits(previous === undefined ? [] : [previous], [object]);
    return this.change('edit', [object], []);
  }

  // Also strips the trigger events that target the object.
  remove(id: string): SectionChange<'level'> | null {
    const object = this.object(id);
    if (object.kind === 'start') throw new LevelError('A level needs its start location. Move it instead of deleting it.');
    const cleaned = object.kind === 'shooter' || object.kind === 'platform'
      ? removeTriggerTargets(this.definition().objects, new Set([id])) : [];
    return this.change('edit', cleaned, [id]);
  }

  /**
   * Adds new objects, removes existing ones and optionally replaces the labels, as one edit. Its added objects are the
   * upserts its delta has no previous object for.
   */
  edit(batch: LevelBatchEdit): SectionChange<'level'> | null {
    const level = this.definition();
    const added = (batch.add ?? []).map(validateLevelObject);
    this.checkDecorations(added);
    const replacedLabels = batch.labels === undefined ? null : validateLevelLabels(batch.labels);
    const removed = new Map<string, LevelObject>();
    for (const id of batch.remove ?? []) {
      const object = this.object(id);
      if (object.kind === 'start') throw new LevelError('A level needs its start location. Move it instead of deleting it.');
      removed.set(id, object);
    }
    const additions = new Map<string, LevelObject>();
    for (const object of added) {
      if (object.kind === 'start') throw new LevelError('A level needs one start location. Move the existing start instead of adding another.');
      if (this.objects.has(object.id) || additions.has(object.id)) throw new LevelError('Every object needs a unique ID.');
      additions.set(object.id, object);
    }
    const lookup = (id: string): LevelObject | undefined => additions.get(id) ?? (removed.has(id) ? undefined : this.objects.get(id));
    for (const object of added) if (object.kind === 'trigger') validateTriggerTargets(object, lookup);
    this.checkLimits(removed.values(), added);
    const labels = replacedLabels === null ? level.labels : keptLabels(replacedLabels, level);
    if (added.length === 0 && removed.size === 0 && labels === level.labels) return null;
    const cleaned = removeTriggerTargets(level.objects, new Set(removed.keys()));
    return this.change('edit', [...added, ...cleaned], [...removed.keys()], { name: level.name, labels });
  }

  // Renames the level or replaces its labels, as one edit; what `value` leaves out stays as it is.
  metadata(value: Partial<Pick<LevelDefinition, 'name' | 'labels'>>): SectionChange<'level'> | null {
    const level = this.definition();
    const metadata = validateLevelMetadata({ name: level.name, labels: level.labels, ...value });
    const labels = keptLabels(metadata.labels, level);
    if (metadata.name === level.name && labels === level.labels) return null;
    return this.change('edit', [], [], { name: metadata.name, labels });
  }

  // Another level in place of this one: the game restarts the run.
  replace(value: unknown): SectionChange<'level'> | null {
    return this.adopt('replace', value);
  }

  /**
   * Adopts another version of this level as one incremental edit: only objects that differ are
   * upserted or removed, so an open playtest continues instead of restarting as it does for replace().
   */
  merge(value: unknown): SectionChange<'level'> | null {
    return this.adopt('edit', value);
  }

  // A command whose run returns `build`'s change, or none for null.
  command(info: StepInfo & { readonly coalesce?: string | null },
    build: (level: LevelState) => SectionChange<'level'> | null): Command {
    return {
      label: info.label,
      place: info.place,
      coalesce: info.coalesce ?? null,
      run: () => {
        const change = build(this);
        return change === null ? [] : [change];
      },
    };
  }

  // Stops following the document.
  dispose(): void {
    this.unsubscribe();
  }

  private add(object: LevelObject): void {
    this.objects.set(object.id, object);
    count(this.tallies, this.geometryUse, object, 1);
  }

  // The change to the level `value` whole, in its own object order, keeping every current object JSON-equal to its
  // incoming one. A new order alone is a change with an empty delta.
  private adopt(kind: LevelDelta['kind'], value: unknown): SectionChange<'level'> | null {
    const level = this.check(value);
    const before = this.definition();
    const objects: LevelObject[] = [];
    const upsert: LevelObject[] = [];
    const previous = new Map<string, LevelObject>();
    for (const object of level.objects) {
      const current = this.objects.get(object.id);
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(object)) {
        objects.push(current);
        continue;
      }
      if (current !== undefined) previous.set(object.id, current);
      upsert.push(object);
      objects.push(object);
    }
    const ids = new Set(level.objects.map((object) => object.id));
    const remove: string[] = [];
    for (const object of before.objects) {
      if (ids.has(object.id)) continue;
      remove.push(object.id);
      previous.set(object.id, object);
    }
    const labels = keptLabels(level.labels, before);
    if (level.name === before.name && labels === before.labels && objects.length === before.objects.length &&
      objects.every((object, index) => object === before.objects[index])) return null;
    return sectionChange(before, { name: level.name, labels, objects: Object.freeze(objects) },
      { kind, upsert, remove, previous });
  }

  // The change to the current level with `upsert` in place of the objects of the same ID, the others following in the
  // order given, `remove` dropped, and `metadata`'s name and labels, else the current ones. Object order comes from the
  // level, never the index.
  private change(kind: LevelDelta['kind'], upsert: readonly LevelObject[], remove: readonly string[],
    metadata?: Pick<LevelDefinition, 'name' | 'labels'>): SectionChange<'level'> {
    const before = this.definition();
    const { name, labels } = metadata ?? before;
    const previous = new Map<string, LevelObject>();
    let objects = before.objects;
    if (upsert.length > 0 || remove.length > 0) {
      const replacements = new Map(upsert.map((object) => [object.id, object]));
      const removed = new Set(remove);
      const next: LevelObject[] = [];
      for (const object of before.objects) {
        const replacement = replacements.get(object.id);
        if (replacement !== undefined || removed.has(object.id)) previous.set(object.id, object);
        if (replacement !== undefined) next.push(replacement);
        else if (!removed.has(object.id)) next.push(object);
      }
      for (const object of upsert) if (!previous.has(object.id)) next.push(object);
      objects = Object.freeze(next);
    }
    return sectionChange(before, { name, labels, objects }, { kind, upsert, remove, previous });
  }

  // Refuses taking `removed` out and putting `added` in where the level would pass its limits.
  private checkLimits(removed: Iterable<LevelObject>, added: Iterable<LevelObject>): void {
    const counts = { ...this.tallies };
    const geometry = new Map(this.geometryUse);
    for (const object of removed) count(counts, geometry, object, -1);
    for (const object of added) count(counts, geometry, object, 1);
    checkCounts(counts);
    if (geometry.size > LEVEL_LIMITS.geometryKinds) {
      throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct terrain collision shapes.`);
    }
  }

  private follow(change: SectionChange<'level'>, cause: ChangeCause): void {
    if (cause === 'open') {
      this.startObject = this.index(change.after);
      return;
    }
    for (const id of change.delta.remove) {
      const object = this.objects.get(id);
      if (object === undefined) throw new Error(`Level object "${id}" is not indexed.`);
      this.objects.delete(id);
      count(this.tallies, this.geometryUse, object, -1);
    }
    for (const object of change.delta.upsert) {
      const replaced = this.objects.get(object.id);
      if (replaced !== undefined) count(this.tallies, this.geometryUse, replaced, -1);
      this.add(object);
      if (object.kind === 'start') this.startObject = object;
    }
  }

  // Indexes every object of `level` afresh and returns its start.
  private index(level: LevelDefinition): StartObject {
    this.objects.clear();
    this.geometryUse.clear();
    Object.assign(this.tallies, emptyCounts());
    for (const object of level.objects) this.add(object);
    return levelStart(level);
  }
}

// The game's LevelChange for a level section change.
export function levelChange(change: SectionChange<'level'>): LevelChange {
  const { kind, upsert, remove } = change.delta;
  return { kind, level: change.after, upsert, remove };
}
