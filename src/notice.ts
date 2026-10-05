import { element, setText } from './dom';
import { PluginError, slotPoint } from './plugins/kernel';

export interface Notices {
  show(text: string, kind: 'info' | 'error'): void;
  dispose(): void;
}
export type NoticesFactory = (mount: HTMLElement) => Notices;

// Release-shell chrome: it outlives load attempts and Games. The Workshop keeps its own notices.
export const NOTICES = slotPoint('release.notices', 'release', (value: unknown): NoticesFactory => {
  if (typeof value !== 'function') throw new TypeError('Notices must be a factory.');
  return value as NoticesFactory;
});
export const DEFAULT_NOTICES: NoticesFactory = (mount) => createNotice({ mount });

export function createNotices(factory: NoticesFactory, mount: HTMLElement, plugin: string | null): Notices {
  try {
    const notices: unknown = factory(mount);
    if (typeof notices !== 'object' || notices === null || Array.isArray(notices) ||
      typeof Reflect.get(notices, 'show') !== 'function' || typeof Reflect.get(notices, 'dispose') !== 'function') {
      throw new PluginError('invalid-contribution',
        `Plugin "${plugin ?? 'engine'}": "${NOTICES.id}" must return show(text, kind) and dispose().`, plugin, NOTICES.id);
    }
    return notices as Notices;
  } catch (error) {
    if (error instanceof PluginError && error.plugin === plugin && error.point === NOTICES.id) throw error;
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${NOTICES.id}".`,
      plugin, NOTICES.id, { cause: error });
  }
}

export function createNotice(options: { mount: HTMLElement }): Notices {
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
