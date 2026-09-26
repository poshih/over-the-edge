import { element } from '../dom';
import type { WorkshopTab } from './ui-types';

/** A place the search can reveal a control in: a tab pane, or an always-visible toolbar. */
export interface SearchScope {
  readonly label: string;
  readonly root: HTMLElement;
  /** Tab to select before revealing; null for controls outside the tab panes. */
  readonly tab: WorkshopTab | null;
}

interface Target {
  readonly element: HTMLElement;
  readonly scope: SearchScope;
  readonly label: string;
  readonly path: string;
  readonly disabled: boolean;
  /** Normalized label, plus the words of the label, of label + location, and of everything indexed. */
  readonly text: string;
  readonly words: { readonly label: readonly string[]; readonly near: readonly string[]; readonly all: readonly string[] };
}

const CONTROLS = 'button, input:not([type="hidden"]), select, textarea, summary';
const SKIPPED = '.range-step, [role="tab"]';
const IGNORED_TEXT = 'svg, input, select, textarea, button, [aria-hidden="true"], .visually-hidden';
const MAX_RESULTS = 12;
const MAX_OPTIONS_INDEXED = 12;
const HIGHLIGHT_MS = 1600;

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Text a person reads for `root`, without nested controls, icons or hidden descriptions. */
function ownText(root: Element): string {
  let text = '';
  const visit = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
      else if (child instanceof Element && !child.matches(IGNORED_TEXT)) visit(child);
    }
  };
  visit(root);
  return text.replace(/\s+/g, ' ').trim();
}

function referencedText(control: HTMLElement, attribute: string): string {
  return (control.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)
    .map((id) => control.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
}

function labelOf(control: HTMLElement): string {
  const aria = control.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const labelledBy = referencedText(control, 'aria-labelledby');
  if (labelledBy) return labelledBy;
  if (control.localName === 'summary') return ownText(control.querySelector('.workshop-section-title') ?? control);
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
    const labels = Array.from(control.labels ?? [], ownText).filter(Boolean);
    if (labels.length > 0) return labels.join(' ');
    return control.getAttribute('placeholder')?.trim() || control.title.trim();
  }
  return ownText(control) || control.title.trim();
}

function extraText(control: HTMLElement): string {
  const parts = [control.title, referencedText(control, 'aria-describedby')];
  if (control instanceof HTMLSelectElement && control.options.length <= MAX_OPTIONS_INDEXED) {
    parts.push(...Array.from(control.options, (option) => option.text));
  }
  return parts.join(' ');
}

/** Section titles and group legends around `control`, outermost first. */
function contextOf(control: HTMLElement, root: HTMLElement): string[] {
  const names: string[] = [];
  const own = control.localName === 'summary' ? control.parentElement : null;
  for (let node = control.parentElement; node !== null && node !== root; node = node.parentElement) {
    if (node === own) continue;
    let name = '';
    if (node instanceof HTMLDetailsElement && node.dataset.section !== undefined) {
      name = ownText(node.querySelector(':scope > summary .workshop-section-title') ?? node);
    } else if (node instanceof HTMLFieldSetElement) {
      const legend = node.querySelector(':scope > legend');
      name = legend === null ? '' : ownText(legend);
    }
    if (name !== '' && normalize(name) !== normalize(names[0] ?? '')) names.unshift(name);
  }
  return names;
}

/**
 * Hidden controls are skipped. Editors hide their own root while another tab is selected
 * ("dormant"); selecting the tab reveals them, so they stay findable.
 */
function availability(control: HTMLElement, root: HTMLElement): 'hidden' | 'dormant' | 'shown' {
  if (control.hidden) return 'hidden';
  for (let node = control.parentElement; node !== null && node !== root; node = node.parentElement) {
    if (node.parentElement === root) return node.hidden ? 'dormant' : 'shown';
    if (node.hidden) return 'hidden';
  }
  return 'shown';
}

const startsAll = (words: readonly string[], tokens: readonly string[]): boolean =>
  words.every((word) => tokens.some((token) => token.startsWith(word)));

function score(target: Target, words: readonly string[], phrase: string): number {
  if (target.text === phrase) return 5;
  if (target.text.startsWith(phrase)) return 4;
  if (startsAll(words, target.words.label)) return 3;
  if (startsAll(words, target.words.near)) return 2;
  return startsAll(words, target.words.all) ? 1 : 0;
}

/**
 * "Find a control" for the Workshop: searches every labeled control and section across all tabs,
 * then reveals the chosen one by selecting its tab, opening its sections and focusing it.
 */
export function createWorkshopSearch(options: {
  readonly root: HTMLElement;
  readonly scopes: readonly SearchScope[];
  readonly selectTab: (tab: WorkshopTab) => void;
  readonly selectedTab: () => WorkshopTab;
  readonly signal: AbortSignal;
}): { focus: () => void } {
  const listen = { signal: options.signal };
  const { root } = options;
  const input = element<HTMLInputElement>(root, 'input');
  const panel = element<HTMLElement>(root, '.workshop-search-panel');
  const list = element<HTMLElement>(root, '[role="listbox"]');
  const note = element<HTMLElement>(root, '.workshop-search-note');
  const status = element<HTMLElement>(root, '[role="status"]');
  let targets: Target[] | null = null;
  let shown: Target[] = [];
  let active = -1;
  let highlighted: { row: HTMLElement; timer: number } | null = null;

  function index(): Target[] {
    if (targets !== null) return targets;
    targets = [];
    for (const scope of options.scopes) {
      for (const control of scope.root.querySelectorAll<HTMLElement>(CONTROLS)) {
        const state = availability(control, scope.root);
        if (state === 'hidden' || control.matches(SKIPPED)) continue;
        const label = labelOf(control);
        if (label === '') continue;
        const context = contextOf(control, scope.root);
        const path = [scope.label, ...context].join(' › ');
        const text = normalize(label);
        const near = [...text.split(' '), ...normalize(path).split(' ')];
        targets.push({
          element: control, scope, label, path, text,
          // A dormant editor disables its controls until its tab is selected.
          disabled: state === 'shown' && control.matches(':disabled'),
          words: { label: text.split(' '), near, all: [...near, ...normalize(extraText(control)).split(' ')] },
        });
      }
    }
    return targets;
  }

  function setActive(next: number): void {
    active = next;
    for (const [position, option] of Array.from(list.children).entries()) {
      option.setAttribute('aria-selected', String(position === active));
    }
    const option = active >= 0 ? list.children[active] : undefined;
    if (!(option instanceof HTMLElement)) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', option.id);
    // Scroll only the results panel; scrollIntoView could also move the page behind a phone sheet.
    const bottom = option.offsetTop + option.offsetHeight;
    if (option.offsetTop < panel.scrollTop) panel.scrollTop = option.offsetTop;
    else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight;
  }

  function hide(): void {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    shown = [];
    active = -1;
  }

  function render(): void {
    const phrase = normalize(input.value);
    if (phrase === '') {
      hide();
      status.textContent = '';
      return;
    }
    const words = phrase.split(' ');
    const current = options.selectedTab();
    // Among equally good matches, and one step above weaker ones, prefer what is already on screen.
    const matches = index().map((target, order) => {
      const quality = score(target, words, phrase);
      const nearby = target.scope.tab === null || target.scope.tab === current;
      return { target, order, score: quality === 0 ? 0 : quality + (nearby ? 1 : 0) };
    })
      .filter((match) => match.score > 0)
      .sort((first, second) => second.score - first.score || first.order - second.order);
    shown = matches.slice(0, MAX_RESULTS).map((match) => match.target);
    list.replaceChildren(...shown.map((target, position) => {
      const option = document.createElement('li');
      option.id = `workshop-search-option-${position}`;
      option.setAttribute('role', 'option');
      option.className = 'workshop-search-option';
      option.classList.toggle('is-disabled', target.disabled);
      const label = document.createElement('span');
      label.className = 'workshop-search-label';
      label.textContent = target.label;
      const path = document.createElement('span');
      path.className = 'workshop-search-path';
      path.textContent = target.disabled ? `${target.path} · unavailable now` : target.path;
      option.append(label, path);
      return option;
    }));
    list.hidden = shown.length === 0;
    note.textContent = matches.length === 0 ? `No controls match “${input.value.trim()}”.` :
      matches.length > shown.length ? `Showing ${shown.length} of ${matches.length}. Keep typing to narrow the list.` : '';
    note.hidden = note.textContent === '';
    status.textContent = matches.length === 0 ? 'No matching controls.' :
      `${matches.length} matching control${matches.length === 1 ? '' : 's'}.`;
    panel.hidden = false;
    input.setAttribute('aria-expanded', String(shown.length > 0));
    setActive(shown.length > 0 ? 0 : -1);
  }

  function highlight(row: HTMLElement): void {
    if (highlighted !== null) {
      window.clearTimeout(highlighted.timer);
      highlighted.row.classList.remove('is-found');
    }
    // Restart the animation when the same control is found twice in a row.
    void row.offsetWidth;
    row.classList.add('is-found');
    highlighted = {
      row,
      timer: window.setTimeout(() => {
        row.classList.remove('is-found');
        highlighted = null;
      }, HIGHLIGHT_MS),
    };
  }

  function reveal(target: Target): void {
    hide();
    targets = null;
    if (target.scope.tab !== null) options.selectTab(target.scope.tab);
    const control = target.element;
    for (let node = control.parentElement; node !== null && node !== target.scope.root; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    const own = control.localName === 'summary' ? control.parentElement : null;
    if (own instanceof HTMLDetailsElement) own.open = true;
    const row = control.closest<HTMLElement>('.tuning-field, .level-field') ?? control;
    const scroller = control.closest<HTMLElement>('.workshop-scroll');
    if (scroller !== null) {
      const view = scroller.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (box.top < view.top || box.bottom > view.bottom) {
        scroller.scrollTop += box.top - view.top - Math.max(0, (view.height - box.height) / 3);
      }
    }
    control.focus({ preventScroll: true });
    highlight(row);
  }

  input.addEventListener('input', render, listen);
  input.addEventListener('focus', () => {
    targets = null;
    if (input.value.trim() !== '') render();
  }, listen);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (panel.hidden) {
        render();
        return;
      }
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + shown.length) % shown.length);
    } else if (event.key === 'Enter') {
      const target = shown[active];
      if (target === undefined) return;
      event.preventDefault();
      reveal(target);
    } else if (event.key === 'Escape' && (!panel.hidden || input.value !== '')) {
      // Clear the search first; a second Escape closes the Workshop as before.
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      status.textContent = '';
      hide();
    }
  }, listen);
  // Keep focus in the field while choosing, so taps never blur-close the list first. This must be
  // mousedown: iOS WebKit still moves focus when only pointerdown is cancelled.
  list.addEventListener('mousedown', (event) => event.preventDefault(), listen);
  list.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    const target = option === null ? undefined : shown[Array.from(list.children).indexOf(option)];
    if (target !== undefined) reveal(target);
  }, listen);
  root.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && root.contains(event.relatedTarget))) hide();
  }, listen);
  options.signal.addEventListener('abort', () => {
    if (highlighted !== null) window.clearTimeout(highlighted.timer);
  }, { once: true });

  return {
    focus: () => {
      input.focus();
      input.select();
    },
  };
}
