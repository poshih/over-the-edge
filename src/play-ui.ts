import { createNotices, DEFAULT_NOTICES } from './notice';
import type { NoticesFactory } from './notice';
import { CHARACTER_CHOICE, createCharacterChoice, DEFAULT_CHARACTER_CHOICE } from './character-choice';
import type { CharacterChoiceModel, CharacterChoiceView } from './character-choice';
import type { CharacterRiggingType } from './sprite-data';
import type { HudSettings } from './hud';
import { createHudBar } from './hud-bar';
import type { HudFrame } from './hud-readouts';
import type { RuntimePlugins } from './plugins/runtime';
import { PluginError } from './plugins/kernel';
import { Disposal } from './disposal';

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

// The release's interface. Notices work from the start; the readouts and the character choice appear
// once the release's content has said what they show.
export function createPlayUI(options: { mount: HTMLElement }) {
  const root = document.createElement('div');
  root.className = 'game-ui play-ui';
  // Release facets can report notices while starting, before their contributions compose.
  // The resolved replacement, if any, then serves the release until the UI is disposed.
  let notice = createNotices(DEFAULT_NOTICES, root, null);
  options.mount.append(root);
  let bar: ReturnType<typeof createHudBar> | null = null;
  let selected = 0;
  let characterView: CharacterChoiceView | null = null;
  let characterMount: HTMLElement | null = null;
  const clear = (): void => {
    const disposal = new Disposal();
    const previousBar = bar;
    const previousView = characterView;
    const previousMount = characterMount;
    bar = null;
    characterView = null;
    characterMount = null;
    disposal.run(() => previousBar?.dispose());
    disposal.run(() => previousView?.dispose());
    disposal.run(() => previousMount?.remove());
    disposal.finish();
  };
  return {
    // Called once after the release facets compose, never for an individual load attempt.
    setNotices(factory: NoticesFactory, plugin: string | null): void {
      if (factory === DEFAULT_NOTICES) return;
      const next = createNotices(factory, root, plugin);
      notice.dispose();
      notice = next;
    },
    // The project's settings choose visibility and labels; the runtime session chooses implementations.
    show(settings: { hud: HudSettings; plugins: RuntimePlugins; characters: PlayCharacterChoice | null }): void {
      clear();
      bar = createHudBar(settings.plugins, settings.hud);
      bar.root.classList.add('play-hud');
      const shown: HTMLElement[] = [bar.root];
      const characters = settings.characters;
      const factory = settings.plugins.slot(CHARACTER_CHOICE, DEFAULT_CHARACTER_CHOICE);
      // A single-profile release shows no settings, exactly as before.
      if (characters !== null && characters.types.length === 2) {
        selected = storedCharacter(characters.types.length);
        const plugin = settings.plugins.owner(CHARACTER_CHOICE);
        const labels = Object.freeze(characterLabels(characters.types));
        const choice: CharacterChoiceModel = Object.freeze({
          labels,
          get selected() { return selected; },
          select(index: number): void {
            if (!Number.isInteger(index) || index < 0 || index >= labels.length) {
              throw new PluginError('invalid-contribution',
                `Plugin "${plugin ?? 'engine'}": "${CHARACTER_CHOICE.id}" must select an index from 0 to ${labels.length - 1}.`,
                plugin, CHARACTER_CHOICE.id);
            }
            selected = index;
            storeCharacter(index);
            characters.onSelect(index);
          },
        });
        characterMount = document.createElement('div');
        characterView = createCharacterChoice(factory, characterMount, choice, plugin);
        characterView.setEnabled(false);
        shown.push(characterMount);
      }
      root.prepend(...shown);
    },
    update(frame: HudFrame): void {
      bar?.update(frame);
    },
    notice(text: string, kind: 'info' | 'error'): void {
      notice.show(text, kind);
    },
    clear,
    // Enables the character choice once every profile has loaded; returns the restored choice.
    enableCharacters(): number {
      characterView?.setEnabled(true);
      return selected;
    },
    dispose(): void {
      const disposal = new Disposal();
      disposal.run(clear);
      disposal.run(() => notice.dispose());
      disposal.run(() => root.remove());
      disposal.finish();
    },
  };
}
