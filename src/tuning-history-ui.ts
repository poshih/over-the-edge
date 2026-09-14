import { TuningError } from './config';
import type { Tuning } from './config';
import {
  isTuningStorageKey, listSavedTunings, loadSavedTuning, saveTuningSnapshot,
  TuningHistoryError, TUNING_NAME_LIMIT,
} from './tuning-store';
import type { SavedTuning, TuningHistoryEntry } from './tuning-store';

interface TuningHistoryUiOptions {
  mount: HTMLElement;
  signal: AbortSignal;
  getTuning: () => Readonly<Tuning>;
  onLoad: (tuning: Tuning) => void;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export function createTuningHistoryUI(options: TuningHistoryUiOptions): void {
  const listen = { signal: options.signal };
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  const title = document.createElement('h3');
  title.textContent = 'Saved tuning';
  heading.append(title);

  const form = document.createElement('form');
  form.className = 'tuning-save-form';
  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'tuning-profile-name';
  nameLabel.textContent = 'Tuning name';
  const name = document.createElement('input');
  name.id = nameLabel.htmlFor;
  name.type = 'text';
  name.maxLength = TUNING_NAME_LIMIT;
  name.autocomplete = 'off';
  name.placeholder = 'e.g. Rough hammer';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button button-primary save-tuning';
  save.textContent = 'Save tuning';
  const saveRow = document.createElement('div');
  saveRow.className = 'tuning-profile-row';
  saveRow.append(name, save);
  form.append(nameLabel, saveRow);

  const pastLabel = document.createElement('label');
  pastLabel.htmlFor = 'past-tuning';
  pastLabel.textContent = 'Past tuning';
  const past = document.createElement('select');
  past.id = pastLabel.htmlFor;
  const load = document.createElement('button');
  load.type = 'button';
  load.className = 'button load-tuning';
  load.textContent = 'Load tuning';
  const loadRow = document.createElement('div');
  loadRow.className = 'tuning-profile-row';
  loadRow.append(past, load);
  const help = document.createElement('p');
  help.className = 'tuning-history-help';
  help.textContent = 'Every save keeps a named snapshot. Choose a past save, then load it.';
  const historyError = document.createElement('p');
  historyError.className = 'tuning-history-error';
  historyError.setAttribute('role', 'status');
  historyError.setAttribute('aria-live', 'polite');
  historyError.hidden = true;
  options.mount.append(heading, form, pastLabel, loadRow, help, historyError);

  function report(error: unknown, action: 'save' | 'load'): void {
    if (error instanceof DOMException) {
      options.onNotice(action === 'save'
        ? 'Tuning could not be saved. Device storage may be full or blocked; existing saves and live tuning are unchanged.'
        : 'Device storage is unavailable. Your live tuning is unchanged.', 'error');
    } else if (error instanceof TuningError || error instanceof TuningHistoryError) {
      options.onNotice(`${error.message} Existing saves and live tuning were left unchanged.`, 'error');
    } else {
      throw error;
    }
  }

  function refresh(selected: string): void {
    try {
      const entries = listSavedTunings(window.localStorage);
      const unreadable = entries.filter((entry) => entry.error !== null);
      const usable = entries.filter((entry) => entry.error === null);
      const items = entries.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.key;
        option.disabled = entry.error !== null;
        if (entry.error !== null) option.title = entry.error;
        option.textContent = entry.savedAt === null ? entry.name :
          `${entry.name} - ${new Date(entry.savedAt).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
          })}`;
        return option;
      });
      if (usable.length === 0) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = entries.length === 0 ? 'No saved tuning yet' : 'No readable saved tuning';
        items.unshift(empty);
      }
      past.replaceChildren(...items);
      past.value = usable.some((entry) => entry.key === selected) ? selected : usable[0]?.key ?? '';
      past.disabled = entries.length === 0;
      load.disabled = usable.length === 0;
      historyError.hidden = unreadable.length === 0;
      historyError.textContent = unreadable.length === 0 ? '' :
        `${unreadable.length} saved tuning record(s) could not be read. They were left untouched.`;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      past.replaceChildren();
      past.disabled = true;
      load.disabled = true;
      historyError.hidden = false;
      historyError.textContent = 'Device storage is unavailable. Saved tuning cannot be listed.';
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    let saved: TuningHistoryEntry;
    try {
      saved = saveTuningSnapshot(window.localStorage, name.value, options.getTuning());
    } catch (error) {
      report(error, 'save');
      name.focus();
      return;
    }
    name.value = saved.name;
    refresh(saved.key);
    options.onNotice(`Saved "${saved.name}" as a new snapshot. Earlier saves were kept.`, 'info');
  }, listen);
  load.addEventListener('click', () => {
    let saved: SavedTuning;
    try {
      saved = loadSavedTuning(window.localStorage, past.value);
    } catch (error) {
      report(error, 'load');
      refresh(past.value);
      return;
    }
    options.onLoad(saved.tuning);
    name.value = saved.name;
    options.onNotice(`Loaded "${saved.name}". Saved snapshots were not changed.`, 'info');
  }, listen);
  window.addEventListener('storage', (event) => {
    if (isTuningStorageKey(event.key)) refresh(past.value);
  }, listen);
  refresh('');
}
