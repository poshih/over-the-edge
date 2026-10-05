import { formatElapsedTime, setText } from './dom';
import { createHealthMeter } from './health-meter';
import type { HealthReading } from './health-meter';
import { formatHeight } from './hud';
import type { HudSettings } from './hud';
import type { InputMode } from './config';
import { listPoint, PluginError, slotPoint } from './plugins/kernel';

// Shared play readouts: runtime facets replace or wrap the built-ins and add extras (docs/runtime-plugins.md).

export const HUD_READOUTS = ['height', 'health', 'timer'] as const;
export type HudReadoutName = (typeof HUD_READOUTS)[number];

// What the readouts show, every frame. Both this object and its health reading are reused; never retain a snapshot
// by keeping their references. Updates draw only changed values and must not allocate frame objects.
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
  readonly pointerLocked: boolean;
  readonly inputMode: InputMode;
}

export interface HudReadout {
  // Called every frame; draw only what changed.
  update(frame: HudFrame): void;
  // Called when the HUD is rebuilt or its Game closes.
  dispose?(): void;
}

// Builds a readout in `mount`, its own empty slot in the HUD, with the project's HUD settings: their labels, units and
// formats.
export type HudReadoutFactory = (mount: HTMLElement, settings: HudSettings) => HudReadout;

function readoutFactory(value: unknown): HudReadoutFactory {
  if (typeof value !== 'function') throw new TypeError('A HUD readout must be a factory.');
  return value as HudReadoutFactory;
}

export const HUD = Object.freeze({
  height: slotPoint('hud.height', 'runtime', readoutFactory),
  health: slotPoint('hud.health', 'runtime', readoutFactory),
  timer: slotPoint('hud.timer', 'runtime', readoutFactory),
  // The engine adds no extras. Each plugin's factories follow the three built-in slots, in manifest order.
  extras: listPoint('hud.extras', 'runtime', 32, readoutFactory),
});

// A labelled value, as the engine's readouts show it.
function labelled(mount: HTMLElement, name: HudReadoutName, label: string): { label: HTMLElement; value: HTMLElement } {
  const list = document.createElement('dl');
  list.className = `play-readout play-readout-${name}`;
  const term = document.createElement('dt');
  term.textContent = label;
  const value = document.createElement('dd');
  list.append(term, value);
  mount.append(list);
  return { label: term, value };
}

// The engine's readouts. A game may wrap one to add to it rather than draw it anew.
export const DEFAULT_HUD_READOUTS: Readonly<Record<HudReadoutName, HudReadoutFactory>> = Object.freeze({
  height: (mount, settings) => {
    const { value } = labelled(mount, 'height', settings.height.label);
    const number = document.createElement('span');
    const unit = document.createElement('span');
    unit.className = 'play-readout-unit';
    unit.textContent = settings.height.unit;
    value.append(number, unit);
    return { update: (frame) => setText(number, formatHeight(settings, frame.height)) };
  },
  health: (mount) => {
    const meter = createHealthMeter();
    labelled(mount, 'health', 'HEALTH').value.append(meter.root);
    return { update: (frame) => { if (frame.health !== null) meter.update(frame.health); } };
  },
  timer: (mount, settings) => {
    const { value, label } = labelled(mount, 'timer', settings.timer.label);
    return { update: (frame) => {
      setText(label, frame.timerRunning ? settings.timer.label : 'TIME STOPPED');
      setText(value, formatElapsedTime(frame.elapsed));
    } };
  },
});

// Builds `name`'s readout from `factory` in `mount`, checking what it returns.
export function createHudReadout(name: HudReadoutName | 'extras', factory: HudReadoutFactory, mount: HTMLElement, settings: HudSettings,
  plugin: string | null): HudReadout {
  const point = HUD[name].id;
  try {
    const readout: unknown = factory(mount, settings);
    if (typeof readout !== 'object' || readout === null || Array.isArray(readout) ||
      typeof Reflect.get(readout, 'update') !== 'function' ||
      Reflect.get(readout, 'dispose') !== undefined && typeof Reflect.get(readout, 'dispose') !== 'function') {
      throw new PluginError('invalid-contribution',
        `Plugin "${plugin ?? 'engine'}": the HUD's ${name} readout must return update(frame) and, when given, dispose().`, plugin, point);
    }
    return readout as HudReadout;
  } catch (error) {
    if (error instanceof PluginError && error.plugin === plugin && error.point === point) throw error;
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${point}".`, plugin, point, { cause: error });
  }
}
