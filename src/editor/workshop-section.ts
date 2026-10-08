/**
 * Collapsible Workshop sections: native <details> elements with a stable `data-section` id, so
 * browser find-in-page, the Workshop search, the section bar and tests can reveal them. Whether a
 * section is open is a browser-local layout preference; only choices that differ from its default
 * are remembered.
 */
const STORAGE_KEY = 'over-the-edge:workshop:sections:v1';

export interface WorkshopSection {
  /** Unique `<tab>-<name>` id, also the remembered-preference key. */
  readonly id: string;
  readonly title: string;
  /** Short, muted note on what the section contains. */
  readonly hint?: string;
  /** State used until the user opens or closes the section. */
  readonly open?: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function remembered(): Record<string, boolean> {
  let text: string | null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return {};
    throw error;
  }
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
}

/** Markup for a section; `body` is trusted template markup. */
export function sectionMarkup(section: WorkshopSection, body: string): string {
  const open = remembered()[section.id] ?? section.open === true;
  // The heading stays on one line, so a long hint is cut short; its title shows all of it.
  const hint = section.hint === undefined ? '' :
    `<span class="workshop-section-hint" title="${escapeHtml(section.hint)}">${escapeHtml(section.hint)}</span>`;
  return `<details class="workshop-section" data-section="${escapeHtml(section.id)}" data-section-default="${
    section.open === true ? 'open' : 'closed'}"${open ? ' open' : ''}>
    <summary class="workshop-section-summary"><span class="workshop-section-title">${escapeHtml(section.title)}</span>${hint}</summary>
    <div class="workshop-section-body">${body}</div>
  </details>`;
}

export function createSection(section: WorkshopSection): { root: HTMLDetailsElement; body: HTMLDivElement } {
  const template = document.createElement('template');
  template.innerHTML = sectionMarkup(section, '');
  const root = template.content.firstElementChild;
  const body = root?.querySelector(':scope > .workshop-section-body');
  if (!(root instanceof HTMLDetailsElement) || !(body instanceof HTMLDivElement)) {
    throw new Error(`Could not create Workshop section: ${section.id}`);
  }
  return { root, body };
}

/**
 * The height of the heading of the open top-level section around `node`, which stays at the top of the tab's scrolling
 * body while the section scrolls by: the part of the view it covers. 0 when `node` is not inside such a section's body.
 */
export function headingInset(node: Element): number {
  let outermost: HTMLDetailsElement | null = null;
  for (let parent = node.parentElement; parent !== null && !parent.classList.contains('workshop-scroll'); parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && parent.dataset.section !== undefined) outermost = parent;
  }
  if (outermost === null || !outermost.open) return 0;
  const summary = outermost.querySelector<HTMLElement>(':scope > summary');
  return summary === null || summary.contains(node) ? 0 : summary.offsetHeight;
}

/** Opens `section` and the sections around it, then scrolls the tab so it starts at the top, below any stuck heading. */
export function showSection(section: HTMLDetailsElement): void {
  for (let node: Element | null = section; node !== null && !node.classList.contains('workshop-scroll'); node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  const scroller = section.closest<HTMLElement>('.workshop-scroll');
  if (scroller === null) return;
  scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headingInset(section);
}

/**
 * Closing a section from its heading stuck at the top of the tab, its start scrolled past, scrolls back to that start, so
 * the heading, and the focus on it, stay in view instead of ending up above the shortened tab.
 */
export function keepClosingHeadingsInView(root: HTMLElement, signal: AbortSignal): void {
  root.addEventListener('click', (event) => {
    const summary = event.target instanceof Element ? event.target.closest('summary') : null;
    const section = summary?.parentElement;
    if (!(section instanceof HTMLDetailsElement) || section.dataset.section === undefined || !section.open) return;
    if (section.querySelector(':scope > summary') !== summary) return;
    const scroller = section.closest<HTMLElement>('.workshop-scroll');
    if (scroller === null) return;
    const past = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (past >= 0) return;
    // Read before closing: the shorter tab may clamp its scroll position, and the setter clamps the target alike.
    const target = scroller.scrollTop + past;
    event.preventDefault();
    section.open = false;
    scroller.scrollTop = target;
  }, { signal });
}

/** Remembers the open state the user chooses for any section inside `root`. */
export function rememberSections(root: HTMLElement, signal: AbortSignal): void {
  root.addEventListener('toggle', (event) => {
    const section = event.target;
    if (!(section instanceof HTMLDetailsElement) || section.dataset.section === undefined) return;
    const id = section.dataset.section;
    const fallback = section.dataset.sectionDefault === 'open';
    const states = remembered();
    // Inserting a section fires toggle with the state it was created in; that is not a choice.
    if ((states[id] ?? fallback) === section.open) return;
    if (section.open === fallback) delete states[id];
    else states[id] = section.open;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
    } catch (error) {
      // Layout is a disposable preference: unavailable or full storage only forgets it.
      if (!(error instanceof DOMException)) throw error;
    }
  }, { capture: true, signal });
}
