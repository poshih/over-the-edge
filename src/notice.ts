import { element, setText } from './dom';

export function createNotice(options: { mount: HTMLElement }) {
  const events = new AbortController();
  const root = document.createElement('div');
  root.className = 'ui-notice';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-atomic', 'true');
  root.hidden = true;
  root.innerHTML = `
    <div><p class="notice-heading">A QUICK NOTE</p><p class="notice-message"></p></div>
    <button type="button" class="icon-button dismiss-notice" aria-label="Dismiss notification">
      <span class="close-icon" aria-hidden="true"></span>
    </button>
  `;
  const heading = element<HTMLElement>(root, '.notice-heading');
  const message = element<HTMLElement>(root, '.notice-message');
  element<HTMLButtonElement>(root, '.dismiss-notice').addEventListener('click', () => {
    root.hidden = true;
  }, { signal: events.signal });
  options.mount.append(root);
  return {
    show(text: string, kind: 'info' | 'error'): void {
      root.dataset.kind = kind;
      setText(heading, kind === 'error' ? 'NEEDS ATTENTION' : 'A QUICK NOTE');
      setText(message, text);
      root.hidden = false;
    },
    dispose(): void {
      events.abort();
      root.remove();
    },
  };
}
