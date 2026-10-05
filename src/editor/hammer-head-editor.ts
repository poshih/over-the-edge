import type { Point } from '../config';
import { RIG } from '../config';
import { element, setPressed, setText } from '../dom';
import { DEFAULT_HAMMER_HEAD, HAMMER_HEAD_LIMITS, HammerHeadError, hammerHeadBack, sameHammerHead, validateHammerHead } from '../hammer-head';
import type { HammerHead } from '../hammer-head';
import { createRangeControl } from './range-control';
import './hammer-head-editor.css';

// A hammer whose head the editor shapes: the default hammer (id null), whose head is a game setting, or a library hammer.
export interface HeadedHammer {
  readonly id: string | null;
  readonly name: string;
  readonly head: HammerHead;
}

export interface HammerHeadEditor {
  // The settings or the library changed elsewhere: shows them, once a drag in progress ends.
  refresh(): void;
  dispose(): void;
}

const SVG = 'http://www.w3.org/2000/svg';
// Metres shown around the head's centre, beyond the farthest a point may go.
const VIEW = HAMMER_HEAD_LIMITS.reach + 0.1;
// The grids a moved or added point snaps to, in whole millimetres, and the arrow keys move it one step of (ten with
// Shift). Each is 1, 2 or 5 times a power of ten, so it divides the 10 cm between the lines always drawn; a grid of
// 2 cm or more draws too, where a finer one would fill the canvas. Outlines round to the millimetre, so 1 mm is free.
const SNAP_GRIDS: readonly number[] = [1, 2, 5, 10, 20, 50, 100];
const DEFAULT_SNAP = 5;
const LINES = 100;
const FINEST_DRAWN = 20;
// This browser's choice of grid.
const SNAP_KEY = 'over-the-edge:hammer-head:snap';
// Screen pixels a pressed point must move before it drags, so a click only selects it.
const DRAG_PIXELS = 3;

function regularHead(radius: number, sides: number): HammerHead {
  return validateHammerHead(Array.from({ length: sides }, (_, index) => {
    const angle = (index + 0.5) / sides * 2 * Math.PI;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }));
}

// Starting points: the built-in sledge, a round head, and a sledge with a pick for hooking ledges.
const PRESETS: readonly { readonly label: string; readonly head: HammerHead }[] = [
  { label: 'Sledge', head: DEFAULT_HAMMER_HEAD },
  { label: 'Round', head: regularHead(0.2, 12) },
  { label: 'Pick', head: validateHammerHead([
    { x: -0.1, y: -0.23 }, { x: -0.06, y: -0.29 }, { x: 0.06, y: -0.29 }, { x: 0.1, y: -0.23 },
    { x: 0.1, y: 0.12 }, { x: 0, y: 0.45 }, { x: -0.1, y: 0.12 },
  ]) },
];

function cross(o: Readonly<Point>, a: Readonly<Point>, b: Readonly<Point>): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// The smallest convex outline around the points, counter-clockwise, without points on its edges.
function hull(points: readonly Readonly<Point>[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (list: readonly Readonly<Point>[]): Point[] => {
    const result: Point[] = [];
    for (const point of list) {
      while (result.length >= 2 && cross(result[result.length - 2]!, result[result.length - 1]!, point) <= 0) result.pop();
      result.push({ x: point.x, y: point.y });
    }
    result.pop();
    return result;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function mirrored(point: Readonly<Point>): Point {
  return { x: point.x, y: -point.y };
}

// Whether the outline is its own reflection across the handle.
function symmetric(head: HammerHead): boolean {
  return head.every((point) => head.some((other) => other.x === point.x && other.y === -point.y));
}

// The nearest point of a grid `step` millimetres apart within reach of the centre. Whole millimetres keep grid points
// exact, so one on the rim stays there.
function snap(point: Readonly<Point>, step: number): Point {
  const distance = Math.hypot(point.x, point.y);
  const scale = distance > HAMMER_HEAD_LIMITS.reach ? HAMMER_HEAD_LIMITS.reach / distance : 1;
  const x = point.x * scale * 1000, y = point.y * scale * 1000;
  const rounded = { x: Math.round(x / step) * step / 1000 + 0, y: Math.round(y / step) * step / 1000 + 0 };
  // Rounding may push a point on the rim past it; then it rounds toward the centre.
  return Math.hypot(rounded.x, rounded.y) <= HAMMER_HEAD_LIMITS.reach ? rounded
    : { x: Math.trunc(x / step) * step / 1000 + 0, y: Math.trunc(y / step) * step / 1000 + 0 };
}

function gridLabel(step: number): string {
  return step < 10 ? `${step} mm` : `${step / 10} cm`;
}

// The grid this browser chose last.
function readSnap(): number {
  try {
    const stored = Number(localStorage.getItem(SNAP_KEY));
    return SNAP_GRIDS.includes(stored) ? stored : DEFAULT_SNAP;
  } catch (error) {
    if (error instanceof DOMException) return DEFAULT_SNAP;
    throw error;
  }
}

// Where a point landed in an outline, which rounds points to the millimetre; -1 when it is not one of its points.
function indexOf(head: HammerHead, point: Readonly<Point>): number {
  return head.findIndex((candidate) => Math.abs(candidate.x - point.x) < 1e-6 && Math.abs(candidate.y - point.y) < 1e-6);
}

function metres(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

/**
 * Physics / Hammer head: each hammer's collision outline, shaped on a canvas around the head's centre, where the
 * handle ends. Points drag, an edge takes a new point where it is pressed, the arrow keys nudge the selected point and
 * Delete removes it; moved and added points snap to the chosen grid. The outline is always the smallest convex one
 * around its points, so it can never fold in. Mirror keeps the two sides of the handle alike. Each change applies once
 * the pointer lifts.
 */
export function createHammerHeadEditor(options: {
  readonly mount: HTMLElement;
  // The default hammer first, then the library's hammers.
  readonly hammers: () => readonly HeadedHammer[];
  // Stores a hammer's new head; false when it was refused, which the store reports.
  readonly setHead: (id: string | null, head: HammerHead) => boolean;
}): HammerHeadEditor {
  const events = new AbortController();
  const listen = { signal: events.signal };
  const root = options.mount;
  root.innerHTML = `
    <label class="hammer-head-label" for="hammer-head-hammer">Hammer</label>
    <select id="hammer-head-hammer"></select>
    <svg class="hammer-head-canvas" viewBox="${-VIEW} ${-VIEW} ${2 * VIEW} ${2 * VIEW}" role="group"
      aria-label="Hammer head outline: the handle comes in from the left to the head's centre">
      <g class="hammer-head-world" transform="scale(1 -1)">
        <g class="hammer-head-snap-grid"></g>
        <g class="hammer-head-grid"></g>
        <circle class="hammer-head-reach" r="${HAMMER_HEAD_LIMITS.reach}"></circle>
        <rect class="hammer-head-handle" x="${-VIEW}" y="${-RIG.handleHalfWidth}" width="${VIEW}" height="${2 * RIG.handleHalfWidth}"></rect>
        <polygon class="hammer-head-outline"></polygon>
        <g class="hammer-head-edges"></g>
        <circle class="hammer-head-centre" r="0.012"></circle>
        <g class="hammer-head-points"></g>
      </g>
    </svg>
    <div class="hammer-head-snap"></div>
    <div class="hammer-head-actions">
      <button type="button" class="button hammer-head-mirror" aria-pressed="false"
        title="Keep both sides of the handle alike; turning it on mirrors the side above the handle">Mirror</button>
      <button type="button" class="button hammer-head-remove">Remove point</button>
    </div>
    <div class="hammer-head-presets" role="group" aria-label="Start from">
      ${PRESETS.map((preset, index) => `<button type="button" class="button" data-preset="${index}">${preset.label}</button>`).join('')}
    </div>
    <p class="hammer-head-readout"></p>
    <p class="hammer-head-problem" role="status" aria-live="polite"></p>
    <p class="hammer-head-help"></p>
  `;
  const select = element<HTMLSelectElement>(root, '#hammer-head-hammer');
  const svg = root.querySelector<SVGSVGElement>('.hammer-head-canvas')!;
  const world = svg.querySelector<SVGGElement>('.hammer-head-world')!;
  const outline = svg.querySelector<SVGPolygonElement>('.hammer-head-outline')!;
  const edgeLayer = svg.querySelector<SVGGElement>('.hammer-head-edges')!;
  const pointLayer = svg.querySelector<SVGGElement>('.hammer-head-points')!;
  const mirrorButton = element<HTMLButtonElement>(root, '.hammer-head-mirror');
  const removeButton = element<HTMLButtonElement>(root, '.hammer-head-remove');
  const readout = element<HTMLParagraphElement>(root, '.hammer-head-readout');
  const problem = element<HTMLParagraphElement>(root, '.hammer-head-problem');
  const help = element<HTMLParagraphElement>(root, '.hammer-head-help');
  const snapGrid = svg.querySelector<SVGGElement>('.hammer-head-snap-grid')!;

  // Lines `every` millimetres apart within reach of the centre, each across the canvas, leaving out the 10 cm lines when
  // `between` is set.
  function drawLines(group: SVGGElement, every: number, between: boolean): void {
    const count = Math.floor(Math.round(HAMMER_HEAD_LIMITS.reach * 1000) / every);
    const lines: SVGLineElement[] = [];
    for (let index = -count; index <= count; index++) {
      if (between && index * every % LINES === 0) continue;
      const at = index * every / 1000;
      for (const [x1, y1, x2, y2] of [[at, -VIEW, at, VIEW], [-VIEW, at, VIEW, at]] as const) {
        const line = document.createElementNS(SVG, 'line');
        line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
        line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
        lines.push(line);
      }
    }
    group.replaceChildren(...lines);
  }
  drawLines(svg.querySelector<SVGGElement>('.hammer-head-grid')!, LINES, false);

  let grid = readSnap();
  const snapControl = createRangeControl({
    label: 'Snap grid', min: 0, max: SNAP_GRIDS.length - 1, step: 1, unit: '',
    description: 'Points snap to this grid as you drag or add them, and the arrow keys move one step, ten with Shift. ' +
      'Grids of 2 cm and more show on the canvas. This browser remembers the choice.',
  }, {
    id: 'hammer-head-snap', name: 'hammer-head-snap', signal: events.signal,
    format: (index) => gridLabel(SNAP_GRIDS[index]!),
    onInput: (index) => {
      grid = SNAP_GRIDS[index]!;
      try {
        localStorage.setItem(SNAP_KEY, String(grid));
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
      }
      showSnap();
    },
  });
  element<HTMLDivElement>(root, '.hammer-head-snap').append(snapControl.row);

  // The chosen grid on the slider and, when it is coarse enough to see, on the canvas.
  function showSnap(): void {
    snapControl.setValue(SNAP_GRIDS.indexOf(grid));
    if (grid >= FINEST_DRAWN) drawLines(snapGrid, grid, true);
    else snapGrid.replaceChildren();
  }
  showSnap();

  let hammers: readonly HeadedHammer[] = [];
  // The chosen hammer's id (null: the default hammer) and the outline shown: its head, or a drag's outline.
  let chosen: string | null = null;
  let head: HammerHead = DEFAULT_HAMMER_HEAD;
  let shown: HammerHead = head;
  let selected: number | null = null;
  let mirror = false;
  // A drag in progress: the points it moves, which may lie inside the outline for now, and which of them move; where
  // the press was, how far the pressed point lies from the pointer, and whether it has moved yet.
  let drag: {
    readonly pointerId: number; readonly points: Point[]; readonly index: number; readonly partner: number | null;
    readonly start: Readonly<Point>; readonly offset: Readonly<Point>; moved: boolean;
  } | null = null;
  let stale = false;
  const pointElements: SVGCircleElement[] = [];
  const edgeElements: SVGLineElement[] = [];

  function hammer(): HeadedHammer | undefined {
    return hammers.find((candidate) => candidate.id === chosen);
  }

  // The outline around `points`, or null with the reason shown when it is not a valid head.
  function outlineOf(points: readonly Readonly<Point>[]): HammerHead | null {
    try {
      const next = validateHammerHead(hull(mirror ? [...points, ...points.map(mirrored)] : points));
      setText(problem, '');
      return next;
    } catch (error) {
      if (!(error instanceof HammerHeadError)) throw error;
      setText(problem, error.message);
      return null;
    }
  }

  function commit(next: HammerHead): void {
    const current = hammer();
    if (current === undefined) return;
    if (options.setHead(current.id, next)) head = next;
    shown = head;
    render();
  }

  function render(): void {
    const current = hammer();
    outline.setAttribute('points', shown.map((point) => `${point.x},${point.y}`).join(' '));
    for (let index = 0; index < Math.max(shown.length, pointElements.length); index++) {
      if (index >= shown.length) {
        pointElements[index]!.remove();
        edgeElements[index]!.remove();
        continue;
      }
      let point = pointElements[index];
      let edge = edgeElements[index];
      if (point === undefined || edge === undefined) {
        point = document.createElementNS(SVG, 'circle');
        point.setAttribute('class', 'hammer-head-point');
        point.setAttribute('r', '0.03');
        point.setAttribute('tabindex', '0');
        point.setAttribute('role', 'button');
        point.dataset.index = String(index);
        edge = document.createElementNS(SVG, 'line');
        edge.setAttribute('class', 'hammer-head-edge');
        edge.dataset.index = String(index);
        pointElements[index] = point;
        edgeElements[index] = edge;
      }
      if (!point.isConnected) pointLayer.append(point);
      if (!edge.isConnected) edgeLayer.append(edge);
      const a = shown[index]!;
      const b = shown[(index + 1) % shown.length]!;
      point.setAttribute('cx', String(a.x));
      point.setAttribute('cy', String(a.y));
      point.setAttribute('aria-label', `Point ${index + 1} of ${shown.length}: x ${metres(a.x)}, y ${metres(a.y)}`);
      point.setAttribute('aria-pressed', String(index === selected));
      edge.setAttribute('x1', String(a.x)); edge.setAttribute('y1', String(a.y));
      edge.setAttribute('x2', String(b.x)); edge.setAttribute('y2', String(b.y));
    }
    const xs = shown.map((point) => point.x);
    const ys = shown.map((point) => point.y);
    setText(readout, `${shown.length} points · ${metres(Math.max(...xs) - Math.min(...xs))} along the handle by ${
      metres(Math.max(...ys) - Math.min(...ys))} across · reaches ${metres(hammerHeadBack(shown))} back down the handle`);
    setText(help, current?.id === null || current === undefined
      ? 'The default hammer\'s head, a game setting: it collides whenever no library hammer is shown, and phantoms show it.'
      : `${current.name}'s own head: it collides while this hammer is shown, as when the game's backend selects it or Project / ` +
        'Model library previews it.');
    setPressed(mirrorButton, mirror);
    removeButton.disabled = selected === null || shown.length <= HAMMER_HEAD_LIMITS.vertices.min;
    const presets = root.querySelectorAll<HTMLButtonElement>('[data-preset]');
    for (const button of presets) button.disabled = current === undefined;
  }

  // Shows the hammers and the chosen one's head as stored.
  function refresh(): void {
    if (drag !== null) {
      stale = true;
      return;
    }
    stale = false;
    hammers = options.hammers();
    if (hammer() === undefined) chosen = null;
    const keep = select.value;
    select.replaceChildren(...hammers.map((entry) => new Option(entry.id === null ? entry.name : `Library: ${entry.name}`, entry.id ?? '')));
    select.value = hammers.some((entry) => (entry.id ?? '') === keep) ? keep : chosen ?? '';
    const next = hammer()?.head ?? DEFAULT_HAMMER_HEAD;
    if (next !== head) {
      head = next;
      if (selected !== null && selected >= head.length) selected = null;
    }
    shown = head;
    render();
  }

  // Where the pointer is on the canvas, in metres about the head's centre.
  function pointer(event: PointerEvent): Point {
    const matrix = world.getScreenCTM();
    if (matrix === null) return { x: 0, y: 0 };
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  // The point across the handle from points[index] in a mirrored outline, if it is another point.
  function partnerOf(points: readonly Readonly<Point>[], index: number): number | null {
    if (!mirror) return null;
    const twin = mirrored(points[index]!);
    const found = points.findIndex((point, other) => other !== index && Math.abs(point.x - twin.x) < 1e-9 && Math.abs(point.y - twin.y) < 1e-9);
    return found < 0 ? null : found;
  }

  // A pressed point keeps its place until the pointer moves it. A point added on an edge is not selected until it
  // joins the outline.
  function startDrag(event: PointerEvent, points: Point[], index: number): void {
    svg.setPointerCapture(event.pointerId);
    selected = index < head.length ? index : null;
    const at = pointer(event);
    drag = {
      pointerId: event.pointerId, points, index, partner: partnerOf(points, index), start: { x: event.clientX, y: event.clientY },
      offset: { x: points[index]!.x - at.x, y: points[index]!.y - at.y }, moved: false,
    };
    render();
  }

  function moveDrag(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < DRAG_PIXELS) return;
      drag.moved = true;
    }
    const raw = pointer(event);
    let at = snap({ x: raw.x + drag.offset.x, y: raw.y + drag.offset.y }, grid);
    // A mirrored point on the handle's line stays on it.
    if (mirror && drag.partner === null && Math.abs(drag.points[drag.index]!.y) < 1e-9) at = { x: at.x, y: 0 };
    drag.points[drag.index] = at;
    if (drag.partner !== null) drag.points[drag.partner] = mirrored(at);
    const next = outlineOf(drag.points);
    if (next !== null) shown = next;
    render();
  }

  function endDrag(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    const at = drag.points[drag.index]!;
    const moved = drag.moved;
    drag = null;
    if (moved && !sameHammerHead(shown, head)) commit(shown);
    else shown = head;
    // The dragged point stays selected unless it folded into the outline.
    const index = indexOf(head, at);
    selected = index < 0 ? null : index;
    if (stale) refresh();
    else render();
  }

  svg.addEventListener('pointerdown', (event) => {
    if (drag !== null || event.button !== 0 || hammer() === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    const index = Number(target?.getAttribute('data-index'));
    if (target?.classList.contains('hammer-head-point')) {
      event.preventDefault();
      (target as SVGCircleElement).focus({ preventScroll: true });
      startDrag(event, head.map((point) => ({ ...point })), index);
    } else if (target?.classList.contains('hammer-head-edge')) {
      event.preventDefault();
      const added = mirror && Math.abs(snap(pointer(event), grid).y) > 1e-9 ? 2 : 1;
      if (head.length + added > HAMMER_HEAD_LIMITS.vertices.max) {
        setText(problem, `A hammer head outline has at most ${HAMMER_HEAD_LIMITS.vertices.max} points.`);
        return;
      }
      const points = head.map((point) => ({ ...point }));
      points.push(snap(pointer(event), grid));
      if (added === 2) points.push(mirrored(points[points.length - 1]!));
      startDrag(event, points, points.length - added);
    }
  }, listen);
  svg.addEventListener('pointermove', moveDrag, listen);
  svg.addEventListener('pointerup', endDrag, listen);
  // A cancelled drag, or one whose capture went without a pointerup, changes nothing; the editor takes presses again.
  const cancelDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag = null;
    shown = head;
    if (stale) refresh();
    else render();
  };
  svg.addEventListener('pointercancel', cancelDrag, listen);
  svg.addEventListener('lostpointercapture', cancelDrag, listen);
  svg.addEventListener('focusin', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.classList.contains('hammer-head-point') || drag !== null) return;
    selected = Number(target.getAttribute('data-index'));
    render();
  }, listen);

  function remove(index: number): void {
    if (head.length <= HAMMER_HEAD_LIMITS.vertices.min) return;
    const partner = partnerOf(head, index);
    const points = head.filter((_, other) => other !== index && other !== partner);
    const next = outlineOf(points);
    if (next === null) return;
    selected = null;
    commit(next);
  }

  svg.addEventListener('keydown', (event) => {
    if (selected === null || drag !== null) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(selected);
      return;
    }
    const moves: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: 1 }, ArrowDown: { x: 0, y: -1 } };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const distance = (event.shiftKey ? 10 : 1) * grid / 1000;
    const points = head.map((point) => ({ ...point }));
    const partner = partnerOf(points, selected);
    const onLine = mirror && partner === null && Math.abs(points[selected]!.y) < 1e-9;
    const at = snap({ x: points[selected]!.x + move.x * distance, y: onLine ? 0 : points[selected]!.y + move.y * distance }, grid);
    points[selected] = at;
    if (partner !== null) points[partner] = mirrored(at);
    const next = outlineOf(points);
    // A point pushed inside the outline leaves it; the selection keeps to a point that is still there.
    if (next === null) return;
    const index = indexOf(next, at);
    commit(next);
    selected = index < 0 ? null : index;
    render();
    if (selected !== null) pointElements[selected]?.focus({ preventScroll: true });
  }, listen);

  select.addEventListener('change', () => {
    chosen = select.value === '' ? null : select.value;
    selected = null;
    head = hammer()?.head ?? DEFAULT_HAMMER_HEAD;
    shown = head;
    mirror = symmetric(head);
    setText(problem, '');
    render();
  }, listen);
  mirrorButton.addEventListener('click', () => {
    mirror = !mirror;
    if (mirror) {
      // The side above the handle, mirrored below it.
      const upper = head.filter((point) => point.y >= 0);
      const next = outlineOf(upper.length >= 2 ? upper : head);
      if (next !== null && next !== head) commit(next);
    }
    render();
  }, listen);
  removeButton.addEventListener('click', () => {
    if (selected !== null) remove(selected);
  }, listen);
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    button.addEventListener('click', () => {
      const preset = PRESETS[Number(button.dataset.preset)]!;
      selected = null;
      mirror = symmetric(preset.head);
      setText(problem, '');
      commit(preset.head);
    }, listen);
  }

  refresh();
  mirror = symmetric(head);
  render();
  return {
    refresh,
    dispose(): void {
      events.abort();
      root.replaceChildren();
    },
  };
}
