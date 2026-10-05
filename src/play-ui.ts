import { createNotice } from './notice';
import type { CharacterRiggingType } from './sprite-data';
import type { HudSettings } from './hud';
import { createHudReadout, DEFAULT_HUD_READOUTS, HUD_READOUTS } from './hud-readouts';
import type { HudFrame, HudReadout, HudReadoutName, HudReadouts } from './hud-readouts';

const CHARACTER_KEY = 'over-the-edge:play:character';
const CHARACTER_LABELS: Readonly<Record<CharacterRiggingType, string>> = {
  'sprite-2d': '2D', 'model-3d': '3D', 'avatar-3d': '3D',
};

export interface PlayCharacterChoice {
  readonly types: readonly CharacterRiggingType[];
  readonly onSelect: (index: number) => void;
}

// The player's last choice, when this release still has it; storage may be unavailable.
function storedCharacter(count: number): number {
  try {
    const value = Number(localStorage.getItem(CHARACTER_KEY));
    return Number.isInteger(value) && value >= 0 && value < count ? value : 0;
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return 0;
  }
}

function storeCharacter(index: number): void {
  try {
    localStorage.setItem(CHARACTER_KEY, String(index));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

export function characterLabels(types: readonly CharacterRiggingType[]): string[] {
  const labels = types.map(type => CHARACTER_LABELS[type]);
  return labels.map((label, index) => labels.indexOf(label) !== labels.lastIndexOf(label) ? `${label} ${index + 1}` : label);
}

// A readout in its slot of the HUD.
interface Shown {
  readonly name: HudReadoutName;
  readonly slot: HTMLElement;
  readonly readout: HudReadout;
}

// Whether the project's HUD settings show `name`'s readout; health shows wherever something can hurt the player.
function shows(hud: HudSettings, name: HudReadoutName): boolean {
  return name === 'height' ? hud.height.visible : name === 'timer' ? hud.timer.visible : true;
}

// The release's interface. Notices work from the start; the readouts and the character choice appear
// once the release's content has said what they show.
export function createPlayUI(options: { mount: HTMLElement }) {
  const root = document.createElement('div');
  root.className = 'game-ui play-ui';
  const events = new AbortController();
  const inputs: HTMLInputElement[] = [];
  const notice = createNotice({ mount: root });
  options.mount.append(root);
  const readouts: Shown[] = [];
  let selected = 0;
  return {
    // `readouts` are the game's own, from its module; the rest are the engine's. The project's HUD settings say which
    // show, and with what labels, units and formats.
    show(settings: { hud: HudSettings; readouts: HudReadouts; characters: PlayCharacterChoice | null }): void {
      const bar = document.createElement('div');
      bar.className = 'play-hud';
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Climb statistics');
      for (const name of HUD_READOUTS) {
        if (!shows(settings.hud, name)) continue;
        const slot = document.createElement('div');
        slot.className = `play-hud-slot play-hud-${name}`;
        // Health waits for the first frame to say whether anything can hurt the player.
        slot.hidden = name === 'health';
        bar.append(slot);
        readouts.push({ name, slot, readout: createHudReadout(name, settings.readouts[name] ?? DEFAULT_HUD_READOUTS[name], slot, settings.hud) });
      }
      const shown: HTMLElement[] = [bar];
      const characters = settings.characters;
      // A single-profile release shows no settings, exactly as before.
      if (characters !== null && characters.types.length > 1) {
        selected = storedCharacter(characters.types.length);
        const group = document.createElement('div');
        group.className = 'play-character';
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', 'Character');
        const heading = document.createElement('span');
        heading.className = 'play-character-label';
        heading.setAttribute('aria-hidden', 'true');
        heading.textContent = 'CHARACTER';
        group.append(heading);
        characterLabels(characters.types).forEach((label, index) => {
          const option = document.createElement('label');
          option.className = 'play-character-option';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'play-character';
          input.value = String(index);
          input.checked = index === selected;
          input.disabled = true;
          input.addEventListener('change', () => {
            if (!input.checked) return;
            selected = index;
            storeCharacter(index);
            characters.onSelect(index);
          }, { signal: events.signal });
          const text = document.createElement('span');
          text.textContent = label;
          option.append(input, text);
          group.append(option);
          inputs.push(input);
        });
        shown.push(group);
      }
      root.prepend(...shown);
    },
    update(frame: HudFrame): void {
      for (const { name, slot, readout } of readouts) {
        if (name === 'health' && slot.hidden !== (frame.health === null)) slot.hidden = frame.health === null;
        readout.update(frame);
      }
    },
    notice: notice.show,
    // Enables the character choice once every profile has loaded; returns the restored choice.
    enableCharacters(): number {
      for (const input of inputs) input.disabled = false;
      return selected;
    },
    dispose(): void {
      events.abort();
      for (const { readout } of readouts.splice(0)) readout.dispose?.();
      notice.dispose();
      root.remove();
    },
  };
}
