import { element, formatElapsedTime, setText } from './dom';
import { createNotice } from './notice';
import type { CharacterRiggingType } from './sprite-data';

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

export function createPlayUI(options: { mount: HTMLElement; characters?: PlayCharacterChoice | null }) {
  const root = document.createElement('div');
  root.className = 'game-ui play-ui';
  root.innerHTML = `
    <dl class="play-hud" aria-label="Climb statistics">
      <div>
        <dt>CURRENT HEIGHT</dt>
        <dd><span class="height-value">0.0</span><span class="play-height-unit">m</span></dd>
      </div>
      <div>
        <dt>ELAPSED</dt>
        <dd class="elapsed-value">00:00</dd>
      </div>
    </dl>
  `;
  const height = element<HTMLElement>(root, '.height-value');
  const elapsed = element<HTMLElement>(root, '.elapsed-value');
  const events = new AbortController();
  const inputs: HTMLInputElement[] = [];
  let selected = 0;
  const characters = options.characters ?? null;
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
    root.append(group);
  }
  const notice = createNotice({ mount: root });
  options.mount.append(root);
  return {
    update(state: { height: number; elapsed: number }): void {
      setText(height, state.height.toFixed(1));
      setText(elapsed, formatElapsedTime(state.elapsed));
    },
    notice: notice.show,
    // Enables the character choice once every profile has loaded; returns the restored choice.
    enableCharacters(): number {
      for (const input of inputs) input.disabled = false;
      return selected;
    },
    dispose(): void {
      events.abort();
      notice.dispose();
      root.remove();
    },
  };
}
