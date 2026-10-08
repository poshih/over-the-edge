import type { Point } from '../config';
import { element, setPressed, setText } from '../dom';
import { createRangeControl } from './range-control';
import './outline-editor.css';

// A convex collision outline about a centre, in metres with y up, counter-clockwise.
export type Outline = readonly Readonly<Point>[];

// One outline the editor offers to shape.
export interface EditedOutline {
  readonly id: string | null;
  readonly name: string;
  readonly outline: Outline;
}

export interface OutlineEditor {
  // The outlines changed elsewhere: shows them, once a drag in progress ends.
  refresh(): void;
  dispose(): void;
}

// What one kind of outline brings to the editor: its limits and checks, how it mirrors, where to start and what the
// canvas shows around it.
export interface OutlineKind {
  // Prefixes its element ids and its stored grid choice; unique on the page.
  readonly key: string;
  // The chooser of which outline to shape: its label and how it names each outline; null for a kind with just one.
  readonly chooser: { readonly label: string; readonly name: (outline: EditedOutline) => string } | null;
  // What one outline is called, as in "A jar outline has at most 12 points."
  readonly noun: string;
  readonly canvasLabel: string;
  // Every point lies within this distance of the centre.
  readonly reach: number;
  readonly vertices: { readonly min: number; readonly max: number };
  // The stored outline, or a refusal that `refused` recognises, whose message the editor shows.
  readonly validate: (points: readonly Readonly<Point>[]) => Outline;
  readonly refused: (error: unknown) => error is Error;
  // Mirroring negates x, keeping left and right alike, or y, keeping the sides above and below alike; turning it on
  // keeps the side where that coordinate is positive.
  readonly mirror: { readonly flips: 'x' | 'y'; readonly title: string };
  readonly presets: readonly { readonly label: string; readonly outline: Outline }[];
  // SVG drawn under the outline, in metres about the centre with y up.
  readonly backdrop: (view: number, mark: number) => string;
  // Keeps a snapped point where the outline may go.
  readonly limit?: (point: Point) => Point;
  readonly readout: (outline: Outline) => string;
  readonly help: (chosen: EditedOutline | undefined) => string;
  // Shown while no outline is chosen.
  readonly fallback: Outline;
}

const SVG = 'http://www.w3.org/2000/svg';
// The grids a moved or added point snaps to, in whole millimetres, and the arrow keys move it one step of (ten with
// Shift). Each is 1, 2 or 5 times a power of ten, so it divides the 10 cm between the lines always drawn; a grid of
// 2 cm or more draws too, where a finer one would fill the canvas. Outlines round to the millimetre, so 1 mm is free.
const SNAP_GRIDS: readonly number[] = [1, 2, 5, 10, 20, 50, 100];
const DEFAULT_SNAP = 5;
const LINES = 100;
const FINEST_DRAWN = 20;
// Screen pixels a pressed point must move before it drags, so a click only selects it.
const DRAG_PIXELS = 3;
// The canvas half-width at which points and marks have their base sizes, in metres; wider canvases scale them up.
const BASE_VIEW = 0.7;

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

function gridLabel(step: number): string {
  return step < 10 ? `${step} mm` : `${step / 10} cm`;
}

// Where a point landed in an outline, which rounds points to the millimetre; -1 when it is not one of its points.
function indexOf(outline: Outline, point: Readonly<Point>): number {
  return outline.findIndex((candidate) => Math.abs(candidate.x - point.x) < 1e-6 && Math.abs(candidate.y - point.y) < 1e-6);
}

function metres(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

function sameOutline(left: Outline, right: Outline): boolean {
  return left === right || left.length === right.length && left.every((point, index) => point.x === right[index]!.x && point.y === right[index]!.y);
}

/**
 * A collision outline shaped on a canvas around its centre. Points drag, an edge takes a new point where it is
 * pressed, the arrow keys nudge the selected point and Delete removes it; moved and added points snap to the chosen
 * grid. The outline is always the smallest convex one around its points, so it can never fold in. Mirror keeps its
 * two halves alike. Each change applies once the pointer lifts.
 */
export function createOutlineEditor(kind: OutlineKind, options: {
  readonly mount: HTMLElement;
  readonly outlines: () => readonly EditedOutline[];
  // Stores an outline; false when it was refused, which the store reports.
  readonly setOutline: (id: string | null, outline: Outline) => boolean;
}): OutlineEditor {
  const events = new AbortController();
  const listen = { signal: events.signal };
  const root = options.mount;
  // Metres shown around the centre, beyond the farthest a point may go, and the size marks and points scale by.
  const view = kind.reach + 0.1;
  const scale = view / BASE_VIEW;
  const snapKey = `over-the-edge:${kind.key}:snap`;
  const flips = kind.mirror.flips;
  root.innerHTML = `
    <label class="outline-editor-label" for="${kind.key}-chosen">${kind.chooser?.label ?? ''}</label>
    <select id="${kind.key}-chosen"></select>
    <svg class="outline-editor-canvas" viewBox="${-view} ${-view} ${2 * view} ${2 * view}" role="group"
      aria-label="${kind.canvasLabel}">
      <g class="outline-editor-world" transform="scale(1 -1)">
        <g class="outline-editor-snap-grid"></g>
        <g class="outline-editor-grid"></g>
        <circle class="outline-editor-reach" r="${kind.reach}"></circle>
        ${kind.backdrop(view, scale)}
        <polygon class="outline-editor-outline"></polygon>
        <g class="outline-editor-edges"></g>
        <circle class="outline-editor-centre" r="${0.012 * scale}"></circle>
        <g class="outline-editor-points"></g>
      </g>
    </svg>
    <div class="outline-editor-snap"></div>
    <div class="outline-editor-actions">
      <button type="button" class="button outline-editor-mirror" aria-pressed="false" title="${kind.mirror.title}">Mirror</button>
      <button type="button" class="button outline-editor-remove">Remove point</button>
    </div>
    <div class="outline-editor-presets" role="group" aria-label="Start from">
      ${kind.presets.map((preset, index) => `<button type="button" class="button" data-preset="${index}">${preset.label}</button>`).join('')}
    </div>
    <p class="outline-editor-readout"></p>
    <p class="outline-editor-problem" role="status" aria-live="polite"></p>
    <p class="outline-editor-help"></p>
  `;
  const label = element<HTMLLabelElement>(root, '.outline-editor-label');
  const select = element<HTMLSelectElement>(root, `#${kind.key}-chosen`);
  label.hidden = select.hidden = kind.chooser === null;
  const svg = root.querySelector<SVGSVGElement>('.outline-editor-canvas')!;
  const world = svg.querySelector<SVGGElement>('.outline-editor-world')!;
  const outlineElement = svg.querySelector<SVGPolygonElement>('.outline-editor-outline')!;
  const edgeLayer = svg.querySelector<SVGGElement>('.outline-editor-edges')!;
  const pointLayer = svg.querySelector<SVGGElement>('.outline-editor-points')!;
  const mirrorButton = element<HTMLButtonElement>(root, '.outline-editor-mirror');
  const removeButton = element<HTMLButtonElement>(root, '.outline-editor-remove');
  const readout = element<HTMLParagraphElement>(root, '.outline-editor-readout');
  const problem = element<HTMLParagraphElement>(root, '.outline-editor-problem');
  const help = element<HTMLParagraphElement>(root, '.outline-editor-help');
  const snapGrid = svg.querySelector<SVGGElement>('.outline-editor-snap-grid')!;

  // The point mirrored onto the other half.
  function mirrored(point: Readonly<Point>): Point {
    return flips === 'x' ? { x: -point.x, y: point.y } : { x: point.x, y: -point.y };
  }
  // A point's coordinate across the mirror line, 0 on it.
  function across(point: Readonly<Point>): number {
    return flips === 'x' ? point.x : point.y;
  }
  // Whether the outline is its own reflection.
  function symmetric(outline: Outline): boolean {
    return outline.every((point) => outline.some((other) => {
      const twin = mirrored(point);
      return other.x === twin.x && other.y === twin.y;
    }));
  }
  // The nearest point of a grid `step` millimetres apart within reach of the centre, and where the outline may go.
  // Whole millimetres keep grid points exact, so one on the rim stays there.
  function snap(point: Readonly<Point>, step: number): Point {
    const distance = Math.hypot(point.x, point.y);
    const shrink = distance > kind.reach ? kind.reach / distance : 1;
    const x = point.x * shrink * 1000, y = point.y * shrink * 1000;
    const rounded = { x: Math.round(x / step) * step / 1000 + 0, y: Math.round(y / step) * step / 1000 + 0 };
    // Rounding may push a point on the rim past it; then it rounds toward the centre.
    const within = Math.hypot(rounded.x, rounded.y) <= kind.reach ? rounded
      : { x: Math.trunc(x / step) * step / 1000 + 0, y: Math.trunc(y / step) * step / 1000 + 0 };
    return kind.limit === undefined ? within : kind.limit(within);
  }

  // Lines `every` millimetres apart within reach of the centre, each across the canvas, leaving out the 10 cm lines when
  // `between` is set.
  function drawLines(group: SVGGElement, every: number, between: boolean): void {
    const count = Math.floor(Math.round(kind.reach * 1000) / every);
    const lines: SVGLineElement[] = [];
    for (let index = -count; index <= count; index++) {
      if (between && index * every % LINES === 0) continue;
      const at = index * every / 1000;
      for (const [x1, y1, x2, y2] of [[at, -view, at, view], [-view, at, view, at]] as const) {
        const line = document.createElementNS(SVG, 'line');
        line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
        line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
        lines.push(line);
      }
    }
    group.replaceChildren(...lines);
  }
  drawLines(svg.querySelector<SVGGElement>('.outline-editor-grid')!, LINES, false);

  // This browser's choice of grid.
  function readSnap(): number {
    try {
      const stored = Number(localStorage.getItem(snapKey));
      return SNAP_GRIDS.includes(stored) ? stored : DEFAULT_SNAP;
    } catch (error) {
      if (error instanceof DOMException) return DEFAULT_SNAP;
      throw error;
    }
  }

  let grid = readSnap();
  const snapControl = createRangeControl({
    label: 'Snap grid', min: 0, max: SNAP_GRIDS.length - 1, step: 1, unit: '',
    description: 'Points snap to this grid as you drag or add them, and the arrow keys move one step, ten with Shift. ' +
      'Grids of 2 cm and more show on the canvas. This browser remembers the choice.',
  }, {
    id: `${kind.key}-snap`, name: `${kind.key}-snap`, signal: events.signal,
    format: (index) => gridLabel(SNAP_GRIDS[index]!),
    onInput: (index) => {
      grid = SNAP_GRIDS[index]!;
      try {
        localStorage.setItem(snapKey, String(grid));
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
      }
      showSnap();
    },
  });
  element<HTMLDivElement>(root, '.outline-editor-snap').append(snapControl.row);

  // The chosen grid on the slider and, when it is coarse enough to see, on the canvas.
  function showSnap(): void {
    snapControl.setValue(SNAP_GRIDS.indexOf(grid));
    if (grid >= FINEST_DRAWN) drawLines(snapGrid, grid, true);
    else snapGrid.replaceChildren();
  }
  showSnap();

  let outlines: readonly EditedOutline[] = [];
  // The chosen outline's id and the outline shown: as stored, or a drag's.
  let chosen: string | null = null;
  let stored: Outline = kind.fallback;
  let shown: Outline = stored;
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

  function current(): EditedOutline | undefined {
    return outlines.find((candidate) => candidate.id === chosen);
  }

  // The outline around `points`, or null with the reason shown when it is not a valid one.
  function outlineOf(points: readonly Readonly<Point>[]): Outline | null {
    try {
      const next = kind.validate(hull(mirror ? [...points, ...points.map(mirrored)] : points));
      setText(problem, '');
      return next;
    } catch (error) {
      if (!kind.refused(error)) throw error;
      setText(problem, error.message);
      return null;
    }
  }

  function commit(next: Outline): void {
    const edited = current();
    if (edited === undefined) return;
    if (options.setOutline(edited.id, next)) stored = next;
    shown = stored;
    render();
  }

  function render(): void {
    const edited = current();
    outlineElement.setAttribute('points', shown.map((point) => `${point.x},${point.y}`).join(' '));
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
        point.setAttribute('class', 'outline-editor-point');
        point.setAttribute('r', String(0.03 * scale));
        point.setAttribute('tabindex', '0');
        point.setAttribute('role', 'button');
        point.dataset.index = String(index);
        edge = document.createElementNS(SVG, 'line');
        edge.setAttribute('class', 'outline-editor-edge');
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
    setText(readout, kind.readout(shown));
    setText(help, kind.help(edited));
    setPressed(mirrorButton, mirror);
    removeButton.disabled = selected === null || shown.length <= kind.vertices.min;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-preset]')) button.disabled = edited === undefined;
  }

  // Shows the outlines and the chosen one as stored.
  function refresh(): void {
    if (drag !== null) {
      stale = true;
      return;
    }
    stale = false;
    outlines = options.outlines();
    if (current() === undefined) chosen = outlines[0]?.id ?? null;
    const keep = select.value;
    select.replaceChildren(...outlines.map((entry) => new Option(kind.chooser?.name(entry) ?? entry.name, entry.id ?? '')));
    select.value = outlines.some((entry) => (entry.id ?? '') === keep) ? keep : chosen ?? '';
    const next = current()?.outline ?? kind.fallback;
    if (next !== stored) {
      stored = next;
      if (selected !== null && selected >= stored.length) selected = null;
    }
    shown = stored;
    render();
  }

  // Where the pointer is on the canvas, in metres about the centre.
  function pointer(event: PointerEvent): Point {
    const matrix = world.getScreenCTM();
    if (matrix === null) return { x: 0, y: 0 };
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  // The point mirrored from points[index] in a mirrored outline, if it is another point.
  function partnerOf(points: readonly Readonly<Point>[], index: number): number | null {
    if (!mirror) return null;
    const twin = mirrored(points[index]!);
    const found = points.findIndex((point, other) => other !== index && Math.abs(point.x - twin.x) < 1e-9 && Math.abs(point.y - twin.y) < 1e-9);
    return found < 0 ? null : found;
  }

  // A point on the mirror line in a mirrored outline stays on it.
  function onLine(point: Readonly<Point>): Point {
    return flips === 'x' ? { x: 0, y: point.y } : { x: point.x, y: 0 };
  }

  // A pressed point keeps its place until the pointer moves it. A point added on an edge is not selected until it
  // joins the outline.
  function startDrag(event: PointerEvent, points: Point[], index: number): void {
    svg.setPointerCapture(event.pointerId);
    selected = index < stored.length ? index : null;
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
    if (mirror && drag.partner === null && Math.abs(across(drag.points[drag.index]!)) < 1e-9) at = onLine(at);
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
    if (moved && !sameOutline(shown, stored)) commit(shown);
    else shown = stored;
    // The dragged point stays selected unless it folded into the outline.
    const index = indexOf(stored, at);
    selected = index < 0 ? null : index;
    if (stale) refresh();
    else render();
  }

  svg.addEventListener('pointerdown', (event) => {
    if (drag !== null || event.button !== 0 || current() === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    const index = Number(target?.getAttribute('data-index'));
    if (target?.classList.contains('outline-editor-point')) {
      event.preventDefault();
      (target as SVGCircleElement).focus({ preventScroll: true });
      startDrag(event, stored.map((point) => ({ ...point })), index);
    } else if (target?.classList.contains('outline-editor-edge')) {
      event.preventDefault();
      const added = mirror && Math.abs(across(snap(pointer(event), grid))) > 1e-9 ? 2 : 1;
      if (stored.length + added > kind.vertices.max) {
        setText(problem, `A ${kind.noun} has at most ${kind.vertices.max} points.`);
        return;
      }
      const points = stored.map((point) => ({ ...point }));
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
    shown = stored;
    if (stale) refresh();
    else render();
  };
  svg.addEventListener('pointercancel', cancelDrag, listen);
  svg.addEventListener('lostpointercapture', cancelDrag, listen);
  svg.addEventListener('focusin', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.classList.contains('outline-editor-point') || drag !== null) return;
    selected = Number(target.getAttribute('data-index'));
    render();
  }, listen);

  function remove(index: number): void {
    if (stored.length <= kind.vertices.min) return;
    const partner = partnerOf(stored, index);
    const points = stored.filter((_, other) => other !== index && other !== partner);
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
    const points = stored.map((point) => ({ ...point }));
    const partner = partnerOf(points, selected);
    // A point on the mirror line moves only along it, before it snaps.
    const pinned = mirror && partner === null && Math.abs(across(points[selected]!)) < 1e-9;
    const moved = { x: points[selected]!.x + move.x * distance, y: points[selected]!.y + move.y * distance };
    const at = snap(pinned ? onLine(moved) : moved, grid);
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
    stored = current()?.outline ?? kind.fallback;
    shown = stored;
    mirror = symmetric(stored);
    setText(problem, '');
    render();
  }, listen);
  mirrorButton.addEventListener('click', () => {
    mirror = !mirror;
    if (mirror) {
      // The side where the mirrored coordinate is positive, mirrored onto the other.
      const kept = stored.filter((point) => across(point) >= 0);
      const next = outlineOf(kept.length >= 2 ? kept : stored);
      if (next !== null && next !== stored) commit(next);
    }
    render();
  }, listen);
  removeButton.addEventListener('click', () => {
    if (selected !== null) remove(selected);
  }, listen);
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    button.addEventListener('click', () => {
      const preset = kind.presets[Number(button.dataset.preset)]!;
      selected = null;
      mirror = symmetric(preset.outline);
      setText(problem, '');
      commit(preset.outline);
    }, listen);
  }

  refresh();
  mirror = symmetric(stored);
  render();
  return {
    refresh,
    dispose(): void {
      events.abort();
      root.replaceChildren();
    },
  };
}
