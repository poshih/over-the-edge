import { TUNING_FIELDS, GameSettingsError, validateTuning } from '../game-settings';
import type { Tuning } from '../config';
import { expectSnapshotFields, NamedSnapshots, readSnapshotJson, SnapshotError, sortSnapshots } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';

const PREVIOUS_KEY = 'over-the-edge:tuning:v2';
const LEGACY_KEY = 'over-the-edge:tuning:v1';
const snapshots = tuningHistory(4, validateTuning);
const previousSnapshots = tuningHistory(3, (value) => migrateLegacyTuning(value, 3));
// Version 1 had fixed tool masses, independent of later tuning defaults.
const V1_TOOL_MASSES = { shaftMass: 0.66, hingeCarrierMass: 0.5, sliderCarriageMass: 0.5 } as const;
const RETIRED_CURSOR_SETTING = { key: 'cursorRelaxation', min: 0, max: 24 } as const;

export type TuningHistoryEntry = SnapshotEntry;

export interface SavedTuning {
  name: string;
  savedAt: number | null;
  tuning: Tuning;
}

function tuningHistory(version: 3 | 4, validate: (value: unknown) => Tuning): NamedSnapshots<Tuning> {
  return new NamedSnapshots({
    prefix: `over-the-edge:tuning:snapshot:v${version}:`, version, field: 'tuning', label: 'tuning',
    namePrompt: 'Enter a tuning name', validate, isDataError: (error) => error instanceof GameSettingsError,
  });
}

function migrateLegacyTuning(value: unknown, version: 1 | 2 | 3): Tuning {
  const keys = [...TUNING_FIELDS.map((field) => field.key), RETIRED_CURSOR_SETTING.key]
    .filter((key) => version !== 1 || !Object.hasOwn(V1_TOOL_MASSES, key));
  expectSnapshotFields(value, keys, 'tuning');
  const retired = value[RETIRED_CURSOR_SETTING.key];
  if (typeof retired !== 'number' || !Number.isFinite(retired) ||
    retired < RETIRED_CURSOR_SETTING.min || retired > RETIRED_CURSOR_SETTING.max) {
    throw new GameSettingsError(`Saved cursor settling must be between ${RETIRED_CURSOR_SETTING.min} and ${RETIRED_CURSOR_SETTING.max}.`);
  }
  const current = { ...value };
  if (version === 1) Object.assign(current, V1_TOOL_MASSES);
  delete current[RETIRED_CURSOR_SETTING.key];
  return validateTuning(current);
}

export function isTuningStorageKey(key: string | null): boolean {
  return key === PREVIOUS_KEY || key === LEGACY_KEY || snapshots.isStorageKey(key) || previousSnapshots.isStorageKey(key);
}

export function loadSavedTuning(storage: Storage, key: string): SavedTuning {
  if (key === PREVIOUS_KEY || key === LEGACY_KEY) {
    const record = readSnapshotJson(storage, key, 'tuning');
    const version = key === PREVIOUS_KEY ? 2 : 1;
    expectSnapshotFields(record, ['schemaVersion', 'tuning'], 'tuning');
    if (record.schemaVersion !== version) throw new SnapshotError(`Saved tuning is invalid: expected version ${version}.`);
    return { name: `Previous saved tuning (v${version})`, savedAt: null, tuning: migrateLegacyTuning(record.tuning, version) };
  }
  const history = previousSnapshots.isStorageKey(key) ? previousSnapshots : snapshots;
  const { name, savedAt, settings } = history.read(storage, key);
  return { name, savedAt, tuning: settings };
}

export function listSavedTunings(storage: Storage): TuningHistoryEntry[] {
  const entries = [...snapshots.list(storage), ...previousSnapshots.list(storage)];
  let key: string | null = null;
  if (storage.getItem(PREVIOUS_KEY) !== null) key = PREVIOUS_KEY;
  else if (storage.getItem(LEGACY_KEY) !== null) key = LEGACY_KEY;
  if (key !== null) {
    try {
      const { name, savedAt } = loadSavedTuning(storage, key);
      entries.push({ key, name, savedAt, error: null });
    } catch (error) {
      if (!(error instanceof GameSettingsError) && !(error instanceof SnapshotError)) throw error;
      entries.push({ key, name: 'Unreadable saved tuning', savedAt: null, error: error.message });
    }
  }
  return sortSnapshots(entries);
}
