import { element, setText } from '../dom';
import {
  createDirectionalPresentation,
  DIRECTIONAL_LIMITS,
  normalizeDegrees,
  sectorSpan,
} from '../directional-data';
import type { DirectionalPresentation, DirectionalRule } from '../directional-data';
import { FACING_DIRECTIONS } from '../skeleton-data';
import type { SpriteRig } from '../sprite-rig';
import type { SpriteEditorState } from './sprite-state';
import './directional-editor.css';

export interface DirectionalViewport {
  readonly canvas: HTMLCanvasElement;
  readonly project: (point: { readonly x: number; readonly y: number; readonly z?: number }) => { x: number; y: number };
}

interface DocumentActions {
  save(): void;
  revert(): void;
  importDocument(): void;
  exportDocument(): void;
}

type RuleField = Exclude<keyof DirectionalRule, 'direction'>;
type PresentationState = ReturnType<SpriteRig['presentationState']>;
type Handle = { readonly kind: 'aim' } | { readonly kind: 'boundary'; readonly index: number };

const SVG_NS = 'http://www.w3.org/2000/svg';
const DIAGRAM_SIZE = 320;
const CENTER = DIAGRAM_SIZE / 2;
const SELECTION_RADIUS = 104;
const BOUNDARY_RADIUS = 112;
const HOLD_RADIUS = 125;
const ROTATION_RADIUS = 76;
const AIM_RADIUS = 143;
const KEYBOARD_STEP = 1;
const KEYBOARD_LARGE_STEP = 15;
const DISPLAY_PRECISION = 1000;
const POINTER_CENTER_RADIUS = 3;
const DEGREES_TO_RADIANS = Math.PI / DIRECTIONAL_LIMITS.halfTurn;
const RULE_COLUMNS: readonly { key: RuleField; label: string; min: number; max: number }[] = [
  { key: 'clockwiseHold', label: 'CW hold (deg)', min: 0, max: DIRECTIONAL_LIMITS.hold },
  { key: 'counterclockwiseHold', label: 'CCW hold (deg)', min: 0, max: DIRECTIONAL_LIMITS.hold },
  { key: 'neutralAngle', label: 'Neutral aim (deg)', min: 0, max: DIRECTIONAL_LIMITS.angle },
  { key: 'minimumRotation', label: 'Minimum extra rotation (deg)', min: -DIRECTIONAL_LIMITS.halfTurn, max: 0 },
  { key: 'maximumRotation', label: 'Maximum extra rotation (deg)', min: 0, max: DIRECTIONAL_LIMITS.halfTurn },
  { key: 'responseTime', label: 'Response time (seconds)', min: 0, max: DIRECTIONAL_LIMITS.responseTime },
];

function svgElement<Key extends keyof SVGElementTagNameMap>(
  tag: Key, attributes: Readonly<Record<string, string>> = {},
): SVGElementTagNameMap[Key] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function attribute(node: SVGElement, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function position(angle: number, radius: number): { x: number; y: number } {
  const radians = angle * DEGREES_TO_RADIANS;
  return { x: CENTER + Math.cos(radians) * radius, y: CENTER - Math.sin(radians) * radius };
}

function arcPath(start: number, span: number, radius: number): string {
  const first = position(start, radius);
  if (span === DIRECTIONAL_LIMITS.angle) {
    const middle = position(start + DIRECTIONAL_LIMITS.halfTurn, radius);
    return `M ${first.x} ${first.y} A ${radius} ${radius} 0 0 0 ${middle.x} ${middle.y} A ${radius} ${radius} 0 0 0 ${first.x} ${first.y}`;
  }
  const last = position(start + span, radius);
  return `M ${first.x} ${first.y} A ${radius} ${radius} 0 ${span > DIRECTIONAL_LIMITS.halfTurn ? 1 : 0} 0 ${last.x} ${last.y}`;
}

function numberText(value: number): string {
  return String(Math.round(value * DISPLAY_PRECISION) / DISPLAY_PRECISION);
}

function angleText(value: number): string {
  return String(normalizeDegrees(Math.round(value * DISPLAY_PRECISION) / DISPLAY_PRECISION));
}

function degrees(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)} deg`;
}

function setNumber(input: HTMLInputElement, value: number): void {
  if (document.activeElement === input) return;
  if (input.value !== String(value)) input.value = String(value);
  input.removeAttribute('aria-invalid');
}

function setStyle(node: HTMLElement, property: 'left' | 'top' | 'width' | 'height', value: number): void {
  const text = `${value}px`;
  if (node.style[property] !== text) node.style[property] = text;
}

export function createDirectionalEditor(options: {
  readonly mount: HTMLElement;
  readonly state: SpriteEditorState;
  readonly viewport: DirectionalViewport;
  readonly presentationState: () => PresentationState;
  readonly actions: DocumentActions;
  readonly signal: AbortSignal;
}): {
  setActive(active: boolean): void;
  updatePreview(): void;
  leavePreview(): void;
  dispose(): void;
} {
  const events = new AbortController();
  const listen = { signal: events.signal };
  let snapshot = options.state.snapshot();
  let active = false;
  let disposed = false;
  let localError: string | null = null;
  let requestedAim: number | null = null;
  let drag: { pointer: number; handle: Handle } | null = null;
  let diagramSettings: DirectionalPresentation | null = null;
  let diagramDirection = -1;
  let viewportDirty = true;
  let viewportRect: DOMRect | null = null;
  let socketFrame = 0;

  function defaultAnchor(): string {
    return snapshot.document.presentation?.pivot.anchor ?? snapshot.document.skeleton?.anchor ?? snapshot.anchors[0].id;
  }

  let settings = snapshot.document.presentation ?? createDirectionalPresentation(defaultAnchor());
  const root = document.createElement('section');
  root.className = 'directional-editor';
  root.setAttribute('aria-labelledby', 'directional-heading');
  root.innerHTML = `
    <div class="sprite-intro">
      <h3 id="directional-heading">Directional Presentation</h3>
      <p>The existing game canvas is your live character preview. Drag aim below to preview the
        actual rig, including braid motion; no separate character renderer is used.</p>
    </div>
    <label class="directional-check">
      <input class="directional-enabled" type="checkbox" /> Use directional presentation
    </label>
    <p class="appearance-format">Off keeps normal facing selection and safe automatic head tilt.
      Enabling replaces that default, including when authored rotation is disabled.
      Edits are draft-only. Static sprite placement rotation stays separate.</p>
    <p id="directional-error" class="directional-error" role="alert" aria-atomic="true" hidden></p>
    <p class="appearance-format directional-status" role="status" aria-live="polite"></p>
    <div class="directional-diagram-mount"></div>
    <p class="appearance-format" id="directional-diagram-help">Right 0, up 90, left 180, down 270 degrees;
      positive angles turn counterclockwise. Round handles are shared boundaries; the diamond is aim.
      Focus a handle and use arrow keys (1 degree), Shift + arrows or Page Up/Down (15 degrees),
      or use the numeric fields. Start is inclusive; end is exclusive.</p>
    <ul class="directional-legend" aria-label="Diagram legend">
      <li class="directional-selection-key">Selected sector</li>
      <li class="directional-hold-key">Active hold range (outer dashed arc)</li>
      <li class="directional-rotation-key">Extra rotation limits (inner arc; faint when off)</li>
      <li class="directional-target-key">Target (dashed) / displayed rotation (solid)</li>
    </ul>
    <dl class="directional-readouts">
      <div><dt>Current aim</dt><dd><output class="directional-current-aim">-</output></dd></div>
      <div><dt>Selected direction</dt><dd><output class="directional-current-direction">-</output></dd></div>
      <div><dt>Target extra rotation</dt><dd><output class="directional-current-target">-</output></dd></div>
      <div><dt>Displayed extra rotation</dt><dd><output class="directional-current-displayed">-</output></dd></div>
    </dl>
    <p class="appearance-format">Extra-rotation readouts and arcs describe the authored presentation,
      not automatic head tilt. Single images can tilt; new face views require direction-tagged artwork.</p>
    <p class="appearance-format directional-preview-mode"></p>
    <div class="directional-aim-controls">
      <label for="directional-aim-angle">Preview aim (degrees)</label>
      <input id="directional-aim-angle" type="number" min="0" max="${DIRECTIONAL_LIMITS.angle}" step="any" value="0" aria-describedby="directional-error" />
      <button type="button" class="button directional-preview-start">Preview aim</button>
      <button type="button" class="button directional-preview-live">Return to live</button>
    </div>
    <fieldset class="tuning-group directional-settings">
      <legend>Shared settings</legend>
      <label class="directional-check"><input class="directional-hysteresis" type="checkbox" /> Enable hysteresis</label>
      <label class="directional-check"><input class="directional-rotation" type="checkbox" /> Enable aim rotation</label>
      <label for="directional-pivot-anchor">Pivot anchor</label>
      <select id="directional-pivot-anchor"></select>
      <div class="directional-pivot-fields">
        <label for="directional-pivot-x">Pivot X<input id="directional-pivot-x" type="number" step="any" aria-describedby="directional-error" /></label>
        <label for="directional-pivot-y">Pivot Y<input id="directional-pivot-y" type="number" step="any" aria-describedby="directional-error" /></label>
      </div>
      <p class="appearance-format">Pivot offsets use anchor-local units. The game-canvas cross marks the
        pivot; circles mark braid attachment sockets.</p>
      <fieldset class="directional-references">
        <legend>Controlled unbound layers</legend>
        <div class="directional-layer-choices"></div>
        <p class="appearance-format directional-no-layers">No unbound layers. Add a layer or control its owning bone.</p>
      </fieldset>
      <fieldset class="directional-references">
        <legend>Controlled bones</legend>
        <div class="directional-bone-choices"></div>
        <p class="appearance-format directional-no-bones">Create a skeleton to select attachment bones.</p>
      </fieldset>
      <p class="appearance-format">In this authored mode, explicitly select head, face and crown layers
        together, or their dedicated owning bone for bound/weighted layers. Without an authored presentation,
        safe head subtrees tilt around their bone attachment; unbound head cutouts use the host neck pivot.
        Shared torso or IK bindings need a dedicated head owner, not a whole-body rotation.
        Attach a simulated braid under the head; do not select hair particles, IK nodes, or both an
        ancestor and its descendant.</p>
      <div class="directional-table-scroll" tabindex="0" role="region" aria-label="Eight direction settings">
        <table class="directional-table">
          <caption>Eight directions: angles in degrees, response time in seconds. Start and adjacent end share one boundary.</caption>
          <thead><tr>
            <th scope="col">Direction</th><th scope="col">Start</th><th scope="col">End</th>
            <th scope="col">CW hold</th><th scope="col">CCW hold</th><th scope="col">Neutral aim</th>
            <th scope="col">Min extra rotation</th><th scope="col">Max extra rotation</th><th scope="col">Response (s)</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="appearance-format">Angles must be at least 0 and less than 360. Boundaries must remain in
        direction order around one turn. Invalid edits are rejected, never reordered or repaired.
        CW hold extends below the start; CCW hold extends beyond the end. Both holds plus the sector must span less than 360.</p>
    </fieldset>
    <button type="button" class="button directional-reset">Reset directional defaults (draft)</button>
    <div class="sprite-action-row directional-actions">
      <button type="button" class="button button-primary directional-save">Save</button>
      <button type="button" class="button directional-revert">Revert</button>
      <button type="button" class="button directional-import">Import sprite JSON</button>
      <button type="button" class="button directional-export">Export sprite JSON</button>
    </div>
    <p class="appearance-format">Save/Revert and JSON actions apply to the entire sprite document.
      Only Save writes browser storage. Aim and displayed runtime values are never saved.</p>
  `;
  const get = <T extends HTMLElement>(selector: string): T => element<T>(root, selector);
  const enabled = get<HTMLInputElement>('.directional-enabled');
  const errorText = get<HTMLParagraphElement>('.directional-error');
  const status = get<HTMLParagraphElement>('.directional-status');
  const group = get<HTMLFieldSetElement>('.directional-settings');
  const hysteresis = get<HTMLInputElement>('.directional-hysteresis');
  const rotation = get<HTMLInputElement>('.directional-rotation');
  const pivotAnchor = get<HTMLSelectElement>('#directional-pivot-anchor');
  const pivotX = get<HTMLInputElement>('#directional-pivot-x');
  const pivotY = get<HTMLInputElement>('#directional-pivot-y');
  const aimInput = get<HTMLInputElement>('#directional-aim-angle');
  const previewStart = get<HTMLButtonElement>('.directional-preview-start');
  const previewLive = get<HTMLButtonElement>('.directional-preview-live');
  const previewMode = get<HTMLParagraphElement>('.directional-preview-mode');
  const currentAim = get<HTMLOutputElement>('.directional-current-aim');
  const currentDirection = get<HTMLOutputElement>('.directional-current-direction');
  const currentTarget = get<HTMLOutputElement>('.directional-current-target');
  const currentDisplayed = get<HTMLOutputElement>('.directional-current-displayed');
  const resetButton = get<HTMLButtonElement>('.directional-reset');
  const saveButton = get<HTMLButtonElement>('.directional-save');
  const revertButton = get<HTMLButtonElement>('.directional-revert');
  const importButton = get<HTMLButtonElement>('.directional-import');
  const exportButton = get<HTMLButtonElement>('.directional-export');

  const diagram = svgElement('svg', {
    viewBox: `0 0 ${DIAGRAM_SIZE} ${DIAGRAM_SIZE}`, class: 'directional-diagram',
    role: 'group', 'aria-label': 'Directional selection, hold and rotation diagram',
    'aria-describedby': 'directional-diagram-help',
  });
  const sector = svgElement('path', { class: 'directional-sector' });
  const hold = svgElement('path', { class: 'directional-hold' });
  const limits = svgElement('path', { class: 'directional-limits' });
  const minimumLimit = svgElement('circle', { r: '3.5', class: 'directional-limit-end' });
  const maximumLimit = svgElement('circle', { r: '3.5', class: 'directional-limit-end' });
  const neutral = svgElement('line', { x1: String(CENTER), y1: String(CENTER), class: 'directional-neutral' });
  const target = svgElement('line', { x1: String(CENTER), y1: String(CENTER), class: 'directional-target' });
  const displayed = svgElement('line', { x1: String(CENTER), y1: String(CENTER), class: 'directional-displayed' });
  const aimLine = svgElement('line', { x1: String(CENTER), y1: String(CENTER), class: 'directional-aim-line' });
  diagram.append(svgElement('circle', {
    cx: String(CENTER), cy: String(CENTER), r: String(BOUNDARY_RADIUS), class: 'directional-circle',
  }), sector, hold, limits, minimumLimit, maximumLimit, neutral, target, displayed, aimLine);
  for (const [angle, label] of [[0, '0'], [90, '90'], [180, '180'], [270, '270']] as const) {
    const point = position(angle, BOUNDARY_RADIUS - 14);
    const text = svgElement('text', { x: String(point.x), y: String(point.y), class: 'directional-cardinal' });
    text.textContent = label;
    diagram.append(text);
  }
  const boundaries = FACING_DIRECTIONS.map((direction, index) => {
    const previous = FACING_DIRECTIONS[(index + FACING_DIRECTIONS.length - 1) % FACING_DIRECTIONS.length];
    const line = svgElement('line', { x1: String(CENTER), y1: String(CENTER), class: 'directional-boundary-line' });
    const handle = svgElement('circle', {
      r: '7', class: 'directional-boundary-handle', role: 'slider', tabindex: '0',
      'aria-label': `${previous} end / ${direction} start shared boundary in degrees`,
      'aria-valuemin': '0', 'aria-valuemax': String(DIRECTIONAL_LIMITS.angle),
      'aria-describedby': 'directional-diagram-help directional-error',
    });
    diagram.append(line, handle);
    wireHandle(handle, { kind: 'boundary', index });
    return { line, handle };
  });
  const aimHandle = svgElement('path', {
    d: 'M 0 -9 L 9 0 L 0 9 L -9 0 Z', class: 'directional-aim-handle', role: 'slider', tabindex: '0',
    'aria-label': 'Preview aim angle in degrees', 'aria-valuemin': '0', 'aria-valuemax': String(DIRECTIONAL_LIMITS.angle),
    'aria-describedby': 'directional-diagram-help directional-error',
  });
  wireHandle(aimHandle, { kind: 'aim' });
  diagram.append(aimHandle);
  get<HTMLDivElement>('.directional-diagram-mount').append(diagram);

  const rows = FACING_DIRECTIONS.map((direction, index) => {
    const row = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = direction;
    row.append(heading);
    const addCell = (label: string, min: number, max: number, onChange: (value: number) => boolean): HTMLInputElement => {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.min = String(min);
      input.max = String(max);
      input.setAttribute('aria-label', `${direction} ${label}`);
      input.setAttribute('aria-describedby', 'directional-error');
      input.addEventListener('change', () => commitNumber(input, onChange), listen);
      cell.append(input);
      row.append(cell);
      return input;
    };
    const start = addCell('start (degrees)', 0, DIRECTIONAL_LIMITS.angle, value => setBoundary(index, value));
    const end = addCell('end (degrees)', 0, DIRECTIONAL_LIMITS.angle,
      value => setBoundary((index + 1) % FACING_DIRECTIONS.length, value));
    const fields = new Map<RuleField, HTMLInputElement>();
    for (const column of RULE_COLUMNS) {
      fields.set(column.key, addCell(column.label, column.min, column.max, value =>
        changeSettings(current => ({
          ...current,
          directions: current.directions.map((rule, at) => at === index ? { ...rule, [column.key]: value } : rule),
        }))));
    }
    get<HTMLTableSectionElement>('.directional-table tbody').append(row);
    return { row, start, end, fields };
  });

  for (const anchor of snapshot.anchors) {
    const option = document.createElement('option');
    option.value = anchor.id;
    option.textContent = anchor.label;
    pivotAnchor.append(option);
  }
  for (const [input, key] of [[pivotX, 'x'], [pivotY, 'y']] as const) {
    input.min = String(-DIRECTIONAL_LIMITS.pivot);
    input.max = String(DIRECTIONAL_LIMITS.pivot);
    input.addEventListener('change', () => commitNumber(input, value =>
      changeSettings(current => ({ ...current, pivot: { ...current.pivot, [key]: value } }))), listen);
  }

  type Choice = { label: HTMLLabelElement; input: HTMLInputElement; text: Text };
  const layerChoices = new Map<string, Choice>();
  const boneChoices = new Map<string, Choice>();
  const layerMount = get<HTMLDivElement>('.directional-layer-choices');
  const boneMount = get<HTMLDivElement>('.directional-bone-choices');
  const noLayers = get<HTMLParagraphElement>('.directional-no-layers');
  const noBones = get<HTMLParagraphElement>('.directional-no-bones');

  const overlay = document.createElement('div');
  overlay.className = 'directional-viewport-guides';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  const guides = svgElement('svg');
  const pivotGuide = svgElement('g', { class: 'directional-pivot-guide' });
  pivotGuide.append(svgElement('path', { d: 'M -10 0 H 10 M 0 -10 V 10' }));
  const pivotLabel = svgElement('text', { x: '13', y: '-8' });
  pivotLabel.textContent = 'pivot';
  pivotGuide.append(pivotLabel);
  guides.append(pivotGuide);
  overlay.append(guides);
  options.viewport.canvas.ownerDocument.body.append(overlay);
  const socketGuides = new Map<string, { node: SVGGElement; text: SVGTextElement; seen: number }>();
  const observer = new ResizeObserver(() => { viewportDirty = true; });
  observer.observe(options.viewport.canvas);
  window.addEventListener('resize', () => { viewportDirty = true; }, listen);
  window.addEventListener('scroll', () => { viewportDirty = true; }, { ...listen, capture: true, passive: true });

  function renderError(): void {
    const message = localError ?? snapshot.error;
    errorText.hidden = message === null;
    setText(errorText, message === null ? '' : `${message} The last valid draft remains active.`);
  }

  function clearLocalError(): void {
    localError = null;
    aimInput.removeAttribute('aria-invalid');
  }

  function changeSettings(change: (current: DirectionalPresentation) => DirectionalPresentation): boolean {
    const current = snapshot.document.presentation;
    if (current === null) {
      localError = 'Enable directional presentation before editing its settings.';
      renderError();
      return false;
    }
    clearLocalError();
    const accepted = options.state.setPresentation(change(current));
    renderError();
    return accepted;
  }

  function commitNumber(input: HTMLInputElement, change: (value: number) => boolean): void {
    input.setAttribute('aria-invalid', String(!change(input.valueAsNumber)));
  }

  function setBoundary(index: number, angle: number): boolean {
    return changeSettings(current => ({
      ...current, boundaries: current.boundaries.map((value, at) => at === index ? angle : value),
    }));
  }

  function previewAim(angle: number): void {
    if (!Number.isFinite(angle) || angle < 0 || angle >= DIRECTIONAL_LIMITS.angle) {
      localError = 'Preview aim must be at least 0 and less than 360 degrees.';
      aimInput.setAttribute('aria-invalid', 'true');
      renderError();
      return;
    }
    clearLocalError();
    const radians = angle * DEGREES_TO_RADIANS;
    const accepted = options.state.setDirectionalPreview({ aim: { x: Math.cos(radians), y: Math.sin(radians) } });
    if (accepted) requestedAim = angle;
    aimInput.setAttribute('aria-invalid', String(!accepted));
    renderError();
  }

  function canDrag(handle: Handle): boolean {
    return active && !snapshot.busy && !snapshot.restoring &&
      (handle.kind === 'aim' ? snapshot.document.characterRiggingType === 'sprite-2d' : snapshot.document.presentation !== null);
  }

  function handleAngle(handle: Handle): number {
    return handle.kind === 'aim' ? requestedAim ?? options.presentationState().aimAngle : settings.boundaries[handle.index];
  }

  function applyHandle(handle: Handle, angle: number): void {
    if (handle.kind === 'aim') previewAim(angle);
    else setBoundary(handle.index, angle);
  }

  function wireHandle(node: SVGElement, handle: Handle): void {
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || drag !== null || !canDrag(handle)) return;
      event.preventDefault();
      event.stopPropagation();
      node.focus({ preventScroll: true });
      drag = { pointer: event.pointerId, handle };
      diagram.setPointerCapture(event.pointerId);
      movePointer(event);
    }, listen);
    node.addEventListener('keydown', event => {
      if (!canDrag(handle)) return;
      const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
      let angle = handleAngle(handle);
      switch (event.key) {
        case 'ArrowUp': case 'ArrowRight': angle += step; break;
        case 'ArrowDown': case 'ArrowLeft': angle -= step; break;
        case 'PageUp': angle += KEYBOARD_LARGE_STEP; break;
        case 'PageDown': angle -= KEYBOARD_LARGE_STEP; break;
        case 'Home': angle = 0; break;
        case 'End': angle = DIRECTIONAL_LIMITS.angle - KEYBOARD_STEP; break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyHandle(handle, normalizeDegrees(angle));
    }, listen);
  }

  function movePointer(event: PointerEvent): void {
    if (drag === null || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!canDrag(drag.handle)) {
      cancelDrag();
      return;
    }
    const rect = diagram.getBoundingClientRect();
    const scale = Math.min(rect.width, rect.height) / DIAGRAM_SIZE;
    if (scale <= 0) {
      cancelDrag();
      localError = 'The direction diagram must be visible before dragging a handle.';
      renderError();
      return;
    }
    const x = (event.clientX - rect.left - rect.width / 2) / scale;
    const y = (rect.top + rect.height / 2 - event.clientY) / scale;
    if (Math.hypot(x, y) < POINTER_CENTER_RADIUS) {
      localError = 'Move the handle away from the diagram center to choose an angle.';
      renderError();
      return;
    }
    applyHandle(drag.handle, normalizeDegrees(Math.atan2(y, x) / DEGREES_TO_RADIANS));
  }

  function cancelDrag(): void {
    const previous = drag;
    drag = null;
    if (previous !== null && diagram.hasPointerCapture(previous.pointer)) diagram.releasePointerCapture(previous.pointer);
  }

  diagram.addEventListener('pointermove', movePointer, listen);
  diagram.addEventListener('pointerup', event => {
    if (drag?.pointer !== event.pointerId) return;
    movePointer(event);
    cancelDrag();
  }, listen);
  diagram.addEventListener('pointercancel', cancelDrag, listen);
  diagram.addEventListener('lostpointercapture', cancelDrag, listen);

  enabled.addEventListener('change', () => {
    clearLocalError();
    options.state.setPresentation(enabled.checked ? createDirectionalPresentation(defaultAnchor()) : null);
    renderError();
  }, listen);
  hysteresis.addEventListener('change', () => changeSettings(current => ({ ...current, hysteresis: hysteresis.checked })), listen);
  rotation.addEventListener('change', () => changeSettings(current => ({ ...current, rotation: rotation.checked })), listen);
  pivotAnchor.addEventListener('change', () => changeSettings(current => ({
    ...current, pivot: { ...current.pivot, anchor: pivotAnchor.value },
  })), listen);
  aimInput.addEventListener('change', () => previewAim(aimInput.valueAsNumber), listen);
  previewStart.addEventListener('click', () => previewAim(aimInput.valueAsNumber), listen);
  previewLive.addEventListener('click', leavePreview, listen);
  resetButton.addEventListener('click', () => {
    clearLocalError();
    options.state.setPresentation(createDirectionalPresentation(defaultAnchor()));
    renderError();
  }, listen);
  saveButton.addEventListener('click', options.actions.save, listen);
  revertButton.addEventListener('click', options.actions.revert, listen);
  importButton.addEventListener('click', options.actions.importDocument, listen);
  exportButton.addEventListener('click', options.actions.exportDocument, listen);

  function syncChoices(
    mount: HTMLElement, choices: Map<string, Choice>, items: readonly { id: string; name: string }[], key: 'layers' | 'bones',
  ): void {
    const ids = new Set(items.map(item => item.id));
    for (const [id, choice] of choices) {
      if (ids.has(id)) continue;
      choice.label.remove();
      choices.delete(id);
    }
    for (const item of items) {
      let choice = choices.get(item.id);
      if (choice === undefined) {
        const label = document.createElement('label');
        label.className = 'directional-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        const text = document.createTextNode('');
        label.append(input, text);
        input.addEventListener('change', () => changeSettings(current => ({
          ...current,
          [key]: input.checked ? [...current[key], item.id] : current[key].filter(id => id !== item.id),
        })), listen);
        choice = { label, input, text };
        choices.set(item.id, choice);
        mount.append(label);
      }
      const label = `${item.name} (${item.id})`;
      if (choice.text.data !== label) choice.text.data = label;
      choice.input.checked = settings[key].includes(item.id);
    }
  }

  function render(): void {
    if (disposed) return;
    const busy = snapshot.busy || snapshot.restoring;
    const spritesEnabled = snapshot.document.characterRiggingType === 'sprite-2d';
    if (busy) {
      cancelDrag();
      clearLocalError();
    }
    if (!spritesEnabled) {
      cancelDrag();
      overlay.hidden = true;
      for (const readout of [currentAim, currentDirection, currentTarget, currentDisplayed]) setText(readout, '—');
      setText(previewMode, 'Sprite previews are inactive in Mesh parts and Avatar modes. Select 2D sprites in Character to preview the retained artwork.');
    }
    const configured = snapshot.document.presentation !== null;
    settings = snapshot.document.presentation ?? createDirectionalPresentation(defaultAnchor());
    enabled.checked = configured;
    enabled.disabled = busy;
    group.disabled = busy || !configured;
    hysteresis.checked = settings.hysteresis;
    rotation.checked = settings.rotation;
    pivotAnchor.value = settings.pivot.anchor;
    setNumber(pivotX, settings.pivot.x);
    setNumber(pivotY, settings.pivot.y);
    for (const [index, row] of rows.entries()) {
      setNumber(row.start, settings.boundaries[index]);
      setNumber(row.end, settings.boundaries[(index + 1) % FACING_DIRECTIONS.length]);
      for (const [key, input] of row.fields) setNumber(input, settings.directions[index][key]);
    }
    const unbound = snapshot.document.layers.filter(layer => layer.bone === null && layer.skin === null);
    const bones = snapshot.document.skeleton?.bones ?? [];
    syncChoices(layerMount, layerChoices, unbound, 'layers');
    syncChoices(boneMount, boneChoices, bones, 'bones');
    noLayers.hidden = unbound.length > 0;
    noBones.hidden = bones.length > 0;
    for (const [index, boundary] of boundaries.entries()) {
      const point = position(settings.boundaries[index], BOUNDARY_RADIUS);
      attribute(boundary.line, 'x2', String(point.x));
      attribute(boundary.line, 'y2', String(point.y));
      attribute(boundary.handle, 'cx', String(point.x));
      attribute(boundary.handle, 'cy', String(point.y));
      attribute(boundary.handle, 'aria-valuenow', angleText(settings.boundaries[index]));
      attribute(boundary.handle, 'aria-disabled', String(busy || !configured || !active));
      attribute(boundary.handle, 'tabindex', busy || !configured || !active ? '-1' : '0');
    }
    attribute(aimHandle, 'aria-disabled', String(busy || !active || !spritesEnabled));
    attribute(aimHandle, 'tabindex', busy || !active || !spritesEnabled ? '-1' : '0');
    aimInput.disabled = busy || !active || !spritesEnabled;
    previewStart.disabled = busy || !active || !spritesEnabled;
    previewLive.disabled = !spritesEnabled || snapshot.preview === null && !snapshot.directionalPreview;
    resetButton.disabled = busy || !configured;
    saveButton.disabled = busy || !snapshot.dirty;
    revertButton.disabled = busy || !snapshot.dirty || snapshot.saved === null;
    importButton.disabled = busy;
    exportButton.disabled = busy || !snapshot.hasContent;
    setText(status, snapshot.restoring ? 'Restoring the saved sprite document...' :
      snapshot.busy ? 'Working on the sprite document...' :
      !spritesEnabled ? 'Sprite rendering and directional preview are disabled in 3D. Authored settings remain editable.' :
      !configured ? options.presentationState().headTracking.reason :
      snapshot.dirty ? 'Directional settings are part of the unsaved sprite draft.' : 'Directional settings are saved on this device.');
    renderError();
    diagramSettings = null;
  }

  function setRay(ray: SVGLineElement, angle: number, radius: number): void {
    const point = position(angle, radius);
    attribute(ray, 'x2', String(point.x));
    attribute(ray, 'y2', String(point.y));
  }

  function renderDiagram(live: PresentationState): void {
    const index = FACING_DIRECTIONS.indexOf(live.direction);
    if (index < 0) throw new Error(`Unknown directional preview direction: ${live.direction}.`);
    const rule = settings.directions[index];
    if (diagramSettings !== settings || diagramDirection !== index) {
      const span = sectorSpan(settings, index);
      const start = settings.boundaries[index];
      attribute(sector, 'd', `${arcPath(start, span, SELECTION_RADIUS)} L ${CENTER} ${CENTER} Z`);
      const clockwise = settings.hysteresis ? rule.clockwiseHold : 0;
      const counterclockwise = settings.hysteresis ? rule.counterclockwiseHold : 0;
      attribute(hold, 'd', arcPath(start - clockwise, span + clockwise + counterclockwise, HOLD_RADIUS));
      attribute(limits, 'd', arcPath(rule.neutralAngle + rule.minimumRotation,
        rule.maximumRotation - rule.minimumRotation, ROTATION_RADIUS));
      attribute(limits, 'opacity', settings.rotation ? '1' : '0.3');
      for (const [marker, offset] of [[minimumLimit, rule.minimumRotation], [maximumLimit, rule.maximumRotation]] as const) {
        const point = position(rule.neutralAngle + offset, ROTATION_RADIUS);
        attribute(marker, 'cx', String(point.x));
        attribute(marker, 'cy', String(point.y));
        attribute(marker, 'opacity', settings.rotation ? '1' : '0.3');
      }
      setRay(neutral, rule.neutralAngle, ROTATION_RADIUS);
      for (const [at, row] of rows.entries()) row.row.classList.toggle('is-selected', at === index);
      diagramSettings = settings;
      diagramDirection = index;
    }
    setRay(target, rule.neutralAngle + live.targetRotation, ROTATION_RADIUS);
    setRay(displayed, rule.neutralAngle + live.displayedRotation, ROTATION_RADIUS);
    setRay(aimLine, live.aimAngle, AIM_RADIUS);
    const point = position(live.aimAngle, AIM_RADIUS);
    attribute(aimHandle, 'transform', `translate(${point.x} ${point.y})`);
    attribute(aimHandle, 'aria-valuenow', angleText(live.aimAngle));
  }

  function alignViewport(): DOMRect {
    if (viewportDirty || viewportRect === null) {
      viewportRect = options.viewport.canvas.getBoundingClientRect();
      viewportDirty = false;
      setStyle(overlay, 'left', viewportRect.left);
      setStyle(overlay, 'top', viewportRect.top);
      setStyle(overlay, 'width', viewportRect.width);
      setStyle(overlay, 'height', viewportRect.height);
      attribute(guides, 'viewBox', `0 0 ${viewportRect.width} ${viewportRect.height}`);
    }
    return viewportRect;
  }

  function projectGuide(node: SVGGElement, point: { x: number; y: number; z?: number }, rect: DOMRect): void {
    const client = options.viewport.project(point);
    attribute(node, 'transform', `translate(${numberText(client.x - rect.left)} ${numberText(client.y - rect.top)})`);
  }

  function updateGuides(live: PresentationState): void {
    const visible = live.pivot !== null || live.sockets.length > 0;
    if (!visible) {
      overlay.hidden = true;
      return;
    }
    const rect = alignViewport();
    overlay.hidden = rect.width <= 0 || rect.height <= 0;
    attribute(pivotGuide, 'visibility', live.pivot === null ? 'hidden' : 'visible');
    if (live.pivot !== null) projectGuide(pivotGuide, live.pivot, rect);
    socketFrame += 1;
    for (const socket of live.sockets) {
      let marker = socketGuides.get(socket.id);
      if (marker === undefined) {
        const node = svgElement('g', { class: 'directional-socket-guide' });
        const text = svgElement('text', { x: '9', y: '-6' });
        node.append(svgElement('circle', { r: '5' }), text);
        guides.append(node);
        marker = { node, text, seen: socketFrame };
        socketGuides.set(socket.id, marker);
      }
      marker.seen = socketFrame;
      const label = `${socket.id} (${socket.bone})`;
      if (marker.text.textContent !== label) marker.text.textContent = label;
      projectGuide(marker.node, socket, rect);
    }
    for (const [id, marker] of socketGuides) {
      if (marker.seen === socketFrame) continue;
      marker.node.remove();
      socketGuides.delete(id);
    }
  }

  function updatePreview(): void {
    if (disposed || !active || snapshot.document.characterRiggingType !== 'sprite-2d') return;
    const live = options.presentationState();
    setText(currentAim, degrees(live.aimAngle));
    setText(currentDirection, live.direction);
    setText(currentTarget, degrees(live.targetRotation));
    setText(currentDisplayed, degrees(live.displayedRotation));
    setText(previewMode, live.posePreview ? 'Manual skeleton pose preview. Set aim here to switch to directional preview.' :
      live.preview ? 'Directional aim preview on the game canvas. Return to live restores gameplay presentation.' :
      'Live game presentation. Drag aim or enter an angle to start a temporary preview.');
    if (document.activeElement !== aimInput && aimInput.getAttribute('aria-invalid') !== 'true') {
      const angle = angleText(live.aimAngle);
      if (aimInput.value !== angle) aimInput.value = angle;
    }
    renderDiagram(live);
    updateGuides(live);
  }

  function leavePreview(): void {
    cancelDrag();
    requestedAim = null;
    clearLocalError();
    options.state.leavePreview();
    renderError();
  }

  function setActive(value: boolean): void {
    if (disposed || active === value) return;
    active = value;
    viewportDirty = true;
    if (!active) {
      leavePreview();
      overlay.hidden = true;
    }
    render();
  }

  options.mount.append(root);
  const unsubscribe = options.state.subscribe(() => {
    snapshot = options.state.snapshot();
    if (!snapshot.directionalPreview) requestedAim = null;
    render();
  });
  options.signal.addEventListener('abort', dispose, { ...listen, once: true });

  function dispose(): void {
    if (disposed) return;
    leavePreview();
    disposed = true;
    unsubscribe();
    observer.disconnect();
    events.abort();
    overlay.remove();
    root.remove();
  }

  return { setActive, updatePreview, leavePreview, dispose };
}
