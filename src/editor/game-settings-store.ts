import { DEFAULT_GAME_SETTINGS, GameSettingsError, validateGameSettings } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { NamedSnapshots, sortSnapshots } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';
import { isTuningStorageKey, listSavedTunings, loadSavedTuning } from './tuning-store';

const profileOptions = {
  field: 'settings' as const,
  label: 'game settings', namePrompt: 'Enter a game settings name',
  validate: validateGameSettings, isDataError: (error: unknown) => error instanceof GameSettingsError,
};
const profiles = new NamedSnapshots<GameSettings>({
  ...profileOptions, prefix: 'over-the-edge:game-settings:snapshot:v2:', version: 2,
});
const retiredProfiles = new NamedSnapshots<GameSettings>({
  ...profileOptions, prefix: 'over-the-edge:game-settings:snapshot:v1:', version: 1,
});

export interface SavedGameSettings {
  name: string;
  savedAt: number | null;
  settings: GameSettings;
}

export function isGameSettingsStorageKey(key: string | null): boolean {
  return profiles.isStorageKey(key) || retiredProfiles.isStorageKey(key) || isTuningStorageKey(key);
}

export function listGameSettingsProfiles(storage: Storage): SnapshotEntry[] {
  return sortSnapshots([
    ...profiles.list(storage),
    ...[...retiredProfiles.list(storage), ...listSavedTunings(storage)]
      .map((entry) => ({ ...entry, name: `${entry.name} (physics only)` })),
  ]);
}

export function loadGameSettingsProfile(storage: Storage, key: string): SavedGameSettings {
  if (profiles.isStorageKey(key)) return profiles.read(storage, key);
  if (retiredProfiles.isStorageKey(key)) {
    const saved = retiredProfiles.read(storage, key);
    return { ...saved, name: `${saved.name} (physics only)` };
  }
  const saved = loadSavedTuning(storage, key);
  return {
    name: `${saved.name} (physics only)`, savedAt: saved.savedAt,
    settings: validateGameSettings({ ...DEFAULT_GAME_SETTINGS, physics: saved.tuning }),
  };
}

export function saveGameSettingsProfile(storage: Storage, name: string, settings: Readonly<GameSettings>): SnapshotEntry {
  return profiles.save(storage, name, settings);
}
