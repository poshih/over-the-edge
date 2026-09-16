// Editor-only event list authoring for trigger objects. Add/remove/reorder only mutate a local
// draft; nothing reaches LevelState until "Apply events" (or an automatic flush before a save/
// export/import/new/load action) validates the whole ordered list at once. This keeps partially
// typed data (e.g. a half-typed video URL) out of LevelState, while still guaranteeing that valid
// pending edits are never silently dropped when the author moves on to save their level.
import { TRIGGER_LIMITS } from '../level';
import type { TriggerAction } from '../trigger-events';

const EVENT_TYPES = ['popup', 'play-video', 'stop-timer'] as const;
type EventType = (typeof EVENT_TYPES)[number];
const EVENT_LABELS: Record<EventType, string> = { popup: 'Popup', 'play-video': 'Play video', 'stop-timer': 'Stop timer' };

function defaultEvent(type: EventType): TriggerAction {
  if (type === 'popup') return { type, title: 'Event', message: 'Describe what happens here.' };
  if (type === 'play-video') return { type, source: '' };
  return { type };
}

function cloneEvents(events: readonly TriggerAction[]): TriggerAction[] {
  return events.map((event) => ({ ...event }));
}

function sameEvents(a: readonly TriggerAction[], b: readonly TriggerAction[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function describeEvents(events: readonly TriggerAction[]): string {
  return events.map((event) => EVENT_LABELS[event.type]).join(', ');
}

interface Draft { committed: TriggerAction[]; draft: TriggerAction[] }

export interface TriggerEventEditorOptions {
  mount: HTMLElement;
  signal: AbortSignal;
  /** Validates and commits the whole ordered list for a trigger id via LevelState; returns
   *  whether it succeeded (a LevelError has already been reported to the author on failure). */
  onApply: (id: string, events: readonly TriggerAction[]) => boolean;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export interface TriggerEventEditor {
  /** Show (or resume editing) the ordered events for a trigger id. */
  show(id: string, events: readonly TriggerAction[]): void;
  hide(): void;
  /** Drop any draft tracked for an id, e.g. because the object was deleted or replaced. */
  forget(id: string): void;
  /** Drop every tracked draft, e.g. because the whole level was replaced. */
  clear(): void;
  /** Applies every dirty-but-valid draft; stops and returns false at the first invalid one. */
  flush(): boolean;
  /** Whether any tracked trigger has unapplied draft edits, valid or not. */
  hasPendingDrafts(): boolean;
}

export function createTriggerEventEditor(options: TriggerEventEditorOptions): TriggerEventEditor {
  const { mount } = options;
  const listen = { signal: options.signal };
  mount.innerHTML = `
    <p class="level-help">Ordered events run in sequence when the trigger fires. Add 1 to ${TRIGGER_LIMITS.events}.</p>
    <ol class="level-event-list" aria-label="Trigger events"></ol>
    <div class="level-action-row level-event-add">
      <label class="level-field level-event-new-type-label" for="level-event-new-type">New event type
        <select id="level-event-new-type">
          ${EVENT_TYPES.map((type) => `<option value="${type}">${EVENT_LABELS[type]}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="button level-event-append">Add event</button>
    </div>
    <div class="level-action-row">
      <button type="button" class="button button-primary level-event-apply">Apply events</button>
      <button type="button" class="button level-event-revert">Revert events</button>
    </div>
    <p class="level-event-status level-help" role="status" aria-live="polite"></p>
  `;
  const get = <T extends HTMLElement>(selector: string): T => {
    const node = mount.querySelector<T>(selector);
    if (node === null) throw new Error(`Missing trigger event editor element: ${selector}`);
    return node;
  };
  const list = get<HTMLOListElement>('.level-event-list');
  const newType = get<HTMLSelectElement>('#level-event-new-type');
  const status = get<HTMLParagraphElement>('.level-event-status');
  const applyButton = get<HTMLButtonElement>('.level-event-apply');
  const revertButton = get<HTMLButtonElement>('.level-event-revert');
  const appendButton = get<HTMLButtonElement>('.level-event-append');

  const drafts = new Map<string, Draft>();
  let currentId: string | null = null;

  function current(): Draft | null {
    return currentId === null ? null : drafts.get(currentId) ?? null;
  }

  function isDirty(entry: Draft): boolean {
    return !sameEvents(entry.committed, entry.draft);
  }

  function renderStatus(): void {
    const entry = current();
    const dirty = entry !== null && isDirty(entry);
    status.textContent = entry === null ? '' : dirty ? 'Unapplied event changes — Apply to keep them.' : 'No unapplied event changes.';
    applyButton.disabled = entry === null || !dirty;
    revertButton.disabled = entry === null || !dirty;
    newType.disabled = entry === null || entry.draft.length >= TRIGGER_LIMITS.events;
    appendButton.disabled = newType.disabled;
  }

  function renderRow(action: TriggerAction, index: number, entry: Draft): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'level-event-row';
    const header = document.createElement('div');
    header.className = 'level-action-row level-event-row-head';
    const label = document.createElement('span');
    label.className = 'level-event-row-label';
    label.textContent = `${index + 1}. ${EVENT_LABELS[action.type]}`;
    const up = document.createElement('button');
    up.type = 'button'; up.className = 'button'; up.textContent = '▲';
    up.setAttribute('aria-label', `Move event ${index + 1} up`);
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      [entry.draft[index - 1], entry.draft[index]] = [entry.draft[index], entry.draft[index - 1]];
      renderList();
    }, listen);
    const down = document.createElement('button');
    down.type = 'button'; down.className = 'button'; down.textContent = '▼';
    down.setAttribute('aria-label', `Move event ${index + 1} down`);
    down.disabled = index === entry.draft.length - 1;
    down.addEventListener('click', () => {
      [entry.draft[index + 1], entry.draft[index]] = [entry.draft[index], entry.draft[index + 1]];
      renderList();
    }, listen);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'button'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove event ${index + 1}`);
    remove.addEventListener('click', () => {
      entry.draft.splice(index, 1);
      renderList();
    }, listen);
    header.append(label, up, down, remove);
    item.append(header);
    if (action.type === 'popup') {
      const title = document.createElement('label');
      title.className = 'level-field';
      title.textContent = 'Title';
      const titleInput = document.createElement('input');
      titleInput.type = 'text'; titleInput.maxLength = TRIGGER_LIMITS.title; titleInput.value = action.title;
      title.append(titleInput);
      const message = document.createElement('label');
      message.className = 'level-field';
      message.textContent = 'Message';
      const messageInput = document.createElement('textarea');
      messageInput.maxLength = TRIGGER_LIMITS.message; messageInput.rows = 3; messageInput.value = action.message;
      const updatePopup = (): void => {
        entry.draft[index] = { type: 'popup', title: titleInput.value, message: messageInput.value };
        renderStatus();
      };
      titleInput.addEventListener('input', updatePopup, listen);
      messageInput.addEventListener('input', updatePopup, listen);
      message.append(messageInput);
      item.append(title, message);
    } else if (action.type === 'play-video') {
      const source = document.createElement('label');
      source.className = 'level-field';
      source.textContent = 'Video source (HTTPS URL or /media path)';
      const sourceInput = document.createElement('input');
      sourceInput.type = 'text'; sourceInput.maxLength = TRIGGER_LIMITS.source; sourceInput.value = action.source;
      sourceInput.placeholder = 'https://example.com/video.mp4';
      sourceInput.addEventListener('input', () => {
        entry.draft[index] = { ...action, source: sourceInput.value };
        renderStatus();
      }, listen);
      source.append(sourceInput);
      const sourceHelp = document.createElement('p');
      sourceHelp.className = 'level-help';
      sourceHelp.textContent = 'This URL is saved and exported with the level, in plain text. Use a public HTTP(S) '
        + 'video URL or a /site-relative path that anyone with the level can reach — not a private upload or a '
        + 'URL that embeds a login/credential.';
      item.append(source, sourceHelp);
    } else {
      const note = document.createElement('p');
      note.className = 'level-help';
      note.textContent = 'Stops the run timer. No fields to configure.';
      item.append(note);
    }
    return item;
  }

  function renderList(): void {
    const entry = current();
    list.replaceChildren();
    if (entry !== null) {
      for (const [index, action] of entry.draft.entries()) list.append(renderRow(action, index, entry));
    }
    renderStatus();
  }

  function commit(id: string, entry: Draft, notify: boolean): boolean {
    if (!options.onApply(id, cloneEvents(entry.draft))) return false;
    entry.committed = cloneEvents(entry.draft);
    if (notify) options.onNotice('Applied trigger events.', 'info');
    return true;
  }

  appendButton.addEventListener('click', () => {
    const entry = current();
    if (entry === null || entry.draft.length >= TRIGGER_LIMITS.events) return;
    entry.draft.push(defaultEvent(newType.value as EventType));
    renderList();
  }, listen);
  applyButton.addEventListener('click', () => {
    const entry = current();
    if (currentId === null || entry === null) return;
    commit(currentId, entry, true);
    renderList();
  }, listen);
  revertButton.addEventListener('click', () => {
    const entry = current();
    if (entry === null) return;
    entry.draft = cloneEvents(entry.committed);
    renderList();
  }, listen);
  renderStatus();

  return {
    show(id, events) {
      currentId = id;
      let entry = drafts.get(id);
      if (entry === undefined) {
        entry = { committed: cloneEvents(events), draft: cloneEvents(events) };
        drafts.set(id, entry);
      }
      renderList();
    },
    hide() {
      currentId = null;
      list.replaceChildren();
      renderStatus();
    },
    forget(id) {
      drafts.delete(id);
      if (currentId === id) currentId = null;
    },
    clear() {
      drafts.clear();
      currentId = null;
    },
    flush() {
      for (const [id, entry] of drafts) {
        if (isDirty(entry) && !commit(id, entry, false)) return false;
      }
      renderList();
      return true;
    },
    hasPendingDrafts() {
      for (const entry of drafts.values()) if (isDirty(entry)) return true;
      return false;
    },
  };
}
