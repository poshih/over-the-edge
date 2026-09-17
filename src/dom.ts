export function element<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const result = root.querySelector<T>(selector);
  if (!result) throw new Error(`Missing UI element: ${selector}`);
  return result;
}

export function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) target.textContent = text;
}

export function formatElapsedTime(elapsed: number): string {
  const seconds = Math.floor(Math.max(0, elapsed));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  const value = String(pressed);
  if (button.getAttribute('aria-pressed') !== value) button.setAttribute('aria-pressed', value);
}
