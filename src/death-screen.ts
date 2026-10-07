import './death-screen.css';
import type { DeathFrame, DeathInfo } from './death-sequence';
import type { HudSettings } from './hud';
import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';

export interface DeathScreen {
  show(info: DeathInfo, settings: HudSettings['death']): void;
  update(frame: DeathFrame): void;
  clear(): void;
  dispose(): void;
}

export type DeathScreenFactory = (mount: HTMLElement) => DeathScreen;

function screenFactory(value: unknown): DeathScreenFactory {
  if (typeof value !== 'function') throw new TypeError('A death screen must be a factory.');
  return value as DeathScreenFactory;
}

export const DEATH_SCREEN = slotPoint('messages.death', 'runtime', screenFactory);

class EngineDeathScreen implements DeathScreen {
  private readonly root = document.createElement('div');
  private readonly text = document.createElement('p');
  private readonly announcer = document.createElement('p');
  private readonly fade: Animation;
  private fadeIn = 1;
  private announcement: string | null = null;
  private firstFrame = false;
  private progress = -1;

  constructor(mount: HTMLElement) {
    this.root.className = 'death-screen';
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.text.className = 'death-screen-text';
    this.root.append(this.text);
    this.announcer.className = 'death-screen-announcer';
    this.announcer.setAttribute('aria-live', 'polite');
    this.announcer.setAttribute('aria-atomic', 'true');
    this.fade = this.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, easing: 'ease-in-out', fill: 'both' });
    try {
      this.fade.pause();
      this.fade.currentTime = 0;
      mount.append(this.root, this.announcer);
    } catch (error) {
      this.fade.cancel();
      this.root.remove();
      this.announcer.remove();
      throw error;
    }
  }

  show(_info: DeathInfo, settings: HudSettings['death']): void {
    this.fadeIn = settings.fadeIn;
    this.text.textContent = settings.text;
    this.announcer.textContent = '';
    this.announcement = settings.text;
    this.firstFrame = true;
    this.progress = -1;
    this.fade.currentTime = 0;
    this.root.hidden = false;
  }

  update(frame: DeathFrame): void {
    const progress = frame.reducedMotion ? 1 : Math.min(1, Math.min(frame.elapsed, frame.duration) / this.fadeIn);
    if (progress !== this.progress) {
      this.progress = progress;
      this.fade.currentTime = progress * 1000;
    }
    if (this.firstFrame) this.firstFrame = false;
    else if (this.announcement !== null) {
      this.announcer.textContent = this.announcement;
      this.announcement = null;
    }
  }

  clear(): void {
    this.root.hidden = true;
    this.fade.currentTime = 0;
    this.announcement = null;
    this.firstFrame = false;
    this.announcer.textContent = '';
    this.text.textContent = '';
  }

  dispose(): void {
    this.clear();
    this.fade.cancel();
    this.root.remove();
    this.announcer.remove();
  }
}

export const DEFAULT_DEATH_SCREEN: DeathScreenFactory = (mount) => new EngineDeathScreen(mount);

const DEATH_SCREEN_CONTRACT = instanceContract({
  returns: 'show(info, settings), update(frame), clear() and dispose()',
  methods: ['show', 'update', 'clear', 'dispose'],
});

export function createDeathScreen(plugins: RuntimePlugins, mount: HTMLElement): Attributed<DeathScreen> {
  const factory = plugins.slot(DEATH_SCREEN, DEFAULT_DEATH_SCREEN);
  const create = factory.value;
  return createInstance(DEATH_SCREEN_CONTRACT, factory, () => create(mount));
}
