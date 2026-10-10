import { LevelError } from '../../level';
import type { LevelDefinition, LevelObject } from '../../level';
import type { LevelDelta, SectionChange, SectionName, SectionValue } from './project-document';

export interface SectionAdapter<S extends SectionName> {
  readonly refusal: abstract new (...args: never[]) => Error;
  change(before: SectionValue<S>, after: SectionValue<S>): SectionChange<S>;
  invert(change: SectionChange<S>): SectionChange<S>;
  compose(first: SectionChange<S>, next: SectionChange<S>): SectionChange<S> | null;
  bytes(change: SectionChange<S>): number;
}

function levelChange(before: LevelDefinition, after: LevelDefinition, delta: LevelDelta): SectionChange<'level'> {
  return Object.freeze({
    section: 'level', before, after,
    delta: Object.freeze({ ...delta, upsert: Object.freeze(delta.upsert), remove: Object.freeze(delta.remove) }),
  });
}

function valueBytes(value: unknown, counterpart: unknown): number {
  if (value === counterpart) return 0;
  if (typeof value === 'string') return 16 + 2 * value.length;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const other: readonly unknown[] | null = Array.isArray(counterpart) ? counterpart : null;
    let bytes = 16 + 8 * items.length;
    for (let index = 0; index < items.length; index++) bytes += valueBytes(items[index], other?.[index]);
    return bytes;
  }
  if (typeof value !== 'object') throw new Error('Level values must contain only plain data.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('Level values must contain only plain data.');
  const keys = Reflect.ownKeys(value);
  const other = counterpart !== null && typeof counterpart === 'object' ? counterpart : null;
  let bytes = 32 + 8 * keys.length;
  for (const key of keys) {
    bytes += valueBytes(Reflect.get(value, key), other === null ? undefined : Reflect.get(other, key));
  }
  return bytes;
}

export const LEVEL_ADAPTER: SectionAdapter<'level'> = Object.freeze({
  refusal: LevelError,
  change(before: LevelDefinition, after: LevelDefinition): SectionChange<'level'> {
    const previous = new Map<string, LevelObject>();
    for (const object of before.objects) previous.set(object.id, object);
    const upsert: LevelObject[] = [];
    const updated = new Set<string>();
    for (const object of after.objects) {
      if (previous.get(object.id) === object) previous.delete(object.id);
      else {
        upsert.push(object);
        updated.add(object.id);
      }
    }
    const remove: string[] = [];
    for (const id of previous.keys()) if (!updated.has(id)) remove.push(id);
    return levelChange(before, after, { kind: 'replace', upsert, remove, previous });
  },
  invert(change: SectionChange<'level'>): SectionChange<'level'> {
    const previous = new Map<string, LevelObject>();
    const remove: string[] = [];
    for (const object of change.delta.upsert) {
      previous.set(object.id, object);
      if (!change.delta.previous.has(object.id)) remove.push(object.id);
    }
    return levelChange(change.after, change.before, {
      kind: change.delta.kind, upsert: [...change.delta.previous.values()], remove, previous,
    });
  },
  compose(first: SectionChange<'level'>, next: SectionChange<'level'>): SectionChange<'level'> | null {
    if (first.after !== next.before) throw new Error('Section changes must compose in order.');
    if (first.before === next.after) return null;
    const edits = new Map<string, { readonly original: LevelObject | undefined; final: LevelObject | undefined }>();
    for (const object of first.delta.upsert) {
      edits.set(object.id, { original: first.delta.previous.get(object.id), final: object });
    }
    for (const id of first.delta.remove) edits.set(id, { original: first.delta.previous.get(id), final: undefined });
    for (const object of next.delta.upsert) {
      const edit = edits.get(object.id);
      if (edit !== undefined) edit.final = object;
      else edits.set(object.id, { original: next.delta.previous.get(object.id), final: object });
    }
    for (const id of next.delta.remove) {
      const edit = edits.get(id);
      if (edit !== undefined) edit.final = undefined;
      else edits.set(id, { original: next.delta.previous.get(id), final: undefined });
    }
    const upsert: LevelObject[] = [];
    const remove: string[] = [];
    const previous = new Map<string, LevelObject>();
    for (const [id, { original, final }] of edits) {
      if (original === final) continue;
      if (original !== undefined) previous.set(id, original);
      if (final === undefined) remove.push(id);
      else upsert.push(final);
    }
    return levelChange(first.before, next.after, {
      kind: first.delta.kind === 'replace' || next.delta.kind === 'replace' ? 'replace' : 'edit',
      upsert, remove, previous,
    });
  },
  bytes(change: SectionChange<'level'>): number {
    let bytes = 8 * change.after.objects.length;
    const upserted = new Set<string>();
    for (const object of change.delta.upsert) {
      upserted.add(object.id);
      const previous = change.delta.previous.get(object.id);
      bytes += valueBytes(object, previous);
      if (previous !== undefined) bytes += valueBytes(previous, object);
    }
    for (const [id, object] of change.delta.previous) {
      if (!upserted.has(id)) bytes += valueBytes(object, undefined);
    }
    if (change.before.labels !== change.after.labels) {
      bytes += valueBytes(change.after.labels, change.before.labels) + valueBytes(change.before.labels, change.after.labels);
    }
    return bytes;
  },
});

export const SECTION_ADAPTERS: { readonly [S in SectionName]: SectionAdapter<S> } = Object.freeze({
  level: LEVEL_ADAPTER,
});
