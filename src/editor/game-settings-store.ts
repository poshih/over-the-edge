import { DEFAULT_GAME_SETTINGS, GameSettingsError, validateGameSettings } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { NamedSnapshots, sortSnapshots } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';
import { isTuningStorageKey, listSavedTunings, loadSavedTuning } from './tuning-store';

const profiles = new NamedSnapshots<GameSettings>({
  prefix: 'over-the-edge:game-settings:snapshot:v1:', version: 1, field: 'settings',
  label: 'game settings', namePrompt: 'Enter a game settings name',
  validate: validateGameSettings, isDataError: (error) => error instanceof GameSettingsError,
});

export interface SavedGameSettings {
  name: string;
  savedAt: number | null;
  settings: GameSettings;
}

export function isGameSettingsStorageKey(key: string | null): boolean {
  return profiles.isStorageKey(key) || isTuningStorageKey(key);
}

export function listGameSettingsProfiles(storage: Storage): SnapshotEntry[] {
  return sortSnapshots([
    ...profiles.list(storage),
    ...listSavedTunings(storage).map((entry) => ({ ...entry, name: `${entry.name} (physics only)` })),
  ]);
}

export function loadGameSettingsProfile(storage: Storage, key: string): SavedGameSettings {
  if (profiles.isStorageKey(key)) return profiles.read(storage, key);
  const saved = loadSavedTuning(storage, key);
  return {
    name: `${saved.name} (physics only)`, savedAt: saved.savedAt,
    settings: validateGameSettings({ ...DEFAULT_GAME_SETTINGS, physics: saved.tuning }),
  };
}

export function saveGameSettingsProfile(storage: Storage, name: string, settings: Readonly<GameSettings>): SnapshotEntry {
  return profiles.save(storage, name, settings);
}
