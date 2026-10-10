import { isProjectDataError } from '../project';
import { SHARED_NAME_LIMIT, validateSharedName } from '../shared-copies';
import type { SharedKind } from '../shared-copies';
import { ProjectApiError } from './project-client';
import type { ServerCopies } from './server-copies';

function expected(error: unknown): error is Error {
  return error instanceof ProjectApiError || isProjectDataError(error);
}

// How a loaded copy reaches its editor: `apply` takes its value once downloaded; `load` downloads it itself through
// `read`, so an undoable load waits for the download as one pending edit. Either is false when nothing loaded.
export type ServerCopyLoadOptions =
  | {
    // Validates and applies a loaded value; false when the editor declined it. Validation errors are reported here.
    readonly apply: (value: unknown) => boolean | Promise<boolean>;
    readonly load?: never;
  }
  | {
    readonly apply?: never;
    // Loads the copy `name`, reporting its own refusals; `read` downloads it, abandoned when `signal` aborts.
    readonly load: (name: string, read: (signal: AbortSignal) => Promise<unknown>) => Promise<boolean>;
  };

/**
 * Save to server, and the server's copies of one kind, for an editor: a copy saved here is shared with everyone who
 * opens this Workshop, and loading one replaces the editor's current value, as an import does.
 */
export function createServerCopyPicker<T>(options: {
  readonly mount: HTMLElement;
  readonly signal: AbortSignal;
  readonly copies: ServerCopies;
  readonly kind: SharedKind;
  // Prefixes the controls' IDs.
  readonly id: string;
  readonly noun: string;
  readonly plural: string;
  readonly placeholder: string;
  // The value to save, or null when it cannot be saved now; the editor says why.
  readonly capture: () => T | null;
  // Ends the notice after a load, e.g. with how to keep what was loaded.
  readonly afterLoad: string;
  // After a save, with the value saved, e.g. to count it as the editor's saved value.
  readonly onSaved?: (value: T) => void;
  // While a copy loads, so the editor can hold back its other loads.
  readonly onLoading?: (loading: boolean) => void;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
} & ServerCopyLoadOptions): { setDisabled(disabled: boolean): void } {
  const { copies, id, kind, noun, plural, signal } = options;
  const listen = { signal };
  const root = options.mount;
  root.classList.add('snapshot-history', 'server-copies');
  root.innerHTML = `
    <form class="server-copies-save">
      <label for="${id}-server-name">Name on the server</label>
      <div class="tuning-profile-row">
        <input id="${id}-server-name" type="text" maxlength="${SHARED_NAME_LIMIT}" autocomplete="off" spellcheck="false" />
        <button type="submit" class="button button-primary server-copies-store">Save to server</button>
      </div>
    </form>
    <label for="${id}-server-list">Server ${plural}</label>
    <div class="tuning-profile-row server-copies-list">
      <select id="${id}-server-list"></select>
      <button type="button" class="button server-copies-load">Load server ${noun}</button>
      <button type="button" class="button server-copies-refresh">Refresh</button>
    </div>
    <p class="snapshot-history-help server-copies-status" role="status" aria-live="polite"></p>
  `;
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing server copies element: ${selector}`);
    return element;
  };
  const form = get<HTMLFormElement>('form');
  const nameInput = get<HTMLInputElement>('input');
  const store = get<HTMLButtonElement>('.server-copies-store');
  const list = get<HTMLSelectElement>('select');
  const load = get<HTMLButtonElement>('.server-copies-load');
  const refreshButton = get<HTMLButtonElement>('.server-copies-refresh');
  const status = get<HTMLParagraphElement>('.server-copies-status');
  nameInput.placeholder = options.placeholder;
  let disabled = false;
  let busy = false;
  let listing = false;
  let entries: readonly string[] = [];
  let problem: string | null = null;
  let generation = 0;

  const selected = (): string | undefined => list.value === '' ? undefined : entries[Number(list.value)];

  function describe(): string {
    if (problem !== null) return problem;
    switch (copies.state()) {
      case 'checking': return 'Looking for the project server…';
      case 'signed-out': return `Sign in to the project server in Project to list and save server ${plural}.`;
      case 'offline': return `No project server: this Workshop is a static site. Run npm run dev or npm run studio to share ${plural} on a server.`;
      case 'connected': return `Shared with everyone who opens this Workshop, as files in its repository's ${kind}/ folder. `
        + `Saving under a listed name replaces that copy; loading one replaces the current ${noun}.`;
    }
  }

  function render(): void {
    nameInput.disabled = disabled || busy || copies.state() !== 'connected';
    store.disabled = nameInput.disabled;
    list.disabled = disabled || busy || entries.length === 0;
    load.disabled = list.disabled || selected() === undefined;
    refreshButton.disabled = disabled || busy || listing;
    status.textContent = describe();
  }

  function fill(keep: string | null): void {
    const items = entries.map((entry, index) => new Option(entry, String(index)));
    if (items.length === 0) items.push(new Option(listing ? 'Loading…' : `No server ${plural} yet`, ''));
    list.replaceChildren(...items);
    const index = keep === null ? -1 : entries.indexOf(keep);
    list.value = entries.length === 0 ? '' : String(Math.max(0, index));
  }

  async function refresh(keep: string | null = selected() ?? null): Promise<void> {
    const current = ++generation;
    listing = true;
    if (entries.length === 0) fill(keep);
    render();
    try {
      const next = await copies.list(kind);
      if (current !== generation || signal.aborted) return;
      entries = next;
      problem = null;
    } catch (error) {
      if (!expected(error)) throw error;
      if (current !== generation || signal.aborted) return;
      entries = [];
      problem = `Server ${plural} could not be listed: ${error.message}`;
    }
    listing = false;
    fill(keep);
    render();
  }

  async function save(): Promise<void> {
    if (disabled || busy || copies.state() !== 'connected') return;
    let name: string;
    try {
      name = validateSharedName(nameInput.value.trim());
    } catch (error) {
      if (!expected(error)) throw error;
      options.onNotice(error.message, 'error');
      nameInput.focus();
      return;
    }
    const value = options.capture();
    if (value === null) return;
    if (entries.includes(name) &&
      !window.confirm(`Replace the server ${noun} "${name}"? Everyone who opens this Workshop gets this version instead.`)) return;
    busy = true;
    render();
    try {
      await copies.save(kind, name, value);
    } catch (error) {
      if (!expected(error)) throw error;
      if (!signal.aborted) options.onNotice(`"${name}" was not saved to the server: ${error.message}`, 'error');
      return;
    } finally {
      busy = false;
      if (!signal.aborted) render();
    }
    if (signal.aborted) return;
    nameInput.value = name;
    options.onSaved?.(value);
    options.onNotice(`Saved "${name}" to the server; everyone who opens this Workshop can load it.`, 'info');
    await refresh(name);
  }

  // Holds the picker, and through onLoading the editor's other loads, while a copy loads.
  function setBusy(value: boolean): void {
    busy = value;
    if (signal.aborted) return;
    options.onLoading?.(value);
    render();
  }

  // Downloads the copy, then gives it to the editor; false when nothing loaded, as reported.
  async function downloadAndApply(name: string, apply: (value: unknown) => boolean | Promise<boolean>): Promise<boolean> {
    setBusy(true);
    let value: unknown;
    try {
      value = await copies.read(kind, name);
    } catch (error) {
      if (signal.aborted) return false;
      if (!expected(error)) throw error;
      options.onNotice(error.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
    if (signal.aborted) return false;
    try {
      return await apply(value);
    } catch (error) {
      if (!isProjectDataError(error)) throw error;
      options.onNotice(`"${name}" on the server is not a valid ${noun}: ${error.message}`, 'error');
      return false;
    }
  }

  // The editor's loader downloads the copy itself, so the download is part of what it loads.
  async function loadThrough(name: string,
    loader: (name: string, read: (signal: AbortSignal) => Promise<unknown>) => Promise<boolean>): Promise<boolean> {
    setBusy(true);
    try {
      return await loader(name, (operation) => copies.read(kind, name, AbortSignal.any([operation, signal])));
    } catch (error) {
      if (signal.aborted) return false;
      if (!expected(error)) throw error;
      options.onNotice(error.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function loadSelected(): Promise<void> {
    const name = selected();
    if (name === undefined || disabled || busy) return;
    const loaded = options.load === undefined
      ? await downloadAndApply(name, options.apply) : await loadThrough(name, options.load);
    if (!loaded || signal.aborted) return;
    nameInput.value = name;
    options.onNotice(`Loaded "${name}" from the server. ${options.afterLoad}`, 'info');
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save();
  }, listen);
  load.addEventListener('click', () => { void loadSelected(); }, listen);
  refreshButton.addEventListener('click', () => { void refresh(); }, listen);
  list.addEventListener('change', () => {
    const name = selected();
    if (name !== undefined) nameInput.value = name;
    render();
  }, listen);
  const unsubscribe = copies.subscribe(() => { void refresh(); });
  signal.addEventListener('abort', unsubscribe, { once: true });
  void refresh(null);
  return {
    setDisabled: (value) => {
      disabled = value;
      render();
    },
  };
}
