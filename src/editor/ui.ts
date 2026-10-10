import type { Tuning } from '../config';
import {
  CURSOR_FIELDS, CURSOR_RETURN_FIELDS, DEATH_FIELDS, DEFAULT_GAME_SETTINGS, GameSettingsError, RIG_FIELDS, TUNING_FIELDS,
  validateGameSettings, withRig,
} from '../game-settings';
import type { CursorSettings, DeathSettings, GameSettings } from '../game-settings';
import { minReachLimit, rigGeometry } from '../rig';
import type { RigSettings } from '../rig';
import { element, setPressed, setText } from '../dom';
import { createGameUI, DESKTOP_QUERY } from './game-ui';
import { inputModeForPointer } from '../input';
import { PRACTICES } from './practices';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import type { HudFrame } from '../hud-readouts';
import { createGameSettingsUI } from './game-settings-ui';
import type { PracticeId } from './practices';
import type { GameUi, HudState, PluginSectionTab, PluginWorkshopTab, UiOptions, WorkshopState, WorkshopTab } from './ui-types';
import { createSection, keepClosingHeadingsInView, rememberSections } from './workshop-section';
import type { WorkshopSection } from './workshop-section';
import { createSectionBar, revealNavigation } from './workshop-section-bar';
import type { NavigationOrientation } from './workshop-section-bar';
import { createWorkshopSearch } from './workshop-search';
import { createWorkshopWidth } from './workshop-width';
import workshopMarkup from './workshop.html?raw';

const WORKSHOP_CLASS = 'workshop-open';
const TEXT_ENTRY = 'textarea, [contenteditable]:not([contenteditable="false"]), ' +
  'input:not([type="range"], [type="checkbox"], [type="radio"], [type="file"], [type="color"], [type="button"], [type="submit"], [type="reset"])';
const TABS = ['project', 'physics', 'character', 'appearance', 'sprites', 'level'] as const;
type TuningGroup = (typeof TUNING_FIELDS)[number]['group'];
// The groups that shape the feel most start open; the rest stay one click away.
const TUNING_SECTIONS: Readonly<Record<TuningGroup, Omit<WorkshopSection, 'title'>>> = {
  'Mass & recoil': { id: 'physics-mass', hint: 'Weights and swing kick', open: true },
  Motors: { id: 'physics-motors', hint: 'Strength and speed caps', open: true },
  Downswing: { id: 'physics-downswing', hint: 'Extra strength swinging the hammer down' },
  Response: { id: 'physics-response', hint: 'How closely the hammer follows aim' },
  Materials: { id: 'physics-materials', hint: 'Friction, bounciness, damping and handle flex' },
  Input: { id: 'physics-input', hint: 'Control sensitivity' },
  Health: { id: 'physics-health', hint: 'Health and invulnerability' },
  Bonfires: { id: 'physics-bonfires', hint: 'How long a lit bonfire burns' },
  Hazards: { id: 'physics-hazards', hint: 'Hurt box and trap knockback' },
  Enemies: { id: 'physics-enemies', hint: 'Health, mass, movement and bumps' },
  Liquids: { id: 'physics-liquids', hint: 'Lava and swamp: lift, drag and burn' },
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
  const layout = element<HTMLElement>(panel, '.workshop-layout');
  const workshopClose = element<HTMLButtonElement>(root, '.workshop-close');
  const workshopWidth = createWorkshopWidth({ panel, desktop, signal: events.signal });
  const projectMount = element<HTMLElement>(root, '#project-pane');
  const characterMount = element<HTMLElement>(root, '#character-pane');
  const appearanceMount = element<HTMLElement>(root, '#appearance-pane');
  const spriteMount = element<HTMLElement>(root, '#sprites-pane');
  const levelMount = element<HTMLElement>(root, '#level-pane');
  // The built-in tabs, then Workshop plugins' tabs in the order they were added.
  const tabs: { readonly id: WorkshopTab; readonly button: HTMLButtonElement; readonly pane: HTMLElement }[] = TABS.map((id) => ({
    id, button: element<HTMLButtonElement>(root, `#${id}-tab`), pane: element<HTMLElement>(root, `#${id}-pane`),
  }));
  const navigation = element<HTMLElement>(root, '.workshop-navigation');
  const tabList = element<HTMLElement>(root, '.workshop-tabs');
  navigation.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLElement) revealNavigation(navigation, event.target);
  }, listen);
  const focusTab = (tab: (typeof tabs)[number]): void => {
    if (document.activeElement === tab.button) revealNavigation(navigation, tab.button);
    else tab.button.focus({ preventScroll: true });
  };
  const focusSelectedTab = (): void => {
    const tab = tabs.find((candidate) => candidate.id === selectedTab);
    if (tab === undefined) throw new Error(`Missing Workshop tab: ${selectedTab}.`);
    focusTab(tab);
  };
  const sectionBar = createSectionBar({
    root: element<HTMLElement>(root, '.workshop-section-bar'), navigation, focusSelectedTab, signal: events.signal,
  });
  let navigationOrientation: NavigationOrientation = 'horizontal';
  function readNavigationOrientation(): void {
    if (panel.hidden || events.signal.aborted) return;
    const next = getComputedStyle(navigation).getPropertyValue('--workshop-navigation-orientation').trim();
    if (next !== 'horizontal' && next !== 'vertical') throw new Error(`Invalid Workshop navigation orientation: ${next}.`);
    if (next === navigationOrientation) return;
    navigationOrientation = next;
    tabList.setAttribute('aria-orientation', next);
    sectionBar.setOrientation(next);
  }
  const navigationResize = new ResizeObserver(readNavigationOrientation);
  events.signal.addEventListener('abort', () => navigationResize.disconnect(), { once: true });
  const workshopState = (): WorkshopState => ({ open: !panel.hidden, compact: !desktop.matches, tab: selectedTab });
  // The section bar lists the selected tab's sections while the Workshop is open.
  const showSections = (): void => {
    const tab = tabs.find((candidate) => candidate.id === selectedTab);
    sectionBar.show(panel.hidden || tab === undefined ? null : tab.pane, tab?.button.textContent?.trim() ?? '');
  };
  const selectTab = (id: WorkshopTab): void => {
    selectedTab = id;
    for (const tab of tabs) {
      const selected = tab.id === id;
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.pane.hidden = !selected;
    }
    options.onWorkshopChange(workshopState());
    // After the change, so the editors have shown the tab they lay out.
    showSections();
  };
  const wireTab = (tab: (typeof tabs)[number], signal: AbortSignal): void => {
    tab.button.addEventListener('click', () => selectTab(tab.id), { signal });
    tab.button.addEventListener('keydown', (event) => {
      const backward = navigationOrientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
      const forward = navigationOrientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
      if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (index + (event.key === backward ? -1 : 1) + tabs.length) % tabs.length;
      selectTab(tabs[next]!.id);
      focusSelectedTab();
    }, { signal });
  };
  for (const tab of tabs) wireTab(tab, events.signal);
  function addTab(tabOptions: { readonly id: PluginWorkshopTab; readonly label: string; readonly title?: string }) {
    if (tabs.some((tab) => tab.id === tabOptions.id)) throw new Error(`The Workshop already has a tab ${tabOptions.id}.`);
    const button = document.createElement('button');
    button.id = `${tabOptions.id}-tab`;
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.setAttribute('aria-controls', `${tabOptions.id}-pane`);
    button.tabIndex = -1;
    button.textContent = tabOptions.label;
    if (tabOptions.title !== undefined) button.title = tabOptions.title;
    const pane = document.createElement('section');
    pane.id = `${tabOptions.id}-pane`;
    pane.className = 'workshop-pane plugin-pane';
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', button.id);
    pane.hidden = true;
    const body = document.createElement('div');
    body.className = 'workshop-scroll plugin-scroll';
    pane.append(body);
    const tab = { id: tabOptions.id, button, pane };
    const tabEvents = new AbortController();
    tabList.append(button);
    layout.append(pane);
    tabs.push(tab);
    wireTab(tab, AbortSignal.any([events.signal, tabEvents.signal]));
    return {
      body,
      remove: (): void => {
        const index = tabs.indexOf(tab);
        if (index < 0) return;
        const recoverFocus = button === document.activeElement || pane.contains(document.activeElement);
        tabs.splice(index, 1);
        tabEvents.abort();
        button.remove();
        pane.remove();
        if (selectedTab === tab.id) selectTab('physics');
        if (recoverFocus) focusSelectedTab();
        else {
          const active = document.activeElement;
          if (active instanceof HTMLElement && navigation.contains(active)) revealNavigation(navigation, active);
        }
      },
    };
  }
  // A container at the end of a built-in tab's scrolling body, made on first use.
  function pluginSections(tab: PluginSectionTab): HTMLElement {
    const scroll = element<HTMLElement>(root, `#${tab}-pane`).querySelector<HTMLElement>('.workshop-scroll');
    if (scroll === null) throw new Error(`The ${tab} tab has no scrolling body for plugin sections.`);
    let container = scroll.querySelector<HTMLElement>(':scope > .workshop-plugin-sections');
    if (container === null) {
      container = document.createElement('div');
      container.className = 'workshop-plugin-sections';
      scroll.append(container);
    }
    return container;
  }
  const groups = new Map<string, HTMLFieldSetElement>();
  const controls = new Map<keyof Tuning, RangeControl>();
  const rigControls = new Map<keyof RigSettings, RangeControl>();
  const cursorControls = new Map<Exclude<keyof CursorSettings, 'returnToHammer'>, RangeControl>();
  const deathControls = new Map<keyof DeathSettings, RangeControl>();
  const returnToggle = document.createElement('input');
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
    const reach = rigGeometry(settings.rig).maxReach;
    for (const field of RIG_FIELDS) {
      const control = rigControls.get(field.key);
      if (!control) throw new Error(`Missing rig control: ${field.key}`);
      if (field.key === 'minReach') control.input.max = String(minReachLimit(settings.rig));
      control.setValue(settings.rig[field.key]);
    }
    for (const field of CURSOR_FIELDS) {
      const control = cursorControls.get(field.key);
      if (!control) throw new Error(`Missing cursor control: ${field.key}`);
      if (field.key === 'maxTargetRadius') control.input.max = String(reach);
      control.setValue(settings.cursor[field.key]);
    }
    returnToggle.checked = settings.cursor.returnToHammer;
    for (const field of DEATH_FIELDS) {
      const control = deathControls.get(field.key);
      if (!control) throw new Error(`Missing death control: ${field.key}`);
      control.setValue(settings.death[field.key]);
    }
    for (const field of CURSOR_RETURN_FIELDS) {
      const control = cursorControls.get(field.key);
      if (!control) throw new Error(`Missing cursor control: ${field.key}`);
      // Off keeps the return's values for when it is turned on again.
      control.setValue(settings.cursor[field.key], { disabled: !settings.cursor.returnToHammer });
      control.row.classList.toggle('is-inactive', !settings.cursor.returnToHammer);
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
  const rigGroup = tuningSection({
    id: 'physics-rig', title: 'Hammer rig', hint: 'Handle length and reach', open: true,
  }, 'Hammer rig', 'tuning-group rig-settings');
  const rigHelp = document.createElement('p');
  rigHelp.className = 'rig-settings-help';
  rigHelp.textContent = 'The hammer\'s geometry. Changing it rebuilds the player and restarts the run. ' +
    'Characters with sliding grips need arms that reach about the maximum extension; fixed grips need arms that reach as far as the handle slides.';
  rigGroup.append(rigHelp);
  for (const field of RIG_FIELDS) {
    const control = createRangeControl(field, {
      id: `rig-${field.key}`, name: field.key, signal: events.signal,
      onInput: (value) => editSettings(withRig(settings, { ...settings.rig, [field.key]: value })),
    });
    rigControls.set(field.key, control);
    rigGroup.append(control.row);
  }
  const hammerHead = createSection({ id: 'physics-head', title: 'Hammer head', hint: 'Each hammer\'s collision outline' });
  const hammerHeadMount = document.createElement('div');
  hammerHeadMount.className = 'outline-editor';
  hammerHead.body.append(hammerHeadMount);
  tuningGroups.append(hammerHead.root);
  const jar = createSection({ id: 'physics-jar', title: 'Jar', hint: 'The jar\'s collision outline' });
  const jarMount = document.createElement('div');
  jarMount.className = 'outline-editor';
  jar.body.append(jarMount);
  tuningGroups.append(jar.root);
  const cursorGroup = tuningSection({
    id: 'physics-cursor', title: 'Cursor target', hint: 'Aim radius, dead zone and return',
  }, 'Cursor target', 'tuning-group cursor-settings');
  const cursorHelp = document.createElement('p');
  cursorHelp.className = 'cursor-target-help';
  cursorHelp.textContent = 'The hammer aims inside a circle around its shoulder hinge. The target moves with the character, as much as ' +
    'Follow character says, and otherwise keeps its place until you aim again, unless Return target to hammer, below, is on. ' +
    'The default radius is the hammer\'s full reach; a smaller one limits how far input can extend it. ' +
    'The cursor moves freely within the dead zone around the target, then drags the target along, so it can reach the dead zone past the radius.';
  cursorGroup.append(cursorHelp);
  for (const field of CURSOR_FIELDS) {
    const control = createRangeControl(field, {
      id: `cursor-${field.key}`, name: field.key, signal: events.signal,
      onInput: (value) => editSettings({ ...settings, cursor: { ...settings.cursor, [field.key]: value } }),
    });
    cursorControls.set(field.key, control);
    cursorGroup.append(control.row);
  }
  returnToggle.type = 'checkbox';
  returnToggle.id = 'cursor-returnToHammer';
  const returnLabel = document.createElement('label');
  returnLabel.className = 'cursor-return-toggle';
  returnLabel.htmlFor = returnToggle.id;
  returnLabel.append(returnToggle, document.createTextNode('Return target to hammer'));
  const returnHelp = document.createElement('p');
  returnHelp.id = 'cursor-return-help';
  returnHelp.className = 'cursor-target-help';
  returnHelp.textContent = 'Off by default. On, once you stop aiming for the return delay while the hammer head touches a surface, ' +
    'the target eases toward the head plus the return offset, and the cursor moves with it; aiming always comes first. ' +
    'X goes right and Y goes up, in world metres; the offset does not turn with the hammer.';
  returnToggle.setAttribute('aria-describedby', returnHelp.id);
  returnToggle.addEventListener('change', () => editSettings({
    ...settings, cursor: { ...settings.cursor, returnToHammer: returnToggle.checked },
  }), listen);
  cursorGroup.append(returnLabel, returnHelp);
  for (const field of CURSOR_RETURN_FIELDS) {
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
  const deathGroup = tuningSection({
    id: 'physics-death', title: 'Death', hint: 'Respawn wait and passive corpse',
  }, 'Death');
  const deathHelp = document.createElement('p');
  deathHelp.className = 'rig-settings-help';
  deathHelp.textContent = 'Death releases the hands and hammer and simulates a passive corpse from the character\'s figure. ' +
    'The corpse and tool collide only with terrain, not enemies or each other, and cannot trigger illusions. ' +
    'Character edits show immediately without changing the existing corpse. These settings apply to the next death; ' +
    'Respawn wait controls placement, while the HUD controls only text and fade.';
  deathGroup.append(deathHelp);
  for (const field of DEATH_FIELDS) {
    const control = createRangeControl(field, {
      id: `death-${field.key}`, name: field.key, signal: events.signal,
      onInput: value => editSettings({ ...settings, death: { ...settings.death, [field.key]: value } }),
    });
    deathControls.set(field.key, control); deathGroup.append(control.row);
  }
  const savedSettingsMount = document.createElement('section');
  savedSettingsMount.className = 'game-settings-history';
  savedSettingsMount.setAttribute('aria-label', 'Saved game settings');
  savedSettings.body.append(savedSettingsMount);
  tuningGroups.append(savedSettings.root);
  const serverSettings = createSection({
    id: 'physics-server', title: 'Server game settings', hint: 'Load or save settings shared on this server',
  });
  const serverSettingsMount = document.createElement('section');
  serverSettingsMount.setAttribute('aria-label', 'Server game settings');
  serverSettings.body.append(serverSettingsMount);
  tuningGroups.append(serverSettings.root);
  function renderWorkshop(mode: 'open' | 'closed'): void {
    const open = mode === 'open';
    const focusInPanel = panel.contains(document.activeElement);
    workshopWidth.setOpen(open);
    panel.hidden = !open;
    workshopToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle(WORKSHOP_CLASS, open);
    if (open) {
      readNavigationOrientation();
      navigationResize.observe(panel);
    } else navigationResize.disconnect();
    if (!open && focusInPanel) workshopToggle.focus({ preventScroll: true });
    showSections();
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
  for (const action of ['debug', 'record', 'recenter'] as const) {
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
  const recordButton = element<HTMLButtonElement>(root, '[data-action="record"]');
  function updateDiagnostics(): void {
    if (panel.hidden || selectedTab !== 'physics') return;
    const state = options.readStatus();
    setText(contacts, `${state.contacts} ${state.contacts === 1 ? 'contact' : 'contacts'}`);
    setText(hinge, state.hingeLoad === null ? 'Released' : `${Math.round(state.hingeLoad * 100)}%`);
    setText(slider, state.sliderLoad === null ? 'Released' : `${Math.round(state.sliderLoad * 100)}%`);
    hingeMeter.hidden = state.hingeLoad === null;
    sliderMeter.hidden = state.sliderLoad === null;
    if (state.hingeLoad !== null && hingeMeter.value !== state.hingeLoad) hingeMeter.value = state.hingeLoad;
    if (state.sliderLoad !== null && sliderMeter.value !== state.sliderLoad) sliderMeter.value = state.sliderLoad;
  }
  function update(frame: HudFrame, state: HudState): void {
    hud.update(frame, state.capturing);
    updateDiagnostics();
    setPressed(debugButton, state.debug);
    setPressed(recordButton, state.recording);
    if (recordButton.title !== state.recordingNote) recordButton.title = state.recordingNote;
    for (const practice of PRACTICES) {
      const button = practiceButtons.get(practice.id);
      if (!button) throw new Error(`Missing practice button: ${practice.id}`);
      const active = practice.id === state.practice;
      setPressed(button, active);
      if (active) setText(practiceDescription, practice.description);
    }
    if (state.practice === null) setText(practiceDescription, 'Where you placed the player in Workshop / Level. Reset returns there.');
  }
  renderSettings(settings);
  createGameSettingsUI({
    mount: savedSettingsMount, serverMount: serverSettingsMount, signal: events.signal,
    projectSave: options.projectSave, serverCopies: options.serverCopies,
    getSettings: () => settings, onLoad: commitSettings, onNotice: notice,
  });
  rememberSections(panel, events.signal);
  keepClosingHeadingsInView(panel, events.signal);
  const quick = element<HTMLElement>(root, '.workshop-quick');
  const search = createWorkshopSearch({
    root: element(root, '.workshop-search'), signal: events.signal, selectTab, selectedTab: () => selectedTab,
    scopes: () => [
      { label: 'Workshop', root: quick, tab: null },
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
    projectMount, characterMount, appearanceMount, spriteMount, levelMount, hammerHeadMount, jarMount, addTab, pluginSections, workshopState,
    closeWorkshop: () => setWorkshop('closed'),
    update, notice,
    applySettings: commitSettings,
    settings: () => settings,
    setHud: hud.setHud,
    setLevelName: hud.setLevelName,
    setSceneTone: hud.setSceneTone,
    dispose: () => {
      events.abort();
      document.body.classList.remove(WORKSHOP_CLASS);
      hud.dispose();
    },
  };
}
