import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';

// The engine owns selection and persistence. Views read the current index and request a choice through select().
export interface CharacterChoiceModel {
  readonly labels: readonly string[];
  readonly selected: number;
  readonly select: (index: number) => void;
}

export interface CharacterChoiceView {
  setEnabled(enabled: boolean): void;
  // Shows a choice made elsewhere, such as in the game's main menu.
  setSelected?(index: number): void;
  dispose(): void;
}

export type CharacterChoiceFactory = (mount: HTMLElement, choice: CharacterChoiceModel) => CharacterChoiceView;

// Per-Game play chrome, shown by releases and studio previews; the Workshop keeps its own character controls.
export const CHARACTER_CHOICE = slotPoint('ui.character-choice', 'runtime', (value: unknown): CharacterChoiceFactory => {
  if (typeof value !== 'function') throw new TypeError('Character choice must be a factory.');
  return value as CharacterChoiceFactory;
});

export const DEFAULT_CHARACTER_CHOICE: CharacterChoiceFactory = (mount, choice) => {
  const events = new AbortController();
  const inputs: HTMLInputElement[] = [];
  mount.className = 'play-character';
  mount.setAttribute('role', 'radiogroup');
  mount.setAttribute('aria-label', 'Character');
  const heading = document.createElement('span');
  heading.className = 'play-character-label';
  heading.setAttribute('aria-hidden', 'true');
  heading.textContent = 'CHARACTER';
  mount.append(heading);
  choice.labels.forEach((label, index) => {
    const option = document.createElement('label');
    option.className = 'play-character-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'play-character';
    input.value = String(index);
    input.checked = index === choice.selected;
    input.disabled = true;
    input.addEventListener('change', () => {
      if (input.checked) choice.select(index);
    }, { signal: events.signal });
    const text = document.createElement('span');
    text.textContent = label;
    option.append(input, text);
    mount.append(option);
    inputs.push(input);
  });
  return {
    setEnabled(enabled): void {
      for (const input of inputs) input.disabled = !enabled;
    },
    setSelected(index): void {
      const input = inputs[index];
      if (input !== undefined) input.checked = true;
    },
    dispose(): void {
      events.abort();
    },
  };
};

const CHARACTER_CHOICE_CONTRACT = instanceContract({
  returns: 'setEnabled(enabled), dispose() and, when given, setSelected(index)',
  methods: ['setEnabled', 'dispose'],
  optional: ['setSelected'],
});

export function createCharacterChoice(factory: Attributed<CharacterChoiceFactory>, mount: HTMLElement,
  choice: CharacterChoiceModel): Attributed<CharacterChoiceView> {
  const create = factory.value;
  return createInstance(CHARACTER_CHOICE_CONTRACT, factory, () => create(mount, choice));
}
