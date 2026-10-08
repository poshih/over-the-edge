import { element, setPressed } from '../dom';
import { readLayoutPreference, writeLayoutPreference } from './layout-preference';

const STORAGE_KEY = 'over-the-edge:workshop:width:v1';
const COMPACT_WIDTH = 354;
const MAX_WIDTH = 960;
// Today's desktop chrome starts at 1040px, beside a 354px Compact panel.
const COMPACT_CHROME_GAME_WIDTH = 1040 - COMPACT_WIDTH;
// The brand mark and signature first appear at 1280px, beside the same Compact panel.
const PLAIN_CHROME_GAME_WIDTH = 1280 - COMPACT_WIDTH;

interface WidthPreference {
  readonly mode: 'compact' | 'wide';
  readonly wideWidth: number;
}

interface Bounds {
  readonly minimum: number;
  readonly maximum: number;
}

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  readonly bounds: Bounds;
  width: number;
}

function widthPreference(value: unknown): WidthPreference | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('mode') || !keys.includes('wideWidth') ||
    !('mode' in value) || !('wideWidth' in value) ||
    (value.mode !== 'compact' && value.mode !== 'wide') || typeof value.wideWidth !== 'number' ||
    !Number.isFinite(value.wideWidth) || value.wideWidth < COMPACT_WIDTH || value.wideWidth > MAX_WIDTH) return null;
  return { mode: value.mode, wideWidth: value.wideWidth };
}

function sideBounds(viewportWidth: number, desktop: boolean): Bounds {
  return desktop ? {
    minimum: viewportWidth >= 1600 ? 374 : COMPACT_WIDTH,
    maximum: Math.min(MAX_WIDTH, viewportWidth - 480),
  } : {
    minimum: Math.min(380, 0.45 * viewportWidth),
    maximum: 0.45 * viewportWidth,
  };
}

function clamp(width: number, bounds: Bounds): number {
  return Math.min(bounds.maximum, Math.max(bounds.minimum, width));
}

/** Owns side-panel width, including transient drag previews; it never changes the viewport-based pause policy. */
export function createWorkshopWidth(options: {
  readonly panel: HTMLElement;
  readonly desktop: MediaQueryList;
  readonly signal: AbortSignal;
}) {
  const { panel, desktop, signal } = options;
  const listen = { signal };
  const handle = element<HTMLElement>(panel, '.workshop-width-handle');
  const wide = element<HTMLButtonElement>(panel, '.workshop-wide');
  const close = element<HTMLButtonElement>(panel, '.workshop-close');
  const portrait = window.matchMedia('(orientation: portrait)');
  const rootStyle = document.documentElement.style;
  let requested: WidthPreference = readLayoutPreference(STORAGE_KEY, widthPreference) ?? { mode: 'compact', wideWidth: 800 };
  let open = false;
  let sheet = false;
  let bounds: Bounds | null = null;
  let viewportWidth = 0;
  let effective = 0;
  let renderedMode: WidthPreference['mode'] = 'compact';
  let drag: Drag | null = null;
  let frame = 0;

  function committedWidth(limits: Bounds): number {
    return requested.mode === 'compact' ? limits.minimum : clamp(requested.wideWidth, limits);
  }

  function preferenceAt(width: number, limits: Bounds): WidthPreference {
    return width <= limits.minimum ? { mode: 'compact', wideWidth: requested.wideWidth } : { mode: 'wide', wideWidth: width };
  }

  function currentMode(width: number, limits: Bounds): WidthPreference['mode'] {
    return width <= limits.minimum ? 'compact' : 'wide';
  }

  function renderGameChrome(): void {
    const gameWidth = viewportWidth - effective;
    const chrome = !open ? undefined : sheet || gameWidth < COMPACT_CHROME_GAME_WIDTH ? 'compact' :
      gameWidth < PLAIN_CHROME_GAME_WIDTH ? 'plain' : undefined;
    if (document.body.dataset.gameChrome === chrome) return;
    if (chrome === undefined) delete document.body.dataset.gameChrome;
    else document.body.dataset.gameChrome = chrome;
  }

  function render(): void {
    if (bounds !== null) {
      const width = drag?.width ?? committedWidth(bounds);
      const mode = currentMode(width, bounds);
      const widthChanged = width !== effective;
      if (widthChanged) {
        rootStyle.setProperty('--workshop-width', `${width}px`);
        effective = width;
        handle.setAttribute('aria-valuenow', String(width));
      }
      if (widthChanged || mode !== renderedMode) {
        handle.setAttribute('aria-valuetext', `${Math.round(width)} pixels, ${mode === 'compact' ? 'Compact' : 'Wide'}`);
        setPressed(wide, mode === 'wide');
        renderedMode = mode;
      }
    }
    renderGameChrome();
  }

  function releaseCapture(pointerId: number): void {
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }

  function releaseDrag(): void {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    const previous = drag;
    drag = null;
    if (previous !== null) releaseCapture(previous.pointerId);
  }

  function cancelDrag(): void {
    releaseDrag();
    render();
  }

  function scheduleRender(): void {
    if (bounds === null) return;
    const width = drag?.width ?? committedWidth(bounds);
    if (width === effective && currentMode(width, bounds) === renderedMode) {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  function preview(clientX: number): void {
    if (drag === null) return;
    const width = clamp(drag.startWidth + drag.startX - clientX, drag.bounds);
    if (width === drag.width) return;
    drag.width = width;
    scheduleRender();
  }

  function refreshViewport(): void {
    if (!open) return;
    // A viewport change invalidates the cached drag geometry, so restore the request rather than committing its clamp.
    releaseDrag();
    sheet = !desktop.matches && portrait.matches;
    viewportWidth = document.documentElement.clientWidth;
    bounds = sheet ? null : sideBounds(viewportWidth, desktop.matches);
    const hidden = bounds === null || bounds.maximum <= bounds.minimum;
    if (hidden && (document.activeElement === handle || document.activeElement === wide)) close.focus({ preventScroll: true });
    handle.hidden = hidden;
    wide.hidden = hidden;
    if (bounds !== null) {
      handle.setAttribute('aria-valuemin', String(bounds.minimum));
      handle.setAttribute('aria-valuemax', String(bounds.maximum));
    }
    render();
  }

  wide.addEventListener('click', () => {
    if (!open || bounds === null || bounds.maximum <= bounds.minimum) return;
    releaseDrag();
    requested = { mode: requested.mode === 'compact' ? 'wide' : 'compact', wideWidth: requested.wideWidth };
    render();
    writeLayoutPreference(STORAGE_KEY, requested);
  }, listen);

  handle.addEventListener('keydown', (event) => {
    if (!open || bounds === null || bounds.maximum <= bounds.minimum || event.ctrlKey || event.metaKey || event.altKey ||
      event.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 50 : 10;
    const width = clamp(event.key === 'Home' ? bounds.minimum : event.key === 'End' ? MAX_WIDTH :
      effective + (event.key === 'ArrowLeft' ? step : -step), bounds);
    if (width === effective && currentMode(width, bounds) === renderedMode) return;
    releaseDrag();
    requested = preferenceAt(event.key === 'End' ? MAX_WIDTH : width, bounds);
    render();
    writeLayoutPreference(STORAGE_KEY, requested);
  }, listen);

  handle.addEventListener('pointerdown', (event) => {
    if (!open || bounds === null || bounds.maximum <= bounds.minimum || drag !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    releaseDrag();
    render();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    // The rendered width, pointer origin and bounds stay cached until release or a viewport change.
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: effective, bounds, width: effective };
  }, listen);
  handle.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      cancelDrag();
      return;
    }
    preview(event.clientX);
  }, listen);
  handle.addEventListener('pointerup', (event) => {
    const finished = drag;
    if (finished === null || finished.pointerId !== event.pointerId) return;
    preview(event.clientX);
    drag = null;
    releaseCapture(finished.pointerId);
    if (finished.width !== finished.startWidth || finished.width <= finished.bounds.minimum) {
      requested = preferenceAt(finished.width, finished.bounds);
    }
    // Even the final pointer position uses the coalesced layout path, never an extra immediate width write.
    scheduleRender();
    writeLayoutPreference(STORAGE_KEY, requested);
  }, listen);
  const cancelled = (event: PointerEvent): void => {
    if (drag?.pointerId === event.pointerId) cancelDrag();
  };
  handle.addEventListener('pointercancel', cancelled, listen);
  handle.addEventListener('lostpointercapture', cancelled, listen);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || drag === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelDrag();
  }, { capture: true, signal });
  window.addEventListener('blur', () => {
    if (drag !== null) cancelDrag();
  }, listen);
  window.addEventListener('resize', refreshViewport, { passive: true, signal });
  desktop.addEventListener('change', refreshViewport, listen);
  portrait.addEventListener('change', refreshViewport, listen);
  signal.addEventListener('abort', () => {
    open = false;
    cancelDrag();
    rootStyle.removeProperty('--workshop-width');
  }, { once: true });

  return {
    setOpen: (nextOpen: boolean): void => {
      if (signal.aborted || open === nextOpen) return;
      if (nextOpen) {
        open = true;
        refreshViewport();
      } else {
        open = false;
        cancelDrag();
      }
    },
  };
}
