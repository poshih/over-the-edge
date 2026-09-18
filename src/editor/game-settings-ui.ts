import { GAME_SETTINGS_LIMITS, GameSettingsError, validateGameSettings } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { element } from '../dom';
import { createJsonDownload } from './json-download';
import { SnapshotError } from './named-snapshots';
import { createSnapshotPicker } from './snapshot-picker';
import {
  isGameSettingsStorageKey, listGameSettingsProfiles, loadGameSettingsProfile, saveGameSettingsProfile,
} from './game-settings-store';
import type { SavedGameSettings } from './game-settings-store';

interface GameSettingsUiOptions {
  mount: HTMLElement;
  signal: AbortSignal;
  getSettings: () => GameSettings;
  onLoad: (settings: GameSettings) => void;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export function createGameSettingsUI(options: GameSettingsUiOptions): void {
  function report(error: unknown, action: 'save' | 'load' | 'import' | 'export'): void {
    if (error instanceof DOMException) {
      options.onNotice(action === 'save'
        ? 'Game settings could not be saved. Device storage may be full or blocked; existing saves and live settings are unchanged.'
        : 'The file or device storage is unavailable. Your live settings are unchanged.', 'error');
    } else if (error instanceof GameSettingsError || error instanceof SnapshotError) {
      options.onNotice(`${error.message} Existing saves and live settings were left unchanged.`, 'error');
    } else {
      throw error;
    }
  }

  const picker = createSnapshotPicker({
    mount: options.mount, signal: options.signal, id: 'game-settings', noun: 'game settings', plural: 'game settings',
    placeholder: 'e.g. Steady hammer', isStorageKey: isGameSettingsStorageKey, onNotice: options.onNotice,
    list: () => listGameSettingsProfiles(localStorage),
    save: (name) => {
      try {
        return saveGameSettingsProfile(localStorage, name, options.getSettings());
      } catch (error) {
        report(error, 'save');
        return null;
      }
    },
    load: (key) => {
      let saved: SavedGameSettings;
      try {
        saved = loadGameSettingsProfile(localStorage, key);
      } catch (error) {
        report(error, 'load');
        return null;
      }
      options.onLoad(saved.settings);
      return saved;
    },
  });
  element(options.mount, '.snapshot-history-help').textContent =
    'Profiles include physics and cursor settings. Older tuning saves load as physics-only profiles with default cursor settings. Loading is manual.';
  const exchange = document.createElement('div');
  exchange.className = 'game-settings-exchange';
  exchange.innerHTML = `
    <button type="button" class="button settings-export">Export settings JSON</button>
    <button type="button" class="button settings-import">Import settings JSON</button>
    <input type="file" class="settings-file" accept=".json,application/json" hidden />
  `;
  options.mount.append(exchange);
  const importButton = element<HTMLButtonElement>(exchange, '.settings-import');
  const exportButton = element<HTMLButtonElement>(exchange, '.settings-export');
  const fileInput = element<HTMLInputElement>(exchange, '.settings-file');
  const download = createJsonDownload({ mount: options.mount, signal: options.signal });
  const listen = { signal: options.signal };
  let generation = 0;
  options.signal.addEventListener('abort', () => { generation++; }, { once: true });

  function setImporting(busy: boolean): void {
    picker.setDisabled(busy);
    importButton.disabled = busy;
    exportButton.disabled = busy;
  }

  async function importFile(file: File): Promise<void> {
    const request = ++generation;
    const previous = options.getSettings();
    if (file.size > GAME_SETTINGS_LIMITS.fileBytes) {
      setImporting(false);
      report(new GameSettingsError(`Game settings JSON must be at most ${GAME_SETTINGS_LIMITS.fileBytes / 1024} KiB.`), 'import');
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new GameSettingsError('Game settings JSON is malformed.');
      }
      const settings = validateGameSettings(value);
      if (options.signal.aborted || request !== generation) return;
      if (options.getSettings() !== previous) {
        options.onNotice('Settings changed while the file was being read. The import was canceled; choose the file again to replace them.', 'info');
        return;
      }
      options.onLoad(settings);
      options.onNotice('Imported game settings. Saved profiles were kept; save a named profile to retain these settings in this browser.', 'info');
    } catch (error) {
      if (!options.signal.aborted && request === generation) report(error, 'import');
      else if (!(error instanceof GameSettingsError) && !(error instanceof DOMException)) throw error;
    } finally {
      if (!options.signal.aborted && request === generation) setImporting(false);
    }
  }

  importButton.addEventListener('click', () => fileInput.click(), listen);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file !== undefined) void importFile(file);
  }, listen);
  exportButton.addEventListener('click', () => {
    try {
      download('game-settings.json', `${JSON.stringify(validateGameSettings(options.getSettings()), null, 2)}\n`);
      options.onNotice('Exported game-settings.json. Select this file with GAME_SETTINGS when building the game.', 'info');
    } catch (error) {
      report(error, 'export');
    }
  }, listen);
}
