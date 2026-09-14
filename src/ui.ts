import { DEFAULT_TUNING, TUNING_FIELDS, TuningError, validateTuning } from './config';
import type { GameUi, HudState, InputMode, PracticeId, Tuning, UiOptions } from './config';
import { PRACTICES } from './course';
import { inputModeForPointer } from './input';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';

const STORAGE_KEY = 'over-the-edge:tuning:v2';
const LEGACY_STORAGE_KEY = 'over-the-edge:tuning:v1';
const SCHEMA_VERSION = 2;
// These were fixed physics values in v1, independent of future tuning defaults.
const V1_TOOL_MASSES = { shaftMass: 0.66, hingeCarrierMass: 0.5, sliderCarriageMass: 0.5 } as const;
const DESKTOP_QUERY = '(min-width: 1040px)';
const WORKSHOP_CLASS = 'workshop-open';

function element<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const result = root.querySelector<T>(selector);
  if (!result) throw new Error(`Missing UI element: ${selector}`);
  return result;
}

function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) target.textContent = text;
}

function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  const value = String(pressed);
  if (button.getAttribute('aria-pressed') !== value) {
    button.setAttribute('aria-pressed', value);
  }
}

function formatElapsed(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

class ProfileFormatError extends Error {}

function decodeProfile(serialized: string, version: 1 | 2): Tuning {
  const profile: unknown = JSON.parse(serialized);
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile) ||
    Object.keys(profile).length !== 2 ||
    !Object.hasOwn(profile, 'schemaVersion') || !Object.hasOwn(profile, 'tuning')) {
    throw new ProfileFormatError('Expected a versioned tuning profile with exactly schemaVersion and tuning.');
  }
  if (Reflect.get(profile, 'schemaVersion') !== version) {
    throw new ProfileFormatError(`Expected tuning profile version ${version}.`);
  }
  const settings: unknown = Reflect.get(profile, 'tuning');
  if (version === 1) {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new ProfileFormatError('Version 1 tuning must be an object.');
    }
    const legacyKeys = TUNING_FIELDS.map((field) => field.key)
      .filter((key) => !Object.hasOwn(V1_TOOL_MASSES, key));
    const keys = Object.keys(settings);
    if (keys.length !== legacyKeys.length || keys.some((key) => !legacyKeys.some((known) => known === key))) {
      throw new ProfileFormatError('Version 1 tuning contains missing or unknown settings.');
    }
    return validateTuning({ ...settings, ...V1_TOOL_MASSES });
  }
  return validateTuning(settings);
}

export function createUI(options: UiOptions): GameUi {
  let tuning = validateTuning(options.initialTuning);
  let currentInputMode = options.initialInputMode;
  const events = new AbortController();
  const listenerOptions = { signal: events.signal };
  const desktop = window.matchMedia(DESKTOP_QUERY);
  const root = document.createElement('div');
  root.className = 'game-ui';
  root.innerHTML = `
    <div class="game-chrome">
      <header class="game-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <p class="eyebrow">PHYSICS PLAYGROUND / 01</p>
            <h1>OVER THE EDGE</h1>
          </div>
        </div>
        <div class="game-toolbar">
          <div class="game-actions" role="group" aria-label="Game controls">
            <button type="button" class="button button-primary play-button" data-action="play"
              title="Play and capture the mouse. Press Esc to release.">
              <span class="play-icon" aria-hidden="true"></span>Play
            </button>
            <button type="button" class="button" data-action="pause" title="Pause or resume (Space)">
              <span class="pause-label">Pause</span>
            </button>
            <button type="button" class="button" data-action="reset" title="Restart this practice (R)">Reset</button>
            <button type="button" class="button workshop-toggle" aria-expanded="false"
              aria-controls="edge-workshop">
              <span class="sliders-icon" aria-hidden="true"></span>Workshop
            </button>
          </div>
          <p class="input-state"><span class="state-dot" aria-hidden="true"></span><span class="input-state-text">Hold + drag, or Play to capture</span></p>
        </div>
      </header>

      <section class="climb-hud" aria-label="Climb statistics">
        <div class="height-metric">
          <p class="eyebrow">CURRENT HEIGHT</p>
          <p class="height-reading"><span class="height-value">0.0</span><span class="metric-unit">m</span></p>
        </div>
        <div class="secondary-metrics">
          <div><p class="metric-label">PEAK</p><p class="metric-reading"><span class="peak-value">0.0</span><span class="small-unit">m</span></p></div>
          <div><p class="metric-label">ELAPSED</p><p class="metric-reading elapsed-value">00:00</p></div>
        </div>
      </section>

      <section class="summit-notice" role="status" aria-live="polite" aria-atomic="true" hidden>
        <span class="summit-mark" aria-hidden="true"></span>
        <p class="eyebrow">SUMMIT REACHED</p>
        <h2>A little closer to the sky.</h2>
        <p>Take in the view. You earned it.</p>
      </section>

      <footer class="game-help" aria-label="How to play">
        <div class="climbing-guide">
          <span class="mouse-icon" aria-hidden="true"></span>
          <div>
            <p class="guide-heading">A good hold changes everything.</p>
            <p class="input-instructions">Move your mouse to guide the hammer. Plant, push, pull.</p>
          </div>
        </div>
        <div class="key-guide">
          <span><kbd>DRAG</kbd>without capture</span>
          <span><kbd>ESC</kbd>release mouse</span>
          <span><kbd>SPACE</kbd>pause</span>
        </div>
        <p class="game-signature">TWO MOTORS. ONE MOUNTAIN. <span>YOUR WAY UP.</span></p>
      </footer>
    </div>

    <aside id="edge-workshop" class="workshop" aria-labelledby="workshop-title" hidden>
      <header class="workshop-header">
        <div>
          <p class="eyebrow">A LITTLE ROOM TO EXPERIMENT</p>
          <h2 id="workshop-title">The workshop<span class="brass-period">.</span></h2>
          <p class="workshop-pause-note">Game paused while editing</p>
        </div>
        <button type="button" class="icon-button workshop-close" aria-label="Close workshop">
          <span class="close-icon" aria-hidden="true"></span>
        </button>
      </header>

      <div class="workshop-tabs" role="tablist" aria-label="Workshop section">
        <button id="physics-tab" type="button" role="tab" aria-selected="true" aria-controls="physics-pane">Physics</button>
        <button id="appearance-tab" type="button" role="tab" aria-selected="false" aria-controls="appearance-pane" tabindex="-1">Appearance</button>
      </div>
      <div id="physics-pane" class="workshop-scroll" role="tabpanel" aria-labelledby="physics-tab">
        <section class="practice-section" aria-labelledby="practice-title">
          <div class="section-heading"><h3 id="practice-title">Find your footing</h3><span class="practice-count"></span></div>
          <div class="practice-grid" role="group" aria-label="Practice positions"></div>
          <p class="practice-description">Choose a starting point. Your tuning stays with you.</p>
        </section>

        <section class="telemetry" aria-labelledby="telemetry-title">
          <div class="section-heading">
            <h3 id="telemetry-title">In the moment</h3>
            <span class="contact-reading"><span class="contact-dot" aria-hidden="true"></span><span class="contact-value">0 contacts</span></span>
          </div>
          <div class="effort-label"><label id="hinge-effort-label" for="hinge-effort">Hinge effort</label><span class="hinge-effort-value">0%</span></div>
          <meter id="hinge-effort" min="0" max="1" value="0" aria-labelledby="hinge-effort-label"></meter>
          <div class="effort-label"><label id="slider-effort-label" for="slider-effort">Slider effort</label><span class="slider-effort-value">0%</span></div>
          <meter id="slider-effort" min="0" max="1" value="0" aria-labelledby="slider-effort-label"></meter>
        </section>

        <div class="tuning-heading"><h3>Make it feel like you.</h3><p>Live adjustments. Hover a label for details.</p></div>
        <div class="tuning-groups"></div>

        <section class="workshop-tools" aria-label="View and input tools">
          <button type="button" class="debug-button" data-action="debug" aria-pressed="false" title="Show physics geometry (D)">
            <span>Physics overlay</span><span class="toggle-track" aria-hidden="true"></span>
          </button>
          <button type="button" class="button recenter-button" data-action="recenter" title="Recenter the camera on the player (C)">Recenter camera <kbd>C</kbd></button>
        </section>
      </div>

      <section id="appearance-pane" class="appearance-pane" role="tabpanel" aria-labelledby="appearance-tab" hidden></section>
      <footer class="workshop-footer physics-footer">
        <div class="persistence-actions" role="group" aria-label="Tuning profiles">
          <button type="button" class="button button-primary save-tuning">Save tuning</button>
          <button type="button" class="button load-tuning">Load tuning</button>
          <button type="button" class="button defaults-tuning">Defaults</button>
        </div>
        <p>Saved on this device. Loaded only when you choose.</p>
      </footer>
    </aside>

    <div class="ui-notice" role="status" aria-live="polite" aria-atomic="true" hidden>
      <div><p class="notice-heading">A QUICK NOTE</p><p class="notice-message"></p></div>
      <button type="button" class="icon-button dismiss-notice" aria-label="Dismiss notification">
        <span class="close-icon" aria-hidden="true"></span>
      </button>
    </div>
  `;

  const panel = element<HTMLElement>(root, '.workshop');
  const workshopToggle = element<HTMLButtonElement>(root, '.workshop-toggle');
  const workshopClose = element<HTMLButtonElement>(root, '.workshop-close');
  const physicsTab = element<HTMLButtonElement>(root, '#physics-tab');
  const appearanceTab = element<HTMLButtonElement>(root, '#appearance-tab');
  const physicsPane = element<HTMLElement>(root, '#physics-pane');
  const appearanceMount = element<HTMLElement>(root, '#appearance-pane');
  const physicsFooter = element<HTMLElement>(root, '.physics-footer');
  const selectTab = (tab: 'physics' | 'appearance'): void => {
    const physics = tab === 'physics';
    physicsTab.setAttribute('aria-selected', String(physics));
    appearanceTab.setAttribute('aria-selected', String(!physics));
    physicsTab.tabIndex = physics ? 0 : -1;
    appearanceTab.tabIndex = physics ? -1 : 0;
    physicsPane.hidden = !physics;
    physicsFooter.hidden = !physics;
    appearanceMount.hidden = physics;
  };
  physicsTab.addEventListener('click', () => selectTab('physics'), listenerOptions);
  appearanceTab.addEventListener('click', () => selectTab('appearance'), listenerOptions);
  for (const tab of [physicsTab, appearanceTab]) {
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? physicsTab : event.key === 'End' ? appearanceTab :
        tab === physicsTab ? appearanceTab : physicsTab;
      selectTab(target === physicsTab ? 'physics' : 'appearance');
      target.focus();
    }, listenerOptions);
  }
  const noticeBox = element<HTMLDivElement>(root, '.ui-notice');
  const noticeHeading = element<HTMLParagraphElement>(root, '.notice-heading');
  const noticeMessage = element<HTMLParagraphElement>(root, '.notice-message');
  const tuningGroups = element<HTMLDivElement>(root, '.tuning-groups');
  const controls = new Map<keyof Tuning, RangeControl>();
  const groups = new Map<string, HTMLFieldSetElement>();
  const practiceButtons = new Map<PracticeId, HTMLButtonElement>();
  const practiceGrid = element<HTMLDivElement>(root, '.practice-grid');
  const practiceDescription = element<HTMLParagraphElement>(root, '.practice-description');
  const practiceCount = element<HTMLSpanElement>(root, '.practice-count');
  setText(practiceCount, `${PRACTICES.length} STARTING POINTS`);

  function notice(message: string, kind: 'info' | 'error'): void {
    noticeBox.dataset.kind = kind;
    setText(noticeHeading, kind === 'error' ? 'NEEDS ATTENTION' : 'A QUICK NOTE');
    setText(noticeMessage, message);
    noticeBox.hidden = false;
  }

  function renderTuning(next: Readonly<Tuning>): void {
    tuning = { ...next };
    for (const field of TUNING_FIELDS) {
      const control = controls.get(field.key);
      if (!control) throw new Error(`Missing tuning control: ${field.key}`);
      const inactive = field.key === 'handleDamping' && tuning.handleFrequency === 0;
      control.setValue(tuning[field.key], { disabled: inactive });
      control.row.classList.toggle('is-inactive', inactive);
    }
  }

  function commitTuning(next: Tuning): void {
    renderTuning(next);
    options.onTuningChange({ ...tuning });
  }

  for (const practice of PRACTICES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'practice-button';
    button.textContent = practice.label;
    button.title = practice.description;
    button.dataset.practice = practice.id;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => options.onPractice(practice.id), listenerOptions);
    practiceButtons.set(practice.id, button);
    practiceGrid.append(button);
  }

  for (const field of TUNING_FIELDS) {
    let group = groups.get(field.group);
    if (!group) {
      group = document.createElement('fieldset');
      group.className = 'tuning-group';
      const legend = document.createElement('legend');
      legend.textContent = field.group;
      group.append(legend);
      groups.set(field.group, group);
      tuningGroups.append(group);
    }
    const control = createRangeControl(field, {
      id: `tuning-${field.key}`,
      name: field.key,
      signal: events.signal,
      onInput: (value) => {
        let next: Tuning;
        try {
          next = validateTuning({ ...tuning, [field.key]: value });
        } catch (error) {
          if (!(error instanceof TuningError)) throw error;
          renderTuning(tuning);
          notice(error.message, 'error');
          return;
        }
        commitTuning(next);
      },
    });
    if (field.key === 'handleDamping') {
      const reason = document.createElement('p');
      reason.className = 'inactive-reason';
      reason.id = `${control.input.id}-inactive`;
      reason.textContent = 'Enable handle compliance to adjust damping.';
      control.input.setAttribute('aria-describedby', `${control.input.id}-description ${reason.id}`);
      control.row.append(reason);
    }
    controls.set(field.key, control);
    group.append(control.row);
  }

  function setWorkshop(mode: 'open' | 'closed'): void {
    const open = mode === 'open';
    const focusInPanel = panel.contains(document.activeElement);
    panel.hidden = !open;
    workshopToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle(WORKSHOP_CLASS, open);
    if (!open && focusInPanel) workshopToggle.focus({ preventScroll: true });
    options.onWorkshopChange({ open, compact: !desktop.matches });
  }

  workshopToggle.addEventListener('click', () => {
    setWorkshop(panel.hidden ? 'open' : 'closed');
    if (!panel.hidden && !desktop.matches) workshopClose.focus({ preventScroll: true });
  }, listenerOptions);
  workshopClose.addEventListener('click', () => setWorkshop('closed'), listenerOptions);
  desktop.addEventListener('change', () => {
    updateControlDensity();
    options.onWorkshopChange({ open: !panel.hidden, compact: !desktop.matches });
  }, listenerOptions);
  element<HTMLButtonElement>(root, '.dismiss-notice').addEventListener('click', () => {
    noticeBox.hidden = true;
  }, listenerOptions);

  for (const action of ['play', 'pause', 'reset', 'debug', 'recenter'] as const) {
    element<HTMLButtonElement>(root, `[data-action="${action}"]`)
      .addEventListener('click', (event) => options.onAction(action, {
        inputMode: event instanceof PointerEvent ? inputModeForPointer(event.pointerType) : undefined,
      }), listenerOptions);
  }

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setWorkshop('closed');
      event.stopPropagation();
    }
  }, listenerOptions);

  function readStorage(version: 1 | 2): { storage: Storage; record: string | null } | null {
    try {
      const storage = window.localStorage;
      return { storage, record: storage.getItem(version === 2 ? STORAGE_KEY : LEGACY_STORAGE_KEY) };
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      notice('Device storage is unavailable. Check your browser storage permissions; your live tuning is unchanged.', 'error');
      return null;
    }
  }

  function readProfile(record: string, version: 1 | 2): Tuning | null {
    try {
      return decodeProfile(record, version);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof ProfileFormatError) && !(error instanceof TuningError)) throw error;
      const recovery = version === 1
        ? 'The original v1 record was left untouched. You can save a new v2 profile without deleting it.'
        : 'The stored record was left untouched. Remove the invalid v2 record in browser storage before saving again.';
      notice(`Saved tuning is invalid: ${error.message} ${recovery}`, 'error');
      return null;
    }
  }

  function writeProfile(storage: Storage, settings: Readonly<Tuning>): boolean {
    const profile = { schemaVersion: SCHEMA_VERSION, tuning: validateTuning(settings) };
    const serialized = JSON.stringify(profile);
    try {
      storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      notice('Tuning could not be saved. Device storage may be full or blocked; your live tuning is unchanged.', 'error');
      return false;
    }
    return true;
  }

  element<HTMLButtonElement>(root, '.save-tuning').addEventListener('click', () => {
    const stored = readStorage(2);
    if (!stored) return;
    if (stored.record !== null && !readProfile(stored.record, 2)) return;
    if (!writeProfile(stored.storage, tuning)) return;
    notice('Tuning saved on this device. A little experiment worth keeping.', 'info');
  }, listenerOptions);

  element<HTMLButtonElement>(root, '.load-tuning').addEventListener('click', () => {
    let stored = readStorage(2);
    if (!stored) return;
    let version: 1 | 2 = 2;
    if (stored.record === null) {
      stored = readStorage(1);
      if (!stored) return;
      version = 1;
    }
    if (stored.record === null) {
      notice('No tuning is saved on this device yet. Choose Save tuning to keep your current setup.', 'error');
      return;
    }
    const next = readProfile(stored.record, version);
    if (!next) return;
    if (version === 1 && !writeProfile(stored.storage, next)) return;
    commitTuning(next);
    notice(version === 1
      ? 'Version 1 tuning upgraded with the original tool masses. The original saved record is preserved.'
      : 'Saved tuning loaded. All controls are ready to try.', 'info');
  }, listenerOptions);

  element<HTMLButtonElement>(root, '.defaults-tuning').addEventListener('click', () => {
    commitTuning(validateTuning(DEFAULT_TUNING));
    notice('All tuning restored to defaults. Your saved profile was not changed.', 'info');
  }, listenerOptions);

  const heightValue = element<HTMLSpanElement>(root, '.height-value');
  const peakValue = element<HTMLSpanElement>(root, '.peak-value');
  const elapsedValue = element<HTMLParagraphElement>(root, '.elapsed-value');
  const contactsValue = element<HTMLSpanElement>(root, '.contact-value');
  const hingeValue = element<HTMLSpanElement>(root, '.hinge-effort-value');
  const sliderValue = element<HTMLSpanElement>(root, '.slider-effort-value');
  const hingeMeter = element<HTMLMeterElement>(root, '#hinge-effort');
  const sliderMeter = element<HTMLMeterElement>(root, '#slider-effort');
  const pauseButton = element<HTMLButtonElement>(root, '[data-action="pause"]');
  const pauseLabel = element<HTMLSpanElement>(root, '.pause-label');
  const playButton = element<HTMLButtonElement>(root, '[data-action="play"]');
  const resetButton = element<HTMLButtonElement>(root, '[data-action="reset"]');
  const debugButton = element<HTMLButtonElement>(root, '[data-action="debug"]');
  const recenterButton = element<HTMLButtonElement>(root, '[data-action="recenter"]');
  const inputState = element<HTMLParagraphElement>(root, '.input-state');
  const inputStateText = element<HTMLSpanElement>(root, '.input-state-text');
  const summit = element<HTMLElement>(root, '.summit-notice');
  const instructions = element<HTMLParagraphElement>(root, '.input-instructions');
  const mouseIcon = element<HTMLElement>(root, '.mouse-icon');
  const guideHeading = element<HTMLElement>(root, '.guide-heading');
  const keyGuide = element<HTMLElement>(root, '.key-guide');

  function updateControlDensity(): void {
    document.body.classList.toggle('touch-controls', currentInputMode === 'touch' || !desktop.matches);
  }

  function setInputMode(mode: InputMode): void {
    currentInputMode = mode;
    document.body.dataset.inputMode = mode;
    updateControlDensity();
    const touch = mode === 'touch';
    mouseIcon.hidden = touch;
    guideHeading.hidden = touch;
    keyGuide.hidden = touch;
    playButton.title = touch ? 'Resume touch controls' : 'Play and capture the mouse. Press Esc to release.';
    pauseButton.title = touch ? 'Pause or resume' : 'Pause or resume (Space)';
    resetButton.title = touch ? 'Restart this practice' : 'Restart this practice (R)';
    debugButton.title = touch ? 'Show physics geometry' : 'Show physics geometry (D)';
    recenterButton.title = touch ? 'Recenter the camera on the player' : 'Recenter the camera on the player (C)';
    setText(instructions, touch
      ? 'Drag anywhere with one finger. Lift and reposition to continue.'
      : 'Move your mouse to guide the hammer. Plant, push, pull.');
  }

  function update(state: HudState): void {
    if (document.body.dataset.inputMode !== state.inputMode) setInputMode(state.inputMode);
    setText(heightValue, state.height.toFixed(1));
    setText(peakValue, state.bestHeight.toFixed(1));
    setText(elapsedValue, formatElapsed(state.elapsed));
    setText(contactsValue, `${state.contacts} ${state.contacts === 1 ? 'contact' : 'contacts'}`);
    setText(hingeValue, `${Math.round(state.hingeLoad * 100)}%`);
    setText(sliderValue, `${Math.round(state.sliderLoad * 100)}%`);
    if (hingeMeter.value !== state.hingeLoad) hingeMeter.value = state.hingeLoad;
    if (sliderMeter.value !== state.sliderLoad) sliderMeter.value = state.sliderLoad;
    setText(pauseLabel, state.paused ? 'Resume' : 'Pause');
    pauseButton.classList.toggle('is-active', state.paused);
    playButton.classList.toggle('is-active', !state.paused && (state.pointerLocked || state.inputMode === 'touch'));
    setPressed(debugButton, state.debug);
    const touch = state.inputMode === 'touch';
    const mode = state.paused ? 'paused' : touch ? 'touch' : state.pointerLocked ? 'captured' : 'free';
    if (inputState.dataset.mode !== mode) inputState.dataset.mode = mode;
    const pausedHint = touch ? 'tap Play to continue' : state.pointerLocked ? 'Esc to release mouse' : 'take your time';
    setText(inputStateText, state.paused ? `Paused - ${pausedHint}` :
      touch ? 'Touch controls - drag anywhere' :
        state.pointerLocked ? 'Mouse captured - Esc to release' : 'Hold + drag, or Play to capture');
    for (const practice of PRACTICES) {
      const button = practiceButtons.get(practice.id);
      if (!button) throw new Error(`Missing practice button: ${practice.id}`);
      const active = practice.id === state.practice;
      setPressed(button, active);
      if (active) setText(practiceDescription, practice.description);
    }
    if (summit.hidden === state.summit) summit.hidden = !state.summit;
  }

  options.mount.append(root);
  setInputMode(options.initialInputMode);
  renderTuning(tuning);
  setWorkshop(desktop.matches ? 'open' : 'closed');

  return {
    appearanceMount,
    closeWorkshop: () => setWorkshop('closed'),
    update,
    setTuning: (next) => renderTuning(validateTuning(next)),
    notice,
    dispose: () => {
      events.abort();
      root.remove();
      document.body.classList.remove(WORKSHOP_CLASS);
      document.body.classList.remove('touch-controls');
      delete document.body.dataset.inputMode;
    },
  };
}
