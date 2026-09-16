import type { InputMode, UiAction, UiActionOptions } from './config';
import { element, setText } from './dom';
import { inputModeForPointer } from './input';

export const DESKTOP_QUERY = '(min-width: 1040px)';

export interface GameHudState {
  height: number;
  bestHeight: number;
  elapsed: number;
  paused: boolean;
  pointerLocked: boolean;
  inputMode: InputMode;
  timerRunning: boolean;
}

export function createGameUI(options: {
  mount: HTMLElement;
  initialInputMode: InputMode;
  onAction: (action: UiAction, options?: UiActionOptions) => void;
}) {
  const events = new AbortController();
  const listen = { signal: events.signal };
  const desktop = window.matchMedia(DESKTOP_QUERY);
  let inputMode = options.initialInputMode;
  const root = document.createElement('div');
  root.className = 'game-ui';
  root.innerHTML = `
    <div class="game-chrome">
      <header class="game-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div><p class="eyebrow">PHYSICS PLAYGROUND / 01</p><h1>OVER THE EDGE</h1></div>
        </div>
        <div class="game-toolbar">
          <div class="game-actions" role="group" aria-label="Game controls">
            <button type="button" class="button button-primary play-button" data-action="play">
              <span class="play-icon" aria-hidden="true"></span>Play
            </button>
            <button type="button" class="button" data-action="pause"><span class="pause-label">Pause</span></button>
            <button type="button" class="button" data-action="reset">Reset</button>
          </div>
          <p class="input-state"><span class="state-dot" aria-hidden="true"></span><span class="input-state-text"></span></p>
        </div>
      </header>
      <section class="climb-hud" aria-label="Climb statistics">
        <div class="height-metric">
          <p class="eyebrow">CURRENT HEIGHT</p>
          <p class="height-reading"><span class="height-value">0.0</span><span class="metric-unit">m</span></p>
        </div>
        <div class="secondary-metrics">
          <div><p class="metric-label">PEAK</p><p class="metric-reading"><span class="peak-value">0.0</span><span class="small-unit">m</span></p></div>
          <div><p class="metric-label timer-label">ELAPSED</p><p class="metric-reading elapsed-value">00:00</p></div>
        </div>
      </section>
      <footer class="game-help" aria-label="How to play">
        <div class="climbing-guide">
          <span class="mouse-icon" aria-hidden="true"></span>
          <div><p class="guide-heading">A good hold changes everything.</p><p class="input-instructions"></p></div>
        </div>
        <div class="key-guide">
          <span><kbd>DRAG</kbd>without capture</span>
          <span><kbd>ESC</kbd>release mouse</span><span><kbd>SPACE</kbd>pause</span>
        </div>
        <p class="game-signature">TWO MOTORS. ONE MOUNTAIN. <span>YOUR WAY UP.</span></p>
      </footer>
    </div>
    <div class="ui-notice" role="status" aria-live="polite" aria-atomic="true" hidden>
      <div><p class="notice-heading">A QUICK NOTE</p><p class="notice-message"></p></div>
      <button type="button" class="icon-button dismiss-notice" aria-label="Dismiss notification">
        <span class="close-icon" aria-hidden="true"></span>
      </button>
    </div>
  `;
  const actions = element<HTMLElement>(root, '.game-actions');
  const play = element<HTMLButtonElement>(root, '[data-action="play"]');
  const pause = element<HTMLButtonElement>(root, '[data-action="pause"]');
  const reset = element<HTMLButtonElement>(root, '[data-action="reset"]');
  const pauseLabel = element<HTMLElement>(root, '.pause-label');
  const inputState = element<HTMLElement>(root, '.input-state');
  const inputStateText = element<HTMLElement>(root, '.input-state-text');
  const height = element<HTMLElement>(root, '.height-value');
  const peak = element<HTMLElement>(root, '.peak-value');
  const elapsed = element<HTMLElement>(root, '.elapsed-value');
  const timerLabel = element<HTMLElement>(root, '.timer-label');
  const noticeBox = element<HTMLElement>(root, '.ui-notice');
  const noticeHeading = element<HTMLElement>(root, '.notice-heading');
  const noticeMessage = element<HTMLElement>(root, '.notice-message');
  const instructions = element<HTMLElement>(root, '.input-instructions');
  const mouseIcon = element<HTMLElement>(root, '.mouse-icon');
  const guideHeading = element<HTMLElement>(root, '.guide-heading');
  const keyGuide = element<HTMLElement>(root, '.key-guide');
  for (const action of ['play', 'pause', 'reset'] as const) {
    element<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', (event) => {
      options.onAction(action, { inputMode: event instanceof PointerEvent ? inputModeForPointer(event.pointerType) : undefined });
    }, listen);
  }
  element<HTMLButtonElement>(root, '.dismiss-notice').addEventListener('click', () => { noticeBox.hidden = true; }, listen);
  const density = (): void => {
    document.body.classList.toggle('touch-controls', inputMode === 'touch' || !desktop.matches);
  };
  function setMode(mode: InputMode): void {
    inputMode = mode;
    document.body.dataset.inputMode = mode;
    density();
    const touch = mode === 'touch';
    mouseIcon.hidden = touch;
    guideHeading.hidden = touch;
    keyGuide.hidden = touch;
    play.title = touch ? 'Resume touch controls' : 'Play and capture the mouse. Press Esc to release.';
    pause.title = touch ? 'Pause or resume' : 'Pause or resume (Space)';
    reset.title = touch ? 'Restart' : 'Restart (R)';
    setText(instructions, touch ? 'Drag anywhere with one finger. Lift and reposition to continue.' :
      'Move your mouse to guide the hammer. Plant, push, pull.');
  }
  desktop.addEventListener('change', density, listen);
  options.mount.append(root);
  setMode(inputMode);
  return {
    root,
    actions,
    update: (state: GameHudState): void => {
      if (inputMode !== state.inputMode) setMode(state.inputMode);
      setText(height, state.height.toFixed(1));
      setText(peak, state.bestHeight.toFixed(1));
      const seconds = Math.floor(Math.max(0, state.elapsed));
      setText(elapsed, `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
      setText(timerLabel, state.timerRunning ? 'ELAPSED' : 'TIME STOPPED');
      setText(pauseLabel, state.paused ? 'Resume' : 'Pause');
      pause.classList.toggle('is-active', state.paused);
      play.classList.toggle('is-active', !state.paused && (state.pointerLocked || state.inputMode === 'touch'));
      const touch = state.inputMode === 'touch';
      const mode = state.paused ? 'paused' : touch ? 'touch' : state.pointerLocked ? 'captured' : 'free';
      if (inputState.dataset.mode !== mode) inputState.dataset.mode = mode;
      const pausedHint = touch ? 'tap Play to continue' : state.pointerLocked ? 'Esc to release mouse' : 'take your time';
      setText(inputStateText, state.paused ? `Paused - ${pausedHint}` :
        touch ? 'Touch controls - drag anywhere' :
          state.pointerLocked ? 'Mouse captured - Esc to release' : 'Hold + drag, or Play to capture');
    },
    notice: (message: string, kind: 'info' | 'error'): void => {
      noticeBox.dataset.kind = kind;
      setText(noticeHeading, kind === 'error' ? 'NEEDS ATTENTION' : 'A QUICK NOTE');
      setText(noticeMessage, message);
      noticeBox.hidden = false;
    },
    dispose: (): void => {
      events.abort();
      root.remove();
      document.body.classList.remove('touch-controls');
      delete document.body.dataset.inputMode;
    },
  };
}
