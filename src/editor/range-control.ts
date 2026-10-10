export interface RangeControl {
  row: HTMLDivElement;
  input: HTMLInputElement;
  setValue: (value: number, options?: { disabled?: boolean }) => void;
}

interface RangeSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  description?: string;
}

// What groups a scrub into one undo step: History, or anything that coalesces and seals as it does.
export interface ScrubHistory {
  coalescing<R>(key: string, label: string, run: () => R): R;
  seal(key: string): void;
}

export interface RangeControlOptions {
  id: string;
  name: string;
  signal: AbortSignal;
  onInput: (value: number) => void;
  // How the readout shows a value; by default the number and the field's unit.
  format?: (value: number) => string;
  // Makes each scrub one undo step, keyed by the input's ID and named stepLabel ("Set <label>" by default).
  history?: ScrubHistory;
  stepLabel?: string;
  // The undo key instead of the ID, for a control that edits whichever layer or part is selected.
  coalesceKey?: () => string;
}

// Edits made on each input event take the input's ID, or its target's coalesceKey, as their undo key, and change seals
// it: a scrub, a held arrow key or a burst of clicks whose gaps are each under a second is one step. An input for another
// target seals the previous key first, so two targets never share a step.
export function bindScrubInput(input: HTMLInputElement, options: {
  readonly history: ScrubHistory;
  readonly label: string;
  readonly signal: AbortSignal;
  readonly onInput: () => void;
  readonly coalesceKey?: () => string;
}): void {
  const { history, coalesceKey } = options;
  if (coalesceKey === undefined && input.id === '') throw new Error('A scrubbed input needs an ID, its undo key.');
  // The key of the latest input until change seals it.
  let open: string | null = null;
  input.addEventListener('input', () => {
    const key = coalesceKey === undefined ? input.id : coalesceKey();
    if (key === '') throw new Error('A scrub needs an undo key.');
    if (open !== null && open !== key) history.seal(open);
    open = key;
    history.coalescing(key, options.label, options.onInput);
  }, { signal: options.signal });
  input.addEventListener('change', () => {
    if (open === null) return;
    history.seal(open);
    open = null;
  }, { signal: options.signal });
}

export function createRangeControl(field: RangeSpec, options: RangeControlOptions): RangeControl {
  const row = document.createElement('div');
  row.className = 'tuning-field';
  const heading = document.createElement('div');
  heading.className = 'tuning-label-row';
  const label = document.createElement('label');
  label.htmlFor = options.id;
  label.textContent = field.label;
  const output = document.createElement('output');
  output.htmlFor = options.id;
  output.setAttribute('aria-live', 'off');
  const controls = document.createElement('div');
  controls.className = 'range-controls';
  const input = document.createElement('input');
  input.type = 'range';
  input.id = options.id;
  input.name = options.name;
  input.min = String(field.min);
  input.max = String(field.max);
  input.step = String(field.step);
  const decrease = document.createElement('button');
  const increase = document.createElement('button');
  for (const [button, text, action] of [
    [decrease, '-', 'Decrease'], [increase, '+', 'Increase'],
  ] as const) {
    button.type = 'button';
    button.className = 'button range-step';
    button.textContent = text;
    button.setAttribute('aria-label', `${action} ${field.label}`);
  }
  const updateButtons = (): void => {
    decrease.disabled = input.disabled || input.valueAsNumber <= Number(input.min);
    increase.disabled = input.disabled || input.valueAsNumber >= Number(input.max);
  };
  const step = (direction: 'down' | 'up'): void => {
    if (input.matches(':disabled')) return;
    if (direction === 'up') input.stepUp();
    else input.stepDown();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  decrease.addEventListener('click', () => step('down'), { signal: options.signal });
  increase.addEventListener('click', () => step('up'), { signal: options.signal });
  const changed = (): void => {
    updateButtons();
    options.onInput(input.valueAsNumber);
  };
  if (options.history === undefined) input.addEventListener('input', changed, { signal: options.signal });
  else bindScrubInput(input, {
    history: options.history, label: options.stepLabel ?? `Set ${field.label}`, signal: options.signal, onInput: changed,
    coalesceKey: options.coalesceKey,
  });
  heading.append(label, output);
  controls.append(decrease, input, increase);
  row.append(heading, controls);
  if (field.description) {
    label.title = field.description;
    input.title = field.description;
    const description = document.createElement('p');
    description.id = `${input.id}-description`;
    description.className = 'visually-hidden';
    description.textContent = field.description;
    input.setAttribute('aria-describedby', description.id);
    row.append(description);
  }
  return {
    row,
    input,
    setValue: (value, state = {}) => {
      input.value = String(value);
      input.disabled = state.disabled === true;
      const text = options.format?.(value)
        ?? `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${field.unit ? ` ${field.unit}` : ''}`;
      if (output.textContent !== text) output.textContent = text;
      input.setAttribute('aria-valuetext', text);
      updateButtons();
    },
  };
}
