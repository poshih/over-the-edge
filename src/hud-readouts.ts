import { formatElapsedTime, setText } from './dom';
import { createHealthMeter } from './health-meter';
import type { HealthReading } from './health-meter';
import { formatHeight } from './hud';
import type { HudSettings } from './hud';

// The release's HUD readouts, and the contract a game's module (GAME_MODULE) replaces any of them with: the engine's own
// readouts below are the defaults, built on the same contract.

export const HUD_READOUTS = ['height', 'health', 'timer'] as const;
export type HudReadoutName = (typeof HUD_READOUTS)[number];

// What the readouts show, every frame.
export interface HudFrame {
  // The player's height now and the best this run, in metres.
  readonly height: number;
  readonly bestHeight: number;
  // The run's timer, in seconds, and whether it still runs; a Stop timer event stops it.
  readonly elapsed: number;
  readonly timerRunning: boolean;
  // The player's health; null in levels where nothing can hurt the player, whose HUD hides the health readout.
  readonly health: HealthReading | null;
  readonly paused: boolean;
}

export interface HudReadout {
  // Called every frame; draw only what changed.
  update(frame: HudFrame): void;
  // Called when the release closes.
  dispose?(): void;
}

// Builds a readout in `mount`, its own empty slot in the HUD, with the project's HUD settings: their labels, units and
// formats.
export type HudReadoutFactory = (mount: HTMLElement, settings: HudSettings) => HudReadout;

// The readouts a game draws its own way; the others keep the engine's.
export type HudReadouts = Readonly<Partial<Record<HudReadoutName, HudReadoutFactory>>>;

// A labelled value, as the engine's readouts show it: returns the value's element.
function labelled(mount: HTMLElement, name: HudReadoutName, label: string): HTMLElement {
  const list = document.createElement('dl');
  list.className = `play-readout play-readout-${name}`;
  const term = document.createElement('dt');
  term.textContent = label;
  const value = document.createElement('dd');
  list.append(term, value);
  mount.append(list);
  return value;
}

// The engine's readouts. A game may wrap one to add to it rather than draw it anew.
export const DEFAULT_HUD_READOUTS: Readonly<Record<HudReadoutName, HudReadoutFactory>> = Object.freeze({
  height: (mount, settings) => {
    const value = labelled(mount, 'height', settings.height.label);
    const number = document.createElement('span');
    const unit = document.createElement('span');
    unit.className = 'play-readout-unit';
    unit.textContent = settings.height.unit;
    value.append(number, unit);
    return { update: (frame) => setText(number, formatHeight(settings, frame.height)) };
  },
  health: (mount) => {
    const meter = createHealthMeter();
    labelled(mount, 'health', 'HEALTH').append(meter.root);
    return { update: (frame) => { if (frame.health !== null) meter.update(frame.health); } };
  },
  timer: (mount, settings) => {
    const value = labelled(mount, 'timer', settings.timer.label);
    return { update: (frame) => setText(value, formatElapsedTime(frame.elapsed)) };
  },
});

// The readouts a game's module supplies, checked where the module is loaded: only the HUD's own readouts, each a
// factory, or undefined for the engine's. A factory may be a method, inherited or not; it is called on its object.
export function validateHudReadouts(value: unknown): HudReadouts {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`The game's module must supply hud as an object of readout factories: ${HUD_READOUTS.join(', ')}.`);
  }
  for (const name of Object.keys(value)) {
    if (!(HUD_READOUTS as readonly string[]).includes(name)) {
      throw new TypeError(`The game's module supplies hud.${name}, but the HUD's readouts are ${HUD_READOUTS.join(', ')}.`);
    }
  }
  const readouts: Partial<Record<HudReadoutName, HudReadoutFactory>> = {};
  for (const name of HUD_READOUTS) {
    const factory: unknown = Reflect.get(value, name);
    if (factory === undefined) continue;
    if (typeof factory !== 'function') throw new TypeError(`The game's module must supply hud.${name} as a readout factory.`);
    readouts[name] = (mount, settings) => Reflect.apply(factory, value, [mount, settings]) as HudReadout;
  }
  return Object.freeze(readouts);
}

// Builds `name`'s readout from `factory` in `mount`, checking what it returns.
export function createHudReadout(name: HudReadoutName, factory: HudReadoutFactory, mount: HTMLElement, settings: HudSettings): HudReadout {
  const readout: unknown = factory(mount, settings);
  if (typeof readout !== 'object' || readout === null || typeof Reflect.get(readout, 'update') !== 'function') {
    throw new TypeError(`The HUD's ${name} readout must return an object with update(frame).`);
  }
  return readout as HudReadout;
}
