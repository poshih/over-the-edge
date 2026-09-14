import { TUNING_FIELDS, TuningError, validateTuning } from './config';
import type { Tuning } from './config';

const SNAPSHOT_PREFIX = 'over-the-edge:tuning:snapshot:v3:';
const PREVIOUS_KEY = 'over-the-edge:tuning:v2';
const LEGACY_KEY = 'over-the-edge:tuning:v1';
const SNAPSHOT_VERSION = 3;
const ID_BYTES = 16;
export const TUNING_NAME_LIMIT = 80;
// Version 1 had fixed tool masses, independent of later tuning defaults.
const V1_TOOL_MASSES = { shaftMass: 0.66, hingeCarrierMass: 0.5, sliderCarriageMass: 0.5 } as const;

export class TuningHistoryError extends Error {}

export interface SavedTuning {
  name: string;
  savedAt: number | null;
  tuning: Tuning;
}

export interface TuningHistoryEntry {
  key: string;
  name: string;
  savedAt: number | null;
  error: string | null;
}

function expectFields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TuningHistoryError('Saved tuning is invalid: missing or unknown fields.');
  }
}

function tuningName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > TUNING_NAME_LIMIT) {
    throw new TuningHistoryError(`Enter a tuning name between 1 and ${TUNING_NAME_LIMIT} characters.`);
  }
  return value.trim();
}

export function isTuningStorageKey(key: string | null): boolean {
  return key === null || key === PREVIOUS_KEY || key === LEGACY_KEY || key.startsWith(SNAPSHOT_PREFIX);
}

export function loadSavedTuning(storage: Storage, key: string): SavedTuning {
  const previous = key === PREVIOUS_KEY || key === LEGACY_KEY;
  const id = key.slice(SNAPSHOT_PREFIX.length);
  if (!previous && (!key.startsWith(SNAPSHOT_PREFIX) || id.length !== ID_BYTES * 2 || !/^[a-f0-9]+$/.test(id))) {
    throw new TuningHistoryError('Saved tuning is invalid: unknown snapshot key.');
  }
  const serialized = storage.getItem(key);
  if (serialized === null) throw new TuningHistoryError('That saved tuning is no longer available. Choose another save.');
  let record: unknown;
  try {
    record = JSON.parse(serialized);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new TuningHistoryError('Saved tuning is invalid: malformed JSON.');
  }
  if (previous) {
    const version = key === PREVIOUS_KEY ? 2 : 1;
    expectFields(record, ['schemaVersion', 'tuning']);
    if (record.schemaVersion !== version) throw new TuningHistoryError(`Saved tuning is invalid: expected version ${version}.`);
    let settings = record.tuning;
    if (version === 1) {
      const legacyKeys = TUNING_FIELDS.map((field) => field.key)
        .filter((field) => !Object.hasOwn(V1_TOOL_MASSES, field));
      expectFields(settings, legacyKeys);
      settings = { ...settings, ...V1_TOOL_MASSES };
    }
    return { name: `Previous saved tuning (v${version})`, savedAt: null, tuning: validateTuning(settings) };
  }
  expectFields(record, ['schemaVersion', 'name', 'savedAt', 'tuning']);
  if (record.schemaVersion !== SNAPSHOT_VERSION ||
    typeof record.savedAt !== 'number' || !Number.isSafeInteger(record.savedAt) ||
    record.savedAt < 0 || !Number.isFinite(new Date(record.savedAt).getTime())) {
    throw new TuningHistoryError('Saved tuning is invalid: unsupported version or timestamp.');
  }
  return { name: tuningName(record.name), savedAt: record.savedAt, tuning: validateTuning(record.tuning) };
}

export function listSavedTunings(storage: Storage): TuningHistoryEntry[] {
  const keys = new Set<string>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(SNAPSHOT_PREFIX)) keys.add(key);
  }
  if (storage.getItem(PREVIOUS_KEY) !== null) keys.add(PREVIOUS_KEY);
  else if (storage.getItem(LEGACY_KEY) !== null) keys.add(LEGACY_KEY);
  const entries = [...keys].map((key): TuningHistoryEntry => {
    try {
      const { name, savedAt } = loadSavedTuning(storage, key);
      return { key, name, savedAt, error: null };
    } catch (error) {
      if (!(error instanceof TuningError) && !(error instanceof TuningHistoryError)) throw error;
      return { key, name: 'Unreadable saved tuning', savedAt: null, error: error.message };
    }
  });
  return entries.sort((a, b) => {
    const time = (b.savedAt ?? 0) - (a.savedAt ?? 0);
    return time !== 0 ? time : a.key.localeCompare(b.key);
  });
}

export function saveTuningSnapshot(storage: Storage, name: string, tuning: Readonly<Tuning>): TuningHistoryEntry {
  const record = {
    schemaVersion: SNAPSHOT_VERSION,
    name: tuningName(name),
    savedAt: Date.now(),
    tuning: validateTuning(tuning),
  };
  const id = Array.from(crypto.getRandomValues(new Uint8Array(ID_BYTES)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `${SNAPSHOT_PREFIX}${id}`;
  if (storage.getItem(key) !== null) throw new TuningHistoryError('Could not create a unique save. Try saving again.');
  // One immutable key per save avoids read/modify/write races between tabs.
  storage.setItem(key, JSON.stringify(record));
  return { key, name: record.name, savedAt: record.savedAt, error: null };
}
