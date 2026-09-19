import type { Tuning } from '../config';
import {
  CURSOR_FIELDS, DEFAULT_GAME_SETTINGS, GameSettingsError, TUNING_FIELDS, validateGameSettings,
} from '../game-settings';
import type { CursorSettings, GameSettings } from '../game-settings';
import { element, setPressed, setText } from '../dom';
import { createGameUI, DESKTOP_QUERY } from './game-ui';
import { inputModeForPointer } from '../input';
import { PRACTICES } from './practices';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import { createGameSettingsUI } from './game-settings-ui';
import type { GameUi, HudState, PracticeId, UiOptions, WorkshopState, WorkshopTab } from './ui-types';
import workshopMarkup from './workshop.html?raw';

const WORKSHOP_CLASS = 'workshop-open';
const TABS = ['physics', 'appearance', 'sprites', 'level'] as const;

export function createUI(options: UiOptions): GameUi {
  let settings = validateGameSettings(options.initialSettings);
  let selectedTab: WorkshopTab = 'physics';
  const events = new AbortController();
  const listen = { signal: events.signal };
  const desktop = window.matchMedia(DESKTOP_QUERY);
  const hud = createGameUI(options);
  const root = hud.root;
  root.insertAdjacentHTML('beforeend', workshopMarkup);
  const notice = hud.notice;
  const workshopToggle = document.createElement('button');
  workshopToggle.type = 'button';
  workshopToggle.className = 'button workshop-toggle';
  workshopToggle.setAttribute('aria-expanded', 'false');
  workshopToggle.setAttribute('aria-controls', 'edge-workshop');
  workshopToggle.innerHTML = '<span class="sliders-icon" aria-hidden="true"></span>Workshop';
  hud.actions.append(workshopToggle);
  const panel = element<HTMLElement>(root, '.workshop');
  const workshopClose = element<HTMLButtonElement>(root, '.workshop-close');
  const appearanceMount = element<HTMLElement>(root, '#appearance-pane');
  const spriteMount = element<HTMLElement>(root, '#sprites-pane');
  const levelMount = element<HTMLElement>(root, '#level-pane');
  const physicsFooter = element<HTMLElement>(root, '.physics-footer');
  const tabs = TABS.map((id) => ({
    id, button: element<HTMLButtonElement>(root, `#${id}-tab`), pane: element<HTMLElement>(root, `#${id}-pane`),
  }));
  const workshopState = (): WorkshopState => ({ open: !panel.hidden, compact: !desktop.matches, tab: selectedTab });
  const selectTab = (id: WorkshopTab): void => {
    selectedTab = id;
    for (const tab of tabs) {
      const selected = tab.id === id;
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.pane.hidden = !selected;
    }
    physicsFooter.hidden = id !== 'physics';
    options.onWorkshopChange(workshopState());
  };
  for (const [index, tab] of tabs.entries()) {
    tab.button.addEventListener('click', () => selectTab(tab.id), listen);
    tab.button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
      selectTab(tabs[next].id);
      tabs[next].button.focus();
    }, listen);
  }
  const groups = new Map<string, HTMLFieldSetElement>();
  const controls = new Map<keyof Tuning, RangeControl>();
  const cursorControls = new Map<keyof CursorSettings, RangeControl>();
  const practiceButtons = new Map<PracticeId, HTMLButtonElement>();
  const tuningGroups = element<HTMLElement>(root, '.tuning-groups');
  const practiceGrid = element<HTMLElement>(root, '.practice-grid');
  const practiceDescription = element<HTMLElement>(root, '.practice-description');
  setText(element(root, '.practice-count'), `${PRACTICES.length} STARTING POINTS`);

  function renderSettings(next: GameSettings): void {
    settings = next;
    const tuning = settings.physics;
    for (const field of TUNING_FIELDS) {
      const control = controls.get(field.key);
      if (!control) throw new Error(`Missing tuning control: ${field.key}`);
      const inactive = field.key === 'handleDamping' && tuning.handleFrequency === 0;
      control.setValue(tuning[field.key], { disabled: inactive });
      control.row.classList.toggle('is-inactive', inactive);
    }
    for (const field of CURSOR_FIELDS) {
      const control = cursorControls.get(field.key);
      if (!control) throw new Error(`Missing cursor control: ${field.key}`);
      control.setValue(settings.cursor[field.key]);
    }
  }
  function commitSettings(next: GameSettings): void {
    const valid = validateGameSettings(next);
    options.onSettingsChange(valid);
    renderSettings(valid);
  }
  function editSettings(next: GameSettings): void {
    try {
      commitSettings(next);
    } catch (error) {
      if (!(error instanceof GameSettingsError)) throw error;
      renderSettings(settings);
      notice(error.message, 'error');
    }
  }
  for (const practice of PRACTICES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'practice-button';
    button.textContent = practice.label;
    button.title = practice.description;
    button.dataset.practice = practice.id;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => options.onPractice(practice.id), listen);
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
      id: `tuning-${field.key}`, name: field.key, signal: events.signal,
      onInput: (value) => editSettings({ ...settings, physics: { ...settings.physics, [field.key]: value } }),
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
  const cursorGroup = document.createElement('fieldset');
  cursorGroup.className = 'tuning-group cursor-settings';
  const cursorLegend = document.createElement('legend');
  cursorLegend.textContent = 'Cursor target';
  const cursorHelp = document.createElement('p');
  cursorHelp.className = 'cursor-target-help';
  cursorHelp.textContent = 'Aim inside a circle around the character center. The target moves with the character and keeps your chosen offset until you aim again. ' +
    'There is no return to the hammer or center. The radius does not change the hammer\'s physical reach.';
  cursorGroup.append(cursorLegend, cursorHelp);
  for (const field of CURSOR_FIELDS) {
    const control = createRangeControl(field, {
      id: `cursor-${field.key}`, name: field.key, signal: events.signal,
      onInput: (value) => editSettings({ ...settings, cursor: { ...settings.cursor, [field.key]: value } }),
    });
    cursorControls.set(field.key, control);
    cursorGroup.append(control.row);
  }
  tuningGroups.append(cursorGroup);
  function renderWorkshop(mode: 'open' | 'closed'): void {
    const open = mode === 'open';
    const focusInPanel = panel.contains(document.activeElement);
    panel.hidden = !open;
    workshopToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle(WORKSHOP_CLASS, open);
    if (!open && focusInPanel) workshopToggle.focus({ preventScroll: true });
  }
  function setWorkshop(mode: 'open' | 'closed'): void {
    renderWorkshop(mode);
    options.onWorkshopChange(workshopState());
  }
  workshopToggle.addEventListener('click', () => {
    setWorkshop(panel.hidden ? 'open' : 'closed');
    if (!panel.hidden && !desktop.matches) workshopClose.focus({ preventScroll: true });
  }, listen);
  workshopClose.addEventListener('click', () => setWorkshop('closed'), listen);
  desktop.addEventListener('change', () => options.onWorkshopChange(workshopState()), listen);
  for (const action of ['debug', 'recenter'] as const) {
    element<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', (event) => {
      options.onAction(action, { inputMode: event instanceof PointerEvent ? inputModeForPointer(event.pointerType) : undefined });
    }, listen);
  }
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setWorkshop('closed');
      event.stopPropagation();
    }
  }, listen);
  element<HTMLButtonElement>(root, '.defaults-tuning').addEventListener('click', () => {
    commitSettings(DEFAULT_GAME_SETTINGS);
    notice('All game settings restored to defaults. Your saved profiles were not changed.', 'info');
  }, listen);
  const contacts = element<HTMLElement>(root, '.contact-value');
  const hinge = element<HTMLElement>(root, '.hinge-effort-value');
  const slider = element<HTMLElement>(root, '.slider-effort-value');
  const hingeMeter = element<HTMLMeterElement>(root, '#hinge-effort');
  const sliderMeter = element<HTMLMeterElement>(root, '#slider-effort');
  const debugButton = element<HTMLButtonElement>(root, '[data-action="debug"]');
  function update(state: HudState): void {
    hud.update(state);
    setText(contacts, `${state.contacts} ${state.contacts === 1 ? 'contact' : 'contacts'}`);
    setText(hinge, `${Math.round(state.hingeLoad * 100)}%`);
    setText(slider, `${Math.round(state.sliderLoad * 100)}%`);
    if (hingeMeter.value !== state.hingeLoad) hingeMeter.value = state.hingeLoad;
    if (sliderMeter.value !== state.sliderLoad) sliderMeter.value = state.sliderLoad;
    setPressed(debugButton, state.debug);
    for (const practice of PRACTICES) {
      const button = practiceButtons.get(practice.id);
      if (!button) throw new Error(`Missing practice button: ${practice.id}`);
      const active = practice.id === state.practice;
      setPressed(button, active);
      if (active) setText(practiceDescription, practice.description);
    }
  }
  renderSettings(settings);
  createGameSettingsUI({
    mount: element(root, '.game-settings-history'), signal: events.signal,
    getSettings: () => settings, onLoad: commitSettings, onNotice: notice,
  });
  renderWorkshop(desktop.matches ? 'open' : 'closed');
  return {
    appearanceMount, spriteMount, levelMount, workshopState,
    closeWorkshop: () => setWorkshop('closed'),
    update, notice,
    dispose: () => {
      events.abort();
      document.body.classList.remove(WORKSHOP_CLASS);
      hud.dispose();
    },
  };
}
