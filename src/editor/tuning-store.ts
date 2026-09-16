import { TUNING_FIELDS, TuningError, validateTuning } from './tuning-schema';
import type { Tuning } from '../config';
import { expectSnapshotFields, NamedSnapshots, readSnapshotJson, SnapshotError, sortSnapshots } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';

const PREVIOUS_KEY = 'over-the-edge:tuning:v2';
const LEGACY_KEY = 'over-the-edge:tuning:v1';
const snapshots = new NamedSnapshots({
  prefix: 'over-the-edge:tuning:snapshot:v3:', version: 3, field: 'tuning', label: 'tuning',
  namePrompt: 'Enter a tuning name', validate: validateTuning, isDataError: (error) => error instanceof TuningError,
});
// Version 1 had fixed tool masses, independent of later tuning defaults.
const V1_TOOL_MASSES = { shaftMass: 0.66, hingeCarrierMass: 0.5, sliderCarriageMass: 0.5 } as const;

export { SnapshotError as TuningHistoryError } from './named-snapshots';
export type TuningHistoryEntry = SnapshotEntry;

export interface SavedTuning {
  name: string;
  savedAt: number | null;
  tuning: Tuning;
}

export function isTuningStorageKey(key: string | null): boolean {
  return key === PREVIOUS_KEY || key === LEGACY_KEY || snapshots.isStorageKey(key);
}

export function loadSavedTuning(storage: Storage, key: string): SavedTuning {
  if (key === PREVIOUS_KEY || key === LEGACY_KEY) {
    const record = readSnapshotJson(storage, key, 'tuning');
    const version = key === PREVIOUS_KEY ? 2 : 1;
    expectSnapshotFields(record, ['schemaVersion', 'tuning'], 'tuning');
    if (record.schemaVersion !== version) throw new SnapshotError(`Saved tuning is invalid: expected version ${version}.`);
    let settings = record.tuning;
    if (version === 1) {
      const legacyKeys = TUNING_FIELDS.map((field) => field.key)
        .filter((field) => !Object.hasOwn(V1_TOOL_MASSES, field));
      expectSnapshotFields(settings, legacyKeys, 'tuning');
      settings = { ...settings, ...V1_TOOL_MASSES };
    }
    return { name: `Previous saved tuning (v${version})`, savedAt: null, tuning: validateTuning(settings) };
  }
  const { name, savedAt, settings } = snapshots.read(storage, key);
  return { name, savedAt, tuning: settings };
}

export function listSavedTunings(storage: Storage): TuningHistoryEntry[] {
  const entries = snapshots.list(storage);
  let key: string | null = null;
  if (storage.getItem(PREVIOUS_KEY) !== null) key = PREVIOUS_KEY;
  else if (storage.getItem(LEGACY_KEY) !== null) key = LEGACY_KEY;
  if (key !== null) {
    try {
      const { name, savedAt } = loadSavedTuning(storage, key);
      entries.push({ key, name, savedAt, error: null });
    } catch (error) {
      if (!(error instanceof TuningError) && !(error instanceof SnapshotError)) throw error;
      entries.push({ key, name: 'Unreadable saved tuning', savedAt: null, error: error.message });
    }
  }
  return sortSnapshots(entries);
}

export function saveTuningSnapshot(storage: Storage, name: string, tuning: Readonly<Tuning>): TuningHistoryEntry {
  return snapshots.save(storage, name, tuning);
}
