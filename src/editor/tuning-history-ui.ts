import { TuningError } from './tuning-schema';
import type { Tuning } from '../config';
import { createSnapshotPicker } from './snapshot-picker';
import {
  isTuningStorageKey, listSavedTunings, loadSavedTuning, saveTuningSnapshot, TuningHistoryError,
} from './tuning-store';
import type { SavedTuning } from './tuning-store';

interface TuningHistoryUiOptions {
  mount: HTMLElement;
  signal: AbortSignal;
  getTuning: () => Readonly<Tuning>;
  onLoad: (tuning: Tuning) => void;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export function createTuningHistoryUI(options: TuningHistoryUiOptions): void {
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

  createSnapshotPicker({
    mount: options.mount, signal: options.signal, id: 'tuning', noun: 'tuning', plural: 'tuning',
    placeholder: 'e.g. Rough hammer', isStorageKey: isTuningStorageKey, onNotice: options.onNotice,
    list: () => listSavedTunings(localStorage),
    save: (name) => {
      try {
        return saveTuningSnapshot(localStorage, name, options.getTuning());
      } catch (error) {
        report(error, 'save');
        return null;
      }
    },
    load: (key) => {
      let saved: SavedTuning;
      try {
        saved = loadSavedTuning(localStorage, key);
      } catch (error) {
        report(error, 'load');
        return null;
      }
      options.onLoad(saved.tuning);
      return saved;
    },
  });
}
