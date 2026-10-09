// The release's main menu: a game's own title screen and pause menu. It starts new games, continues the player's saved
// run and changes the player's settings while the release holds play behind it. Release-shell chrome over one loaded
// game; see docs/release-plugins.md#main-menu.
import type { HudSettings } from './hud';
import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed, CheckedInstance } from './plugins/kernel';
import type { PlayerSettings } from './player-settings';
import type { SavedRun } from './saved-run';

// `title` until the player starts a run, `playing` while one is in play, `paused` while the menu is open over one.
export type MenuState = 'title' | 'playing' | 'paused';

// What the release hands its menu. Every member reads or drives the loaded game on request; none runs per frame.
export interface MenuApi {
  readonly state: MenuState;
  // The run continueGame() takes up, or null when the browser keeps none of this course.
  readonly saved: SavedRun | null;
  // A new run from the level's start, in place of the saved run; play begins as a click on the game begins it.
  newGame(): void;
  // Takes up the saved run; play begins as a click on the game begins it.
  continueGame(): void;
  // Opens the run in play to the menu: holds it, releases the mouse and saves it.
  pause(): void;
  // Plays on from the menu, as a click on the game does.
  resume(): void;
  readonly settings: PlayerSettings;
  // Changes some of the player's settings, keeps them and applies them at once; returns all of them.
  changeSettings(changes: Partial<PlayerSettings>): PlayerSettings;
  // The characters' labels, one for each character the release has, such as 2D and 3D.
  readonly characters: readonly string[];
  // The project's HUD settings, so the menu shows heights as the HUD does: formatHeight(game.hud, metres).
  readonly hud: HudSettings;
  // Whether the game has stopped on an error; the verbs then change nothing.
  readonly halted: boolean;
}

export interface Menu {
  dispose(): void;
}

export type MenuFactory = (mount: HTMLElement, game: MenuApi) => Menu;

// Its base is null: without a menu, a release plays at once and keeps no saved run.
export const MENU = slotPoint('release.menu', 'release', (value: unknown): MenuFactory | null => {
  if (value !== null && typeof value !== 'function') throw new TypeError('A menu must be a factory, or null for none.');
  return value as MenuFactory | null;
});

const MENU_CONTRACT = instanceContract({ returns: 'dispose()', methods: ['dispose'] });

export function createMenu(factory: Attributed<MenuFactory>, mount: HTMLElement, game: MenuApi): CheckedInstance<Menu> {
  const create = factory.value;
  return createInstance<Menu>(MENU_CONTRACT, factory, () => create(mount, game));
}
