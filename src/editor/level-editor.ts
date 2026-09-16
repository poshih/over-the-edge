import { RIG } from '../config';
import type { Point } from '../config';
import { DEFAULT_LEVEL } from '../default-level';
import {
  ILLUSION, LEVEL_LIMITS, LevelError, ROCK_COLOR, SHAPE_KINDS,
  objectContains, objectVertices, shapeVertices, validateLevel, validateLevelObject,
} from '../level';
import type { LevelDefinition, LevelObject, LevelShape, ShapeKind } from '../level';
import { element } from '../dom';
import type { EditorCamera, LevelEditorOptions } from './level-editor-host';
import { NamedSnapshots, SnapshotError } from './named-snapshots';
import { createSnapshotPicker } from './snapshot-picker';
import './level-editor.css';

export type { LevelEditorOptions } from './level-editor-host';

type Tool = 'select' | 'pan' | 'place' | 'spawn' | 'summit';
interface Bounds { left: number; right: number; bottom: number; top: number }
interface Preset { id: string; label: string; shape: LevelShape; width: number; height: number }
type Gesture =
  | { kind: 'move'; pointerId: number; start: Point; world: Point; original: LevelObject; preview: LevelObject }
  | { kind: 'pan'; pointerId: number; start: Point; camera: EditorCamera; unitsPerPixel: number }
  | { kind: 'place' | 'spawn' | 'summit'; pointerId: number; world: Point };

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEGREES = 180 / Math.PI;
const DRAG_DISTANCE = 4;
const MIN_VIEW_HEIGHT = 3;
const MAX_VIEW_HEIGHT = LEVEL_LIMITS.coordinate * 4;
const VIEW_PADDING = 1.2;
const ZOOM_FACTOR = 1.35;
const WHEEL_ZOOM_RATE = 0.0015;
const GRID_TARGET_PIXELS = 48;
const DOWNLOAD_REVOKE_MS = 1000;
const DEFAULT_OBJECT_DEPTH = 1.5;
const STARTER_SUMMIT = { xMin: 4, xMax: 7, y: 0 } as const;
const WHEEL_LINE_PIXELS = 16;
const PRESET_SETTINGS: Record<ShapeKind, { label: string; width: number; height: number }> = {
  box: { label: 'Block', width: 2.5, height: 2 },
  ramp: { label: 'Ramp', width: 3, height: 2 },
  triangle: { label: 'Triangle', width: 2.5, height: 2.5 },
  circle: { label: 'Circle', width: 2.5, height: 2.5 },
  hexagon: { label: 'Hexagon', width: 2.5, height: 2.5 },
};
const PRESETS: readonly Preset[] = SHAPE_KINDS.flatMap((type): Preset[] => {
  const preset = { id: type, shape: Object.freeze({ type }), ...PRESET_SETTINGS[type] };
  return type === 'box'
    ? [preset, { id: 'platform', label: 'Platform', shape: preset.shape, width: 4, height: 0.4 }]
    : [preset];
});
const history = new NamedSnapshots<LevelDefinition>({
  prefix: 'over-the-edge:level:snapshot:v1:', version: 1, field: 'level',
  label: 'level', namePrompt: 'Enter a level name',
  validate: validateLevel, isDataError: (error) => error instanceof LevelError,
});

function objectBounds(object: LevelObject): Bounds {
  const vertices = objectVertices(object);
  return {
    left: Math.min(...vertices.map((point) => point.x)), right: Math.max(...vertices.map((point) => point.x)),
    bottom: Math.min(...vertices.map((point) => point.y)), top: Math.max(...vertices.map((point) => point.y)),
  };
}

function numericField(id: string, label: string, min: number, max: number, step = 0.1): string {
  return `<label class="level-field" for="level-${id}">${label}
    <input id="level-${id}" type="number" min="${min}" max="${max}" step="${step}" inputmode="decimal" />
  </label>`;
}

export function createLevelEditor(options: LevelEditorOptions) {
  const { level, camera, onNotice } = options;
  const events = new AbortController();
  const listen = { signal: events.signal };
  const root = document.createElement('section');
  root.className = 'level-editor';
  root.hidden = true;
  root.setAttribute('aria-label', 'Level editor');
  root.innerHTML = `
    <div class="level-top">
      <div class="level-action-row">
        <button type="button" class="button button-primary level-play">Playtest</button>
        <button type="button" class="button level-new">New level</button>
      </div>
      <div class="level-save-dock"></div>
      <p class="level-save-status" role="status" aria-live="polite"></p>
    </div>
    <div class="workshop-scroll level-scroll">
      <fieldset class="tuning-group level-tools">
        <legend>Build the course</legend>
        <div class="level-action-row">
          <button type="button" class="button" data-level-tool="select" aria-pressed="true">Select / move</button>
          <button type="button" class="button" data-level-tool="pan" aria-pressed="false">Pan view</button>
        </div>
        <div class="level-palette" aria-label="Shape palette"></div>
        <p class="level-help level-tool-help"></p>
        <div class="level-camera-controls" aria-label="Editor camera">
          <button type="button" class="button level-zoom-out" aria-label="Zoom out">−</button>
          <button type="button" class="button level-zoom-in" aria-label="Zoom in">+</button>
          <button type="button" class="button level-fit">Fit course</button>
        </div>
      </fieldset>
      <fieldset class="tuning-group level-inspector">
        <legend>Object properties</legend>
        <p class="level-selection-name"></p>
        <div class="level-field-grid">
          ${numericField('x', 'Position X', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('y', 'Position Y', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('width', 'Width / diameter', LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize)}
          ${numericField('height', 'Height', LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize)}
          ${numericField('angle', 'Rotation (°)', -180, 180, 1)}
          ${numericField('depth', 'Depth', LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth)}
        </div>
        <p class="level-help level-circle-help" hidden>Circle width is its diameter. Height is linked to width.</p>
        <label class="level-checkbox" for="level-illusion">
          <input id="level-illusion" type="checkbox" aria-describedby="level-illusion-help" /> Illusion
        </label>
        <p id="level-illusion-help" class="level-help">Only the player pot landing on top starts a
          ${ILLUSION.fadeSeconds}s fade. Then collision and visuals disappear. Hammer, side and underside
          contacts do not trigger it. Playtest resets disappeared objects; saved level data is unchanged.</p>
        <button type="button" class="button level-delete">Delete selected object</button>
      </fieldset>
      <fieldset class="tuning-group level-course-settings">
        <legend>Player start &amp; summit</legend>
        <p class="level-help">Start coordinates are the pot center; leave space above the ground.
          The summit line belongs at the top of a reachable surface.</p>
        <div class="level-field-grid">
          ${numericField('spawn-x', 'Start X', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('spawn-y', 'Start Y', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('spawn-angle', 'Hammer angle (°)', -180, 180, 1)}
          ${numericField('spawn-extension', 'Hammer extension', RIG.minExtension, RIG.maxExtension)}
        </div>
        <div class="level-action-row">
          <button type="button" class="button" data-level-tool="spawn" aria-pressed="false">Place start</button>
          <button type="button" class="button level-go-start">View start</button>
        </div>
        <div class="level-field-grid">
          ${numericField('summit-left', 'Summit left X', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('summit-right', 'Summit right X', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('summit-y', 'Summit height', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('summit-tolerance', 'Arrival tolerance', 0, 0.25, 0.01)}
        </div>
        <div class="level-action-row">
          <button type="button" class="button" data-level-tool="summit" aria-pressed="false">Place summit</button>
          <button type="button" class="button level-go-summit">View summit</button>
        </div>
        <button type="button" class="button level-clear-labels">Remove course labels</button>
        <p class="level-help level-label-count"></p>
      </fieldset>
      <div class="level-history"></div>
      <fieldset class="tuning-group level-files">
        <legend>Level JSON</legend>
        <div class="level-action-row">
          <button type="button" class="button level-export">Export level JSON</button>
          <button type="button" class="button level-import">Import level JSON</button>
        </div>
        <input class="level-file" type="file" accept=".json,application/json" aria-label="Import level JSON" hidden />
        <p class="level-help">Exports level.json: course geometry, start, summit and labels only.
          Models, appearance, tuning and browser settings are never included. Import limit:
          ${LEVEL_LIMITS.fileBytes / (1024 * 1024)} MiB. Saved history loads only when you choose Load level.</p>
      </fieldset>
    </div>
  `;
  options.mount.append(root);
  const overlay = document.createElement('div');
  overlay.className = 'level-overlay';
  overlay.hidden = true;
  overlay.tabIndex = 0;
  overlay.setAttribute('aria-label', 'Level canvas. V selects, H pans, plus and minus zoom. Escape cancels; Delete removes selection.');
  overlay.innerHTML = `<svg class="level-guides" aria-hidden="true">
    <polygon class="level-selection" vector-effect="non-scaling-stroke" hidden />
    <polygon class="level-ghost" vector-effect="non-scaling-stroke" hidden />
    <g class="level-start-marker"><circle r="8" /><path d="M -13 0 H 13 M 0 -13 V 13" /><text x="16" y="-12">START</text></g>
    <g class="level-summit-marker"><path /><text>SUMMIT</text></g>
  </svg>`;
  // A canvas sibling stays below the host's interface stacking context, including its toolbar.
  options.canvas.insertAdjacentElement('afterend', overlay);
  const graphic = <T extends SVGElement>(selector: string): T => {
    const node = overlay.querySelector<T>(selector);
    if (node === null) throw new Error(`Missing level overlay element: ${selector}`);
    return node;
  };
  const svg = graphic<SVGSVGElement>('svg');
  const selectionPolygon = graphic<SVGPolygonElement>('.level-selection');
  const ghostPolygon = graphic<SVGPolygonElement>('.level-ghost');
  const startMarker = graphic<SVGGElement>('.level-start-marker');
  const summitPath = graphic<SVGPathElement>('.level-summit-marker path');
  const summitText = graphic<SVGTextElement>('.level-summit-marker text');
  const inspector = element<HTMLFieldSetElement>(root, '.level-inspector');
  const input = (name: string) => element<HTMLInputElement>(root, `#level-${name}`);
  const saveStatus = element<HTMLParagraphElement>(root, '.level-save-status');
  const importButton = element<HTMLButtonElement>(root, '.level-import');
  const fileInput = element<HTMLInputElement>(root, '.level-file');
  const bounds = new Map(level.definition().objects.map((object) => [object.id, objectBounds(object)]));
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  let active = false;
  let disposed = false;
  let tool: Tool = 'select';
  let selectedId: string | null = null;
  let presetId: string | null = null;
  let placement: LevelObject | null = null;
  let gesture: Gesture | null = null;
  let markerPreview: Point | null = null;
  let savedDefinition = level.definition();
  let savedCamera: EditorCamera | null = null;
  let importGeneration = 0;
  let importing = false;
  let rect = options.canvas.getBoundingClientRect();
  let drawCount = 0;
  let commitCount = 0;
  let hitTestCount = 0;

  const dirty = () => level.definition() !== savedDefinition;
  const selectedObject = () => selectedId === null ? null : level.object(selectedId);
  const inspectorObject = () => tool === 'place' ? placement : selectedObject();
  const pointFromEvent = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });
  const local = (point: Point): Point => {
    const client = camera.project(point);
    return { x: client.x - rect.left, y: client.y - rect.top };
  };

  function report(error: unknown): void {
    if (error instanceof LevelError || error instanceof SnapshotError) {
      onNotice(`${error.message} Your current level and existing snapshots were left unchanged.`, 'error');
    } else if (error instanceof DOMException) {
      onNotice('The file or device storage is unavailable or full. Your current level and existing snapshots were left unchanged.', 'error');
    } else {
      throw error;
    }
  }

  function applyEdit(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!(error instanceof LevelError)) throw error;
      report(error);
      renderControls();
      draw();
    }
  }

  function confirmReplacement(action: string): boolean {
    return !dirty() || window.confirm(`${action} replaces your unsaved level changes.
Save a named snapshot or export first if you want to keep them. Continue without saving?`);
  }

  function renderStatus(): void {
    saveStatus.textContent = `${level.definition().objects.length} / ${LEVEL_LIMITS.objects} objects · ${
      importing ? 'Reading level file…' : dirty() ? 'Unsaved changes — save or export to keep them' : 'No unsaved changes'}`;
    saveStatus.dataset.dirty = String(dirty());
  }

  function renderControls(): void {
    const object = inspectorObject();
    inspector.disabled = object === null;
    element(root, '.level-selection-name').textContent = object === null ? 'Select an object, or choose a shape to place.' :
      tool === 'place' ? `New ${object.shape.type} — click / tap the canvas to place` : `${object.shape.type} · ${object.id}`;
    for (const name of ['x', 'y', 'width', 'height', 'angle', 'depth'] as const) {
      input(name).value = object === null ? '' : String(Number((name === 'angle' ? object.angle * DEGREES : object[name]).toFixed(4)));
    }
    input('height').disabled = object?.shape.type === 'circle';
    input('illusion').checked = object?.illusion === true;
    element(root, '.level-circle-help').hidden = object?.shape.type !== 'circle';
    element<HTMLButtonElement>(root, '.level-delete').disabled = selectedId === null || tool === 'place';
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.levelTool === tool));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-preset]')) {
      button.setAttribute('aria-pressed', String(tool === 'place' && button.dataset.levelPreset === presetId));
    }
    const help: Record<Tool, string> = {
      select: 'Click / tap to select; drag to move. V selects, H pans. Escape cancels a drag without changing the level.',
      pan: 'Drag the canvas to pan anywhere in the course. Use + / − or the mouse wheel to zoom.',
      place: 'Click / tap to place this shape. Adjust its properties first if needed. Escape cancels placement.',
      spawn: 'Click / tap the new pot-center position. Escape cancels.',
      summit: 'Click / tap the middle of the summit surface. Its current width is preserved. Escape cancels.',
    };
    element(root, '.level-tool-help').textContent = help[tool];
    overlay.dataset.tool = tool;
    const { spawn, summit, labels } = level.definition();
    for (const [name, value] of Object.entries({
      'spawn-x': spawn.position.x, 'spawn-y': spawn.position.y,
      'spawn-angle': spawn.angle * DEGREES, 'spawn-extension': spawn.extension,
      'summit-left': summit.xMin, 'summit-right': summit.xMax,
      'summit-y': summit.y, 'summit-tolerance': summit.arrivalTolerance,
    })) input(name).value = String(Number(value.toFixed(4)));
    element(root, '.level-label-count').textContent = `${labels.length} course labels. Edits, saves and exports preserve them unless you remove them.`;
    element<HTMLButtonElement>(root, '.level-clear-labels').disabled = labels.length === 0;
    renderStatus();
  }

  function drawPolygon(polygon: SVGPolygonElement, object: LevelObject | null): void {
    polygon.toggleAttribute('hidden', object === null);
    if (object === null) return;
    polygon.setAttribute('points', objectVertices(object).map((point) => {
      const p = local(point);
      return `${p.x},${p.y}`;
    }).join(' '));
    polygon.classList.toggle('level-illusion-outline', object.illusion);
  }

  function draw(): void {
    if (!active || disposed || rect.width <= 0 || rect.height <= 0) return;
    drawCount++;
    drawPolygon(selectionPolygon, selectedObject());
    drawPolygon(ghostPolygon, gesture?.kind === 'move' ? gesture.preview : placement);
    const { spawn, summit } = level.definition();
    const start = local(tool === 'spawn' && markerPreview !== null ? markerPreview : spawn.position);
    startMarker.setAttribute('transform', `translate(${start.x},${start.y})`);
    const summitCenter = tool === 'summit' ? markerPreview : null;
    const halfWidth = (summit.xMax - summit.xMin) / 2;
    const left = local(summitCenter === null ? { x: summit.xMin, y: summit.y } :
      { x: summitCenter.x - halfWidth, y: summitCenter.y });
    const right = local(summitCenter === null ? { x: summit.xMax, y: summit.y } :
      { x: summitCenter.x + halfWidth, y: summitCenter.y });
    summitPath.setAttribute('d', `M ${left.x} ${left.y - 8} V ${left.y} H ${right.x} V ${right.y - 8}`);
    summitText.setAttribute('x', String((left.x + right.x) / 2));
    summitText.setAttribute('y', String(left.y - 12));
  }

  function drawCamera(): void {
    if (!active || disposed) return;
    const origin = local({ x: 0, y: 0 });
    const unit = local({ x: 1, y: 0 });
    const pixelsPerUnit = Math.hypot(unit.x - origin.x, unit.y - origin.y);
    if (pixelsPerUnit > 0) {
      const spacing = 2 ** Math.ceil(Math.log2(GRID_TARGET_PIXELS / pixelsPerUnit)) * pixelsPerUnit;
      overlay.style.backgroundSize = `${spacing}px ${spacing}px`;
      overlay.style.backgroundPosition = `${origin.x % spacing}px ${origin.y % spacing}px`;
    }
    draw();
  }

  function alignOverlay(): void {
    if (!active || disposed) return;
    rect = options.canvas.getBoundingClientRect();
    Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    drawCamera();
  }

  function setCamera(next: EditorCamera): void {
    const limit = LEVEL_LIMITS.coordinate + LEVEL_LIMITS.maximumSize;
    savedCamera = {
      x: Math.max(-limit, Math.min(limit, next.x)),
      y: Math.max(-limit, Math.min(limit, next.y)),
      worldHeight: Math.max(MIN_VIEW_HEIGHT, Math.min(MAX_VIEW_HEIGHT, next.worldHeight)),
    };
    camera.set(savedCamera);
    drawCamera();
  }

  function cancelGesture(): void {
    const previous = gesture;
    gesture = null;
    if (previous !== null && overlay.hasPointerCapture(previous.pointerId)) overlay.releasePointerCapture(previous.pointerId);
    if (previous?.kind === 'pan' && active) setCamera(previous.camera);
    markerPreview = null;
    draw();
  }

  function chooseTool(next: Exclude<Tool, 'place'>): void {
    cancelGesture();
    tool = next;
    placement = null;
    markerPreview = null;
    renderControls();
    draw();
  }

  function fitCourse(): void {
    cancelGesture();
    const { spawn, summit } = level.definition();
    const combined: Bounds = {
      left: Math.min(spawn.position.x, summit.xMin), right: Math.max(spawn.position.x, summit.xMax),
      bottom: Math.min(spawn.position.y, summit.y), top: Math.max(spawn.position.y, summit.y),
    };
    for (const bound of bounds.values()) {
      combined.left = Math.min(combined.left, bound.left); combined.right = Math.max(combined.right, bound.right);
      combined.bottom = Math.min(combined.bottom, bound.bottom); combined.top = Math.max(combined.top, bound.top);
    }
    const aspect = rect.width / Math.max(1, rect.height);
    setCamera({
      x: (combined.left + combined.right) / 2, y: (combined.bottom + combined.top) / 2,
      worldHeight: Math.max(combined.top - combined.bottom, (combined.right - combined.left) / Math.max(0.01, aspect)) * VIEW_PADDING,
    });
  }

  function zoom(factor: number, anchor: Point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }): void {
    cancelGesture();
    const before = camera.unproject(anchor);
    const state = camera.state();
    const height = Math.max(MIN_VIEW_HEIGHT, Math.min(MAX_VIEW_HEIGHT, state.worldHeight * factor));
    const ratio = height / state.worldHeight;
    setCamera({ x: before.x + (state.x - before.x) * ratio, y: before.y + (state.y - before.y) * ratio, worldHeight: height });
  }

  function resetSelection(): void {
    cancelGesture();
    selectedId = null;
    chooseTool('select');
  }

  function markSaved(): void {
    savedDefinition = level.definition();
    renderStatus();
  }

  const picker = createSnapshotPicker({
    mount: element(root, '.level-history'), signal: events.signal, id: 'level', noun: 'level', plural: 'levels',
    placeholder: 'e.g. The quiet ascent', isStorageKey: (key) => history.isStorageKey(key), onNotice,
    list: () => {
      try {
        return history.list(localStorage);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        report(error);
        throw error;
      }
    },
    save: (name) => {
      if (!active) return null;
      try {
        const entry = history.save(localStorage, name, level.definition());
        markSaved();
        return entry;
      } catch (error) {
        report(error);
        return null;
      }
    },
    load: (key) => {
      if (!active) return null;
      let saved;
      try {
        saved = history.read(localStorage, key);
      } catch (error) {
        report(error);
        return null;
      }
      if (!confirmReplacement('Loading this snapshot')) return null;
      resetSelection();
      level.replace(saved.settings);
      markSaved();
      fitCourse();
      return saved;
    },
  });
  picker.setDisabled(true);
  element(root, '.level-save-dock').append(element(root, '.tuning-save-form'));

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-preset';
    button.dataset.levelPreset = preset.id;
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '-0.65 -0.65 1.3 1.3');
    icon.setAttribute('aria-hidden', 'true');
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    const size = Math.max(preset.width, preset.height);
    polygon.setAttribute('points', shapeVertices(preset.shape).map((p) =>
      `${p.x * preset.width / size},${-p.y * preset.height / size}`).join(' '));
    icon.append(polygon);
    button.append(icon, document.createTextNode(preset.label));
    button.addEventListener('click', () => {
      if (!active) return;
      cancelGesture();
      const view = camera.state();
      tool = 'place'; presetId = preset.id; selectedId = null;
      placement = {
        id: 'placement-preview', shape: preset.shape, x: view.x, y: view.y,
        width: preset.width, height: preset.height, angle: 0,
        depth: DEFAULT_OBJECT_DEPTH, color: ROCK_COLOR, illusion: false,
      };
      renderControls();
      draw();
    }, listen);
    element(root, '.level-palette').append(button);
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-tool]')) {
    button.addEventListener('click', () => {
      if (!active) return;
      const next = button.dataset.levelTool;
      if (next !== 'select' && next !== 'pan' && next !== 'spawn' && next !== 'summit') throw new Error('Unknown level tool.');
      chooseTool(next);
    }, listen);
  }
  for (const name of ['x', 'y', 'width', 'height', 'angle', 'depth', 'illusion'] as const) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      const object = inspectorObject();
      if (object === null) return;
      cancelGesture();
      applyEdit(() => {
        const value = name === 'illusion' ? input(name).checked : input(name).valueAsNumber / (name === 'angle' ? DEGREES : 1);
        const next = { ...object, [name]: value };
        if (next.shape.type === 'circle' && (name === 'width' || name === 'height')) {
          next.width = Number(value); next.height = Number(value);
        }
        if (tool === 'place') {
          placement = validateLevelObject(next);
          renderControls(); draw();
        } else {
          level.upsert(next);
        }
      });
    }, listen);
  }
  for (const name of ['spawn-x', 'spawn-y', 'spawn-angle', 'spawn-extension', 'summit-left', 'summit-right', 'summit-y', 'summit-tolerance']) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      cancelGesture();
      applyEdit(() => {
        const { spawn, summit, labels } = level.definition();
        const value = input(name).valueAsNumber;
        const nextSpawn = {
          ...spawn, position: {
            x: name === 'spawn-x' ? value : spawn.position.x, y: name === 'spawn-y' ? value : spawn.position.y,
          },
          angle: name === 'spawn-angle' ? value / DEGREES : spawn.angle,
          extension: name === 'spawn-extension' ? value : spawn.extension,
        };
        level.metadata({
          spawn: nextSpawn, labels,
          summit: {
            xMin: name === 'summit-left' ? value : summit.xMin, xMax: name === 'summit-right' ? value : summit.xMax,
            y: name === 'summit-y' ? value : summit.y,
            arrivalTolerance: name === 'summit-tolerance' ? value : summit.arrivalTolerance,
          },
        });
      });
    }, listen);
  }

  function action(selector: string, callback: () => void): void {
    element(root, selector).addEventListener('click', () => { if (active) callback(); }, listen);
  }
  function deleteSelected(): void {
    if (selectedId === null || tool === 'place') return;
    cancelGesture();
    const id = selectedId;
    selectedId = null;
    level.remove(id);
  }
  action('.level-delete', deleteSelected);
  action('.level-play', () => { cancelGesture(); options.onPlay(); });
  action('.level-fit', fitCourse);
  action('.level-zoom-in', () => zoom(1 / ZOOM_FACTOR));
  action('.level-zoom-out', () => zoom(ZOOM_FACTOR));
  action('.level-go-start', () => {
    cancelGesture();
    const { position } = level.definition().spawn;
    setCamera({ ...camera.state(), x: position.x, y: position.y });
  });
  action('.level-go-summit', () => {
    cancelGesture();
    const summit = level.definition().summit;
    setCamera({ ...camera.state(), x: (summit.xMin + summit.xMax) / 2, y: summit.y });
  });
  action('.level-clear-labels', () => {
    const { spawn, summit, labels } = level.definition();
    if (labels.length === 0 || !window.confirm(`Remove all ${labels.length} course labels? Saved snapshots are not changed.`)) return;
    level.metadata({ spawn, summit, labels: [] });
  });
  action('.level-new', () => {
    if (!window.confirm(`Start a new level? ${dirty() ? 'Your unsaved changes will be discarded. Save or export first to keep them. ' : ''}
This restores the default ground and player start, removes all other objects and labels, and puts the summit on the ground. Saved snapshots are kept.`)) return;
    const ground = DEFAULT_LEVEL.objects.find((object) => object.id === 'ground');
    if (ground === undefined) throw new Error('The starter level needs its authored ground.');
    resetSelection();
    level.replace({
      ...DEFAULT_LEVEL, objects: [ground], labels: [],
      summit: { ...DEFAULT_LEVEL.summit, ...STARTER_SUMMIT },
    });
    fitCourse();
    onNotice('New level started. Add a course, set its start and summit, then save or export before leaving.', 'info');
  });
  action('.level-export', () => {
    const definition = validateLevel(level.definition());
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(definition, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'level.json';
    root.append(link);
    link.click();
    link.remove();
    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, DOWNLOAD_REVOKE_MS));
    markSaved();
    onNotice('Exported level.json. It contains only authored level data, ready for a game-only build.', 'info');
  });
  action('.level-import', () => fileInput.click());

  async function importFile(file: File): Promise<void> {
    if (file.size > LEVEL_LIMITS.fileBytes) {
      onNotice(`Level JSON must be at most ${LEVEL_LIMITS.fileBytes / (1024 * 1024)} MiB. Your current level was not changed.`, 'error');
      return;
    }
    const generation = ++importGeneration;
    importing = true; importButton.disabled = true; picker.setDisabled(true); renderStatus();
    let definition: LevelDefinition;
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new LevelError('Level JSON is malformed.');
      }
      definition = validateLevel(raw);
    } catch (error) {
      if (!disposed && generation === importGeneration) report(error);
      else if (!(error instanceof LevelError) && !(error instanceof DOMException)) throw error;
      return;
    } finally {
      if (!disposed && generation === importGeneration) {
        importing = false; importButton.disabled = false; picker.setDisabled(!active); renderStatus();
      }
    }
    if (disposed || !active || generation !== importGeneration || !confirmReplacement('Importing this level')) return;
    resetSelection();
    level.replace(definition);
    markSaved();
    fitCourse();
    onNotice('Imported level JSON. Existing named snapshots were kept; save a snapshot to keep it in this browser.', 'info');
  }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (active && file !== undefined) void importFile(file);
  }, listen);

  function hitTest(world: Point): LevelObject | null {
    hitTestCount++;
    const objects = level.definition().objects;
    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index];
      const bound = bounds.get(object.id);
      if (bound === undefined) throw new Error('Missing authored object bounds.');
      if (world.x >= bound.left && world.x <= bound.right && world.y >= bound.bottom && world.y <= bound.top &&
        objectContains(object, world)) return object;
    }
    return null;
  }

  function movePreview(event: PointerEvent): void {
    const client = pointFromEvent(event);
    const world = camera.unproject(client);
    if (gesture?.kind === 'pan') {
      setCamera({
        ...gesture.camera,
        x: gesture.camera.x - (client.x - gesture.start.x) * gesture.unitsPerPixel,
        y: gesture.camera.y + (client.y - gesture.start.y) * gesture.unitsPerPixel,
      });
      return;
    }
    if (gesture?.kind === 'move') {
      const moved = Math.hypot(client.x - gesture.start.x, client.y - gesture.start.y) >= DRAG_DISTANCE;
      gesture.preview = moved ? {
        ...gesture.original, x: gesture.original.x + world.x - gesture.world.x,
        y: gesture.original.y + world.y - gesture.world.y,
      } : gesture.original;
    } else if (tool === 'place' && placement !== null) {
      placement = { ...placement, x: world.x, y: world.y };
      if (gesture?.kind === 'place') gesture.world = world;
    } else if (tool === 'spawn' || tool === 'summit') {
      markerPreview = world;
      if (gesture?.kind === tool) gesture.world = world;
    }
    draw();
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (!active || gesture !== null || event.button !== 0) return;
    event.preventDefault();
    overlay.focus({ preventScroll: true });
    const client = pointFromEvent(event);
    const world = camera.unproject(client);
    if (tool === 'select') {
      const object = hitTest(world);
      selectedId = object?.id ?? null;
      if (object !== null) gesture = { kind: 'move', pointerId: event.pointerId, start: client, world, original: object, preview: object };
      renderControls(); draw();
    } else if (tool === 'pan') {
      gesture = {
        kind: 'pan', pointerId: event.pointerId, start: client, camera: { ...camera.state() },
        unitsPerPixel: camera.state().worldHeight / Math.max(1, rect.height),
      };
    } else {
      gesture = { kind: tool, pointerId: event.pointerId, world };
      movePreview(event);
    }
    if (gesture !== null) overlay.setPointerCapture(event.pointerId);
  }, listen);
  overlay.addEventListener('pointermove', (event) => {
    if (!active || (gesture !== null && gesture.pointerId !== event.pointerId)) return;
    if (gesture === null && tool !== 'place' && tool !== 'spawn' && tool !== 'summit') return;
    movePreview(event);
  }, listen);
  overlay.addEventListener('pointerup', (event) => {
    if (!active || gesture === null || gesture.pointerId !== event.pointerId) return;
    movePreview(event);
    const finished = gesture;
    gesture = null;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    applyEdit(() => {
      if (finished.kind === 'move') {
        if (finished.preview !== finished.original) level.upsert(finished.preview);
      } else if (finished.kind === 'place' && inside && placement !== null) {
        const object = { ...placement, id: `shape-${crypto.randomUUID()}` };
        level.upsert(object);
        selectedId = object.id;
        chooseTool('select');
      } else if ((finished.kind === 'spawn' || finished.kind === 'summit') && inside) {
        const { spawn, summit, labels } = level.definition();
        const halfWidth = (summit.xMax - summit.xMin) / 2;
        level.metadata({
          labels,
          spawn: finished.kind === 'spawn' ? { ...spawn, position: finished.world } : spawn,
          summit: finished.kind === 'summit' ? {
            ...summit, xMin: finished.world.x - halfWidth, xMax: finished.world.x + halfWidth, y: finished.world.y,
          } : summit,
        });
        chooseTool('select');
      }
    });
    markerPreview = null;
    renderControls(); draw();
  }, listen);
  const cancelPointer = (event: PointerEvent): void => {
    if (gesture?.pointerId === event.pointerId) cancelGesture();
  };
  overlay.addEventListener('pointercancel', cancelPointer, listen);
  overlay.addEventListener('lostpointercapture', cancelPointer, listen);
  overlay.addEventListener('pointerleave', () => {
    if (gesture === null) { markerPreview = null; draw(); }
  }, listen);
  overlay.addEventListener('wheel', (event) => {
    if (!active) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS :
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1);
    zoom(Math.exp(Math.max(-1, Math.min(1, delta * WHEEL_ZOOM_RATE))), { x: event.clientX, y: event.clientY });
  }, { ...listen, passive: false });
  window.addEventListener('keydown', (event) => {
    if (!active || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    switch (event.key.toLowerCase()) {
      case 'escape': cancelGesture(); selectedId = null; chooseTool('select'); break;
      case 'v': chooseTool('select'); break;
      case 'h': chooseTool('pan'); break;
      case 'delete':
      case 'backspace': deleteSelected(); break;
      case '+':
      case '=': zoom(1 / ZOOM_FACTOR); break;
      case '-': zoom(ZOOM_FACTOR); break;
      case '0': fitCourse(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, { ...listen, capture: true });
  window.addEventListener('blur', cancelGesture, listen);
  window.addEventListener('beforeunload', (event) => {
    if (!dirty()) return;
    event.preventDefault();
    event.returnValue = '';
  }, listen);
  window.addEventListener('resize', alignOverlay, listen);
  window.addEventListener('scroll', alignOverlay, { ...listen, capture: true, passive: true });
  const resize = new ResizeObserver(alignOverlay);
  resize.observe(options.canvas);
  const unsubscribe = level.subscribe((change) => {
    commitCount++;
    for (const id of change.remove) bounds.delete(id);
    for (const object of change.upsert) bounds.set(object.id, objectBounds(object));
    if (selectedId !== null && !bounds.has(selectedId)) selectedId = null;
    if (gesture !== null) cancelGesture();
    renderControls();
    draw();
  });
  renderControls();
  root.inert = true;

  return {
    setMode(mode: 'edit' | 'inactive'): void {
      if (disposed) return;
      if (mode === 'edit') {
        if (!active) {
          active = true;
          root.hidden = false; root.inert = false; overlay.hidden = false;
          camera.set(savedCamera === null ? camera.state() : savedCamera);
          picker.setDisabled(importing);
          renderControls();
        }
        alignOverlay();
      } else {
        cancelGesture();
        active = false;
        importGeneration++; importing = false; importButton.disabled = false;
        root.hidden = true; root.inert = true; overlay.hidden = true;
        picker.setDisabled(true);
        camera.set(null);
      }
    },
    snapshot() {
      const current = level.definition();
      const object = selectedObject();
      return Object.freeze({
        mode: active ? 'edit' as const : 'inactive' as const,
        tool, selectedId, selected: object, preset: presetId,
        preview: gesture?.kind === 'move' ? Object.freeze({ ...gesture.preview }) :
          placement === null ? null : Object.freeze({ ...placement }),
        dragging: gesture?.kind ?? null, capturedPointer: gesture?.pointerId ?? null,
        dirty: dirty(), importing, objectCount: current.objects.length,
        spawn: current.spawn, summit: current.summit, labelCount: current.labels.length,
        camera: Object.freeze({ ...camera.state() }),
        overlay: Object.freeze({ visible: active && !overlay.hidden, x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
        commits: commitCount, hitTests: hitTestCount, draws: drawCount,
      });
    },
    dispose(): void {
      if (disposed) return;
      cancelGesture();
      active = false; disposed = true; importGeneration++;
      events.abort(); resize.disconnect(); unsubscribe();
      camera.set(null);
      for (const [url, timeout] of downloads) { clearTimeout(timeout); URL.revokeObjectURL(url); }
      downloads.clear(); bounds.clear();
      root.remove(); overlay.remove();
    },
  };
}
