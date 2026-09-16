const ID_BYTES = 16;
export const SNAPSHOT_NAME_LIMIT = 80;

export class SnapshotError extends Error {}

export interface SnapshotEntry {
  key: string;
  name: string;
  savedAt: number | null;
  error: string | null;
}

export interface NamedSnapshot<T> {
  name: string;
  savedAt: number;
  settings: T;
}

export function expectSnapshotFields(value: unknown, keys: readonly string[], label: string):
  asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new SnapshotError(`Saved ${label} is invalid: missing or unknown fields.`);
  }
}

export function readSnapshotJson(storage: Storage, key: string, label: string): unknown {
  const serialized = storage.getItem(key);
  if (serialized === null) throw new SnapshotError(`That saved ${label} is no longer available. Choose another save.`);
  try {
    return JSON.parse(serialized);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SnapshotError(`Saved ${label} is invalid: malformed JSON.`);
  }
}

export function sortSnapshots(entries: SnapshotEntry[]): SnapshotEntry[] {
  return entries.sort((a, b) => {
    const time = (b.savedAt ?? 0) - (a.savedAt ?? 0);
    return time !== 0 ? time : a.key.localeCompare(b.key);
  });
}

interface SnapshotOptions<T> {
  prefix: string;
  version: number;
  field: 'tuning' | 'settings' | 'level';
  label: string;
  namePrompt: string;
  validate: (value: unknown) => T;
  isDataError: (error: unknown) => boolean;
}

export class NamedSnapshots<T> {
  private readonly options: SnapshotOptions<T>;

  constructor(options: SnapshotOptions<T>) {
    this.options = options;
  }

  isStorageKey(key: string | null): boolean {
    return key === null || key.startsWith(this.options.prefix);
  }

  read(storage: Storage, key: string): NamedSnapshot<T> {
    const { prefix, version, field, label } = this.options;
    const id = key.slice(prefix.length);
    if (!key.startsWith(prefix) || id.length !== ID_BYTES * 2 || !/^[a-f0-9]+$/.test(id)) {
      throw new SnapshotError(`Saved ${label} is invalid: unknown snapshot key.`);
    }
    const record = readSnapshotJson(storage, key, label);
    expectSnapshotFields(record, ['schemaVersion', 'name', 'savedAt', field], label);
    if (record.schemaVersion !== version ||
      typeof record.savedAt !== 'number' || !Number.isSafeInteger(record.savedAt) ||
      record.savedAt < 0 || !Number.isFinite(new Date(record.savedAt).getTime())) {
      throw new SnapshotError(`Saved ${label} is invalid: unsupported version or timestamp.`);
    }
    return { name: this.name(record.name), savedAt: record.savedAt, settings: this.options.validate(record[field]) };
  }

  list(storage: Storage): SnapshotEntry[] {
    const keys = new Set<string>();
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(this.options.prefix)) keys.add(key);
    }
    return sortSnapshots([...keys].map((key): SnapshotEntry => {
      try {
        const { name, savedAt } = this.read(storage, key);
        return { key, name, savedAt, error: null };
      } catch (error) {
        if (!(error instanceof SnapshotError) && !this.options.isDataError(error)) throw error;
        if (!(error instanceof Error)) throw error;
        return { key, name: `Unreadable saved ${this.options.label}`, savedAt: null, error: error.message };
      }
    }));
  }

  save(storage: Storage, name: string, settings: Readonly<T>): SnapshotEntry {
    const record = {
      schemaVersion: this.options.version,
      name: this.name(name),
      savedAt: Date.now(),
      [this.options.field]: this.options.validate(settings),
    };
    const id = Array.from(crypto.getRandomValues(new Uint8Array(ID_BYTES)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const key = `${this.options.prefix}${id}`;
    if (storage.getItem(key) !== null) throw new SnapshotError('Could not create a unique save. Try saving again.');
    // Independent immutable keys keep simultaneous tab saves from overwriting a shared collection.
    storage.setItem(key, JSON.stringify(record));
    return { key, name: record.name, savedAt: record.savedAt, error: null };
  }

  private name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > SNAPSHOT_NAME_LIMIT) {
      throw new SnapshotError(`${this.options.namePrompt} between 1 and ${SNAPSHOT_NAME_LIMIT} characters.`);
    }
    return value.trim();
  }
}
