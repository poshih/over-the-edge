import type { History, HistoryAction } from './document/history';
import { TEXT_ENTRY } from './ui';
import type { WorkshopState, WorkshopTab } from './ui-types';
import { showSection } from './workshop-section';

export interface HistoryControlsOptions {
  readonly history: History;
  readonly mount: HTMLElement;                                 // GameUi.historyMount
  readonly workshop: () => WorkshopState;                      // GameUi.workshopState
  readonly tabLabel: (tab: WorkshopTab) => string;             // GameUi.tabLabel
  readonly tabPane: (tab: WorkshopTab) => HTMLElement | null;  // GameUi.tabPane
  readonly notice: (message: string, kind: 'info' | 'error') => void;
}
export interface HistoryControls { dispose(): void }

type Direction = 'undo' | 'redo';
interface Verb { readonly now: string; readonly done: string }

const DIRECTIONS = ['undo', 'redo'] as const;
const KEYS: Readonly<Record<Direction, string>> = {
  undo: 'Control+Z Meta+Z',
  redo: 'Control+Shift+Z Meta+Shift+Z Control+Y',
};
// An action's verb before and after it is taken; cancelling a pending edit is Undo's.
const VERBS: Readonly<Record<Direction | 'cancel', Verb>> = {
  undo: { now: 'Undo', done: 'Undid' },
  redo: { now: 'Redo', done: 'Redid' },
  cancel: { now: 'Cancel', done: 'Cancelled' },
};

function verbs(direction: Direction, action: HistoryAction): Verb {
  return VERBS[action.kind === 'cancel' ? 'cancel' : direction];
}

// Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo.
function shortcut(event: KeyboardEvent): Direction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z' && (event.ctrlKey || event.metaKey)) return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey ? 'redo' : null;
}

function createButton(direction: Direction): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button history-button';
  button.setAttribute('aria-keyshortcuts', KEYS[direction]);
  const icon = document.createElement('span');
  icon.className = `${direction}-icon`;
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  return button;
}

/**
 * The Workshop's Undo and Redo for the project's one history: header buttons naming what each would do, their keys,
 * and word of what each did. They change only when the history's state does.
 */
export function createHistoryControls(options: HistoryControlsOptions): HistoryControls {
  const { history } = options;
  const events = new AbortController();
  // Tips show only to a pointer that hovers.
  const hoverless = window.matchMedia('(hover: none)');
  const buttons: Readonly<Record<Direction, HTMLButtonElement>> = {
    undo: createButton('undo'),
    redo: createButton('redo'),
  };
  const status = document.createElement('p');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  let announcement = 0;

  // "Undo Move Block at D7 (Level)"; a plugin's step names no tab.
  function describe(direction: Direction, action: HistoryAction): string {
    const { tab } = action.place;
    return `${verbs(direction, action).now} ${action.label}${tab === null ? '' : ` (${options.tabLabel(tab)})`}`;
  }

  function render(): void {
    const state = history.state();
    for (const direction of DIRECTIONS) {
      const action = state[direction];
      const tip = action === null ? `Nothing to ${direction}` :
        state.held ? `${describe(direction, action)}: waits for the project` : describe(direction, action);
      const button = buttons[direction];
      button.title = tip;
      button.setAttribute('aria-label', tip);
      button.disabled = action === null || state.held;
    }
  }

  function announce(message: string): void {
    // Cleared now and set on the next frame, so the same message is announced again.
    status.textContent = '';
    cancelAnimationFrame(announcement);
    announcement = requestAnimationFrame(() => {
      announcement = 0;
      status.textContent = message;
    });
  }

  // Takes the action the button names, then says what it did; false when there is none to take.
  function perform(direction: Direction): boolean {
    const state = history.state();
    const action = state[direction];
    if (action === null || state.held) return false;
    if (direction === 'undo') history.undo();
    else history.redo();
    const done = `${verbs(direction, action).done} ${action.label}`;
    announce(done);
    const { tab, section } = action.place;
    const shown = options.workshop().tab;
    // The Workshop stays on its tab, so a notice says what changed elsewhere, and on devices where tips do not show.
    if (tab !== null && tab !== shown) options.notice(`${done} in ${options.tabLabel(tab)}`, 'info');
    else if (hoverless.matches) options.notice(done, 'info');
    if (tab === shown && section !== null) {
      const pane = options.tabPane(tab);
      if (pane === null) throw new Error(`Missing Workshop tab: ${tab}.`);
      const details = pane.querySelector<HTMLDetailsElement>(`details[data-section="${CSS.escape(section)}"]`);
      if (details === null) throw new Error(`Missing Workshop section: ${section}.`);
      showSection(details);
    }
    return true;
  }

  render();
  options.mount.append(buttons.undo, buttons.redo, status);
  for (const direction of DIRECTIONS) {
    buttons[direction].addEventListener('click', () => perform(direction), { signal: events.signal });
  }
  // The keys work in the open Workshop, except in captured-mouse play and in text entry, where the browser's own undo
  // edits the text.
  document.addEventListener('keydown', (event) => {
    const direction = shortcut(event);
    if (direction === null || event.defaultPrevented || event.isComposing) return;
    if (!options.workshop().open || document.pointerLockElement !== null) return;
    if (event.target instanceof Element && event.target.closest(TEXT_ENTRY)) return;
    if (perform(direction)) event.preventDefault();
  }, { signal: events.signal });
  const unsubscribe = history.subscribe(render);
  return {
    dispose: () => {
      events.abort();
      unsubscribe();
      cancelAnimationFrame(announcement);
      buttons.undo.remove();
      buttons.redo.remove();
      status.remove();
    },
  };
}
