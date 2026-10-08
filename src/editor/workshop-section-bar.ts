import { element } from '../dom';
import { showSection } from './workshop-section';

// The sections the bar lists: those with a stable ID that no other section holds.
const SECTION = 'details.workshop-section[data-section]';
// A chip brought into view keeps this much room beside it, so the strip still reads as scrollable.
const CHIP_MARGIN = 24;
// One line of a mouse wheel that scrolls by lines, in pixels.
const LINE_PIXELS = 16;

export interface SectionBar {
  /** Lists the sections of `pane`, the selected tab named `label`; null while the Workshop is closed. */
  show(pane: HTMLElement | null, label: string): void;
}

interface Entry {
  readonly section: HTMLDetailsElement;
  readonly chip: HTMLButtonElement;
}

function holdsSection(nodes: NodeList): boolean {
  for (const node of nodes) {
    if (node instanceof Element && (node.matches(SECTION) || node.querySelector(SECTION) !== null)) return true;
  }
  return false;
}

// Whether `section` shows with its tab: neither it nor anything around it in the scrolling body is hidden. Editors hide
// their own root while their tab is not selected, so what lies outside the body does not count.
function shown(section: HTMLElement, scroller: HTMLElement): boolean {
  for (let node: HTMLElement | null = section; node !== null && node !== scroller; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return true;
}

function headingText(section: HTMLDetailsElement, part: string): string {
  return section.querySelector(`:scope > summary ${part}`)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * The Workshop's section bar: a chip for each section of the selected tab, in order, so every section is one click
 * away however long the tab grows. A chip opens its section and brings it to the top of the tab; as the tab scrolls,
 * the chip of the section at the top is marked current. Back to top and Fold all sit beside the chips. The bar follows
 * only the selected tab of the open Workshop: its scrolling, its sections opening and closing, and sections coming and
 * going, as Workshop plugins add theirs.
 */
export function createSectionBar(options: { readonly root: HTMLElement; readonly signal: AbortSignal }): SectionBar {
  const { root, signal } = options;
  const listen = { signal };
  const strip = element<HTMLElement>(root, '.workshop-section-chips');
  const chips = new Map<string, HTMLButtonElement>();
  let entries: readonly Entry[] = [];
  let pane: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let scrolling: AbortController | null = null;
  let current: HTMLDetailsElement | null = null;
  // The section a chip brought up stays current while the tab rests where the jump left it, even when the tab ends too
  // soon to bring that section all the way to the top.
  let pinned: { readonly section: HTMLDetailsElement; readonly top: number } | null = null;
  let frame = 0;
  let due: 'spy' | 'sync' | null = null;

  const observer = new MutationObserver((records) => {
    if (records.some((record) => holdsSection(record.addedNodes) || holdsSection(record.removedNodes))) schedule('sync');
  });
  const resize = new ResizeObserver(() => {
    const chip = chipOf(current);
    if (chip !== undefined) revealChip(chip);
    updateOverflow();
  });
  resize.observe(strip);

  function schedule(work: 'spy' | 'sync'): void {
    if (due !== 'sync') due = work;
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const pending = due;
      due = null;
      if (pending === 'sync') sync();
      else if (pending === 'spy') spy();
    });
  }

  function chipOf(section: HTMLDetailsElement | null): HTMLButtonElement | undefined {
    return section === null ? undefined : entries.find((entry) => entry.section === section)?.chip;
  }

  function chipFor(id: string): HTMLButtonElement {
    let chip = chips.get(id);
    if (chip === undefined) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'workshop-section-chip';
      chip.tabIndex = -1;
      chips.set(id, chip);
    }
    return chip;
  }

  // Lists the tab's sections again, reusing the chips of those it still has.
  function sync(): void {
    const body = pane?.querySelector<HTMLElement>('.workshop-scroll') ?? null;
    if (body !== scroller) {
      scrolling?.abort();
      scrolling = null;
      scroller = body;
      pinned = null;
      if (body !== null) {
        scrolling = new AbortController();
        body.addEventListener('scroll', () => schedule('spy'), { passive: true, signal: AbortSignal.any([signal, scrolling.signal]) });
      }
    }
    const sections = body === null ? [] : Array.from(body.querySelectorAll<HTMLDetailsElement>(SECTION))
      .filter((section) => (section.parentElement?.closest('details.workshop-section') ?? null) === null && shown(section, body));
    const ids = new Set<string>();
    entries = sections.map((section) => {
      const id = section.dataset.section ?? '';
      ids.add(id);
      const chip = chipFor(id);
      const title = headingText(section, '.workshop-section-title') || id;
      if (chip.textContent !== title) chip.textContent = title;
      const hint = headingText(section, '.workshop-section-hint');
      if (chip.title !== hint) chip.title = hint;
      return { section, chip };
    });
    for (const [id, chip] of chips) {
      if (ids.has(id)) continue;
      chip.remove();
      chips.delete(id);
    }
    const order = entries.map((entry) => entry.chip);
    if (order.length !== strip.children.length || order.some((chip, index) => strip.children[index] !== chip)) {
      strip.replaceChildren(...order);
    }
    root.hidden = entries.length < 2;
    if (!entries.some((entry) => entry.section === current)) current = null;
    spy();
  }

  // Marks the section at the top of the tab current, and which sections are open.
  function spy(): void {
    const body = scroller;
    let next = body === null ? null : current;
    const pin = pinned;
    // A tab whose editor has yet to show it has no layout to read; its current section waits for the next look.
    if (body !== null && body.getClientRects().length > 0) {
      if (pin !== null && body.scrollTop === pin.top && entries.some((entry) => entry.section === pin.section)) {
        next = pin.section;
      } else {
        pinned = null;
        next = null;
        const top = body.getBoundingClientRect().top + 1;
        for (const { section } of entries) {
          if (section.getBoundingClientRect().top > top) break;
          next = section;
        }
      }
    }
    for (const { section, chip } of entries) {
      const open = section.open ? 'true' : 'false';
      if (chip.dataset.open !== open) chip.dataset.open = open;
      if (section === next) {
        if (chip.getAttribute('aria-current') !== 'location') chip.setAttribute('aria-current', 'location');
      } else if (chip.hasAttribute('aria-current')) chip.removeAttribute('aria-current');
    }
    const changed = next !== current;
    current = next;
    const chip = chipOf(next);
    // The strip is one stop in the tab order, at the current chip, unless focus is moving through it.
    if (!strip.contains(document.activeElement)) setTabStop(chip ?? entries[0]?.chip);
    if (changed && chip !== undefined) revealChip(chip);
    updateOverflow();
  }

  function setTabStop(stop: HTMLButtonElement | undefined): void {
    for (const { chip } of entries) {
      const index = chip === stop ? 0 : -1;
      if (chip.tabIndex !== index) chip.tabIndex = index;
    }
  }

  // Scrolls the strip, never the page, until `chip` shows.
  function revealChip(chip: HTMLButtonElement): void {
    const start = chip.offsetLeft - CHIP_MARGIN;
    const end = chip.offsetLeft + chip.offsetWidth + CHIP_MARGIN;
    if (start < strip.scrollLeft) strip.scrollLeft = Math.max(0, start);
    else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth;
  }

  // Which ends of the strip have chips scrolled past them, so they fade there.
  function updateOverflow(): void {
    const room = strip.scrollWidth - strip.clientWidth;
    const more = room <= 1 ? 'none' : strip.scrollLeft <= 1 ? 'end' : strip.scrollLeft >= room - 1 ? 'start' : 'both';
    if (strip.dataset.more !== more) strip.dataset.more = more;
  }

  strip.addEventListener('scroll', updateOverflow, { passive: true, signal });
  // A plain mouse wheel scrolls the strip sideways.
  strip.addEventListener('wheel', (event) => {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PIXELS :
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1);
  }, { passive: false, signal });
  strip.addEventListener('click', (event) => {
    const chip = event.target instanceof Element ? event.target.closest('.workshop-section-chip') : null;
    const entry = entries.find((candidate) => candidate.chip === chip);
    const body = scroller;
    if (entry === undefined || body === null) return;
    if (!body.contains(entry.section) || !shown(entry.section, body)) {
      sync();
      return;
    }
    showSection(entry.section);
    pinned = { section: entry.section, top: body.scrollTop };
    // Like following a link to a part of a page, focus moves to the section, and Tab goes on into it.
    entry.section.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
    spy();
  }, listen);
  strip.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = entries.findIndex((entry) => entry.chip === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 :
      (index + (event.key === 'ArrowLeft' ? -1 : 1) + entries.length) % entries.length;
    const chip = entries[next]!.chip;
    setTabStop(chip);
    chip.focus({ preventScroll: true });
    revealChip(chip);
  }, listen);
  element<HTMLButtonElement>(root, '.workshop-section-top').addEventListener('click', () => {
    if (scroller === null) return;
    pinned = null;
    scroller.scrollTop = 0;
  }, listen);
  element<HTMLButtonElement>(root, '.workshop-section-fold').addEventListener('click', () => {
    if (scroller === null) return;
    for (const { section } of entries) section.open = false;
    pinned = null;
    scroller.scrollTop = 0;
  }, listen);
  // Opening or closing a section changes which sections are open, and can move which one is at the top.
  document.addEventListener('toggle', (event) => {
    if (pane !== null && event.target instanceof Node && pane.contains(event.target)) schedule('spy');
  }, { capture: true, signal });
  signal.addEventListener('abort', () => {
    observer.disconnect();
    resize.disconnect();
    scrolling?.abort();
    if (frame !== 0) cancelAnimationFrame(frame);
  }, { once: true });

  return {
    show(next, label) {
      root.setAttribute('aria-label', `${label} sections`);
      if (next !== pane) {
        observer.disconnect();
        pane = next;
        current = null;
        strip.scrollLeft = 0;
        if (next !== null) observer.observe(next, { childList: true, subtree: true });
      }
      sync();
      // A tab just shown may still be laying out; look for the section at its top again on the next frame.
      if (next !== null) schedule('spy');
    },
  };
}
