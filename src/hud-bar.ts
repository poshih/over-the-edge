import { createHudReadout, DEFAULT_HUD_READOUTS, HUD, HUD_READOUTS } from './hud-readouts';
import type { HudFrame, HudReadout, HudReadoutName } from './hud-readouts';
import type { HudSettings } from './hud';
import type { RuntimePlugins } from './plugins/runtime';
import { call0, call1 } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import { Disposal } from './disposal';
import './hud-bar.css';

interface Shown {
  readonly name: HudReadoutName | 'extras';
  readonly slot: HTMLElement;
  readonly readout: Attributed<HudReadout>;
}

// Both release and Workshop resolve the same factories. Settings changes rebuild the bar, not the session.
export function createHudBar(plugins: RuntimePlugins, settings: HudSettings) {
  const root = document.createElement('div');
  root.className = 'hud-bar';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Climb statistics');
  const shown: Shown[] = [];
  const dispose = (): void => {
    const disposal = new Disposal();
    for (const { readout } of shown.splice(0)) {
      if (readout.value.dispose !== undefined) disposal.run(() => call0(readout, 'dispose'));
    }
    disposal.run(() => root.remove());
    disposal.finish();
  };
  try {
    // Resolve the complete catalogue even when project settings hide a slot. A bad wrapper must not wait until a
    // later visibility edit to be refused, and wrapping still runs only once for this runtime session.
    const factories = {
      level: plugins.slot(HUD.level, DEFAULT_HUD_READOUTS.level),
      height: plugins.slot(HUD.height, DEFAULT_HUD_READOUTS.height),
      health: plugins.slot(HUD.health, DEFAULT_HUD_READOUTS.health),
      timer: plugins.slot(HUD.timer, DEFAULT_HUD_READOUTS.timer),
    };
    for (const name of HUD_READOUTS) {
      if (name === 'level' && !settings.level.visible || name === 'height' && !settings.height.visible ||
        name === 'timer' && !settings.timer.visible) continue;
      const factory = factories[name];
      const slot = document.createElement('div');
      slot.className = `hud-slot hud-${name}`;
      // Health shows only in levels that can hurt, and the level only when it has a name.
      slot.hidden = name === 'health' || name === 'level';
      root.append(slot);
      const readout = createHudReadout(factory, slot, settings);
      shown.push({ name, slot, readout });
    }
    for (const factory of plugins.list(HUD.extras)) {
      const slot = document.createElement('div');
      slot.className = 'hud-slot hud-extra';
      root.append(slot);
      const readout = createHudReadout(factory, slot, settings);
      shown.push({ name: 'extras', slot, readout });
    }
  } catch (error) {
    // Construction failed first; complete teardown without replacing that refusal.
    try { dispose(); } finally { throw error; }
  }
  return {
    root,
    update(frame: HudFrame): void {
      for (const { name, slot, readout } of shown) {
        if (name === 'health' && slot.hidden !== (frame.health === null)) slot.hidden = frame.health === null;
        else if (name === 'level' && slot.hidden !== (frame.level === null)) slot.hidden = frame.level === null;
        call1(readout, 'update', frame);
      }
    },
    dispose,
  };
}
