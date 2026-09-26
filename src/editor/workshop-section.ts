/**
 * Collapsible Workshop sections: native <details> elements with a stable `data-section` id, so
 * browser find-in-page, the Workshop search and tests can reveal them. Whether a section is open
 * is a browser-local layout preference; only choices that differ from its default are remembered.
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
  const hint = section.hint === undefined ? '' : `<span class="workshop-section-hint">${escapeHtml(section.hint)}</span>`;
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
