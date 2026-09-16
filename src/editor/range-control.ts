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

export function createRangeControl(field: RangeSpec, options: {
  id: string;
  name: string;
  signal: AbortSignal;
  onInput: (value: number) => void;
}): RangeControl {
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
    decrease.disabled = input.disabled || input.valueAsNumber <= field.min;
    increase.disabled = input.disabled || input.valueAsNumber >= field.max;
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
  input.addEventListener('input', () => {
    updateButtons();
    options.onInput(input.valueAsNumber);
  }, { signal: options.signal });
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
      const formatted = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const text = `${formatted}${field.unit ? ` ${field.unit}` : ''}`;
      if (output.textContent !== text) output.textContent = text;
      input.setAttribute('aria-valuetext', text);
      updateButtons();
    },
  };
}
