import { RIG } from '../config';
import type { Point } from '../config';
import { DEFAULT_LEVEL } from '../default-level';
import {
  ILLUSION, isTerrainObject, isTriggerObject, LEVEL_LIMITS, LevelError, ROCK_COLOR, SHAPE_KINDS,
  objectContains, objectVertices, shapeVertices, TRIGGER_LIMITS, validateLevel, validateLevelObject,
} from '../level';
import type { LevelDefinition, LevelObject, LevelShape, ShapeKind, StartObject, TerrainObject, TriggerObject, TriggerRegion } from '../level';
import { ENDING_EVENTS } from '../trigger-events';
import type { TriggerAction } from '../trigger-events';
import { element } from '../dom';
import type { EditorCamera, LevelEditorOptions } from './level-editor-host';
import { EntityGizmos, objectGizmoBounds } from './object-gizmos';
import { NamedSnapshots, SnapshotError } from './named-snapshots';
import { createSnapshotPicker } from './snapshot-picker';
import { createTriggerEventEditor, describeEvents } from './trigger-inspector';
import './level-editor.css';

export type { LevelEditorOptions } from './level-editor-host';

type Tool = 'select' | 'pan' | 'place' | 'place-trigger' | 'start';
interface Bounds { left: number; right: number; bottom: number; top: number }
interface TerrainPreset { id: string; label: string; shape: LevelShape; width: number; height: number }
interface TriggerPreset {
  id: string; label: string; name: string; region: TriggerRegion;
  activation: 'once' | 'on-enter'; marker: 'none' | 'flag';
  events: readonly TriggerAction[]; anchorBottom: boolean;
}
type Gesture =
  | { kind: 'move'; pointerId: number; start: Point; world: Point; original: LevelObject; preview: LevelObject }
  | { kind: 'pan'; pointerId: number; start: Point; camera: EditorCamera; unitsPerPixel: number }
  | { kind: 'place' | 'place-trigger' | 'start'; pointerId: number; world: Point };

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEGREES = 180 / Math.PI;
const DRAG_DISTANCE = 4;
const HANDLE_PIXELS = 16;
const MIN_VIEW_HEIGHT = 3;
const MAX_VIEW_HEIGHT = LEVEL_LIMITS.coordinate * 4;
const VIEW_PADDING = 1.2;
const ZOOM_FACTOR = 1.35;
const WHEEL_ZOOM_RATE = 0.0015;
const GRID_TARGET_PIXELS = 48;
const DOWNLOAD_REVOKE_MS = 1000;
const DEFAULT_OBJECT_DEPTH = 1.5;
const WHEEL_LINE_PIXELS = 16;
const PRESET_SETTINGS: Record<ShapeKind, { label: string; width: number; height: number }> = {
  box: { label: 'Block', width: 2.5, height: 2 },
  ramp: { label: 'Ramp', width: 3, height: 2 },
  triangle: { label: 'Triangle', width: 2.5, height: 2.5 },
  circle: { label: 'Circle', width: 2.5, height: 2.5 },
  hexagon: { label: 'Hexagon', width: 2.5, height: 2.5 },
};
const PRESETS: readonly TerrainPreset[] = SHAPE_KINDS.flatMap((type): TerrainPreset[] => {
  const preset = { id: type, shape: Object.freeze({ type }), ...PRESET_SETTINGS[type] };
  return type === 'box'
    ? [preset, { id: 'platform', label: 'Platform', shape: preset.shape, width: 4, height: 0.4 }]
    : [preset];
});
const TRIGGER_PRESETS: readonly TriggerPreset[] = [
  {
    id: 'trigger', label: 'Trigger', name: 'Trigger', anchorBottom: false,
    region: { type: 'circle', radius: 1.5 }, activation: 'once', marker: 'none',
    events: [{ type: 'popup', title: 'Event', message: 'Describe what happens here.' }],
  },
  {
    id: 'ending-trigger', label: 'Ending trigger', name: 'Ending', anchorBottom: true,
    region: { type: 'box', width: 3, height: TRIGGER_LIMITS.endingHeight }, activation: 'once', marker: 'flag',
    events: ENDING_EVENTS,
  },
];
const history = new NamedSnapshots<LevelDefinition>({
  prefix: 'over-the-edge:level:snapshot:v1:', version: 1, field: 'level',
  label: 'level', namePrompt: 'Enter a level name',
  validate: validateLevel, isDataError: (error) => error instanceof LevelError,
});

function asTerrain(object: LevelObject | null): TerrainObject | null {
  return object !== null && isTerrainObject(object) ? object : null;
}
function asStart(object: LevelObject | null): StartObject | null {
  return object !== null && object.kind === 'start' ? object : null;
}
function asTrigger(object: LevelObject | null): TriggerObject | null {
  return object !== null && isTriggerObject(object) ? object : null;
}

function objectBounds(object: LevelObject): Bounds {
  if (isTerrainObject(object)) {
    const vertices = objectVertices(object);
    return {
      left: Math.min(...vertices.map((point) => point.x)), right: Math.max(...vertices.map((point) => point.x)),
      bottom: Math.min(...vertices.map((point) => point.y)), top: Math.max(...vertices.map((point) => point.y)),
    };
  }
  return objectGizmoBounds(object);
}

function anchorTrigger(object: TriggerObject, preset: TriggerPreset): TriggerObject {
  if (!preset.anchorBottom || object.region.type !== 'box') return object;
  return { ...object, y: object.y + object.region.height / 2 };
}

function triggerPlacement(preset: TriggerPreset, at: Point): TriggerObject {
  return anchorTrigger({
    kind: 'trigger', id: 'placement-preview', name: preset.name, x: at.x, y: at.y,
    region: preset.region, activation: preset.activation, marker: preset.marker,
    events: preset.events.map((action) => ({ ...action })),
  }, preset);
}

function numericField(id: string, label: string, min: number, max: number, step = 0.1): string {
  return `<label class="level-field" for="level-${id}">${label}
    <input id="level-${id}" type="number" min="${min}" max="${max}" step="${step}" inputmode="decimal" />
  </label>`;
}

function textField(id: string, label: string, maxlength: number): string {
  return `<label class="level-field" for="level-${id}">${label}
    <input id="level-${id}" type="text" maxlength="${maxlength}" />
  </label>`;
}

function selectField(id: string, label: string, options: readonly { value: string; label: string }[]): string {
  return `<label class="level-field" for="level-${id}">${label}
    <select id="level-${id}">${options.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}</select>
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
        <p class="level-help">Terrain shapes</p>
        <div class="level-palette" aria-label="Shape palette"></div>
        <p class="level-help">Start &amp; triggers</p>
        <div class="level-action-row">
          <button type="button" class="button" data-level-tool="start" aria-pressed="false">Start location</button>
          <button type="button" class="button level-go-start">View start</button>
        </div>
        <div class="level-entity-palette" aria-label="Trigger palette"></div>
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
        <div class="level-field-grid level-fields-common">
          ${numericField('x', 'Position X', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('y', 'Position Y', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
        </div>
        <div class="level-field-grid level-fields-angle">
          ${numericField('angle', 'Rotation / hammer angle (°)', -180, 180, 1)}
        </div>
        <div class="level-fields-terrain">
          <div class="level-field-grid">
            ${numericField('width', 'Width / diameter', LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize)}
            ${numericField('height', 'Height', LEVEL_LIMITS.minimumSize, LEVEL_LIMITS.maximumSize)}
            ${numericField('depth', 'Depth', LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth)}
          </div>
          <p class="level-help level-circle-help" hidden>Circle width is its diameter. Height is linked to width.</p>
          <label class="level-checkbox" for="level-illusion">
            <input id="level-illusion" type="checkbox" aria-describedby="level-illusion-help" /> Illusion
          </label>
          <p id="level-illusion-help" class="level-help">Only the player pot landing on top starts a
            ${ILLUSION.fadeSeconds}s fade. Then collision and visuals disappear. Hammer, side and underside
            contacts do not trigger it. Playtest resets disappeared objects; saved level data is unchanged.</p>
        </div>
        <div class="level-fields-start">
          <div class="level-field-grid">
            ${numericField('extension', 'Hammer extension', RIG.minExtension, RIG.maxExtension, 0.01)}
          </div>
          <p class="level-help">Position is the starting pot center. Rotation is the starting hammer angle.
            A level always has exactly one start; moving it here relocates it instead of creating another. Start
            is only the spawn pose — it cannot carry events. For an intro popup or video, place a normal trigger
            around the start position instead.</p>
        </div>
        <div class="level-fields-trigger">
          <div class="level-field-grid">
            ${textField('trigger-name', 'Name', LEVEL_LIMITS.text)}
            ${selectField('trigger-region', 'Region shape', [{ value: 'circle', label: 'Circle' }, { value: 'box', label: 'Box' }])}
          </div>
          <div class="level-field-grid level-trigger-circle-fields">
            ${numericField('trigger-radius', 'Radius', 0.1, TRIGGER_LIMITS.maximumSize / 2)}
          </div>
          <div class="level-field-grid level-trigger-box-fields">
            ${numericField('trigger-width', 'Width', 0.1, TRIGGER_LIMITS.maximumSize)}
            ${numericField('trigger-height', 'Height', 0.1, TRIGGER_LIMITS.maximumSize)}
          </div>
          <div class="level-field-grid">
            ${selectField('trigger-activation', 'Activation', [{ value: 'once', label: 'Once per run' }, { value: 'on-enter', label: 'Every entry' }])}
            ${selectField('trigger-marker', 'Marker', [{ value: 'none', label: 'None' }, { value: 'flag', label: 'Flag' }])}
          </div>
          <p class="level-help">Trigger regions are centered on Position X/Y and axis-aligned (no rotation).
            Proximity uses the player's foot position; "Once per run" fires a single time, "Every entry" fires
            again each time the player re-enters after leaving.</p>
          <p class="level-help level-trigger-preview-events" hidden></p>
          <div class="level-trigger-events"></div>
        </div>
        <button type="button" class="button level-delete">Delete selected object</button>
      </fieldset>
      <fieldset class="tuning-group level-labels">
        <legend>Course labels</legend>
        <p class="level-help level-label-count"></p>
        <button type="button" class="button level-clear-labels">Remove course labels</button>
      </fieldset>
      <div class="level-history"></div>
      <fieldset class="tuning-group level-files">
        <legend>Level JSON</legend>
        <div class="level-action-row">
          <button type="button" class="button level-export">Export level JSON</button>
          <button type="button" class="button level-import">Import level JSON</button>
        </div>
        <input class="level-file" type="file" accept=".json,application/json" aria-label="Import level JSON" hidden />
        <p class="level-help">Exports level.json: terrain, start, triggers and labels only.
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
    <g class="level-camera-group">
      <polygon class="level-selection" vector-effect="non-scaling-stroke" hidden />
      <polygon class="level-ghost" vector-effect="non-scaling-stroke" hidden />
    </g>
  </svg>`;
  // A canvas sibling stays below the host's interface stacking context, including its toolbar.
  options.canvas.insertAdjacentElement('afterend', overlay);
  const graphic = <T extends SVGElement>(selector: string): T => {
    const node = overlay.querySelector<T>(selector);
    if (node === null) throw new Error(`Missing level overlay element: ${selector}`);
    return node;
  };
  const svg = graphic<SVGSVGElement>('svg');
  const cameraGroup = graphic<SVGGElement>('.level-camera-group');
  const selectionPolygon = graphic<SVGPolygonElement>('.level-selection');
  const ghostPolygon = graphic<SVGPolygonElement>('.level-ghost');
  const entityGizmos = new EntityGizmos(cameraGroup);
  const inspector = element<HTMLFieldSetElement>(root, '.level-inspector');
  const input = (name: string) => element<HTMLInputElement>(root, `#level-${name}`);
  const select = (name: string) => element<HTMLSelectElement>(root, `#level-${name}`);
  const saveStatus = element<HTMLParagraphElement>(root, '.level-save-status');
  const importButton = element<HTMLButtonElement>(root, '.level-import');
  const fileInput = element<HTMLInputElement>(root, '.level-file');
  const bounds = new Map(level.definition().objects.map((object) => [object.id, objectBounds(object)]));
  entityGizmos.sync(level.definition().objects, []);
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  const triggerEvents = createTriggerEventEditor({
    mount: element(root, '.level-trigger-events'), signal: events.signal, onNotice,
    onApply: (id, actions) => {
      try {
        const target = level.object(id);
        if (target.kind !== 'trigger') return false;
        level.upsert({ ...target, events: actions });
        return true;
      } catch (error) {
        if (!(error instanceof LevelError)) throw error;
        report(error);
        return false;
      }
    },
  });
  let active = false;
  let disposed = false;
  let tool: Tool = 'select';
  let selectedId: string | null = null;
  let presetId: string | null = null;
  let placement: LevelObject | null = null;
  let gesture: Gesture | null = null;
  let savedDefinition = level.definition();
  let savedCamera: EditorCamera | null = null;
  let importGeneration = 0;
  let importing = false;
  let rect = options.canvas.getBoundingClientRect();
  let drawCount = 0;
  let commitCount = 0;
  let hitTestCount = 0;

  const dirty = () => level.definition() !== savedDefinition || triggerEvents.hasPendingDrafts();
  const selectedObject = () => selectedId === null ? null : level.object(selectedId);
  const inspectorObject = (): LevelObject | null =>
    (tool === 'place' || tool === 'place-trigger' || tool === 'start') ? placement : selectedObject();
  const pointFromEvent = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });
  const local = (point: Point): Point => {
    const client = camera.project(point);
    return { x: client.x - rect.left, y: client.y - rect.top };
  };
  const ghostObject = (): LevelObject | null => {
    if (gesture?.kind === 'move') return gesture.preview;
    if (tool === 'place' || tool === 'place-trigger' || tool === 'start') return placement;
    return null;
  };
  const handleRadius = (): number => HANDLE_PIXELS * camera.state().worldHeight / Math.max(1, rect.height);

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

  function commitOrPreview(next: LevelObject): void {
    if (tool === 'place' || tool === 'place-trigger' || tool === 'start') {
      placement = validateLevelObject(next);
      renderControls();
      draw();
    } else {
      level.upsert(next);
    }
  }

  function confirmReplacement(action: string): boolean {
    return !dirty() || window.confirm(`${action} replaces your unsaved level changes.
Save a named snapshot or export first if you want to keep them. Continue without saving?`);
  }

  function renderStatus(): void {
    const counts = level.counts();
    saveStatus.textContent = `${counts.terrain} / ${LEVEL_LIMITS.objects} terrain · ${counts.triggers} / ${TRIGGER_LIMITS.objects} triggers · ${
      importing ? 'Reading level file…' : dirty() ? 'Unsaved changes — save or export to keep them' : 'No unsaved changes'}`;
    saveStatus.dataset.dirty = String(dirty());
  }

  function renderControls(): void {
    const object = inspectorObject();
    const terrain = asTerrain(object);
    const start = asStart(object);
    const trigger = asTrigger(object);
    inspector.disabled = object === null;
    element(root, '.level-fields-common').hidden = object === null;
    element(root, '.level-fields-angle').hidden = trigger !== null || object === null;
    element(root, '.level-fields-terrain').hidden = terrain === null;
    element(root, '.level-fields-start').hidden = start === null;
    element(root, '.level-fields-trigger').hidden = trigger === null;

    element(root, '.level-selection-name').textContent =
      object === null ? 'Select an object, choose a shape, or place a start/trigger.' :
      tool === 'place' && terrain !== null ? `New ${terrain.shape.type} — click / tap the canvas to place` :
      tool === 'place-trigger' ? `New ${presetId === 'ending-trigger' ? 'ending trigger' : 'trigger'} — click / tap the canvas to place` :
      tool === 'start' ? 'Start location — click / tap the canvas to place' :
      terrain !== null ? `${terrain.shape.type} · ${terrain.id}` :
      start !== null ? `Start location · ${start.id}` :
      trigger !== null ? `Trigger "${trigger.name}" · ${trigger.id}` : '';

    if (object !== null) {
      const coordLimit = trigger !== null ? TRIGGER_LIMITS.coordinate : LEVEL_LIMITS.coordinate;
      input('x').max = String(coordLimit); input('x').min = String(-coordLimit);
      input('y').max = String(coordLimit); input('y').min = String(-coordLimit);
      input('x').value = String(Number(object.x.toFixed(4)));
      input('y').value = String(Number(object.y.toFixed(4)));
    } else {
      input('x').value = ''; input('y').value = '';
    }

    if (terrain !== null) {
      input('angle').value = String(Number((terrain.angle * DEGREES).toFixed(4)));
      input('width').value = String(Number(terrain.width.toFixed(4)));
      input('height').value = String(Number(terrain.height.toFixed(4)));
      input('depth').value = String(Number(terrain.depth.toFixed(4)));
      input('height').disabled = terrain.shape.type === 'circle';
      input('illusion').checked = terrain.illusion;
      element(root, '.level-circle-help').hidden = terrain.shape.type !== 'circle';
    } else if (start !== null) {
      input('angle').value = String(Number((start.angle * DEGREES).toFixed(4)));
      input('extension').value = String(Number(start.extension.toFixed(4)));
    } else if (trigger !== null) {
      input('trigger-name').value = trigger.name;
      select('trigger-region').value = trigger.region.type;
      select('trigger-activation').value = trigger.activation;
      select('trigger-marker').value = trigger.marker;
      const isCircle = trigger.region.type === 'circle';
      element(root, '.level-trigger-circle-fields').hidden = !isCircle;
      element(root, '.level-trigger-box-fields').hidden = isCircle;
      if (isCircle) input('trigger-radius').value = String(Number(trigger.region.radius.toFixed(4)));
      else {
        input('trigger-width').value = String(Number(trigger.region.width.toFixed(4)));
        input('trigger-height').value = String(Number(trigger.region.height.toFixed(4)));
      }
      const placing = tool === 'place-trigger';
      const previewNote = element(root, '.level-trigger-preview-events');
      previewNote.hidden = !placing;
      previewNote.textContent = placing ? `Default events: ${describeEvents(trigger.events)}. Edit after placing.` : '';
      element(root, '.level-trigger-events').hidden = placing;
      if (placing) triggerEvents.hide();
      else triggerEvents.show(trigger.id, trigger.events);
    } else {
      triggerEvents.hide();
    }

    const selected = selectedObject();
    element<HTMLButtonElement>(root, '.level-delete').disabled = selected === null || tool !== 'select' || selected.kind === 'start';
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.levelTool === tool));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-preset]')) {
      button.setAttribute('aria-pressed', String((tool === 'place' || tool === 'place-trigger') && button.dataset.levelPreset === presetId));
    }
    const help: Record<Tool, string> = {
      select: 'Click / tap to select; drag to move. Start and trigger objects select near their center handle. ' +
        'V selects, H pans. Escape cancels a drag without changing the level.',
      pan: 'Drag the canvas to pan anywhere in the course. Use + / − or the mouse wheel to zoom.',
      place: 'Click / tap to place this shape. Adjust its properties first if needed. Escape cancels placement.',
      'place-trigger': 'Click / tap to place this trigger. Escape cancels placement.',
      start: 'Click / tap the new pot-center position. Escape cancels.',
    };
    element(root, '.level-tool-help').textContent = help[tool];
    overlay.dataset.tool = tool;
    const { labels } = level.definition();
    element(root, '.level-label-count').textContent = `${labels.length} course labels. Edits, saves and exports preserve them unless you remove them.`;
    element<HTMLButtonElement>(root, '.level-clear-labels').disabled = labels.length === 0;
    renderStatus();
  }

  function drawPolygon(polygon: SVGPolygonElement, object: TerrainObject | null): void {
    polygon.toggleAttribute('hidden', object === null);
    if (object === null) return;
    polygon.setAttribute('points', objectVertices(object).map((point) => `${point.x},${point.y}`).join(' '));
    polygon.classList.toggle('level-illusion-outline', object.illusion);
  }

  function draw(): void {
    if (!active || disposed || rect.width <= 0 || rect.height <= 0) return;
    drawCount++;
    drawPolygon(selectionPolygon, asTerrain(selectedObject()));
    const ghost = ghostObject();
    drawPolygon(ghostPolygon, ghost !== null ? asTerrain(ghost) : null);
    entityGizmos.setSelection(asStart(selectedObject()) ?? asTrigger(selectedObject()));
    entityGizmos.setGhost(ghost !== null && !isTerrainObject(ghost) ? ghost : null);
  }

  function drawCamera(): void {
    if (!active || disposed) return;
    const origin = local({ x: 0, y: 0 });
    const unitX = local({ x: 1, y: 0 });
    const unitY = local({ x: 0, y: 1 });
    // A single matrix on the camera group repositions every world-space gizmo/polygon at once,
    // so panning and zooming never rebuild per-object geometry.
    cameraGroup.setAttribute('transform',
      `matrix(${unitX.x - origin.x} ${unitX.y - origin.y} ${unitY.x - origin.x} ${unitY.y - origin.y} ${origin.x} ${origin.y})`);
    const pixelsPerUnit = Math.hypot(unitX.x - origin.x, unitX.y - origin.y);
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
    draw();
  }

  function chooseTool(next: 'select' | 'pan' | 'start'): void {
    cancelGesture();
    tool = next;
    presetId = null;
    placement = next === 'start' ? { ...level.start() } : null;
    renderControls();
    draw();
  }

  function fitCourse(): void {
    cancelGesture();
    let combined: Bounds | null = null;
    for (const bound of bounds.values()) {
      combined = combined === null ? { ...bound } : {
        left: Math.min(combined.left, bound.left), right: Math.max(combined.right, bound.right),
        bottom: Math.min(combined.bottom, bound.bottom), top: Math.max(combined.top, bound.top),
      };
    }
    combined ??= { left: -1, right: 1, bottom: -1, top: 1 };
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
      if (!active || !triggerEvents.flush()) return null;
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
        kind: 'terrain', id: 'placement-preview', shape: preset.shape, x: view.x, y: view.y,
        width: preset.width, height: preset.height, angle: 0,
        depth: DEFAULT_OBJECT_DEPTH, color: ROCK_COLOR, illusion: false,
      };
      renderControls();
      draw();
    }, listen);
    element(root, '.level-palette').append(button);
  }

  for (const preset of TRIGGER_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-preset';
    button.dataset.levelPreset = preset.id;
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '-0.65 -0.65 1.3 1.3');
    icon.setAttribute('aria-hidden', 'true');
    const shape: SVGElement = document.createElementNS(SVG_NS, preset.region.type === 'circle' ? 'circle' : 'rect');
    if (preset.region.type === 'circle') shape.setAttribute('r', '0.4');
    else { shape.setAttribute('x', '-0.4'); shape.setAttribute('y', '-0.3'); shape.setAttribute('width', '0.8'); shape.setAttribute('height', '0.6'); }
    shape.setAttribute('fill', 'none'); shape.setAttribute('stroke', 'currentColor'); shape.setAttribute('stroke-width', '0.08');
    icon.append(shape);
    button.append(icon, document.createTextNode(preset.label));
    button.addEventListener('click', () => {
      if (!active) return;
      cancelGesture();
      const view = camera.state();
      tool = 'place-trigger'; presetId = preset.id; selectedId = null;
      placement = triggerPlacement(preset, view);
      renderControls();
      draw();
    }, listen);
    element(root, '.level-entity-palette').append(button);
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-tool]')) {
    button.addEventListener('click', () => {
      if (!active) return;
      const next = button.dataset.levelTool;
      if (next !== 'select' && next !== 'pan' && next !== 'start') throw new Error('Unknown level tool.');
      chooseTool(next);
    }, listen);
  }
  for (const name of ['x', 'y'] as const) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      const object = inspectorObject();
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(name).valueAsNumber }));
    }, listen);
  }
  input('angle').addEventListener('change', () => {
    if (!active) return;
    const object = inspectorObject();
    if (object === null || object.kind === 'trigger') return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, angle: input('angle').valueAsNumber / DEGREES }));
  }, listen);
  for (const name of ['width', 'height', 'depth'] as const) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      const object = asTerrain(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => {
        const value = input(name).valueAsNumber;
        const circle = object.shape.type === 'circle' && (name === 'width' || name === 'height');
        commitOrPreview({ ...object, [name]: value, ...(circle ? { width: value, height: value } : {}) });
      });
    }, listen);
  }
  input('illusion').addEventListener('change', () => {
    if (!active) return;
    const object = asTerrain(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, illusion: input('illusion').checked }));
  }, listen);
  input('extension').addEventListener('change', () => {
    if (!active) return;
    const object = asStart(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, extension: input('extension').valueAsNumber }));
  }, listen);
  input('trigger-name').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, name: input('trigger-name').value }));
  }, listen);
  select('trigger-region').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => {
      const type = select('trigger-region').value;
      const region: TriggerRegion = type === 'circle'
        ? { type: 'circle', radius: object.region.type === 'circle' ? object.region.radius : Math.max(object.region.width, object.region.height) / 2 }
        : {
          type: 'box',
          width: object.region.type === 'box' ? object.region.width : object.region.radius * 2,
          height: object.region.type === 'box' ? object.region.height : object.region.radius * 2,
        };
      commitOrPreview({ ...object, region });
    });
  }, listen);
  input('trigger-radius').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null || object.region.type !== 'circle') return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, region: { type: 'circle', radius: input('trigger-radius').valueAsNumber } }));
  }, listen);
  for (const name of ['trigger-width', 'trigger-height'] as const) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      const object = asTrigger(inspectorObject());
      if (object === null || object.region.type !== 'box') return;
      const region = object.region;
      cancelGesture();
      applyEdit(() => commitOrPreview({
        ...object, region: {
          type: 'box',
          width: name === 'trigger-width' ? input(name).valueAsNumber : region.width,
          height: name === 'trigger-height' ? input(name).valueAsNumber : region.height,
        },
      }));
    }, listen);
  }
  select('trigger-activation').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, activation: select('trigger-activation').value === 'on-enter' ? 'on-enter' : 'once' }));
  }, listen);
  select('trigger-marker').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, marker: select('trigger-marker').value === 'flag' ? 'flag' : 'none' }));
  }, listen);

  function action(selector: string, callback: () => void): void {
    element(root, selector).addEventListener('click', () => { if (active) callback(); }, listen);
  }
  function deleteSelected(): void {
    if (selectedId === null || tool !== 'select') return;
    const object = selectedObject();
    if (object === null || object.kind === 'start') return;
    cancelGesture();
    const id = selectedId;
    selectedId = null;
    level.remove(id);
  }
  action('.level-delete', deleteSelected);
  action('.level-play', () => { if (triggerEvents.flush()) { cancelGesture(); options.onPlay(); } });
  action('.level-fit', fitCourse);
  action('.level-zoom-in', () => zoom(1 / ZOOM_FACTOR));
  action('.level-zoom-out', () => zoom(ZOOM_FACTOR));
  action('.level-go-start', () => {
    cancelGesture();
    const { x, y } = level.start();
    setCamera({ ...camera.state(), x, y });
  });
  action('.level-clear-labels', () => {
    const { labels } = level.definition();
    if (labels.length === 0 || !window.confirm(`Remove all ${labels.length} course labels? Saved snapshots are not changed.`)) return;
    level.metadata({ labels: [] });
  });
  action('.level-new', () => {
    if (!window.confirm(`Start a new level? ${dirty() ? 'Your unsaved changes will be discarded. Save or export first to keep them. ' : ''}
This restores the default ground and start location, removes all other objects and labels. Saved snapshots are kept.`)) return;
    const ground = DEFAULT_LEVEL.objects.find((object) => object.kind === 'terrain' && object.id === 'ground');
    const start = DEFAULT_LEVEL.objects.find((object) => object.kind === 'start');
    if (ground === undefined || start === undefined) throw new Error('The starter level needs its authored ground and start.');
    resetSelection();
    level.replace({ schemaVersion: 2, labels: [], objects: [ground, start] });
    fitCourse();
    onNotice('New level started. Add terrain and place an ending trigger, then save or export before leaving.', 'info');
  });
  action('.level-export', () => {
    if (!triggerEvents.flush()) return;
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
    const radius = handleRadius();
    // Start/trigger handles are picked first by proximity to their small center dot so a large
    // (often invisible-in-play) trigger region never blocks selecting terrain underneath it.
    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index];
      if (!isTerrainObject(object) && Math.hypot(world.x - object.x, world.y - object.y) <= radius) return object;
    }
    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index];
      if (!isTerrainObject(object)) continue;
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
    } else if (tool === 'place-trigger' && placement !== null && placement.kind === 'trigger') {
      const preset = TRIGGER_PRESETS.find((candidate) => candidate.id === presetId) ?? null;
      const moved = { ...placement, x: world.x, y: world.y };
      placement = preset === null ? moved : anchorTrigger(moved, preset);
      if (gesture?.kind === 'place-trigger') gesture.world = world;
    } else if (tool === 'start' && placement !== null && placement.kind === 'start') {
      placement = { ...placement, x: world.x, y: world.y };
      if (gesture?.kind === 'start') gesture.world = world;
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
    if (gesture === null && tool !== 'place' && tool !== 'place-trigger' && tool !== 'start') return;
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
      } else if (finished.kind === 'place-trigger' && inside && placement !== null) {
        const object = { ...placement, id: `trigger-${crypto.randomUUID()}` };
        level.upsert(object);
        selectedId = object.id;
        chooseTool('select');
      } else if (finished.kind === 'start' && inside && placement !== null) {
        level.upsert(placement);
        selectedId = placement.id;
        chooseTool('select');
      }
    });
    renderControls(); draw();
  }, listen);
  const cancelPointer = (event: PointerEvent): void => {
    if (gesture?.pointerId === event.pointerId) cancelGesture();
  };
  overlay.addEventListener('pointercancel', cancelPointer, listen);
  overlay.addEventListener('lostpointercapture', cancelPointer, listen);
  overlay.addEventListener('pointerleave', () => {
    if (gesture === null) draw();
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
    for (const id of change.remove) { bounds.delete(id); triggerEvents.forget(id); }
    for (const object of change.upsert) bounds.set(object.id, objectBounds(object));
    entityGizmos.sync(change.upsert, change.remove);
    if (change.kind === 'replace') triggerEvents.clear();
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
      const ghost = ghostObject();
      return Object.freeze({
        mode: active ? 'edit' as const : 'inactive' as const,
        tool, selectedId, selected: object, preset: presetId,
        preview: ghost === null ? null : Object.freeze({ ...ghost }),
        dragging: gesture?.kind ?? null, capturedPointer: gesture?.pointerId ?? null,
        dirty: dirty(), importing, objectCount: current.objects.length,
        start: level.start(), counts: level.counts(), labelCount: current.labels.length,
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
      entityGizmos.destroy();
      root.remove(); overlay.remove();
    },
  };
}
