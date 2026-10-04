import { createRangeControl } from './range-control';
import type { WorkshopOption, WorkshopRange, WorkshopSelect, WorkshopToggle, WorkshopUiKit } from './workshop-sdk';

/**
 * A Workshop plugin's UI kit (WorkshopUiKit): the Workshop's own controls and styles, so plugin UI looks and behaves like
 * the built-in tabs. Each control's callback runs guarded, so an error it throws stops the plugin, and its listeners go
 * with `signal` when the plugin stops.
 */
export function createWorkshopUiKit(options: {
  // Unique per plugin, for the controls' element IDs.
  readonly prefix: string;
  readonly signal: AbortSignal;
  readonly guard: <A extends unknown[]>(callback: (...args: A) => void) => (...args: A) => void;
  readonly notice: (message: string, kind?: 'info' | 'error') => void;
}): WorkshopUiKit {
  const listen = { signal: options.signal };
  let next = 0;
  const id = (): string => `${options.prefix}-control-${++next}`;
  const fillOptions = (select: HTMLSelectElement, entries: readonly WorkshopOption[]): void => {
    select.replaceChildren(...entries.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      return option;
    }));
  };
  const kit: WorkshopUiKit = {
    range(spec): WorkshopRange {
      const onInput = options.guard((value: number) => spec.onInput(value));
      const control = createRangeControl({
        label: spec.label, min: spec.min, max: spec.max, step: spec.step, unit: spec.unit ?? '', description: spec.description,
      }, { id: id(), name: spec.label, signal: options.signal, onInput: (value) => onInput(value) });
      control.setValue(spec.value);
      return { element: control.row, input: control.input, set: (value, state) => control.setValue(value, state) };
    },
    button(spec): HTMLButtonElement {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = spec.label;
      if (spec.title !== undefined) button.title = spec.title;
      button.addEventListener('click', options.guard(() => spec.onClick()), listen);
      return button;
    },
    select(spec): WorkshopSelect {
      const element = document.createElement('div');
      element.className = 'workshop-plugin-field';
      const label = document.createElement('label');
      label.className = 'appearance-label';
      const select = document.createElement('select');
      select.id = id();
      label.htmlFor = select.id;
      label.textContent = spec.label;
      fillOptions(select, spec.options);
      select.value = spec.value;
      element.append(label, select);
      const onChange = options.guard((value: string) => spec.onChange(value));
      select.addEventListener('change', () => onChange(select.value), listen);
      return {
        element, select,
        set: (value, state = {}) => {
          if (state.options !== undefined) fillOptions(select, state.options);
          select.value = value;
          select.disabled = state.disabled === true;
        },
      };
    },
    toggle(spec): WorkshopToggle {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'quick-toggle';
      const text = document.createElement('span');
      text.textContent = spec.label;
      const track = document.createElement('span');
      track.className = 'toggle-track';
      track.setAttribute('aria-hidden', 'true');
      element.append(text, track);
      if (spec.title !== undefined) element.title = spec.title;
      const set = (value: boolean, state: { readonly disabled?: boolean } = {}): void => {
        element.setAttribute('aria-pressed', String(value));
        element.disabled = state.disabled === true;
      };
      set(spec.value);
      const onChange = options.guard((value: boolean) => spec.onChange(value));
      element.addEventListener('click', () => {
        const value = element.getAttribute('aria-pressed') !== 'true';
        set(value, { disabled: element.disabled });
        onChange(value);
      }, listen);
      return { element, set };
    },
    group(legend): HTMLFieldSetElement {
      const group = document.createElement('fieldset');
      group.className = 'tuning-group';
      const title = document.createElement('legend');
      title.textContent = legend;
      group.append(title);
      return group;
    },
    note(text): HTMLParagraphElement {
      const note = document.createElement('p');
      note.className = 'appearance-format';
      note.textContent = text;
      return note;
    },
    notice: (message, kind = 'info') => options.notice(message, kind),
  };
  return Object.freeze(kit);
}
