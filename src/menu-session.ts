// The release's side of a game's main menu: it holds play behind the menu, starts and takes up runs, keeps the run in
// play saved and hands the menu the player's settings. One session serves one loaded game. See
// docs/release-plugins.md#main-menu.
import type { Game } from './game';
import { createMenu, MENU } from './game-menu';
import type { Menu, MenuApi, MenuFactory, MenuState } from './game-menu';
import type { HudSettings } from './hud';
import { call0, invalidResult, PluginError } from './plugins/kernel';
import type { Attributed, CheckedInstance } from './plugins/kernel';
import type { PlayerSettings } from './player-settings';
import { clearSavedRun, readSavedRun, storedRun, writeSavedRun } from './saved-run';
import type { StoredRun } from './saved-run';

// How often a run in play is saved, in milliseconds, besides as the menu pauses it and as the page hides.
const SAVE_INTERVAL = 5000;
// The reason the menu pauses play and blocks its input under, apart from the player's own pause and the game's.
const HOLD = 'menu';

export interface MenuHost {
  readonly game: Game;
  // The SHA-256 of the level's play layout and physics, which the saved run belongs to.
  readonly course: string;
  readonly hud: HudSettings;
  readonly characters: readonly string[];
  settings(): PlayerSettings;
  // The player's settings with `changes`. Throws a RangeError stating the rule a change breaks.
  checkSettings(changes: unknown): PlayerSettings;
  // Keeps the player's settings and applies them to the game.
  applySettings(settings: PlayerSettings): void;
  notice(message: string): void;
}

export class MenuSession {
  private readonly factory: Attributed<MenuFactory>;
  private readonly host: MenuHost;
  private readonly menu: CheckedInstance<Menu>;
  private readonly lifecycle = new AbortController();
  private state: MenuState = 'title';
  private stored: StoredRun | null;
  // The run last saved, as text, so an unchanged run is not written again.
  private written: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;
  private disposed = false;

  // Call before the game starts: play waits behind the menu from its first frame.
  constructor(factory: Attributed<MenuFactory>, mount: HTMLElement, host: MenuHost) {
    this.factory = factory;
    this.host = host;
    this.stored = readSavedRun(host.course);
    this.hold(true);
    const listen = { signal: this.lifecycle.signal };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save();
    }, listen);
    window.addEventListener('pagehide', () => this.save(), listen);
    const session = this;
    const api: MenuApi = Object.freeze({
      get state() { return session.state; },
      get saved() { return session.stored?.summary ?? null; },
      newGame: () => this.newGame(),
      continueGame: () => this.continueGame(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      get settings() { return host.settings(); },
      changeSettings: (changes: Partial<PlayerSettings>) => this.changeSettings(changes),
      characters: host.characters,
      hud: host.hud,
      get halted() { return host.game.halted; },
    });
    try {
      this.menu = createMenu(factory, mount, api);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    call0(this.menu, 'dispose');
  }

  private newGame(): void {
    this.live();
    if (this.host.game.halted) return;
    this.forget();
    this.host.game.reset();
    this.play();
  }

  private continueGame(): void {
    this.live();
    const stored = this.stored;
    if (stored === null) throw invalidResult(this.factory, 'can continue only a saved run: check saved first');
    if (this.host.game.halted) return;
    this.host.game.resumeRun(stored.run);
    this.play();
  }

  private pause(): void {
    this.live();
    if (this.state !== 'playing') throw invalidResult(this.factory, 'can pause only a run in play');
    if (this.host.game.halted) return;
    this.state = 'paused';
    this.stopSaving();
    this.hold(true);
    this.save();
  }

  private resume(): void {
    this.live();
    if (this.state !== 'paused') throw invalidResult(this.factory, 'can resume only a paused run');
    if (this.host.game.halted) return;
    this.play();
  }

  private changeSettings(changes: unknown): PlayerSettings {
    this.live();
    let settings: PlayerSettings;
    try {
      settings = this.host.checkSettings(changes);
    } catch (error) {
      if (error instanceof RangeError) throw invalidResult(this.factory, error.message);
      throw error;
    }
    this.host.applySettings(settings);
    return settings;
  }

  // Releases the hold and plays as a click on the game does: the player's own pause ends and, during their gesture, the
  // mouse is captured.
  private play(): void {
    this.state = 'playing';
    this.hold(false);
    this.host.game.perform('play');
    this.timer ??= setInterval(() => this.save(), SAVE_INTERVAL);
  }

  private hold(held: boolean): void {
    this.host.game.setPause({ reason: HOLD, paused: held });
    this.host.game.setInputBlock({ reason: HOLD, blocked: held });
  }

  // Keeps the run as it stands, or forgets the saved run while a death restarts the run. Never at the title, whose
  // fresh run would replace the saved one before the player chose.
  private save(): void {
    if (this.disposed || this.state === 'title' || this.host.game.halted) return;
    const run = this.host.game.runRecord();
    if (run === null) {
      if (this.stored !== null) this.forget();
      return;
    }
    const text = JSON.stringify(run);
    if (text === this.written) return;
    this.written = text;
    this.stored = storedRun(run, Date.now());
    try {
      writeSavedRun(this.host.course, this.stored);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      // The menu still continues the run until the page closes.
      if (!this.warned) {
        this.warned = true;
        this.host.notice('This browser is not keeping your progress: Continue lasts only until this page closes.');
      }
    }
  }

  private forget(): void {
    this.stored = null;
    this.written = null;
    clearSavedRun();
  }

  private stopSaving(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private stop(): void {
    this.disposed = true;
    this.lifecycle.abort();
    this.stopSaving();
  }

  private live(): void {
    if (this.disposed) throw new PluginError('plugin-stopped', 'The menu\'s game has closed.', this.factory.plugin, MENU.id);
  }
}
