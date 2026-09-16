import { SNAPSHOT_NAME_LIMIT } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';

export function createSnapshotPicker(options: {
  mount: HTMLElement;
  signal: AbortSignal;
  id: string;
  noun: string;
  plural: string;
  placeholder: string;
  list: () => SnapshotEntry[];
  save: (name: string) => SnapshotEntry | null;
  load: (key: string) => { name: string } | null;
  isStorageKey: (key: string | null) => boolean;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}): { setDisabled: (disabled: boolean) => void; select: (key: string) => void } {
  const { id, noun, plural, mount } = options;
  const listen = { signal: options.signal };
  mount.classList.add('snapshot-history');
  mount.innerHTML = `
    <div class="section-heading"><h3>Saved ${plural}</h3></div>
    <form class="tuning-save-form">
      <label for="${id}-profile-name">${noun[0].toUpperCase()}${noun.slice(1)} name</label>
      <div class="tuning-profile-row">
        <input id="${id}-profile-name" type="text" maxlength="${SNAPSHOT_NAME_LIMIT}" autocomplete="off" />
        <button type="submit" class="button button-primary save-${id}">Save ${noun}</button>
      </div>
    </form>
    <label for="past-${id}">Past ${plural}</label>
    <div class="tuning-profile-row">
      <select id="past-${id}"></select>
      <button type="button" class="button load-${id}">Load ${noun}</button>
    </div>
    <p class="snapshot-history-help">Every save keeps a named snapshot. Choose a past save, then load it.</p>
    <p class="${id}-history-error snapshot-history-error" role="status" aria-live="polite" hidden></p>
  `;
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = mount.querySelector<T>(selector);
    if (!element) throw new Error(`Missing snapshot picker element: ${selector}`);
    return element;
  };
  const form = get<HTMLFormElement>('form');
  const name = get<HTMLInputElement>('input');
  const past = get<HTMLSelectElement>('select');
  const save = get<HTMLButtonElement>(`.save-${id}`);
  const load = get<HTMLButtonElement>(`.load-${id}`);
  const errorBox = get<HTMLParagraphElement>('.snapshot-history-error');
  name.placeholder = options.placeholder;
  let disabled = false;
  let entries: SnapshotEntry[] = [];

  function updateDisabled(): void {
    name.disabled = disabled;
    save.disabled = disabled;
    past.disabled = disabled || entries.length === 0;
    load.disabled = disabled || !entries.some((entry) => entry.key === past.value && entry.error === null);
  }

  function refresh(selected: string): void {
    try {
      entries = options.list();
      const usable = entries.filter((entry) => entry.error === null);
      const unreadable = entries.length - usable.length;
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
        empty.textContent = entries.length === 0 ? `No saved ${plural} yet` : `No readable saved ${plural}`;
        items.unshift(empty);
      }
      past.replaceChildren(...items);
      past.value = usable.some((entry) => entry.key === selected) ? selected : usable[0]?.key ?? '';
      errorBox.hidden = unreadable === 0;
      errorBox.textContent = unreadable === 0 ? '' :
        `${unreadable} saved ${noun} record(s) could not be read. They were left untouched.`;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      entries = [];
      past.replaceChildren();
      errorBox.hidden = false;
      errorBox.textContent = `Device storage is unavailable. Saved ${plural} cannot be listed.`;
    }
    updateDisabled();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const saved = options.save(name.value);
    refresh(saved === null ? past.value : saved.key);
    if (saved === null) {
      name.focus();
      return;
    }
    name.value = saved.name;
    options.onNotice(`Saved "${saved.name}" as a new snapshot. Earlier saves were kept.`, 'info');
  }, listen);
  load.addEventListener('click', () => {
    const saved = options.load(past.value);
    refresh(past.value);
    if (saved === null) return;
    name.value = saved.name;
    options.onNotice(`Loaded "${saved.name}". Saved snapshots were not changed.`, 'info');
  }, listen);
  past.addEventListener('change', updateDisabled, listen);
  window.addEventListener('storage', (event) => {
    if (options.isStorageKey(event.key)) refresh(past.value);
  }, listen);
  refresh('');
  return {
    setDisabled: (value) => { disabled = value; updateDisabled(); },
    select: (key) => {
      refresh(key);
      const selected = entries.find((entry) => entry.key === key && entry.error === null);
      if (selected) name.value = selected.name;
    },
  };
}
