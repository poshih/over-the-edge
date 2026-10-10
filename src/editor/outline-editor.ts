import type { Point } from '../config';
import { element, setPressed, setText } from '../dom';
import type { ChangeCause } from './document/project-document';
import { createRangeControl } from './range-control';
import type { ScrubHistory } from './range-control';
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
  dispose(): void;
}

// What changed an outline: a moved or added point, a removed one, mirroring, a starting shape, or an arrow key's nudge,
// whose step takes the nudges after it while they share `key`.
export type OutlineAction =
  | { readonly kind: 'drag' | 'add' | 'remove' | 'mirror' }
  | { readonly kind: 'preset'; readonly name: string }
  | { readonly kind: 'nudge'; readonly key: string };

// One change of one outline, over the exact outline it replaces.
export interface OutlineEdit {
  readonly id: string | null;
  readonly before: Outline;
  readonly after: Outline;
  readonly action: OutlineAction;
}

export interface OutlineEditorOptions {
  readonly mount: HTMLElement;
  // Seals a burst of nudges once the arrow key lifts.
  readonly history: ScrubHistory;
  // The outlines to shape, as the project holds them.
  readonly outlines: () => readonly EditedOutline[];
  // Applies one change as a command; returns its refusal, or null.
  readonly apply: (edit: OutlineEdit) => Error | null;
  // Hears every change of the outlines, with its cause; returns the unsubscribe.
  readonly subscribe: (listener: (cause: ChangeCause) => void) => () => void;
}

// A step's name: what an action did to `outline`, as in "Move jar outline point".
export function outlineStepLabel(action: OutlineAction, outline: string): string {
  switch (action.kind) {
    case 'drag': return `Move ${outline} point`;
    case 'add': return `Add ${outline} point`;
    case 'remove': return `Remove ${outline} point`;
    case 'nudge': return `Nudge ${outline} point`;
    case 'mirror': return `Mirror ${outline}`;
    case 'preset': return `Start ${outline} from ${action.name}`;
  }
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
// Where each arrow key nudges the selected point, in grid steps.
const NUDGES: Readonly<Record<string, Readonly<Point>>> = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: 1 }, ArrowDown: { x: 0, y: -1 },
};

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
 * two halves alike. Each change applies once the pointer lifts, as one undo step; a burst of nudges is one step. The
 * outline shown is the project's, or a drag's preview of it.
 */
export function createOutlineEditor(kind: OutlineKind, options: OutlineEditorOptions): OutlineEditor {
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
  // The chosen outline's id and the outline shown: as the project holds it, or a drag's preview.
  let chosen: string | null = null;
  let stored: Outline = kind.fallback;
  let shown: Outline = stored;
  let selected: number | null = null;
  let mirror = false;
  // A drag in progress: the points it moves, which may lie inside the outline for now, and which of them move; where
  // the press was, how far the pressed point lies from the pointer, whether it has moved yet, and whether its point is
  // a new one, added on an edge.
  let drag: {
    readonly pointerId: number; readonly points: Point[]; readonly index: number; readonly partner: number | null;
    readonly start: Readonly<Point>; readonly offset: Readonly<Point>; moved: boolean; readonly added: boolean;
  } | null = null;
  // The nudges of one point: one key, kept while that point stays selected in the chosen outline wherever the outline's
  // order puts it, so a held arrow key or a quick burst is one step.
  let nudge: { readonly key: string; readonly outline: string | null; readonly at: Readonly<Point> } | null = null;
  let nudges = 0;
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

  // Applies `next` over the chosen outline as the project holds it now, then shows what the project holds; a refusal
  // shows its reason.
  function apply(next: Outline, action: OutlineAction): void {
    const edited = options.outlines().find((candidate) => candidate.id === chosen);
    if (edited !== undefined && !sameOutline(next, edited.outline)) {
      const refusal = options.apply({ id: edited.id, before: edited.outline, after: next, action });
      if (refusal !== null) setText(problem, refusal.message);
    }
    refresh();
  }

  // Ends a drag without applying it.
  function stopDrag(): void {
    if (drag === null) return;
    const { pointerId } = drag;
    drag = null;
    if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
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

  // Shows the outlines as the project holds them; a drag in progress keeps its preview. An outline changed elsewhere keeps
  // its selected point while it has one, and mirroring while it is still mirrored.
  function refresh(): void {
    outlines = options.outlines();
    if (current() === undefined) chosen = outlines[0]?.id ?? null;
    const keep = select.value;
    select.replaceChildren(...outlines.map((entry) => new Option(kind.chooser?.name(entry) ?? entry.name, entry.id ?? '')));
    select.value = outlines.some((entry) => (entry.id ?? '') === keep) ? keep : chosen ?? '';
    const next = current()?.outline ?? kind.fallback;
    if (!sameOutline(next, stored)) {
      if (selected !== null && selected >= next.length) selected = null;
      if (mirror && !symmetric(next)) mirror = false;
    }
    stored = next;
    if (drag === null) shown = stored;
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
  function startDrag(event: PointerEvent, points: Point[], index: number, added: boolean): void {
    svg.setPointerCapture(event.pointerId);
    selected = index < stored.length ? index : null;
    const at = pointer(event);
    drag = {
      pointerId: event.pointerId, points, index, partner: partnerOf(points, index), start: { x: event.clientX, y: event.clientY },
      offset: { x: points[index]!.x - at.x, y: points[index]!.y - at.y }, moved: false, added,
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
    const { points, index, moved, added } = drag;
    drag = null;
    if (moved && !sameOutline(shown, stored)) apply(shown, { kind: added ? 'add' : 'drag' });
    else shown = stored;
    // The dragged point stays selected unless it folded into the outline.
    const found = indexOf(stored, points[index]!);
    selected = found < 0 ? null : found;
    render();
  }

  svg.addEventListener('pointerdown', (event) => {
    if (drag !== null || event.button !== 0 || current() === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    const index = Number(target?.getAttribute('data-index'));
    if (target?.classList.contains('outline-editor-point')) {
      event.preventDefault();
      (target as SVGCircleElement).focus({ preventScroll: true });
      startDrag(event, stored.map((point) => ({ ...point })), index, false);
    } else if (target?.classList.contains('outline-editor-edge')) {
      event.preventDefault();
      const count = mirror && Math.abs(across(snap(pointer(event), grid))) > 1e-9 ? 2 : 1;
      if (stored.length + count > kind.vertices.max) {
        setText(problem, `A ${kind.noun} has at most ${kind.vertices.max} points.`);
        return;
      }
      const points = stored.map((point) => ({ ...point }));
      points.push(snap(pointer(event), grid));
      if (count === 2) points.push(mirrored(points[points.length - 1]!));
      startDrag(event, points, points.length - count, true);
    }
  }, listen);
  svg.addEventListener('pointermove', moveDrag, listen);
  svg.addEventListener('pointerup', endDrag, listen);
  // A cancelled drag, or one whose capture went without a pointerup, changes nothing; the editor takes presses again.
  const cancelDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag = null;
    shown = stored;
    render();
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
    apply(next, { kind: 'remove' });
  }

  svg.addEventListener('keydown', (event) => {
    if (selected === null || drag !== null) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(selected);
      return;
    }
    if (!Object.hasOwn(NUDGES, event.key)) return;
    const move = NUDGES[event.key]!;
    event.preventDefault();
    const distance = (event.shiftKey ? 10 : 1) * grid / 1000;
    const from = stored[selected]!;
    const points = stored.map((point) => ({ ...point }));
    const partner = partnerOf(points, selected);
    // A point on the mirror line moves only along it, before it snaps.
    const pinned = mirror && partner === null && Math.abs(across(from)) < 1e-9;
    const moved = { x: from.x + move.x * distance, y: from.y + move.y * distance };
    const at = snap(pinned ? onLine(moved) : moved, grid);
    points[selected] = at;
    if (partner !== null) points[partner] = mirrored(at);
    const next = outlineOf(points);
    if (next === null) return;
    // The point keeps its key however the outline reorders it; another point or outline takes a new one.
    if (nudge === null || nudge.outline !== chosen || indexOf(stored, nudge.at) !== selected) {
      nudge = { key: `outline:${kind.key}:${++nudges}`, outline: chosen, at: from };
    }
    const { key } = nudge;
    const previous = stored;
    apply(next, { kind: 'nudge', key });
    // The selection follows the point to its place in the outline the project now holds, where it stays put when the
    // nudge was refused; a point pushed inside the outline leaves it, and the selection with it.
    const index = indexOf(stored, stored === previous ? from : at);
    selected = index < 0 ? null : index;
    nudge = selected === null ? null : { key, outline: chosen, at: stored[selected]! };
    render();
    // Focus moves with the point, keeping its key.
    if (selected !== null) pointElements[selected]?.focus({ preventScroll: true });
  }, listen);
  // Releasing the arrow key seals the point's step: a nudge more than a second later starts a step of its own.
  svg.addEventListener('keyup', (event) => {
    if (nudge !== null && Object.hasOwn(NUDGES, event.key)) options.history.seal(nudge.key);
  }, listen);
  // Focus leaving the outline lets its key go, so its step takes no more nudges; focus moving between points keeps it.
  svg.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && svg.contains(event.relatedTarget))) nudge = null;
  }, listen);

  select.addEventListener('change', () => {
    // A drag goes with the outline it shapes.
    stopDrag();
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
      // The side where the mirrored coordinate is positive, mirrored onto the other; an outline already mirrored stays.
      const kept = stored.filter((point) => across(point) >= 0);
      const next = outlineOf(kept.length >= 2 ? kept : stored);
      if (next !== null) apply(next, { kind: 'mirror' });
      // Mirroring stays on only once the outline is mirrored.
      mirror = symmetric(stored);
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
      setText(problem, '');
      apply(preset.outline, { kind: 'preset', name: preset.label });
      mirror = symmetric(stored);
      render();
    }, listen);
  }

  refresh();
  mirror = symmetric(stored);
  render();
  // Undo, Redo, another project or the server end a drag at once, as an edit does that changes the outline dragged:
  // its release must not put back what they changed.
  const unsubscribe = options.subscribe((cause) => {
    if (drag !== null) {
      const next = options.outlines().find((candidate) => candidate.id === chosen)?.outline;
      if (cause !== 'edit' || next === undefined || !sameOutline(next, stored)) stopDrag();
    }
    refresh();
  });
  return {
    dispose(): void {
      unsubscribe();
      events.abort();
      root.replaceChildren();
    },
  };
}
