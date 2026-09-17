import { element, formatElapsedTime, setText } from './dom';
import { createNotice } from './notice';

export function createPlayUI(options: { mount: HTMLElement }) {
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
  const notice = createNotice({ mount: root });
  options.mount.append(root);
  return {
    update(state: { height: number; elapsed: number }): void {
      setText(height, state.height.toFixed(1));
      setText(elapsed, formatElapsedTime(state.elapsed));
    },
    notice: notice.show,
    dispose(): void {
      notice.dispose();
      root.remove();
    },
  };
}
