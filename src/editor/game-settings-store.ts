import { GameSettingsError, validateGameSettings } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { NamedSnapshots } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';

const profiles = new NamedSnapshots<GameSettings>({
  prefix: 'over-the-edge:game-settings:snapshot:v4:', version: 4, field: 'settings',
  label: 'game settings', namePrompt: 'Enter a game settings name',
  validate: validateGameSettings, isDataError: (error: unknown) => error instanceof GameSettingsError,
});

export interface SavedGameSettings {
  name: string;
  savedAt: number | null;
  settings: GameSettings;
}

export function isGameSettingsStorageKey(key: string | null): boolean {
  return profiles.isStorageKey(key);
}

export function listGameSettingsProfiles(storage: Storage): SnapshotEntry[] {
  return profiles.list(storage);
}

export function loadGameSettingsProfile(storage: Storage, key: string): SavedGameSettings {
  return profiles.read(storage, key);
}

export function saveGameSettingsProfile(storage: Storage, name: string, settings: Readonly<GameSettings>): SnapshotEntry {
  return profiles.save(storage, name, settings);
}
