import gameTitle from 'virtual:game-title';
import type { InputMode, UiAction, UiActionOptions } from '../config';
import { element, setText } from '../dom';
import { DEFAULT_INPUT_BINDINGS, INPUT_BINDINGS, inputModeForPointer } from '../input';
import { createNotice } from '../notice';
import { DEFAULT_HUD, formatHeight } from '../hud';
import type { HudSettings } from '../hud';
import { createHudBar } from '../hud-bar';
import type { HudFrame } from '../hud-readouts';
import type { RuntimePlugins } from '../plugins/runtime';

export const DESKTOP_QUERY = '(min-width: 1040px)';

export function createGameUI(options: {
  mount: HTMLElement;
  plugins: RuntimePlugins;
  initialInputMode: InputMode;
  onAction: (action: UiAction, options?: UiActionOptions) => void;
}) {
  const events = new AbortController();
  const listen = { signal: events.signal };
  const desktop = window.matchMedia(DESKTOP_QUERY);
  const bindings = options.plugins.slot(INPUT_BINDINGS, DEFAULT_INPUT_BINDINGS).value;
  const shortcuts = { pause: '', reset: '' };
  for (const [key, action] of Object.entries(bindings)) {
    if (action !== 'pause' && action !== 'reset') continue;
    const label = key === ' ' ? 'Space' : key.toUpperCase();
    shortcuts[action] += `${shortcuts[action] === '' ? '' : ' / '}${label}`;
  }
  let inputMode = options.initialInputMode;
  const root = document.createElement('div');
  root.className = 'game-ui';
  root.innerHTML = `
    <div class="game-chrome">
      <header class="game-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div><p class="eyebrow">PHYSICS PLAYGROUND / 01</p><h1></h1></div>
        </div>
        <div class="game-toolbar">
          <div class="game-actions" role="group" aria-label="Game controls">
            <button type="button" class="button button-primary play-button" data-action="play">
              <span class="play-icon" aria-hidden="true"></span>Play
            </button>
            <button type="button" class="button" data-action="pause"><span class="pause-label">Pause</span></button>
            <button type="button" class="button" data-action="reset">Reset</button>
          </div>
          <p class="input-state"><span class="recording-state" title="Recording your play for phantoms" hidden><span
            class="recording-dot" aria-hidden="true"></span>REC</span><span class="state-dot" aria-hidden="true"></span><span
            class="input-state-text"></span></p>
        </div>
      </header>
      <section class="climb-hud" aria-label="Climb statistics">
        <div class="peak-metric">
          <p class="metric-label">PEAK</p><p class="metric-reading"><span class="peak-value">0.0</span><span class="small-unit">m</span></p>
        </div>
      </section>
      <footer class="game-help" aria-label="How to play">
        <div class="climbing-guide">
          <span class="mouse-icon" aria-hidden="true"></span>
          <div><p class="guide-heading">A good hold changes everything.</p><p class="input-instructions"></p></div>
        </div>
        <div class="key-guide">
          <span><kbd>DRAG</kbd>without capture</span>
          <span><kbd>ESC</kbd>release mouse</span><span data-key-hint="pause"><kbd></kbd>pause</span>
        </div>
        <p class="game-signature">TWO MOTORS. ONE MOUNTAIN. <span>YOUR WAY UP.</span></p>
      </footer>
    </div>
  `;
  const heading = element<HTMLHeadingElement>(root, '.brand h1');
  setText(heading, gameTitle);
  heading.title = gameTitle;
  const notice = createNotice({ mount: root });
  const actions = element<HTMLElement>(root, '.game-actions');
  const play = element<HTMLButtonElement>(root, '[data-action="play"]');
  const pause = element<HTMLButtonElement>(root, '[data-action="pause"]');
  const reset = element<HTMLButtonElement>(root, '[data-action="reset"]');
  const pauseLabel = element<HTMLElement>(root, '.pause-label');
  const inputState = element<HTMLElement>(root, '.input-state');
  const inputStateText = element<HTMLElement>(root, '.input-state-text');
  const recording = element<HTMLElement>(root, '.recording-state');
  const peak = element<HTMLElement>(root, '.peak-value');
  const peakMetric = element<HTMLElement>(root, '.peak-metric');
  const peakUnit = element<HTMLElement>(root, '.small-unit');
  const climb = element<HTMLElement>(root, '.climb-hud');
  let hud: HudSettings = DEFAULT_HUD;
  let bar = createHudBar(options.plugins, hud);
  bar.root.classList.add('workshop-hud');
  climb.prepend(bar.root);
  const instructions = element<HTMLElement>(root, '.input-instructions');
  const mouseIcon = element<HTMLElement>(root, '.mouse-icon');
  const guideHeading = element<HTMLElement>(root, '.guide-heading');
  const keyGuide = element<HTMLElement>(root, '.key-guide');
  const pauseHint = element<HTMLElement>(root, '[data-key-hint="pause"]');
  pauseHint.hidden = shortcuts.pause === '';
  setText(element<HTMLElement>(pauseHint, 'kbd'), shortcuts.pause.toUpperCase());
  for (const action of ['play', 'pause', 'reset'] as const) {
    element<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', (event) => {
      options.onAction(action, { inputMode: event instanceof PointerEvent ? inputModeForPointer(event.pointerType) : undefined });
    }, listen);
  }
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
    pause.title = !touch && shortcuts.pause !== '' ? `Pause or resume (${shortcuts.pause})` : 'Pause or resume';
    reset.title = !touch && shortcuts.reset !== '' ? `Restart (${shortcuts.reset})` : 'Restart';
    setText(instructions, touch ? 'Drag anywhere with one finger. Lift and reposition to continue.' :
      'Move your mouse to guide the hammer. Plant, push, pull.');
  }
  desktop.addEventListener('change', density, listen);
  options.mount.append(root);
  setMode(inputMode);
  return {
    root,
    actions,
    // Keeps the title and readouts legible when a project's sky is dark.
    setSceneTone: (dark: boolean): void => {
      root.dataset.scene = dark ? 'dark' : 'light';
    },
    // Previews a project's HUD labels, units and visibility on the Workshop readout.
    setHud: (next: HudSettings): void => {
      if (next === hud) return;
      hud = next;
      bar.dispose();
      bar = createHudBar(options.plugins, hud);
      bar.root.classList.add('workshop-hud');
      climb.prepend(bar.root);
      setText(peakUnit, hud.height.unit);
      peakMetric.hidden = !hud.height.visible;
    },
    update: (state: HudFrame, capturing: boolean): void => {
      if (inputMode !== state.inputMode) setMode(state.inputMode);
      bar.update(state);
      setText(peak, formatHeight(hud, state.bestHeight));
      setText(pauseLabel, state.paused ? 'Resume' : 'Pause');
      pause.classList.toggle('is-active', state.paused);
      play.classList.toggle('is-active', !state.paused && (state.pointerLocked || state.inputMode === 'touch'));
      const touch = state.inputMode === 'touch';
      const mode = state.paused ? 'paused' : touch ? 'touch' : state.pointerLocked ? 'captured' : 'free';
      if (inputState.dataset.mode !== mode) inputState.dataset.mode = mode;
      if (recording.hidden === capturing) recording.hidden = !capturing;
      const pausedHint = touch ? 'tap Play to continue' : state.pointerLocked ? 'Esc to release mouse' : 'take your time';
      setText(inputStateText, state.paused ? `Paused - ${pausedHint}` :
        touch ? 'Touch controls - drag anywhere' :
          state.pointerLocked ? 'Mouse captured - Esc to release' : 'Hold + drag, or Play to capture');
    },
    notice: notice.show,
    dispose: (): void => {
      events.abort();
      bar.dispose();
      notice.dispose();
      root.remove();
      document.body.classList.remove('touch-controls');
      delete document.body.dataset.inputMode;
    },
  };
}
