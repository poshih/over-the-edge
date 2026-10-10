import { GameSettingsError } from '../../game-settings';
import { LevelError } from '../../level';
import type { LevelDefinition, LevelObject } from '../../level';
import { ModelError as AppearanceError } from '../../model-data';
import { PART_ROLES } from '../../model-library';
import { pluginOfSection } from '../../plugin-data';
import { PluginError } from '../../plugins/kernel';
import { ProjectError } from '../../project';
import type { SpriteDocument } from '../../sprite-data';
import { SpriteError } from '../../sprite-fields';
import type { FileHandle } from './files';
import type {
  BuiltinDocumentSectionName, DocumentAppearance, DocumentArt, DocumentMedia, DocumentModels, FrozenPluginData, LevelDelta,
  PluginSectionName, SectionChange, SectionName, SectionValue, WholeSectionName,
} from './project-document';

export type RefusalClass = abstract new (...args: never[]) => Error;

export interface SectionAdapter<S extends SectionName> {
  readonly refusal: RefusalClass;
  change(before: SectionValue<S>, after: SectionValue<S>): SectionChange<S>;
  invert(change: SectionChange<S>): SectionChange<S>;
  compose(first: SectionChange<S>, next: SectionChange<S>): SectionChange<S> | null;
  bytes(change: SectionChange<S>): number;
  files(value: SectionValue<S>): readonly FileHandle[];
}

export interface PluginAdapterFamily {
  readonly refusal: RefusalClass;
  for(section: PluginSectionName): SectionAdapter<PluginSectionName>;
}

export interface SectionAdapters {
  readonly builtin: { readonly [S in BuiltinDocumentSectionName]: SectionAdapter<S> };
  readonly plugins: PluginAdapterFamily;
}

const NO_FILES: readonly FileHandle[] = Object.freeze([]);

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
  if (typeof value !== 'object') throw new Error('Project values must contain only plain data.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('Project values must contain only plain data.');
  const keys = Reflect.ownKeys(value);
  const other = counterpart !== null && typeof counterpart === 'object' ? counterpart : null;
  let bytes = 32 + 8 * keys.length;
  for (const key of keys) {
    bytes += valueBytes(Reflect.get(value, key), other === null ? undefined : Reflect.get(other, key));
  }
  return bytes;
}

export function wholeValueAdapter<S extends WholeSectionName>(
  section: S,
  refusal: RefusalClass,
  estimate: (change: SectionChange<S>) => number,
  files: (value: SectionValue<S>) => readonly FileHandle[],
): SectionAdapter<S> {
  const change = (before: SectionValue<S>, after: SectionValue<S>): SectionChange<S> =>
    Object.freeze({ section, before, after, delta: null }) as SectionChange<S>;
  return Object.freeze({
    refusal,
    change,
    invert(value: SectionChange<S>): SectionChange<S> { return change(value.after, value.before); },
    compose(first: SectionChange<S>, next: SectionChange<S>): SectionChange<S> | null {
      if (first.after !== next.before) throw new Error('Section changes must compose in order.');
      return first.before === next.after ? null : change(first.before, next.after);
    },
    bytes(value: SectionChange<S>): number { return value.before === value.after ? 0 : estimate(value); },
    files,
  });
}

function wholeBytes<S extends WholeSectionName>(change: SectionChange<S>): number {
  return valueBytes(change.before, change.after) + valueBytes(change.after, change.before);
}

function artValueBytes(value: DocumentArt, other: DocumentArt): number {
  if (value === other) return 0;
  let bytes = 32 + valueBytes(value.decorations, other.decorations);
  if (value.assets !== other.assets) {
    bytes += 16 + 8 * value.assets.length;
    const previous = new Map(other.assets.map((asset) => [asset.id, asset]));
    for (const asset of value.assets) {
      if (asset !== previous.get(asset.id)) bytes += 48 + 2 * (asset.id.length + asset.name.length);
    }
  }
  return bytes;
}

function mediaValueBytes(value: DocumentMedia, other: DocumentMedia): number {
  if (value === other) return 0;
  let bytes = 16 + 8 * value.length;
  const previous = new Map(other.map((item) => [item.path, item]));
  for (const item of value) {
    if (item !== previous.get(item.path)) bytes += 32 + 2 * item.path.length;
  }
  return bytes;
}

function modelValueBytes(value: DocumentModels, other: DocumentModels): number {
  if (value === other) return 0;
  let bytes = 48;
  for (const role of PART_ROLES) {
    const items = value[role];
    const previousItems = other[role];
    if (items === previousItems) continue;
    bytes += 16 + 8 * items.length;
    const previous = new Map(previousItems.map((item) => [item.entry.id, item]));
    for (const item of items) {
      const counterpart = previous.get(item.entry.id);
      if (item !== counterpart) bytes += 32 + valueBytes(item.entry, counterpart?.entry);
    }
  }
  return bytes;
}

// Matched by ID, so a removal or reorder never charges unchanged entries, or their embedded sources, again.
const KEYED_SPRITE_LISTS: ReadonlySet<string> = new Set(['images', 'layers', 'models']);

function spriteValueBytes(value: SpriteDocument | null, other: SpriteDocument | null): number {
  if (value === other) return 0;
  if (value === null) return 8;
  const keys = Object.keys(value) as (keyof SpriteDocument)[];
  let bytes = 32 + 8 * keys.length;
  for (const key of keys) {
    const item: unknown = value[key];
    const counterpart: unknown = other?.[key];
    if (item === counterpart) continue;
    if (!KEYED_SPRITE_LISTS.has(key) || !Array.isArray(item)) {
      bytes += valueBytes(item, counterpart);
      continue;
    }
    const previous = new Map<string, unknown>();
    if (Array.isArray(counterpart)) for (const entry of counterpart as readonly { readonly id: string }[]) previous.set(entry.id, entry);
    bytes += 16 + 8 * item.length;
    for (const entry of item as readonly { readonly id: string }[]) bytes += valueBytes(entry, previous.get(entry.id));
  }
  return bytes;
}

// The primary and alternate characters: a scrub's step holds its changed branch, never the profile's sources.
function spriteBytes(change: { readonly before: SpriteDocument | null; readonly after: SpriteDocument | null }): number {
  return spriteValueBytes(change.before, change.after) + spriteValueBytes(change.after, change.before);
}

// Part metadata only: the history charges a step's files itself.
function appearanceValueBytes(value: DocumentAppearance, other: DocumentAppearance): number {
  if (value === other) return 0;
  let bytes = 16 + 8 * value.length;
  const previous = new Map(other.map((entry) => [entry.part, entry]));
  for (const entry of value) {
    const counterpart = previous.get(entry.part);
    if (entry !== counterpart) bytes += 64 + 2 * entry.name.length + valueBytes(entry.alignment, counterpart?.alignment);
  }
  return bytes;
}

function pluginAdapter(section: PluginSectionName): SectionAdapter<PluginSectionName> {
  if (pluginOfSection(section) === null) throw new Error(`Unknown project section "${section}".`);
  const change = (before: FrozenPluginData | null, after: FrozenPluginData | null): SectionChange<PluginSectionName> =>
    Object.freeze({ section, before, after, delta: null });
  return Object.freeze({
    refusal: PluginError,
    change,
    invert(value: SectionChange<PluginSectionName>): SectionChange<PluginSectionName> { return change(value.after, value.before); },
    compose(first: SectionChange<PluginSectionName>, next: SectionChange<PluginSectionName>): SectionChange<PluginSectionName> | null {
      if (first.after !== next.before) throw new Error('Section changes must compose in order.');
      return first.before === next.after ? null : change(first.before, next.after);
    },
    bytes(value: SectionChange<PluginSectionName>): number {
      if (value.before === value.after) return 0;
      return 32 + (value.before?.data === value.after?.data ? 0 : (value.before?.bytes ?? 0) + (value.after?.bytes ?? 0));
    },
    files: () => NO_FILES,
  });
}

export const LEVEL_ADAPTER: SectionAdapter<'level'> = Object.freeze({
  refusal: LevelError,
  change(before: LevelDefinition, after: LevelDefinition): SectionChange<'level'> {
    if (before === after) {
      return levelChange(before, after, { kind: 'replace', upsert: [], remove: [], previous: new Map() });
    }
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
  files: () => NO_FILES,
});

export const SECTION_ADAPTERS: SectionAdapters = Object.freeze({
  builtin: Object.freeze({
    level: LEVEL_ADAPTER,
    title: wholeValueAdapter('title', ProjectError, wholeBytes, () => NO_FILES),
    settings: wholeValueAdapter('settings', GameSettingsError, wholeBytes, () => NO_FILES),
    theme: wholeValueAdapter('theme', ProjectError, wholeBytes, () => NO_FILES),
    hud: wholeValueAdapter('hud', ProjectError, wholeBytes, () => NO_FILES),
    audio: wholeValueAdapter('audio', ProjectError, wholeBytes, () => NO_FILES),
    enemies: wholeValueAdapter('enemies', ProjectError, wholeBytes, () => NO_FILES),
    'characters/primary': wholeValueAdapter('characters/primary', SpriteError, spriteBytes, () => NO_FILES),
    'characters/alternate': wholeValueAdapter('characters/alternate', SpriteError, spriteBytes, () => NO_FILES),
    art: wholeValueAdapter('art', ProjectError,
      (change) => artValueBytes(change.before, change.after) + artValueBytes(change.after, change.before),
      (value) => value.assets.map((asset) => asset.file)),
    media: wholeValueAdapter('media', ProjectError,
      (change) => mediaValueBytes(change.before, change.after) + mediaValueBytes(change.after, change.before),
      (value) => value.map((item) => item.file)),
    models: wholeValueAdapter('models', ProjectError,
      (change) => modelValueBytes(change.before, change.after) + modelValueBytes(change.after, change.before),
      (value) => PART_ROLES.flatMap((role) => value[role].map((item) => item.file))),
    'arm-ik': wholeValueAdapter('arm-ik', AppearanceError, wholeBytes, () => NO_FILES),
    // Parts can share one GLB.
    appearance: wholeValueAdapter('appearance', AppearanceError,
      (change) => appearanceValueBytes(change.before, change.after) + appearanceValueBytes(change.after, change.before),
      (value) => [...new Set(value.map((entry) => entry.file))]),
  }),
  plugins: Object.freeze({ refusal: PluginError, for: pluginAdapter }),
});

export function adapterFor<S extends SectionName>(section: S): SectionAdapter<S> {
  if (Object.hasOwn(SECTION_ADAPTERS.builtin, section)) {
    return SECTION_ADAPTERS.builtin[section as BuiltinDocumentSectionName] as SectionAdapter<S>;
  }
  if (pluginOfSection(section) !== null) return SECTION_ADAPTERS.plugins.for(section as PluginSectionName) as SectionAdapter<S>;
  throw new Error(`Unknown project section "${section}".`);
}
