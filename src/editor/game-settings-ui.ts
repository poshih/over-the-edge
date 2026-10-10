import { GameSettingsError, validateGameSettings } from '../game-settings';
import type { GameSettings } from '../game-settings';
import { element } from '../dom';
import type { History } from './document/history';
import type { StepPlace } from './document/project-document';
import { applyProjectCommand } from './document/project-commands';
import type { ProjectCommands } from './document/project-commands';
import type { EditOutcome, ProjectImports } from './document/project-imports';
import { createJsonDownload } from './json-download';
import { SnapshotError } from './named-snapshots';
import { createProjectSaveButton } from './project-save';
import type { ProjectSaveTarget } from './project-save';
import type { ServerCopies } from './server-copies';
import { createServerCopyPicker } from './server-copy-picker';
import { createSnapshotPicker } from './snapshot-picker';
import {
  isGameSettingsStorageKey, listGameSettingsProfiles, loadGameSettingsProfile, saveGameSettingsProfile,
} from './game-settings-store';
import type { SavedGameSettings } from './game-settings-store';

export interface GameSettingsUiOptions {
  mount: HTMLElement;
  // Where the settings shared on the server are listed.
  serverMount: HTMLElement;
  signal: AbortSignal;
  // The project's game settings: each load is a step, and a file or server copy is a pending edit while it is read.
  history: History;
  commands: ProjectCommands;
  imports: ProjectImports;
  onNotice: (message: string, kind: 'info' | 'error') => void;
  projectSave: ProjectSaveTarget;
  serverCopies: ServerCopies;
}

export function createGameSettingsUI(options: GameSettingsUiOptions): void {
  const settings = (): GameSettings => options.history.document.get('settings');
  const place = (section: string): StepPlace => ({ tab: 'physics', section, select: null });

  // A load the project refused leaves everything as it was.
  function refused(error: Error): void {
    options.onNotice(`${error.message} Existing saves and live settings were left unchanged.`, 'error');
  }

  function report(error: unknown, action: 'save' | 'load' | 'export'): void {
    if (error instanceof DOMException) {
      options.onNotice(action === 'save'
        ? 'Game settings could not be saved. Device storage may be full or blocked; existing saves and live settings are unchanged.'
        : 'The file or device storage is unavailable. Your live settings are unchanged.', 'error');
    } else if (error instanceof GameSettingsError || error instanceof SnapshotError) {
      refused(error);
    } else {
      throw error;
    }
  }

  const picker = createSnapshotPicker({
    mount: options.mount, signal: options.signal, id: 'game-settings', noun: 'game settings', plural: 'game settings',
    placeholder: 'e.g. Steady hammer', heading: false, isStorageKey: isGameSettingsStorageKey, onNotice: options.onNotice,
    actions: [createProjectSaveButton({ target: options.projectSave, sections: ['settings'], label: 'the game settings', signal: options.signal })],
    list: () => listGameSettingsProfiles(localStorage),
    save: (name) => {
      try {
        return saveGameSettingsProfile(localStorage, name, settings());
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
      const refusal = applyProjectCommand(options.history, options.commands.settings(() => saved.settings, {
        label: `Load settings profile ${saved.name}`, place: place('physics-saved'), coalesce: null,
      }));
      if (refusal === null) return saved;
      refused(refusal);
      return null;
    },
  });
  element(options.mount, '.snapshot-history-help').textContent =
    'Profiles include physics, the hammer rig and the target radius. Loading is manual.';
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

  // One load at a time: the others wait while a file or server copy is read.
  function setImporting(busy: boolean): void {
    picker.setDisabled(busy);
    serverPicker.setDisabled(busy);
    importButton.disabled = busy;
    exportButton.disabled = busy;
  }

  // A pending edit while the file is read, which Undo cancels; then one step.
  async function importFile(file: File): Promise<void> {
    setImporting(true);
    let outcome: EditOutcome<void>;
    try {
      outcome = await options.imports.settings(file, {
        info: { label: `Import settings ${file.name}`, place: place('physics-saved'), coalesce: null }, signal: options.signal,
      });
    } finally {
      if (!options.signal.aborted) setImporting(false);
    }
    if (options.signal.aborted || outcome.kind === 'cancelled') return;
    if (outcome.kind === 'refused') refused(outcome.error);
    else options.onNotice('Imported game settings. Saved profiles were kept; save a named profile to retain these settings in this browser.', 'info');
  }

  importButton.addEventListener('click', () => fileInput.click(), listen);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file !== undefined) void importFile(file);
  }, listen);
  exportButton.addEventListener('click', () => {
    try {
      download('game-settings.json', `${JSON.stringify(validateGameSettings(settings()), null, 2)}\n`);
      options.onNotice('Exported game-settings.json. Select this file with GAME_SETTINGS when building the game.', 'info');
    } catch (error) {
      report(error, 'export');
    }
  }, listen);

  const serverPicker = createServerCopyPicker({
    mount: options.serverMount, signal: options.signal, copies: options.serverCopies, kind: 'game-settings',
    id: 'game-settings', noun: 'game settings', plural: 'game settings', placeholder: 'e.g. steady-hammer',
    onNotice: options.onNotice,
    capture: settings,
    // A pending edit from before the download, which Undo cancels; then one step.
    load: async (name, read) => {
      const outcome = await options.imports.serverSettings(name, read, {
        info: { label: `Load server settings ${name}`, place: place('physics-server'), coalesce: null }, signal: options.signal,
      });
      if (outcome.kind === 'refused') refused(outcome.error);
      return outcome.kind === 'applied' || outcome.kind === 'unchanged';
    },
    afterLoad: 'Saved profiles were kept; save a named profile to keep these settings in this browser.',
    onLoading: setImporting,
  });
}
