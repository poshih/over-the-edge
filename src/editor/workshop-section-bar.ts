import { element, setText } from '../dom';
import { showSection } from './workshop-section';

// The sections the bar lists: those with a stable ID that no other section holds.
const SECTION = 'details.workshop-section[data-section]';

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

/** Reveals a control vertically inside navigation, without scrolling the page or the selected pane. */
export function revealNavigation(navigation: HTMLElement, control: HTMLElement): void {
  if (navigation.clientHeight === 0 || control.getClientRects().length === 0) return;
  const bounds = control.getBoundingClientRect();
  const top = bounds.top - navigation.getBoundingClientRect().top - navigation.clientTop;
  if (top < 0 || bounds.height > navigation.clientHeight) navigation.scrollTop += top;
  else if (top + bounds.height > navigation.clientHeight) navigation.scrollTop += top + bounds.height - navigation.clientHeight;
}

/**
 * The Workshop's section bar: a current-section summary and All sections opening every chip in DOM order. A chip opens
 * its section and brings it to the top of the tab; as the tab scrolls, that section's chip is marked current. The bar
 * follows only the selected tab of the open Workshop, including sections coming and going as plugins add theirs.
 */
export function createSectionBar(options: {
  readonly root: HTMLElement;
  readonly navigation: HTMLElement;
  readonly focusSelectedTab: () => void;
  readonly signal: AbortSignal;
}): SectionBar {
  const { root, navigation, focusSelectedTab, signal } = options;
  const listen = { signal };
  const strip = element<HTMLElement>(root, '.workshop-section-chips');
  const all = element<HTMLButtonElement>(root, '.workshop-section-all');
  const tabList = element<HTMLElement>(navigation, '.workshop-tabs');
  const chips = new Map<string, HTMLButtonElement>();
  let entries: readonly Entry[] = [];
  let pane: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let scrolling: AbortController | null = null;
  let current: HTMLDetailsElement | null = null;
  let expanded = false;
  // The section a chip brought up stays current while the tab rests where the jump left it, even when the tab ends too
  // soon to bring that section all the way to the top.
  let pinned: { readonly section: HTMLDetailsElement; readonly top: number } | null = null;
  let frame = 0;
  let due: 'spy' | 'sync' | null = null;
  let focusDue = false;

  const observer = new MutationObserver((records) => {
    if (records.some((record) => holdsSection(record.addedNodes) || holdsSection(record.removedNodes))) schedule('sync');
  });
  const resize = new ResizeObserver((records) => {
    schedule('spy', records.some((record) => record.target === navigation || record.target === tabList || record.target === strip));
  });

  function cancelScheduled(): void {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    due = null;
    focusDue = false;
  }

  function schedule(work: 'spy' | 'sync', navigationLayout = false): void {
    if (due !== 'sync') due = work;
    focusDue ||= navigationLayout;
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const pending = due;
      const keepFocus = focusDue;
      due = null;
      focusDue = false;
      if (pending === 'sync') sync();
      else if (pending === 'spy') {
        spy();
        if (keepFocus) keepFocusInView();
      }
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
    const active = document.activeElement;
    const focusedIndex = entries.findIndex((entry) => entry.chip === active);
    const body = pane?.querySelector<HTMLElement>('.workshop-scroll') ?? null;
    if (body !== scroller) {
      scrolling?.abort();
      scrolling = null;
      resize.disconnect();
      scroller = body;
      pinned = null;
      if (body !== null) {
        scrolling = new AbortController();
        const paneSignal = AbortSignal.any([signal, scrolling.signal]);
        body.addEventListener('scroll', () => schedule('spy'), { passive: true, signal: paneSignal });
        strip.addEventListener('focusout', () => schedule('spy'), { signal: paneSignal });
        resize.observe(body);
        resize.observe(navigation);
        resize.observe(tabList);
        resize.observe(strip);
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
    const hidden = entries.length < 2;
    // Move focus out before a disappearing bar hides its controls.
    if (hidden && pane !== null && root.contains(active)) focusSelectedTab();
    const restore = hidden || focusedIndex < 0 ? undefined :
      entries.find((entry) => entry.chip === active)?.chip ?? entries[Math.min(focusedIndex, entries.length - 1)]?.chip;
    for (const [id, chip] of chips) {
      if (ids.has(id)) continue;
      chip.remove();
      chips.delete(id);
    }
    const order = entries.map((entry) => entry.chip);
    if (order.length !== strip.children.length || order.some((chip, index) => strip.children[index] !== chip)) {
      strip.replaceChildren(...order);
    }
    root.hidden = hidden;
    if (!entries.some((entry) => entry.section === current)) current = null;
    setText(all, `All sections (${entries.length})`);
    updateChips(restore);
    // Reordering may detach a focused survivor; removing it instead focuses its next neighbour, or the last chip.
    if (restore !== undefined && document.activeElement !== restore) restore.focus({ preventScroll: true });
    spy();
    keepFocusInView();
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
    updateChips();
    const chip = chipOf(next) ?? entries[0]?.chip;
    if (changed && chip !== undefined && !navigation.contains(document.activeElement)) revealNavigation(navigation, chip);
  }

  // A collapsed summary retains a focused chip even when scroll-spy moves the current section elsewhere.
  function updateChips(focused = entries.find((entry) => entry.chip === document.activeElement)?.chip): void {
    const summary = chipOf(current) ?? entries[0]?.chip;
    const stop = focused ?? summary;
    for (const { chip } of entries) {
      const hidden = !expanded && chip !== summary && chip !== focused;
      if (chip.hidden !== hidden) chip.hidden = hidden;
      const index = chip === stop ? 0 : -1;
      if (chip.tabIndex !== index) chip.tabIndex = index;
    }
    const state = String(expanded);
    if (all.getAttribute('aria-expanded') !== state) all.setAttribute('aria-expanded', state);
    if (strip.dataset.expanded !== state) strip.dataset.expanded = state;
  }

  function keepFocusInView(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && navigation.contains(active)) revealNavigation(navigation, active);
  }

  function setExpanded(next: boolean): void {
    // Focus All sections while every chip is still visible, before collapsing hides any of them.
    if (!next) all.focus({ preventScroll: true });
    expanded = next;
    updateChips();
    keepFocusInView();
  }

  all.addEventListener('click', () => setExpanded(!expanded), listen);
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !expanded) return;
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
  }, listen);
  strip.addEventListener('focusin', () => updateChips(), listen);
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
    if (chip.hidden) setExpanded(true);
    updateChips(chip);
    if (document.activeElement === chip) revealNavigation(navigation, chip);
    else chip.focus({ preventScroll: true });
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
    cancelScheduled();
    observer.disconnect();
    resize.disconnect();
    scrolling?.abort();
  }, { once: true });

  return {
    show(next, label) {
      if (signal.aborted) return;
      root.setAttribute('aria-label', `${label} sections`);
      if (next !== pane) {
        cancelScheduled();
        observer.disconnect();
        resize.disconnect();
        scrolling?.abort();
        scrolling = null;
        scroller = null;
        pinned = null;
        if (next !== null && root.contains(document.activeElement)) focusSelectedTab();
        pane = next;
        current = null;
        expanded = false;
        if (next !== null) observer.observe(next, { childList: true, subtree: true });
      }
      sync();
      // A tab just shown may still be laying out; look for the section at its top again on the next frame.
      if (next !== null) schedule('spy');
    },
  };
}
