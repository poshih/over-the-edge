// A game's own main menu, built on the release's MenuApi: a title screen with Continue, New game and Settings, and a
// pause menu that Escape or the Menu button opens over play. See docs/release-plugins.md#main-menu.
import { formatElapsedTime, formatHeight, PLAYER_SETTINGS_LIMITS } from '../../src/plugins/release-sdk';
import type { MenuApi, MenuFactory, SavedRun } from '../../src/plugins/release-sdk';
import './menu.css';

type Screen = 'title' | 'confirm' | 'paused' | 'settings' | 'closed';

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'main-menu-button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function text(tag: 'h1' | 'p', className: string, content: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}

function actions(...buttons: HTMLButtonElement[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'main-menu-actions';
  group.append(...buttons);
  return group;
}

// The saved climb in the HUD's own units, such as "Saved climb: 214.5 m, best 230.1 m, 12:34".
function describe(game: MenuApi, saved: SavedRun): string {
  const unit = game.hud.height.unit;
  const height = (metres: number): string => `${formatHeight(game.hud, metres)}${unit === '' ? '' : ` ${unit}`}`;
  return `Saved climb: ${height(saved.height)}, best ${height(saved.bestHeight)}, ${formatElapsedTime(saved.elapsed)}` +
    (saved.finished ? ', finished' : '');
}

function slider(label: string, limits: { readonly min: number; readonly max: number }, value: number,
  shown: (value: number) => string, change: (value: number) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'main-menu-setting';
  const name = document.createElement('span');
  name.textContent = label;
  const output = document.createElement('output');
  output.textContent = shown(value);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(limits.min);
  input.max = String(limits.max);
  input.step = '0.05';
  input.value = String(value);
  // Each change applies at once, so the player hears the new volume as they drag.
  input.addEventListener('input', () => {
    const next = Number(input.value);
    change(next);
    output.textContent = shown(next);
  });
  row.append(name, output, input);
  return row;
}

function characterChoice(labels: readonly string[], selected: number, change: (index: number) => void): HTMLElement {
  const group = document.createElement('fieldset');
  group.className = 'main-menu-setting main-menu-characters';
  const legend = document.createElement('legend');
  legend.textContent = 'Character';
  group.append(legend);
  labels.forEach((label, index) => {
    const option = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'main-menu-character';
    input.checked = index === selected;
    input.addEventListener('change', () => {
      if (input.checked) change(index);
    });
    option.append(input, label);
    group.append(option);
  });
  return group;
}

export const createMainMenu: MenuFactory = (mount, game) => {
  const events = new AbortController();
  const root = document.createElement('div');
  root.className = 'main-menu';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', document.title);
  const panel = document.createElement('div');
  panel.className = 'main-menu-panel';
  root.append(panel);
  // Opens the pause menu over play: on a touchscreen, or with the mouse once Escape has released it.
  const opener = button('Menu', () => pause());
  opener.className = 'main-menu-opener';
  mount.append(root, opener);
  let screen: Screen = 'closed';
  // Where Settings and the new game's confirmation go back to.
  let back: 'title' | 'paused' = 'title';

  // Each verb that plays runs in the player's own click or key press, so the release can capture the mouse.
  const play = (start: () => void): void => {
    start();
    show('closed');
  };
  const pause = (): void => {
    if (game.state !== 'playing' || game.halted) return;
    game.pause();
    show('paused');
  };

  function show(next: Screen): void {
    screen = next;
    if (next === 'title' || next === 'paused') back = next;
    root.hidden = next === 'closed';
    opener.hidden = next !== 'closed' || game.state !== 'playing';
    panel.replaceChildren(...content(next));
    panel.querySelector<HTMLElement>('button, input')?.focus();
  }

  function content(next: Screen): HTMLElement[] {
    switch (next) {
      case 'title': {
        const saved = game.saved;
        return [
          text('h1', 'main-menu-heading', document.title),
          text('p', 'main-menu-note', saved === null ? 'No saved climb yet.' : describe(game, saved)),
          actions(
            ...(saved === null ? [] : [button('Continue', () => play(() => game.continueGame()))]),
            // Starting over replaces the saved climb, so ask first.
            button('New game', () => saved === null ? play(() => game.newGame()) : show('confirm')),
            button('Settings', () => show('settings')),
          ),
        ];
      }
      case 'confirm':
        return [
          text('h1', 'main-menu-heading', 'Start over?'),
          text('p', 'main-menu-note', 'A new game replaces your saved climb.'),
          actions(button('Start over', () => play(() => game.newGame())), button('Back', () => show(back))),
        ];
      case 'paused':
        return [
          text('h1', 'main-menu-heading', 'Paused'),
          actions(
            button('Resume', () => play(() => game.resume())),
            button('Settings', () => show('settings')),
            // The run was saved as it paused, so the title's Continue takes it up again.
            button('Main menu', () => show('title')),
          ),
        ];
      case 'settings': {
        const { volume, sensitivity, character } = game.settings;
        return [
          text('h1', 'main-menu-heading', 'Settings'),
          slider('Volume', PLAYER_SETTINGS_LIMITS.volume, volume, (value) => `${Math.round(value * 100)}%`,
            (value) => game.changeSettings({ volume: value })),
          slider('Control sensitivity', PLAYER_SETTINGS_LIMITS.sensitivity, sensitivity, (value) => `${value.toFixed(2)}×`,
            (value) => game.changeSettings({ sensitivity: value })),
          ...(game.characters.length > 1
            ? [characterChoice(game.characters, character, (index) => game.changeSettings({ character: index }))] : []),
          actions(button('Back', () => show(back))),
        ];
      }
      case 'closed':
        return [];
    }
  }

  // Escape opens the pause menu over play once the mouse is free, and steps back out of Settings and the confirmation.
  // Escape is no gesture to the browser, so it never resumes: Resume, focused, takes Enter or Space and captures the mouse.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
    if (screen === 'closed') {
      if (document.pointerLockElement !== null || game.state !== 'playing') return;
      pause();
    } else if (screen === 'settings' || screen === 'confirm') {
      show(back);
    } else {
      return;
    }
    event.preventDefault();
  }, { signal: events.signal });

  show('title');
  return {
    dispose(): void {
      events.abort();
      root.remove();
      opener.remove();
    },
  };
};
