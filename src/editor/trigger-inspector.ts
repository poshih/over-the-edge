// Editor-only event list authoring for trigger objects. Add/remove/reorder only mutate a local
// draft; nothing reaches LevelState until "Apply events" (or an automatic flush before a save/
// export/import/new/load action) validates the whole ordered list at once. This keeps partially
// typed data (e.g. a half-typed video URL) out of LevelState, while still guaranteeing that valid
// pending edits are never silently dropped when the author moves on to save their level.
import { TRIGGER_LIMITS } from '../level';
import type { LevelObject } from '../level';
import { DEFAULT_LAUNCH, FIRE_TRAP_FIELDS, LAUNCH_FIELDS, PLATFORM_DESTINATIONS, SOUND_VOLUME } from '../trigger-events';
import type { PlatformDestination, TriggerAction } from '../trigger-events';
import { connectionTargetId } from './connection-links';

const EVENT_TYPES = ['message', 'play-video', 'play-sound', 'stop-timer', 'launch-player', 'fire-trap', 'move-platform'] as const;
type EventType = TriggerAction['type'];
const EVENT_LABELS: Record<EventType, string> = {
  message: 'Message', 'play-video': 'Play video', 'play-sound': 'Play sound', 'stop-timer': 'Stop timer', 'launch-player': 'Launch player',
  'fire-trap': 'Fire trap', 'move-platform': 'Move platform',
};
const PLATFORM_LABELS: Readonly<Record<PlatformDestination, string>> = {
  toggle: 'Toggle', start: 'To start', end: 'To end',
};

function defaultEvent(type: EventType): TriggerAction {
  switch (type) {
    case 'message': return { type, title: 'Event', message: 'Describe what happens here.' };
    case 'play-video': return { type, source: '' };
    case 'play-sound': return { type, source: '', volume: 1 };
    case 'stop-timer': return { type };
    case 'launch-player': return { type, ...DEFAULT_LAUNCH };
    case 'fire-trap': return { type, trap: '', shots: 3 };
    case 'move-platform': return { type, platform: '', to: 'toggle' };
  }
}

function cloneEvents(events: readonly TriggerAction[]): TriggerAction[] {
  return events.map((event) => ({ ...event }));
}

function sameEvents(a: readonly TriggerAction[], b: readonly TriggerAction[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function targetLabel(object: LevelObject): string {
  return `${object.id} (${Number(object.x.toFixed(2))}, ${Number(object.y.toFixed(2))})`;
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
  objects: () => readonly LevelObject[];
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
  /** Appends to the current draft and applies the whole list; an invalid list stays in the draft. */
  appendEvent(id: string, action: TriggerAction): boolean;
  /** Whether any tracked trigger has unapplied draft edits, valid or not. */
  hasPendingDrafts(): boolean;
}

export function createTriggerEventEditor(options: TriggerEventEditorOptions): TriggerEventEditor {
  const { mount } = options;
  const listen = { signal: options.signal };
  mount.innerHTML = `
    <p class="level-help">Ordered events run in sequence when the trigger fires. Add up to ${TRIGGER_LIMITS.events}.</p>
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

  function draftFor(id: string, events: readonly TriggerAction[]): Draft {
    let entry = drafts.get(id);
    if (entry === undefined) {
      entry = { committed: cloneEvents(events), draft: cloneEvents(events) };
      drafts.set(id, entry);
    } else if (!isDirty(entry) && !sameEvents(entry.committed, events)) {
      entry.committed = cloneEvents(events);
      entry.draft = cloneEvents(events);
    }
    return entry;
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
    if (action.type === 'message') {
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
      const updateMessage = (): void => {
        entry.draft[index] = { type: 'message', title: titleInput.value, message: messageInput.value };
        renderStatus();
      };
      titleInput.addEventListener('input', updateMessage, listen);
      messageInput.addEventListener('input', updateMessage, listen);
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
        + 'URL that embeds a login/credential. The video plays in the game; the Workshop skips it while you test.';
      item.append(source, sourceHelp);
    } else if (action.type === 'play-sound') {
      const source = document.createElement('label');
      source.className = 'level-field';
      source.textContent = 'Sound source (/media path or HTTPS URL)';
      const sourceInput = document.createElement('input');
      sourceInput.type = 'text'; sourceInput.maxLength = TRIGGER_LIMITS.source; sourceInput.value = action.source;
      sourceInput.placeholder = '/media/bell.mp3';
      const volume = document.createElement('label');
      volume.className = 'level-field';
      volume.textContent = `${SOUND_VOLUME.label} (0-1)`;
      const volumeInput = document.createElement('input');
      volumeInput.type = 'number'; volumeInput.inputMode = 'decimal';
      volumeInput.min = String(SOUND_VOLUME.min); volumeInput.max = String(SOUND_VOLUME.max); volumeInput.step = String(SOUND_VOLUME.step);
      volumeInput.value = String(action.volume);
      const updateSound = (): void => {
        entry.draft[index] = { type: 'play-sound', source: sourceInput.value, volume: volumeInput.valueAsNumber };
        renderStatus();
      };
      sourceInput.addEventListener('input', updateSound, listen);
      volumeInput.addEventListener('input', updateSound, listen);
      source.append(sourceInput);
      volume.append(volumeInput);
      const help = document.createElement('p');
      help.className = 'level-help';
      help.textContent = 'Plays once without pausing the game; the next event starts right away. Add the file to ' +
        'Project / Media library to ship it with a standalone game.';
      item.append(source, volume, help);
    } else if (action.type === 'launch-player') {
      const fields = document.createElement('div');
      fields.className = 'level-field-grid';
      const numericInput = (key: keyof typeof LAUNCH_FIELDS): HTMLInputElement => {
        const field = LAUNCH_FIELDS[key];
        const label = document.createElement('label');
        label.className = 'level-field';
        label.textContent = `${field.label} (${field.unit})`;
        const input = document.createElement('input');
        input.type = 'number'; input.inputMode = 'decimal';
        input.min = String(field.min); input.max = String(field.max); input.step = String(field.step);
        input.value = String(action[key]);
        label.append(input);
        fields.append(label);
        return input;
      };
      const height = numericInput('height');
      const strength = numericInput('strength');
      const updateLaunch = (): void => {
        entry.draft[index] = { type: 'launch-player', height: height.valueAsNumber, strength: strength.valueAsNumber };
        renderStatus();
      };
      height.addEventListener('input', updateLaunch, listen);
      strength.addEventListener('input', updateLaunch, listen);
      const help = document.createElement('p');
      help.className = 'level-help';
      help.textContent = 'At 1x strength, lift height estimates clear-air rise with the current body damping. ' +
        'Strength scales the upward launch speed; impulse automatically accounts for player and tool mass. ' +
        'Falling momentum is cancelled; faster upward motion is never slowed. Terrain and hammer pose can change the exact apex.';
      item.append(fields, help);
    } else if (action.type === 'fire-trap') {
      const trap = document.createElement('label');
      trap.className = 'level-field';
      trap.textContent = 'Projectile trap';
      const trapInput = document.createElement('select');
      const shooters = options.objects().filter((object) => object.kind === 'shooter');
      trapInput.append(...shooters.map((object) => {
        const option = document.createElement('option');
        option.value = object.id;
        option.textContent = targetLabel(object);
        return option;
      }));
      if (shooters.length === 0 || !shooters.some((object) => object.id === action.trap)) {
        const option = document.createElement('option');
        option.value = action.trap;
        option.textContent = shooters.length === 0 ? 'No projectile traps in the level' : `${action.trap} (missing)`;
        trapInput.prepend(option);
      }
      trapInput.value = action.trap;
      trap.append(trapInput);
      const shots = document.createElement('label');
      shots.className = 'level-field';
      shots.textContent = FIRE_TRAP_FIELDS.shots.label;
      const shotsInput = document.createElement('input');
      shotsInput.type = 'number'; shotsInput.inputMode = 'numeric';
      shotsInput.min = String(FIRE_TRAP_FIELDS.shots.min);
      shotsInput.max = String(FIRE_TRAP_FIELDS.shots.max);
      shotsInput.step = String(FIRE_TRAP_FIELDS.shots.step);
      shotsInput.value = String(action.shots);
      shots.append(shotsInput);
      const updateFireTrap = (): void => {
        entry.draft[index] = { type: 'fire-trap', trap: trapInput.value, shots: shotsInput.valueAsNumber };
        renderStatus();
      };
      trapInput.addEventListener('change', updateFireTrap, listen);
      shotsInput.addEventListener('input', updateFireTrap, listen);
      const help = document.createElement('p');
      help.className = 'level-help';
      help.textContent = shooters.length === 0 ? 'Add a projectile trap before this event can be valid.' :
        'Starts a burst on the selected projectile trap.';
      item.append(trap, shots, help);
    } else if (action.type === 'move-platform') {
      const platform = document.createElement('label');
      platform.className = 'level-field';
      platform.textContent = 'Platform';
      const input = document.createElement('select');
      const platforms = options.objects().filter((object) => object.kind === 'platform');
      input.append(...platforms.map((object) => {
        const option = document.createElement('option');
        option.value = object.id;
        option.textContent = targetLabel(object);
        return option;
      }));
      if (platforms.length === 0 || !platforms.some((object) => object.id === action.platform)) {
        const option = document.createElement('option');
        option.value = action.platform;
        option.textContent = platforms.length === 0 ? 'No platforms in the level' : `${action.platform} (missing)`;
        input.prepend(option);
      }
      input.value = action.platform;
      platform.append(input);
      const destination = document.createElement('label');
      destination.className = 'level-field';
      destination.textContent = 'To';
      const destinationInput = document.createElement('select');
      destinationInput.append(...PLATFORM_DESTINATIONS.map((to) => {
        const option = document.createElement('option');
        option.value = to;
        option.textContent = PLATFORM_LABELS[to];
        return option;
      }));
      destinationInput.value = action.to;
      destination.append(destinationInput);
      const updateMovePlatform = (): void => {
        const to = PLATFORM_DESTINATIONS.find((candidate) => candidate === destinationInput.value);
        if (to === undefined) throw new Error('Unknown platform destination.');
        entry.draft[index] = { type: 'move-platform', platform: input.value, to };
        renderStatus();
      };
      input.addEventListener('change', updateMovePlatform, listen);
      destinationInput.addEventListener('change', updateMovePlatform, listen);
      const help = document.createElement('p');
      help.className = 'level-help';
      help.textContent = platforms.length === 0 ? 'Add an elevator platform before this event can be valid.' :
        'Toggle turns it back. To start / To end call it to that landing; nothing changes if it is already going or resting there.';
      item.append(platform, destination, help);
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
    const type = EVENT_TYPES.find((candidate) => candidate === newType.value);
    if (type === undefined) throw new Error('Unknown trigger event type.');
    const event = defaultEvent(type);
    if (event.type === 'fire-trap') {
      const shooter = options.objects().find((object) => object.kind === 'shooter');
      entry.draft.push(shooter === undefined ? event : { ...event, trap: shooter.id });
    } else if (event.type === 'move-platform') {
      const platform = options.objects().find((object) => object.kind === 'platform');
      entry.draft.push(platform === undefined ? event : { ...event, platform: platform.id });
    } else entry.draft.push(event);
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
      draftFor(id, events);
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
    appendEvent(id, action) {
      const trigger = options.objects().find((object) => object.id === id);
      if (trigger?.kind !== 'trigger') {
        options.onNotice('The trigger no longer exists. No event was added.', 'error');
        return false;
      }
      const entry = draftFor(id, trigger.events);
      const targetId = connectionTargetId(action);
      if (targetId !== null && entry.draft.some((event) => connectionTargetId(event) === targetId)) {
        options.onNotice('Already connected. Edit or remove the link in Trigger events.', 'info');
        return false;
      }
      if (entry.draft.length >= TRIGGER_LIMITS.events) {
        options.onNotice(`A trigger has at most ${TRIGGER_LIMITS.events} events. Remove an event before connecting another target.`, 'error');
        return false;
      }
      entry.draft.push({ ...action });
      const applied = commit(id, entry, true);
      if (currentId === id) renderList();
      return applied;
    },
    hasPendingDrafts() {
      for (const entry of drafts.values()) if (isDirty(entry)) return true;
      return false;
    },
  };
}
