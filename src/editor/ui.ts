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
import { createSection, rememberSections } from './workshop-section';
import type { WorkshopSection } from './workshop-section';
import { createWorkshopSearch } from './workshop-search';
import workshopMarkup from './workshop.html?raw';

const WORKSHOP_CLASS = 'workshop-open';
const TEXT_ENTRY = 'textarea, [contenteditable]:not([contenteditable="false"]), ' +
  'input:not([type="range"], [type="checkbox"], [type="radio"], [type="file"], [type="color"], [type="button"], [type="submit"], [type="reset"])';
const TABS = ['physics', 'character', 'appearance', 'sprites', 'level'] as const;
type TuningGroup = (typeof TUNING_FIELDS)[number]['group'];
// The groups that shape the feel most start open; the rest stay one click away.
const TUNING_SECTIONS: Readonly<Record<TuningGroup, Omit<WorkshopSection, 'title'>>> = {
  'Mass & recoil': { id: 'physics-mass', hint: 'Weights and swing kick', open: true },
  Motors: { id: 'physics-motors', hint: 'Strength and speed caps', open: true },
  Response: { id: 'physics-response', hint: 'How closely the hammer follows aim' },
  Materials: { id: 'physics-materials', hint: 'Friction, damping and handle flex' },
  Input: { id: 'physics-input', hint: 'Control sensitivity' },
};

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
  const characterMount = element<HTMLElement>(root, '#character-pane');
  const appearanceMount = element<HTMLElement>(root, '#appearance-pane');
  const spriteMount = element<HTMLElement>(root, '#sprites-pane');
  const levelMount = element<HTMLElement>(root, '#level-pane');
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
  const tuningSection = (section: WorkshopSection, legendText: string, className = 'tuning-group'): HTMLFieldSetElement => {
    const { root: details, body } = createSection(section);
    const group = document.createElement('fieldset');
    group.className = className;
    const legend = document.createElement('legend');
    // The section heading shows the name; the legend still names the group for assistive technology.
    legend.className = 'visually-hidden';
    legend.textContent = legendText;
    group.append(legend);
    body.append(group);
    tuningGroups.append(details);
    return group;
  };
  for (const field of TUNING_FIELDS) {
    let group = groups.get(field.group);
    if (!group) {
      group = tuningSection({ ...TUNING_SECTIONS[field.group], title: field.group }, field.group);
      groups.set(field.group, group);
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
  const cursorGroup = tuningSection({
    id: 'physics-cursor', title: 'Cursor target', hint: 'Aim radius around the hinge',
  }, 'Cursor target', 'tuning-group cursor-settings');
  const cursorHelp = document.createElement('p');
  cursorHelp.className = 'cursor-target-help';
  cursorHelp.textContent = 'Aim inside a circle around the hammer\'s shoulder hinge. The target moves with the character and keeps your chosen offset until you aim again. ' +
    'There is no return to the hammer or hinge. The default radius is the hammer\'s full reach; a smaller one limits how far input can extend it.';
  cursorGroup.append(cursorHelp);
  for (const field of CURSOR_FIELDS) {
    const control = createRangeControl(field, {
      id: `cursor-${field.key}`, name: field.key, signal: events.signal,
      onInput: (value) => editSettings({ ...settings, cursor: { ...settings.cursor, [field.key]: value } }),
    });
    cursorControls.set(field.key, control);
    cursorGroup.append(control.row);
  }
  const savedSettings = createSection({
    id: 'physics-saved', title: 'Saved game settings', hint: 'Named profiles and JSON files',
  });
  const savedSettingsMount = document.createElement('section');
  savedSettingsMount.className = 'game-settings-history';
  savedSettingsMount.setAttribute('aria-label', 'Saved game settings');
  savedSettings.body.append(savedSettingsMount);
  tuningGroups.append(savedSettings.root);
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
    mount: savedSettingsMount, signal: events.signal,
    getSettings: () => settings, onLoad: commitSettings, onNotice: notice,
  });
  rememberSections(panel, events.signal);
  const search = createWorkshopSearch({
    root: element(root, '.workshop-search'), signal: events.signal, selectTab, selectedTab: () => selectedTab,
    scopes: [
      { label: 'Workshop', root: element(root, '.workshop-quick'), tab: null },
      ...tabs.map((tab) => ({ label: tab.button.textContent?.trim() ?? tab.id, root: tab.pane, tab: tab.id })),
    ],
  });
  // "/" finds a control from anywhere except text entry or captured-mouse play.
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
    if (document.pointerLockElement !== null) return;
    const target = event.target;
    if (target instanceof Element && target.closest(TEXT_ENTRY)) return;
    event.preventDefault();
    if (panel.hidden) setWorkshop('open');
    search.focus();
  }, listen);
  renderWorkshop(desktop.matches ? 'open' : 'closed');
  return {
    characterMount, appearanceMount, spriteMount, levelMount, workshopState,
    closeWorkshop: () => setWorkshop('closed'),
    update, notice,
    dispose: () => {
      events.abort();
      document.body.classList.remove(WORKSHOP_CLASS);
      hud.dispose();
    },
  };
}
