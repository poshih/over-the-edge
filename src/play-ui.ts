import { createNotices, DEFAULT_NOTICES, NOTICES } from './notice';
import type { NoticesFactory } from './notice';
import { CHARACTER_CHOICE, createCharacterChoice, DEFAULT_CHARACTER_CHOICE } from './character-choice';
import type { CharacterChoiceModel, CharacterChoiceView } from './character-choice';
import type { CharacterRiggingType } from './sprite-data';
import type { HudSettings } from './hud';
import { createHudBar } from './hud-bar';
import type { HudFrame } from './hud-readouts';
import type { RuntimePlugins } from './plugins/runtime';
import { attributed, call0, call1, call2, invalidResult } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import { Disposal } from './disposal';

const CHARACTER_LABELS: Readonly<Record<CharacterRiggingType, string>> = {
  'sprite-2d': '2D', 'model-3d': '3D', 'avatar-3d': '3D',
};

export interface PlayCharacterChoice {
  readonly types: readonly CharacterRiggingType[];
  // The player's choice, which the release keeps with their other settings.
  readonly selected: number;
  readonly onSelect: (index: number) => void;
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
  let notice = createNotices(attributed(null, NOTICES.id, DEFAULT_NOTICES), root);
  options.mount.append(root);
  let bar: ReturnType<typeof createHudBar> | null = null;
  let selected = 0;
  let characterView: Attributed<CharacterChoiceView> | null = null;
  let characterMount: HTMLElement | null = null;
  let menuMount: HTMLElement | null = null;
  const clear = (): void => {
    const disposal = new Disposal();
    const previousBar = bar;
    const previousView = characterView;
    const previousMount = characterMount;
    const previousMenu = menuMount;
    bar = null;
    characterView = null;
    characterMount = null;
    menuMount = null;
    disposal.run(() => previousBar?.dispose());
    if (previousView !== null) disposal.run(() => call0(previousView, 'dispose'));
    disposal.run(() => previousMount?.remove());
    disposal.run(() => previousMenu?.remove());
    disposal.finish();
  };
  return {
    // Called once after the release facets compose, never for an individual load attempt.
    setNotices(factory: Attributed<NoticesFactory>): void {
      if (factory.value === DEFAULT_NOTICES) return;
      const next = createNotices(factory, root);
      call0(notice, 'dispose');
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
        selected = characters.selected;
        const labels = Object.freeze(characterLabels(characters.types));
        const choice: CharacterChoiceModel = Object.freeze({
          labels,
          get selected() { return selected; },
          // The release keeps the choice with the player's settings and shows it back through setCharacter().
          select(index: number): void {
            if (!Number.isInteger(index) || index < 0 || index >= labels.length) {
              throw invalidResult(factory, `must select an index from 0 to ${labels.length - 1}`);
            }
            characters.onSelect(index);
          },
        });
        characterMount = document.createElement('div');
        characterView = createCharacterChoice(factory, characterMount, choice);
        call1(characterView, 'setEnabled', false);
        shown.push(characterMount);
      }
      root.prepend(...shown);
    },
    update(frame: HudFrame): void {
      bar?.update(frame);
    },
    notice(text: string, kind: 'info' | 'error'): void {
      call2(notice, 'show', text, kind);
    },
    clear,
    // Enables the character choice once every profile has loaded.
    enableCharacters(): void {
      if (characterView !== null) call1(characterView, 'setEnabled', true);
    },
    // Shows the character the release selected, from the choice itself or from elsewhere, such as the game's menu.
    setCharacter(index: number): void {
      selected = index;
      const view = characterView;
      if (view !== null && view.value.setSelected !== undefined) call1(view, 'setSelected', index);
    },
    // An empty layer for the game's main menu: over the readouts and the character choice, under notices.
    addMenu(): HTMLElement {
      const shown = bar;
      if (shown === null) throw new Error('The play UI shows no game to put a menu over.');
      const mount = document.createElement('div');
      mount.className = 'play-menu';
      (characterMount ?? shown.root).after(mount);
      menuMount = mount;
      return mount;
    },
    dispose(): void {
      const disposal = new Disposal();
      disposal.run(clear);
      disposal.run(() => call0(notice, 'dispose'));
      disposal.run(() => root.remove());
      disposal.finish();
    },
  };
}
