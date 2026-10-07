import type { Point } from '../config';
import { STARTER_LEVEL } from '../default-course';
import { ENEMY_BEHAVIOR, ENEMY_FACINGS, ENEMY_FIELDS, ENEMY_LIMITS, ENEMY_SPECIES, ENEMY_SPECS } from '../enemy-types';
import type { EnemySpecies } from '../enemy-types';
import {
  DECORATION_LIMITS, ILLUSION, isDecorationObject, isTerrainObject, isTriggerObject, LEVEL_LIMITS, LevelError,
  meshIsCircle, PLATFORM_LIMITS, ROCK_COLOR, SHAPE_KINDS, objectContains, objectLoops, shapeMesh, shapeOutline, terrainFromOutline, TRIGGER_LIMITS,
  TRIGGER_MARKERS, validateLevel, validateLevelObject,
} from '../level';
import type {
  AxeObject, BonfireObject, DecorationObject, EnemyObject, LevelDefinition, LevelLabel, LevelObject, PlatformObject, PoolObject, ShapeKind,
  ShooterObject, StartObject, TerrainMesh, TerrainObject, TriggerObject, TriggerRegion,
} from '../level';
import { AXE, AXE_FIELDS, BONFIRE, HAZARD_LIMITS, SHOOTER, SHOOTER_FIELDS } from '../hazards';
import { LIQUID_LABELS, LIQUID_LIMITS, LIQUIDS } from '../liquids';
import type { Liquid } from '../liquids';
import type { MeshTerrain } from '../mesh-collision';
import { builtInDecoration, builtInGeometry, DECORATION_CATEGORIES, DECORATION_MODELS } from '../decoration-models';
import type { DecorationCategory, DecorationModel } from '../decoration-models';
import { decorationThumbnail } from './decoration-thumbnail';
import { MAX_RIG_REACH } from '../rig';
import { DEFAULT_SURFACE, isSurface, SURFACE_LABELS, SURFACES } from '../surfaces';
import { ENDING_EVENTS, UPDRAFT_EVENTS } from '../trigger-events';
import type { TriggerAction } from '../trigger-events';
import { element, setText } from '../dom';
import { BOARD_CELL, boardLeft, boardSquareAt, boardSquareBounds, boardSquareName, parseBoardSquare } from '../level-board';
import type { BoardSquare } from '../level-board';
import { LevelBoardView, niceStep } from './level-board-view';
import type { BoardViewport } from './level-board-view';
import { createJsonDownload } from './json-download';
import type { EditorCamera, LevelEditorOptions } from './level-editor-host';
import { EntityGizmos, enemyGlyph, objectGizmoBounds, triggerLinkHandle, updraftGlyph } from './object-gizmos';
import { deriveConnectionLinks } from './connection-links';
import type { ConnectionLink, ConnectionLinks, ConnectionTarget } from './connection-links';
import { createSetPieceGhost, createSetPieceThumbnail, loopsPath } from './set-piece-view';
import { placeSetPiece, SET_PIECE_CATALOG, SET_PIECE_CATEGORIES, SET_PIECES, setPieceById } from './set-pieces';
import type { SetPiece, SetPieceCategory, SetPieceCounts } from './set-pieces';
import { SurfaceIndex } from './surface-snap';
import { createProjectSaveButton } from './project-save';
import { createReplayViewer } from './replay-viewer';
import { downloadServerLevel } from './server-levels';
import { createTriggerEventEditor, describeEvents } from './trigger-inspector';
import { DRAWING, PolygonDraft } from './polygon-draft';
import { sectionMarkup } from './workshop-section';
import './level-editor.css';

export type { LevelEditorOptions } from './level-editor-host';

// 'player' moves the live player without editing the level; it previews in the start's pose.
type PlacementTool = 'place' | 'place-trigger' | 'place-enemy' | 'place-hazard' | 'place-set-piece' | 'place-decoration' | 'start' | 'player';
// 'decorate' selects and moves decorations; 'select' never picks them, so scenery cannot get in the way of the course.
type Tool = 'select' | 'decorate' | 'draw' | PlacementTool;
interface Bounds { left: number; right: number; bottom: number; top: number }
interface TerrainPreset { id: string; label: string; shape: ShapeKind; width: number; height: number }
interface TriggerPreset {
  id: string; label: string; name: string; region: TriggerRegion;
  activation: TriggerObject['activation']; marker: TriggerObject['marker'];
  events: readonly TriggerAction[]; anchorBottom: boolean;
}
type Gesture =
  // `selected` is the selection the press replaced, restored if a second finger turns the press into a pinch.
  | { kind: 'move'; pointerId: number; start: Point; world: Point; original: LevelObject; preview: LevelObject; selected: string | null }
  | { kind: 'platform-end'; pointerId: number; start: Point; original: PlatformObject; preview: PlatformObject; selected: string | null }
  | { kind: 'connect'; pointerId: number; trigger: TriggerObject; world: Point; target: ConnectionTarget | null }
  // Drags the view: with the middle button from anywhere, or from empty space while selecting, where a click that never
  // moved selects nothing instead.
  | { kind: 'pan'; pointerId: number; start: Point; last: Point; camera: EditorCamera; unitsPerPixel: number; moved: boolean; deselects: boolean }
  // Two fingers: their midpoint pans the view and their spread zooms it about where they first touched.
  | { kind: 'pinch'; pointerId: number; other: number; starts: readonly [Point, Point]; anchor: Point; camera: EditorCamera }
  | { kind: 'draw'; pointerId: number; start: Point; samples: Point[]; unitsPerPixel: number }
  | { kind: PlacementTool; pointerId: number };

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
const DEFAULT_OBJECT_DEPTH = 1.5;
const WHEEL_LINE_PIXELS = 16;
/** Vertical pointer distance within which a set piece rests on the terrain top below or above it. */
const SNAP_PIXELS = 28;
const SET_PIECE_HISTORY = 64;
/** Decorations nearer the course than this rest on terrain tops while being placed. */
const DECORATION_SNAP_DEPTH = 20;
const PRESET_SETTINGS: Record<ShapeKind, { label: string; width: number; height: number }> = {
  box: { label: 'Block', width: 2.5, height: 2 },
  ramp: { label: 'Ramp', width: 3, height: 2 },
  triangle: { label: 'Triangle', width: 2.5, height: 2.5 },
  circle: { label: 'Circle', width: 2.5, height: 2.5 },
  hexagon: { label: 'Hexagon', width: 2.5, height: 2.5 },
};
const PRESETS: readonly TerrainPreset[] = SHAPE_KINDS.flatMap((type): TerrainPreset[] => {
  const preset = { id: type, shape: type, ...PRESET_SETTINGS[type] };
  return type === 'box'
    ? [preset, { id: 'platform', label: 'Platform', shape: type, width: 4, height: 0.4 }]
    : [preset];
});
const TRIGGER_MARKER_LABELS: Readonly<Record<(typeof TRIGGER_MARKERS)[number], string>> = {
  none: 'None',
  flag: 'Flag',
  updraft: 'Updraft',
  switch: 'Pressure switch',
};
const TRIGGER_PRESETS: readonly TriggerPreset[] = [
  {
    id: 'trigger', label: 'Trigger', name: 'Trigger', anchorBottom: false,
    region: { type: 'circle', radius: 1.5 }, activation: 'once', marker: 'none',
    events: [{ type: 'message', title: 'Event', message: 'Describe what happens here.' }],
  },
  {
    id: 'ending-trigger', label: 'Ending trigger', name: 'Ending', anchorBottom: true,
    region: { type: 'box', width: 3, height: TRIGGER_LIMITS.endingHeight }, activation: 'once', marker: 'flag',
    events: ENDING_EVENTS,
  },
  {
    id: 'updraft', label: 'Updraft', name: 'Updraft', anchorBottom: true,
    region: { type: 'box', width: 2, height: 1.4 }, activation: 'on-enter', marker: 'updraft',
    events: UPDRAFT_EVENTS,
  },
  {
    id: 'switch', label: 'Pressure switch', name: 'Pressure switch', anchorBottom: true,
    region: { type: 'box', width: 1.2, height: 0.5 }, activation: 'on-enter', marker: 'switch',
    events: [],
  },
];

const MESH_PRESET = 'mesh:';
// A mesh with no outline to show until its GLB is read.
const MESH_ICON = '<svg viewBox="-0.65 -0.65 1.3 1.3" aria-hidden="true"><path d="M-0.5 0.3 L-0.1 -0.45 L0.5 -0.2 L0.35 0.45 L-0.2 0.5 Z" ' +
  'fill="none" stroke="currentColor" stroke-width="0.08" stroke-linejoin="round" /><path d="M-0.1 -0.45 L0 0.05 L0.35 0.45 M0 0.05 ' +
  'L-0.5 0.3" fill="none" stroke="currentColor" stroke-width="0.06" /></svg>';

const tidySize = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number(value.toFixed(4))));

// A mesh placed at its own size, scaled as a whole into the level's size limits when it is too large or too small.
function meshPlacement(mesh: TerrainMesh, size: Pick<MeshTerrain, 'width' | 'height' | 'depth'>, at: Point): TerrainObject {
  const { minimumSize, maximumSize, minimumDepth, maximumDepth } = LEVEL_LIMITS;
  const shrink = Math.min(1, maximumSize / Math.max(size.width, size.height), maximumDepth / size.depth);
  const grow = Math.max(1, minimumSize / Math.min(size.width, size.height), minimumDepth / size.depth);
  const scale = shrink < 1 ? shrink : grow;
  let width = tidySize(size.width * scale, minimumSize, maximumSize);
  let height = tidySize(size.height * scale, minimumSize, maximumSize);
  // A circle's box is square.
  if (meshIsCircle(mesh)) width = height = Math.max(width, height);
  return {
    kind: 'terrain', id: 'placement-preview', mesh, x: at.x, y: at.y, width, height, angle: 0, mirror: false,
    depth: tidySize(size.depth * scale, minimumDepth, maximumDepth), color: ROCK_COLOR, illusion: false, surface: DEFAULT_SURFACE,
  };
}

// How a terrain object collides, for the inspector.
function collisionNote(mesh: TerrainMesh): string {
  if (mesh.type === 'shape') return 'Collides as its shape.';
  if (mesh.type === 'outline') return 'Collides as its drawn outline.';
  if (mesh.collision.type !== 'slice') return `Collides as the ${mesh.collision.type} its GLB declares, fitted to its box.`;
  const { loops } = mesh.collision;
  return `Collides as its slice on the obstacle line: ${loops.length} outline${loops.length === 1 ? '' : 's'}, ` +
    `${loops.reduce((sum, loop) => sum + loop.length, 0)} points.`;
}

function asTerrain(object: LevelObject | null): TerrainObject | null {
  return object !== null && isTerrainObject(object) ? object : null;
}
function asStart(object: LevelObject | null): StartObject | null {
  return object !== null && object.kind === 'start' ? object : null;
}
function asTrigger(object: LevelObject | null): TriggerObject | null {
  return object !== null && isTriggerObject(object) ? object : null;
}
function asEnemy(object: LevelObject | null): EnemyObject | null {
  return object !== null && object.kind === 'enemy' ? object : null;
}
function asDecoration(object: LevelObject | null): DecorationObject | null {
  return object !== null && object.kind === 'decoration' ? object : null;
}
function asBonfire(object: LevelObject | null): BonfireObject | null {
  return object !== null && object.kind === 'bonfire' ? object : null;
}
function asShooter(object: LevelObject | null): ShooterObject | null {
  return object !== null && object.kind === 'shooter' ? object : null;
}
function asAxe(object: LevelObject | null): AxeObject | null {
  return object !== null && object.kind === 'axe' ? object : null;
}
function asPool(object: LevelObject | null): PoolObject | null {
  return object !== null && object.kind === 'pool' ? object : null;
}
function asPlatform(object: LevelObject | null): PlatformObject | null {
  return object !== null && object.kind === 'platform' ? object : null;
}

function isPlacementTool(tool: Tool): tool is PlacementTool {
  return tool === 'place' || tool === 'place-trigger' || tool === 'place-enemy' || tool === 'place-hazard' || tool === 'place-set-piece' ||
    tool === 'place-decoration' || tool === 'start' || tool === 'player';
}

// Bonfires, traps, liquid pools and elevator platforms: objects the palette places whole, each by its anchor.
type HazardObject = BonfireObject | ShooterObject | AxeObject | PoolObject | PlatformObject;
interface HazardPreset {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  // What it counts toward, and that count's limit.
  readonly tally: 'bonfires' | 'traps' | 'pools' | 'platforms';
  readonly limit: number;
  readonly create: (at: Point) => HazardObject;
}

const PREVIEW_ID = 'placement-preview';
const POOL_ICONS: Readonly<Record<Liquid, string>> = {
  lava: '<path d="M-0.56 -0.02 Q-0.37 -0.18 -0.19 -0.02 T0.19 -0.02 T0.56 -0.02 L0.56 0.5 L-0.56 0.5 Z" fill="currentColor" />' +
    '<circle cx="-0.12" cy="-0.34" r="0.07" fill="currentColor" /><circle cx="0.22" cy="-0.5" r="0.05" fill="currentColor" />',
  swamp: '<path d="M-0.56 0.02 Q-0.37 -0.1 -0.19 0.02 T0.19 0.02 T0.56 0.02 L0.56 0.5 L-0.56 0.5 Z" fill="currentColor" opacity="0.55" />' +
    '<path d="M0.3 0.02 L0.26 -0.5 M0.42 0.02 L0.48 -0.38" fill="none" stroke="currentColor" stroke-width="0.07" stroke-linecap="round" />',
};
const HAZARD_PRESETS: readonly HazardPreset[] = [
  {
    id: 'bonfire', label: 'Bonfire', tally: 'bonfires', limit: HAZARD_LIMITS.bonfires,
    icon: '<path d="M0 -0.52 C0.3 -0.25 0.3 0.05 0 0.22 C-0.3 0.05 -0.3 -0.25 0 -0.52 Z" fill="currentColor" />' +
      '<path d="M-0.45 0.48 L0.45 0.28 M-0.45 0.28 L0.45 0.48" fill="none" stroke="currentColor" stroke-width="0.09" stroke-linecap="round" />',
    create: (at) => ({ kind: 'bonfire', id: PREVIEW_ID, x: at.x, y: at.y }),
  },
  {
    id: 'shooter', label: 'Projectile trap', tally: 'traps', limit: HAZARD_LIMITS.traps,
    icon: '<rect x="-0.56" y="-0.26" width="0.44" height="0.52" fill="none" stroke="currentColor" stroke-width="0.08" />' +
      '<path d="M-0.04 0 L0.52 0 M0.33 -0.16 L0.52 0 L0.33 0.16" fill="none" stroke="currentColor" stroke-width="0.08" ' +
      'stroke-linecap="round" stroke-linejoin="round" />',
    create: (at) => ({ kind: 'shooter', id: PREVIEW_ID, firing: 'timer', x: at.x, y: at.y, angle: 0, interval: 2, delay: 0, speed: 12, damage: 1 }),
  },
  {
    id: 'axe', label: 'Swinging axe', tally: 'traps', limit: HAZARD_LIMITS.traps,
    icon: '<circle cy="-0.48" r="0.08" fill="currentColor" /><path d="M0 -0.44 L0 0.2" stroke="currentColor" stroke-width="0.08" />' +
      '<path d="M-0.44 0.14 Q0 0.32 0.44 0.14 Q0.3 0.52 0 0.56 Q-0.3 0.52 -0.44 0.14 Z" fill="currentColor" />',
    create: (at) => ({ kind: 'axe', id: PREVIEW_ID, x: at.x, y: at.y, length: 4, period: 3, offset: 0, damage: 2 }),
  },
  ...LIQUIDS.map((liquid): HazardPreset => ({
    id: liquid, label: `${LIQUID_LABELS[liquid]} pool`, tally: 'pools', limit: LIQUID_LIMITS.pools, icon: POOL_ICONS[liquid],
    create: (at) => ({ kind: 'pool', id: PREVIEW_ID, liquid, x: at.x, y: at.y, width: 6, height: 2, depth: 2 }),
  })),
  {
    id: 'platform', label: 'Elevator platform', tally: 'platforms', limit: PLATFORM_LIMITS.objects,
    icon: '<rect x="-0.5" y="-0.08" width="1" height="0.16" fill="currentColor" />' +
      '<path d="M0 -0.5 L0 0.5 M-0.16 -0.34 L0 -0.5 L0.16 -0.34 M-0.16 0.34 L0 0.5 L0.16 0.34" ' +
      'fill="none" stroke="currentColor" stroke-width="0.08" stroke-linecap="round" stroke-linejoin="round" />',
    create: (at) => ({
      kind: 'platform', id: PREVIEW_ID, x: at.x, y: at.y, ride: true, travelX: 0, travelY: 4,
      width: 3, height: 0.4, depth: 2, speed: 1.5, surface: 'metal',
    }),
  },
];

function isHazard(object: LevelObject): object is HazardObject {
  return object.kind === 'bonfire' || object.kind === 'shooter' || object.kind === 'axe' || object.kind === 'pool' || object.kind === 'platform';
}

// The palette entry an object comes from: its liquid's for a pool, its kind's otherwise.
function hazardPresetId(object: HazardObject): string {
  return object.kind === 'pool' ? object.liquid : object.kind;
}

function hazardName(object: HazardObject): string {
  const id = hazardPresetId(object);
  return HAZARD_PRESETS.find((preset) => preset.id === id)?.label ?? id;
}

// A numeric field's label with its unit, if it has one.
function fieldLabel(field: { readonly label: string; readonly unit: string }): string {
  return field.unit === '' ? field.label : `${field.label} (${field.unit})`;
}

// Decorations are placed by their base anchor; their size on screen depends on depth and the camera.
function objectBounds(object: LevelObject): Bounds {
  if (object.kind === 'decoration') return { left: object.x, right: object.x, bottom: object.y, top: object.y };
  if (isTerrainObject(object)) {
    const points = objectLoops(object).flat();
    return {
      left: Math.min(...points.map((point) => point.x)), right: Math.max(...points.map((point) => point.x)),
      bottom: Math.min(...points.map((point) => point.y)), top: Math.max(...points.map((point) => point.y)),
    };
  }
  return objectGizmoBounds(object);
}

function boundsContain(bounds: Bounds, point: Point): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.bottom && point.y <= bounds.top;
}

const BOARD_KEY = 'over-the-edge:level-board:v1';
const LINKS_KEY = 'over-the-edge:level-links:v1';

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function leastOf(values: Iterable<number>): number | null {
  let least: number | null = null;
  for (const value of values) if (least === null || value < least) least = value;
  return least;
}

// Whether the level board shows; it does until the designer hides it.
function readBoardShown(): boolean {
  try {
    return localStorage.getItem(BOARD_KEY) !== 'hidden';
  } catch (error) {
    if (error instanceof DOMException) return true;
    throw error;
  }
}

function readLinksShown(): boolean {
  try {
    return localStorage.getItem(LINKS_KEY) === 'shown';
  } catch (error) {
    if (error instanceof DOMException) return false;
    throw error;
  }
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

// How each species behaves, shown in the enemy inspector.
const ENEMY_HELP: Readonly<Record<EnemySpecies, string>> = {
  bird: 'Birds patrol, warn, then dive toward nearby players.',
  'hollow-soldier': 'Hollow soldiers patrol their configured range, turning at terrain obstacles and edges.',
  'hollow-archer': 'Hollow archers hold their post, or walk a patrol radius as soldiers do. Within Physics / Enemies archer ' +
    'sight they warn as they draw, then shoot arrows that arc under gravity, low or else high, only along an arc clear of terrain.',
};

function anchorEnemy(object: EnemyObject): EnemyObject {
  return { ...object, y: object.y + ENEMY_SPECS[object.species].height / 2 };
}

function enemyPlacement(species: EnemySpecies, at: Point): EnemyObject {
  const spec = ENEMY_SPECS[species];
  return anchorEnemy({
    kind: 'enemy', id: 'placement-preview', species, x: at.x, y: at.y,
    facing: 'right', patrolDistance: spec.patrolDistance, speed: spec.speed,
  });
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
      <p class="level-help level-player-note" hidden>Playtests start where you placed the player.
        <button type="button" class="button level-player-clear">Use the level start</button></p>
      <div class="level-save-dock"></div>
      <p class="level-save-status" role="status" aria-live="polite"></p>
      <p class="level-board-readout"></p>
    </div>
    <div class="workshop-scroll level-scroll">
      <fieldset class="tuning-group level-tools">
        <legend class="visually-hidden">Build the course</legend>
        <div class="level-action-row">
          <button type="button" class="button" data-level-tool="decorate" aria-pressed="false">Select decorations</button>
          <button type="button" class="button" data-level-tool="player" aria-pressed="false">Place player</button>
        </div>
        <div class="level-camera-controls" aria-label="Editor camera">
          <button type="button" class="button level-zoom-out" aria-label="Zoom out">−</button>
          <button type="button" class="button level-zoom-in" aria-label="Zoom in">+</button>
          <button type="button" class="button level-fit">Fit course</button>
          <button type="button" class="button level-go-start">View start</button>
        </div>
        <form class="level-board-controls" aria-label="Level board">
          <button type="button" class="button level-board-toggle" aria-pressed="true"
            title="Name 10 m squares like a chessboard: columns A, B… from the left, rows 1, 2… up from the ground">Board</button>
          <button type="button" class="button level-links-toggle" aria-pressed="false"
            title="Show all trigger connections; the selected object's links are emphasised">Links</button>
          <input id="level-board-square" type="text" maxlength="8" placeholder="Square, e.g. D7" aria-label="Board square to go to"
            autocomplete="off" spellcheck="false" />
          <button type="submit" class="button">Go to</button>
        </form>
        <p class="level-help level-palette-label">Terrain</p>
        <div class="level-palette" aria-label="Shape palette">
          <button type="button" class="button level-preset level-draw-tool" data-level-tool="draw" aria-pressed="false">
            <svg viewBox="-0.65 -0.65 1.3 1.3" aria-hidden="true"><polyline points="-0.5,0.4 -0.2,-0.35 0.15,0.15 0.5,-0.45"
              fill="none" stroke="currentColor" stroke-width="0.09" stroke-linecap="round" stroke-linejoin="round" /></svg>Draw shape
          </button>
        </div>
        <div class="level-drawing-controls" hidden>
          <p class="level-help level-drawing-status" role="status" aria-live="polite"></p>
          <div class="level-drawing-actions">
            <button type="button" class="button button-primary level-drawing-finish">Finish shape</button>
            <button type="button" class="button level-drawing-undo">Undo point / stroke</button>
            <button type="button" class="button level-drawing-cancel">Cancel outline</button>
          </div>
        </div>
        <p class="level-help level-palette-label">Meshes</p>
        <div class="level-palette level-mesh-palette" aria-label="Course meshes"></div>
        <div class="level-action-row">
          <button type="button" class="button level-mesh-import">Import GLB mesh</button>
        </div>
        <input class="level-mesh-file" type="file" accept=".glb,model/gltf-binary" aria-label="Import a GLB mesh" hidden />
        <p class="level-help">Any GLB places as terrain at its own size. It collides as the shape it declares
          (extras.collision on its scene or a root node: box, ramp, triangle, circle or hexagon), or else as its slice
          where it meets the obstacle line, the middle of its depth. Imported meshes join Project / Course artwork.</p>
        <p class="level-help level-palette-label">Start, triggers &amp; enemies</p>
        <div class="level-entity-palette" aria-label="Start and trigger palette">
          <button type="button" class="button level-preset" data-level-tool="start" aria-pressed="false">
            <svg viewBox="-0.65 -0.65 1.3 1.3" aria-hidden="true"><circle cx="-0.12" cy="0.18" r="0.3" fill="none"
              stroke="currentColor" stroke-width="0.08" /><path d="M0.08 -0.02 L0.5 -0.45" fill="none" stroke="currentColor"
              stroke-width="0.08" stroke-linecap="round" /></svg>Start location
          </button>
        </div>
        <div class="level-enemy-palette" aria-label="Enemy palette"></div>
        <p class="level-help level-palette-label">Bonfires, traps &amp; liquids</p>
        <div class="level-hazard-palette" aria-label="Bonfire, trap and liquid palette"></div>
        <p class="level-help level-tool-help"></p>
      </fieldset>
      ${sectionMarkup({ id: 'level-inspector', title: 'Object properties', hint: 'The selected or new object', open: true }, `
      <fieldset class="tuning-group level-inspector">
        <legend class="visually-hidden">Object properties</legend>
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
          <label class="level-checkbox" for="level-terrain-mirror">
            <input id="level-terrain-mirror" type="checkbox" /> Mirror left / right (M)
          </label>
          <p class="level-help level-terrain-collision"></p>
          ${selectField('surface', 'Surface', SURFACES.map((surface) => ({ value: surface, label: SURFACE_LABELS[surface] })))}
          <p class="level-help">What it is made of. Each surface's friction and bounciness are set once for the game in
            Physics / Materials; a contact bounces as much as the bouncier of its two sides.</p>
          <label class="level-checkbox" for="level-illusion">
            <input id="level-illusion" type="checkbox" aria-describedby="level-illusion-help" /> Illusion
          </label>
          <p id="level-illusion-help" class="level-help">Only the player pot landing on top starts a
            ${ILLUSION.fadeSeconds}s fade. Then collision and visuals disappear. Hammer, side and underside
            contacts do not trigger it. Playtest resets disappeared objects; saved level data is unchanged.</p>
        </div>
        <div class="level-fields-start">
          <div class="level-field-grid">
            ${numericField('reach', 'Hammer reach', 0, MAX_RIG_REACH, 0.01)}
          </div>
          <p class="level-help">Position is the starting pot center. Rotation is the starting hammer angle.
            Reach is the head's distance from the shoulder hinge, so the start pose is the same whatever the
            game's handle length; a hammer that cannot reach that far starts fully extended.
            A level always has exactly one start; moving it here relocates it instead of creating another. Start
            is only the spawn pose — it cannot carry events. For an intro message or video, place a normal trigger
            around the start position instead.</p>
        </div>
        <div class="level-fields-enemy">
          <div class="level-field-grid">
            ${selectField('enemy-facing', 'Facing', ENEMY_FACINGS.map((facing) => ({
              value: facing, label: facing[0].toUpperCase() + facing.slice(1),
            })))}
            ${Object.entries(ENEMY_FIELDS).map(([name, field]) =>
              numericField(`enemy-${name}`, field.label, field.min, field.max, field.step)).join('')}
          </div>
          <p class="level-help level-enemy-help"></p>
          <p class="level-help">Position X/Y is the authored center/home; placement uses the clicked base.
            The guide shows the patrol radius on either side. Body collisions knock the player back and cost
            the configured bump damage (Physics / Enemies). Dead enemies return on Reset or an editor rebuild,
            including entering Level mode.
            Patrol motion and deaths never change saved positions.</p>
        </div>
        <div class="level-fields-bonfire">
          <p class="level-help">Position is the centre of its base; placing it rests the base on the terrain top under the
            pointer. It lights when the player's foot comes within ${BONFIRE.reach} m of the base, the dashed circle. A
            death, from health running out or a fall out of the level, brings the player back at the bonfire reached
            last, healed and protected for Physics / Health's Respawn invulnerability; the run, its clock and the level go on. Before
            any bonfire, a death restarts the run. Bonfires never collide.</p>
        </div>
        <div class="level-fields-shooter">
          <div class="level-field-grid">
            ${selectField('shooter-firing', 'Fires', [
              { value: 'timer', label: 'On its timer' },
              { value: 'trigger', label: 'Only when triggered' },
            ])}
            ${Object.entries(SHOOTER_FIELDS).map(([name, field]) =>
              numericField(`shooter-${name}`, fieldLabel(field), field.min, field.max, field.step)).join('')}
          </div>
          <p class="level-help">Position is the muzzle; Rotation is the direction it fires. Timer traps fire at First shot
            and every Shot interval after, in run time, while the player is within ${SHOOTER.range} m; triggered traps
            fire only bursts that trigger events start, using First shot as the delay after the switch and Shot interval
            between shots. Projectiles fly straight up to ${SHOOTER.range} m; terrain, platforms and the hammer head stop them, so the hammer is a shield.
            Set the muzzle into a wall's face to shoot out of it. A hit costs its damage and knocks the player along
            the shot. The trap never collides. Select it to see its incoming trigger links; Links shows every connection.</p>
        </div>
        <div class="level-fields-axe">
          <div class="level-field-grid">
            ${Object.entries(AXE_FIELDS).map(([name, field]) =>
              numericField(`axe-${name}`, fieldLabel(field), field.min, field.max, field.step)).join('')}
          </div>
          <p class="level-help">Position is the pivot. The blade hangs Length below it, edge-on to the camera with its curved
            edge below, and swings in and out of the view edge first, toward the camera and away, up to
            ${Math.round(AXE.amplitude * DEGREES)}° either side. It cuts through the play line, where the box shows it,
            at Swing offset and every half period after; there a blade that meets the
            player costs its damage and knocks the player away from it. Stagger neighbours with the offset. The axe
            never collides.</p>
        </div>
        <div class="level-fields-pool">
          <div class="level-field-grid">
            ${selectField('pool-liquid', 'Liquid', LIQUIDS.map((liquid) => ({ value: liquid, label: LIQUID_LABELS[liquid] })))}
            ${numericField('pool-width', 'Width', LIQUID_LIMITS.minimumSize, LIQUID_LIMITS.maximumSize)}
            ${numericField('pool-height', 'Height', LIQUID_LIMITS.minimumSize, LIQUID_LIMITS.maximumSize)}
            ${numericField('pool-depth', 'Depth', LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth)}
          </div>
          <p class="level-help">Position is the centre of the pool's box; its top is the liquid's surface, and placing it
            puts the surface at the pointer. The liquid never collides: fit the box into a basin of terrain, which holds
            the player up where the pool ends. Lava holds the player up and burns the character each second the pot is
            in it; swamp lets the player sink and holds it back. Physics / Liquids sets how much. The half in front of
            the play line draws over the player, so whatever is in the pool looks in it.</p>
        </div>
        <div class="level-fields-platform">
          <div class="level-field-grid">
            ${numericField('platform-travelX', 'Travel X (m)', -PLATFORM_LIMITS.maximumTravel, PLATFORM_LIMITS.maximumTravel)}
            ${numericField('platform-travelY', 'Travel Y (m)', -PLATFORM_LIMITS.maximumTravel, PLATFORM_LIMITS.maximumTravel)}
            ${numericField('platform-width', 'Width', PLATFORM_LIMITS.minimumWidth, PLATFORM_LIMITS.maximumWidth)}
            ${numericField('platform-height', 'Height', PLATFORM_LIMITS.minimumHeight, PLATFORM_LIMITS.maximumHeight)}
            ${numericField('platform-depth', 'Depth', LEVEL_LIMITS.minimumDepth, LEVEL_LIMITS.maximumDepth)}
            ${numericField('platform-speed', 'Speed (m/s)', PLATFORM_LIMITS.minimumSpeed, PLATFORM_LIMITS.maximumSpeed)}
            ${selectField('platform-surface', 'Surface', SURFACES.map((surface) => ({ value: surface, label: SURFACE_LABELS[surface] })))}
          </div>
          <label class="level-checkbox" for="level-platform-ride">
            <input id="level-platform-ride" type="checkbox" aria-describedby="level-platform-ride-help" /> Starts when stepped on
          </label>
          <p id="level-platform-ride-help" class="level-help">When it rests, the pot boarding its top sends it to the other
            end, carrying the player. Step off briefly before boarding again to return; staying aboard or bouncing on
            arrival does not turn it back. The default look draws a pressure plate on its deck, moving with it.</p>
          <p class="level-help">Position X/Y is the platform's start centre. Travel X/Y is the offset in metres to its
            other centre. Dragging the slab moves both ends; its end handle changes only the travel. The editor draws
            the start slab, a dashed end preview and the travel line. A Move platform trigger can toggle its destination
            or send it to start / end, reversing if it is moving away. For landing calls, use a switch set To start at
            the bottom and To end at the top. Keep its path clear: it moves through terrain and can push the
            player into rock. Reset returns it to the start, but returning to a bonfire leaves it where the run has moved it.
            Select the platform to see its incoming trigger links; Links shows every connection.</p>
        </div>
        <div class="level-fields-decoration">
          <div class="level-field-grid">
            ${selectField('decoration-model', 'Model', DECORATION_MODELS.map(({ id, name }) => ({ value: id, label: name })))}
            ${numericField('decoration-z', 'Depth', -DECORATION_LIMITS.back, DECORATION_LIMITS.front, 0.5)}
            ${numericField('decoration-height', 'Height', DECORATION_LIMITS.minimumHeight, DECORATION_LIMITS.maximumHeight)}
            <label class="level-field" for="level-decoration-tint">Tint
              <input id="level-decoration-tint" type="color" />
            </label>
          </div>
          <label class="level-checkbox" for="level-decoration-mirror">
            <input id="level-decoration-mirror" type="checkbox" /> Mirror left / right (M)
          </label>
          <p class="level-help level-decoration-help">Scenery only: decorations never collide. Position is the centre of the
            model's base. Negative depth sets it behind the course, out to ${DECORATION_LIMITS.back} m; positive depth brings it
            up to ${DECORATION_LIMITS.front} m toward the camera, in front of the climb. With a perspective camera distant
            decorations look smaller and drift slowly by. White tint keeps the model's own colours.</p>
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
            ${selectField('trigger-marker', 'Marker', TRIGGER_MARKERS.map((marker) => ({
              value: marker, label: TRIGGER_MARKER_LABELS[marker],
            })))}
          </div>
          <p class="level-help">Trigger regions are centred on Position X/Y and axis-aligned (no rotation).
            Proximity uses the player's foot position; "Once per run" fires a single time, "Every entry" fires
            again each time the player re-enters after leaving. A pressure switch uses the switch marker and Every entry.
            Select a trigger to see its outgoing links, or a trap or platform to see incoming links; Links shows all.
            Arrowheads point to the target; labels show ×N shots or toggle, in event order.
            Drag the trigger's link handle onto a projectile trap or platform to connect.
            Edit or remove a link in Trigger events.</p>
          <p class="level-help level-trigger-preview-events" hidden></p>
          <div class="level-trigger-events"></div>
        </div>
        <button type="button" class="button level-delete">Delete selected object</button>
      </fieldset>
      `)}
      ${sectionMarkup({ id: 'level-set-pieces', title: 'Set piece library', hint: `${SET_PIECES.length} ready-made obstacles` }, `
      <fieldset class="tuning-group level-set-pieces">
        <legend class="visually-hidden">Set piece library</legend>
        <p class="level-help">Ready-made obstacles built from the basic shapes. Pick one, then click / tap the
          canvas to drop it. It rests on the terrain top nearest the pointer, and every part stays editable.</p>
        ${selectField('set-piece-category', 'Category', SET_PIECE_CATEGORIES.map(({ id, label }) => ({ value: id, label })))}
        <div class="level-set-piece-grid" aria-label="Set pieces"></div>
        <p class="level-help level-set-piece-detail"></p>
        <label class="level-checkbox" for="level-set-piece-mirror">
          <input id="level-set-piece-mirror" type="checkbox" /> Mirror left / right (M)
        </label>
        <button type="button" class="button level-set-piece-undo">Remove last placed set piece</button>
        <p class="level-help level-set-piece-status" role="status" aria-live="polite"></p>
      </fieldset>
      `)}
      ${sectionMarkup({ id: 'level-decorations', title: 'Decoration library', hint: `${DECORATION_MODELS.length} placeholder models, scenery only` }, `
      <fieldset class="tuning-group level-decorations">
        <legend class="visually-hidden">Decoration library</legend>
        <p class="level-help">Scenery that never collides, to set the mood: far behind the course, just behind it,
          or in front of it. Pick a model, adjust its depth and height under Object properties, then click / tap the
          canvas. These are placeholders: course artwork (npm run pack:course) replaces any model with the game's own
          GLB in mesh releases, while the Workshop keeps showing the placeholder.</p>
        <p class="level-help">Depth reads best through a perspective camera (Project / Theme). Anything deeper than the
          theme's fog end disappears into the fog, and the theme's backdrop mountains, about 10-25 m back, hide what
          stands behind them: raise the fog end, or hide the backdrop, to show the far horizon.</p>
        ${selectField('decoration-category', 'Category', DECORATION_CATEGORIES.map(({ id, label }) => ({ value: id, label })))}
        <div class="level-set-piece-grid level-decoration-grid" aria-label="Decorations"></div>
        <p class="level-help level-decoration-detail"></p>
      </fieldset>
      `)}
      ${sectionMarkup({ id: 'level-server', title: 'Server levels', hint: 'Load a level served with this Workshop' }, `
      <div class="snapshot-history level-server">
        <label for="level-server-list">Server level</label>
        <div class="tuning-profile-row">
          <select id="level-server-list"></select>
          <button type="button" class="button level-server-load">Load server level</button>
        </div>
        <p class="snapshot-history-help">${options.serverLevels.length === 0
    ? 'This Workshop serves no levels. Put level JSON files in the levels folder of its repository, then build or start it again.'
    : 'The same for everyone who opens this Workshop. Loading one replaces the current level.'}</p>
      </div>
      `)}
      ${sectionMarkup({ id: 'level-replays', title: 'Replays', hint: 'Watch the play recorded on this project\'s level' }, `
      <div class="level-replays"></div>
      `)}
      ${sectionMarkup({ id: 'level-file', title: 'Level JSON', hint: 'Import or export, e.g. for releases' }, `
      <fieldset class="tuning-group level-files">
        <legend class="visually-hidden">Level JSON</legend>
        <div class="level-action-row">
          <button type="button" class="button level-export">Export level JSON</button>
          <button type="button" class="button level-import">Import level JSON</button>
        </div>
        <input class="level-file" type="file" accept=".json,application/json" aria-label="Import level JSON" hidden />
        <p class="level-help">Exports level.json: terrain, start, triggers, enemies, decorations, bonfires, traps, liquid pools and labels only.
          Models, appearance, tuning and browser settings are never included. Import limit:
          ${LEVEL_LIMITS.fileBytes / (1024 * 1024)} MiB. Enemy motion/deaths are not saved.
          New enemy kinds and trigger actions need an updated game runtime.</p>
      </fieldset>
      `)}
      ${sectionMarkup({ id: 'level-labels', title: 'Course labels', hint: 'Signs painted on the course' }, `
      <fieldset class="tuning-group level-labels">
        <legend class="visually-hidden">Course labels</legend>
        <p class="level-help level-label-count"></p>
        <button type="button" class="button level-clear-labels">Remove course labels</button>
      </fieldset>
      `)}
    </div>
  `;
  options.mount.append(root);
  const overlay = document.createElement('div');
  overlay.className = 'level-overlay';
  overlay.hidden = true;
  overlay.tabIndex = 0;
  overlay.setAttribute('aria-label', 'Level canvas. Drag a shape to move it, or empty space to pan; the middle button pans from anywhere. Plus and minus zoom. V returns to selecting. Enter finishes a drawing; Backspace undoes a stroke. Escape cancels; Delete removes selection.');
  overlay.innerHTML = `<svg class="level-guides" aria-hidden="true">
    <g class="level-camera-group">
      <path class="level-selection" fill-rule="evenodd" vector-effect="non-scaling-stroke" hidden />
      <path class="level-ghost" fill-rule="evenodd" vector-effect="non-scaling-stroke" hidden />
      <g class="level-drawing-guide" hidden>
        <polyline class="level-drawing-line" vector-effect="non-scaling-stroke" />
        <path class="level-drawing-links" vector-effect="non-scaling-stroke" />
        <path class="level-drawing-nodes" vector-effect="non-scaling-stroke" />
        <circle class="level-drawing-first" vector-effect="non-scaling-stroke" />
      </g>
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
  const selectionPolygon = graphic<SVGPathElement>('.level-selection');
  const ghostPolygon = graphic<SVGPathElement>('.level-ghost');
  const drawingGuide = graphic<SVGGElement>('.level-drawing-guide');
  const drawingLine = graphic<SVGPolylineElement>('.level-drawing-line');
  const drawingLinks = graphic<SVGPathElement>('.level-drawing-links');
  const drawingNodes = graphic<SVGPathElement>('.level-drawing-nodes');
  const drawingFirst = graphic<SVGCircleElement>('.level-drawing-first');
  const drawing = new PolygonDraft();
  const board = new LevelBoardView();
  svg.insertBefore(board.root, cameraGroup);
  const entityGizmos = new EntityGizmos(cameraGroup);
  const inspector = element<HTMLFieldSetElement>(root, '.level-inspector');
  const input = (name: string) => element<HTMLInputElement>(root, `#level-${name}`);
  const select = (name: string) => element<HTMLSelectElement>(root, `#level-${name}`);
  const saveStatus = element<HTMLParagraphElement>(root, '.level-save-status');
  const importButton = element<HTMLButtonElement>(root, '.level-import');
  const fileInput = element<HTMLInputElement>(root, '.level-file');
  const serverList = select('server-list');
  const serverLoad = element<HTMLButtonElement>(root, '.level-server-load');
  const bounds = new Map(level.definition().objects.map((object) => [object.id, objectBounds(object)]));
  // Each terrain object's leftmost point, and the least of them, which places the board's column A.
  const terrainLefts = new Map(level.definition().objects.filter(isTerrainObject).map((object) => [object.id, bounds.get(object.id)!.left]));
  let terrainLeft = leastOf(terrainLefts.values());
  board.setLeft(boardLeft(terrainLeft));
  const boardReadout = element<HTMLParagraphElement>(root, '.level-board-readout');
  const boardToggle = element<HTMLButtonElement>(root, '.level-board-toggle');
  const linksToggle = element<HTMLButtonElement>(root, '.level-links-toggle');
  const boardInput = input('board-square');
  let boardShown = readBoardShown();
  let linksShown = readLinksShown();
  // The square under the pointer, or the one Go to chose; null for none.
  let boardSquare: BoardSquare | null = null;
  entityGizmos.sync(level.definition().objects, []);
  const downloadJson = createJsonDownload({ mount: root, signal: events.signal });
  const triggerEvents = createTriggerEventEditor({
    mount: element(root, '.level-trigger-events'), signal: events.signal, onNotice,
    objects: () => level.definition().objects,
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
  // The latest mesh being read to place; one finishing after another request or a change of tool is not armed.
  let meshRequest = 0;
  let placement: LevelObject | null = null;
  let gesture: Gesture | null = null;
  let connections = deriveConnectionLinks(level.definition().objects);
  let connectionDrawing: {
    readonly model: ConnectionLinks; readonly selectedId: string | null; readonly shown: boolean;
    readonly unitsPerPixel: number; readonly moved: LevelObject | null;
  } | null = null;
  // Fingers on the canvas, so a second one turns the first's gesture into a pinch.
  const touches = new Map<number, Point>();
  let drawingCursor: Point | null = null;
  let savedDefinition: LevelDefinition | null = level.definition();
  let savedCamera: EditorCamera | null = null;
  let importGeneration = 0;
  // A level file being read, or a server level being downloaded; either blocks other loads.
  let loading: 'file' | 'server' | null = null;
  let rect = options.canvas.getBoundingClientRect();
  let drawCount = 0;
  let commitCount = 0;
  let hitTestCount = 0;
  let setPieceId: string | null = null;
  let setPieceMirror = false;
  let setPieceAnchor: Point = { x: 0, y: 0 };
  let setPieceSnapped = false;
  let setPieceCategory: SetPieceCategory = SET_PIECE_CATEGORIES[0].id;
  let setPieceGridCategory: SetPieceCategory | null = null;
  let setPieceGhost: SVGGElement | null = null;
  let setPieceGhostKey: string | null = null;
  let setPieceStatus = '';
  // Most recent drops first to be removed; stale entries (parts already deleted) are skipped.
  const setPieceHistory: { readonly name: string; readonly ids: readonly string[]; readonly labels: readonly LevelLabel[] }[] = [];
  const setPieceButtons = new Map<string, HTMLButtonElement>();
  // The library model being placed or last chosen, and the grid of the category on show.
  let decorationId: string | null = null;
  let decorationCategory: DecorationCategory = DECORATION_CATEGORIES[0].id;
  let decorationGridCategory: DecorationCategory | null = null;
  let decorationMirror = false;
  let decorationPreview: DecorationObject | null = null;
  const decorationButtons = new Map<string, HTMLButtonElement>();
  const decorationList = select('decoration-model');
  // Holds a model the library does not have, so the inspector can still show it.
  const unknownModel = document.createElement('option');
  const surfaces = new SurfaceIndex(() => level.definition());

  const dirty = () => level.definition() !== savedDefinition || triggerEvents.hasPendingDrafts() ||
    drawing.vertices.length > 0 || gesture?.kind === 'draw';
  const selectedObject = () => selectedId === null ? null : level.object(selectedId);
  const armedSetPiece = (): SetPiece | null =>
    tool === 'place-set-piece' && setPieceId !== null ? setPieceById(setPieceId) : null;
  const inspectorObject = (): LevelObject | null =>
    isPlacementTool(tool) ? placement : selectedObject();
  const pointFromEvent = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });
  const local = (point: Point): Point => {
    const client = camera.project(point);
    return { x: client.x - rect.left, y: client.y - rect.top };
  };
  const ghostObject = (): LevelObject | null => {
    if (gesture?.kind === 'move' || gesture?.kind === 'platform-end') return gesture.preview;
    if (isPlacementTool(tool)) return placement;
    return null;
  };
  const handleRadius = (): number => HANDLE_PIXELS * camera.state().worldHeight / Math.max(1, rect.height);

  function report(error: unknown): void {
    if (error instanceof LevelError) {
      onNotice(`${error.message} Your current level was left unchanged.`, 'error');
    } else if (error instanceof DOMException) {
      onNotice('The file could not be read. Your current level was left unchanged.', 'error');
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
    if (isPlacementTool(tool)) {
      placement = validateLevelObject(next);
      renderControls();
      draw();
    } else {
      level.upsert(next);
    }
  }

  function confirmReplacement(action: string): boolean {
    return !dirty() || window.confirm(`${action} replaces your unsaved level changes.
Export the level first if you want to keep them. Continue without saving?`);
  }

  // Where the level is kept: in the open server project, which saves it a moment after each change, as part of the
  // numbered level version the page plays once its game settings are saved too; or nowhere until it is exported.
  function saveState(): string {
    if (loading === 'file') return 'Reading level file…';
    if (loading === 'server') return 'Downloading server level…';
    if (drawing.vertices.length > 0) return 'Unfinished outline - finish or cancel before saving';
    const project = options.projectSave.openProject();
    if (project === null) return dirty() ? 'Unsaved changes — export, or open a server project in Project, to keep them' : 'No unsaved changes';
    if (dirty()) return `Unsaved changes — they save to project "${project}" a moment after you stop`;
    const played = options.projectSave.playedVersion();
    return played === null ? `Saved in project "${project}"` : `Saved as version ${played.version} in project "${project}"`;
  }

  function renderStatus(): void {
    const counts = level.counts();
    saveStatus.textContent = `${counts.terrain} / ${LEVEL_LIMITS.objects} terrain · ${counts.triggers} / ${TRIGGER_LIMITS.objects} triggers · ${
      counts.enemies} / ${ENEMY_LIMITS.objects} enemies · ${counts.decorations} / ${DECORATION_LIMITS.objects} decorations · ${
      counts.bonfires} / ${HAZARD_LIMITS.bonfires} bonfires · ${counts.traps} / ${HAZARD_LIMITS.traps} traps · ${
      counts.pools} / ${LIQUID_LIMITS.pools} pools · ${counts.platforms} / ${PLATFORM_LIMITS.objects} platforms · ${saveState()}`;
    saveStatus.dataset.dirty = String(dirty());
  }

  function renderControls(): void {
    const object = inspectorObject();
    const terrain = asTerrain(object);
    const start = asStart(object);
    const trigger = asTrigger(object);
    const enemy = asEnemy(object);
    const decoration = asDecoration(object);
    const bonfire = asBonfire(object);
    const shooter = asShooter(object);
    const axe = asAxe(object);
    const pool = asPool(object);
    const platform = asPlatform(object);
    inspector.disabled = object === null;
    element(root, '.level-fields-common').hidden = object === null;
    element(root, '.level-fields-angle').hidden = terrain === null && start === null && decoration === null && shooter === null;
    element(root, '.level-fields-decoration').hidden = decoration === null;
    element(root, '.level-fields-terrain').hidden = terrain === null;
    element(root, '.level-fields-start').hidden = start === null;
    element(root, '.level-fields-trigger').hidden = trigger === null;
    element(root, '.level-fields-enemy').hidden = enemy === null;
    element(root, '.level-fields-bonfire').hidden = bonfire === null;
    element(root, '.level-fields-shooter').hidden = shooter === null;
    element(root, '.level-fields-axe').hidden = axe === null;
    element(root, '.level-fields-pool').hidden = pool === null;
    element(root, '.level-fields-platform').hidden = platform === null;

    const armedPiece = armedSetPiece();
    element(root, '.level-selection-name').textContent =
      armedPiece !== null ? `${armedPiece.name}${setPieceMirror ? ' (mirrored)' : ''} — click / tap the canvas to drop it` :
      object === null ? 'Select an object, or place terrain, a start, a trigger, an enemy, a bonfire, a trap, a liquid pool or a platform.' :
      tool === 'place' && terrain !== null ? `New ${terrainName(terrain)}${terrain.mirror ? ' (mirrored)' : ''} — click / tap the canvas to place` :
      tool === 'place-trigger' ? `New ${presetId === 'ending-trigger' ? 'ending trigger' : 'trigger'} — click / tap the canvas to place` :
      tool === 'place-enemy' && enemy !== null ? `New ${ENEMY_SPECS[enemy.species].label} - click / tap its base to place` :
      tool === 'place-hazard' && object !== null && isHazard(object) ? `New ${hazardName(object).toLowerCase()} — click / tap to place` :
      tool === 'place-decoration' && decoration !== null ? `New ${modelName(decoration.model)}${decoration.mirror ? ' (mirrored)' : ''} — click / tap its base to place` :
      tool === 'start' ? 'Start location — click / tap the canvas to place' :
      tool === 'player' ? 'Place player — click / tap where the pot should stand' :
      terrain !== null ? `${terrainName(terrain)} · ${terrain.id}` :
      start !== null ? `Start location · ${start.id}` :
      trigger !== null ? `Trigger "${trigger.name}" · ${trigger.id}` :
      enemy !== null ? `${ENEMY_SPECS[enemy.species].label} - ${enemy.id}` :
      decoration !== null ? `${modelName(decoration.model)} · ${decoration.id}` :
      isHazard(object) ? `${hazardName(object)} · ${object.id}` : '';

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
      input('height').disabled = meshIsCircle(terrain.mesh);
      input('illusion').checked = terrain.illusion;
      input('terrain-mirror').checked = terrain.mirror;
      select('surface').value = terrain.surface;
      element(root, '.level-circle-help').hidden = !meshIsCircle(terrain.mesh);
      element(root, '.level-terrain-collision').textContent = collisionNote(terrain.mesh);
    } else if (start !== null) {
      input('angle').value = String(Number((start.angle * DEGREES).toFixed(4)));
      input('reach').value = String(Number(start.reach.toFixed(4)));
    } else if (decoration !== null) {
      input('angle').value = String(Number((decoration.angle * DEGREES).toFixed(4)));
      const known = builtInDecoration(decoration.model) !== undefined;
      unknownModel.value = decoration.model;
      unknownModel.textContent = `${decoration.model} (no placeholder: drawn only by course artwork)`;
      if (known) unknownModel.remove();
      else if (unknownModel.parentElement === null) decorationList.append(unknownModel);
      decorationList.value = decoration.model;
      input('decoration-z').value = String(Number(decoration.z.toFixed(4)));
      input('decoration-height').value = String(Number(decoration.height.toFixed(4)));
      input('decoration-tint').value = `#${decoration.tint.toString(16).padStart(6, '0')}`;
      input('decoration-mirror').checked = decoration.mirror;
    } else if (shooter !== null) {
      input('angle').value = String(Number((shooter.angle * DEGREES).toFixed(4)));
      select('shooter-firing').value = shooter.firing;
      for (const name of Object.keys(SHOOTER_FIELDS) as (keyof typeof SHOOTER_FIELDS)[]) {
        input(`shooter-${name}`).value = String(Number(shooter[name].toFixed(4)));
      }
    } else if (axe !== null) {
      for (const name of Object.keys(AXE_FIELDS) as (keyof typeof AXE_FIELDS)[]) {
        input(`axe-${name}`).value = String(Number(axe[name].toFixed(4)));
      }
    } else if (pool !== null) {
      select('pool-liquid').value = pool.liquid;
      for (const name of ['width', 'height', 'depth'] as const) input(`pool-${name}`).value = String(Number(pool[name].toFixed(4)));
    } else if (platform !== null) {
      for (const name of ['travelX', 'travelY', 'width', 'height', 'depth', 'speed'] as const) {
        input(`platform-${name}`).value = String(Number(platform[name].toFixed(4)));
      }
      select('platform-surface').value = platform.surface;
      input('platform-ride').checked = platform.ride;
    } else if (enemy !== null) {
      select('enemy-facing').value = enemy.facing;
      for (const name of ['patrolDistance', 'speed'] as const) {
        input(`enemy-${name}`).value = String(Number(enemy[name].toFixed(4)));
      }
      element(root, '.level-enemy-help').textContent =
        `${ENEMY_HELP[enemy.species]} Physics / Enemies sets how many separate hammer-head strikes defeat each species; health applies at reset or spawn. ` +
        `Strikes need at least ${ENEMY_BEHAVIOR.hitSpeed} m/s closing speed, with a ${ENEMY_BEHAVIOR.hitSeconds}s anti-jitter cooldown. ` +
        'Brushing or holding the head against an enemy does not repeatedly deal damage.';
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
    }
    if (trigger === null) triggerEvents.hide();

    const selected = selectedObject();
    element<HTMLButtonElement>(root, '.level-delete').disabled = selected === null || (tool !== 'select' && tool !== 'decorate') ||
      selected.kind === 'start';
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.levelTool === tool));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-preset]')) {
      button.setAttribute('aria-pressed', String(isPlacementTool(tool) && button.dataset.levelPreset === presetId));
    }
    const counts = level.counts();
    element<HTMLButtonElement>(root, '.level-draw-tool').disabled =
      counts.terrain >= LEVEL_LIMITS.objects && drawing.vertices.length === 0 && tool !== 'draw';
    element(root, '.level-drawing-controls').hidden = tool !== 'draw' && drawing.vertices.length === 0;
    element(root, '.level-drawing-status').textContent =
      `${drawing.vertices.length} / ${LEVEL_LIMITS.polygonVertices} points. Click / tap corners or drag a trace. ` +
      'Tap the first point or finish to close. Freehand traces are simplified; concave outlines work, holes and crossing edges do not.';
    element<HTMLButtonElement>(root, '.level-drawing-finish').disabled = drawing.vertices.length < 3;
    element<HTMLButtonElement>(root, '.level-drawing-undo').disabled = drawing.vertices.length === 0;
    for (const [selector, full] of [
      ['.level-palette', counts.terrain >= LEVEL_LIMITS.objects],
      ['.level-entity-palette', counts.triggers >= TRIGGER_LIMITS.objects],
      ['.level-enemy-palette', counts.enemies >= ENEMY_LIMITS.objects],
    ] as const) {
      for (const button of root.querySelectorAll<HTMLButtonElement>(`${selector} [data-level-preset]`)) {
        button.disabled = full;
      }
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('.level-hazard-palette [data-level-preset]')) {
      const preset = HAZARD_PRESETS.find((candidate) => candidate.id === button.dataset.levelPreset);
      button.disabled = preset === undefined || counts[preset.tally] >= preset.limit;
    }
    const help: Record<Tool, string> = {
      select: 'Click / tap to select; drag to move. Drag empty space, or drag with the middle button from anywhere, to pan; the ' +
        'wheel and + / − zoom. On a touch screen, drag with two fingers to pan and pinch to zoom. Pick enemies on their bodies, ' +
        'starts and triggers near their centre handle, and liquid pools in their box where no terrain is. Select a trigger to see ' +
        'outgoing links, or a projectile trap or platform for incoming links. Links shows all; drag a trigger\'s link handle onto ' +
        'a trap or platform to connect. Escape cancels a drag without changing the level. Decorations are picked with Select decorations.',
      decorate: 'Click / tap a decoration to select it, nearest first; drag to move it at its own depth, or drag empty space to ' +
        'pan. The course cannot be picked in this mode; click Select decorations again to pick it. Delete removes the selection.',
      draw: 'Click / tap corners, or hold and drag to sketch. Enter finishes; Backspace or Ctrl / Cmd + Z undoes a point or stroke. ' +
        'Escape cancels. Pan with the middle button or two fingers and zoom as usual; your unfinished outline is kept.',
      place: 'Click / tap to place it. Adjust its properties first if needed. M mirrors it. Escape cancels placement.',
      'place-trigger': 'Click / tap to place this trigger or pressure switch. Select it after placing, then drag its link handle ' +
        'onto a projectile trap or platform to connect; edit or remove links in Trigger events. Escape cancels placement.',
      'place-enemy': 'Click / tap the desired base to place this enemy. Tune facing, patrol radius and speed before or after placing. Escape cancels.',
      'place-hazard': 'Click / tap to place it: a bonfire by its base, which rests on the terrain top under the pointer; a projectile ' +
        'trap by its muzzle; a swinging axe by its pivot; a liquid pool by the middle of its surface; a platform by its start centre. Tune it before or after ' +
        'placing. Escape cancels.',
      'place-set-piece': 'Click / tap to drop the set piece. Its base rests on the terrain top nearest the pointer; move ' +
        'away from surfaces to place it freely. M mirrors it. Escape cancels.',
      'place-decoration': 'Click / tap to place the decoration. Its base follows the pointer at its depth and rests on nearby ' +
        'terrain tops when it is close to the course. Set depth, height and tint first if you like. M mirrors it. Escape cancels.',
      start: 'Click / tap the new pot-center position. Escape cancels.',
      player: 'Click / tap where the pot should stand. The player moves there, in the start\'s pose, to test that part of ' +
        'the course; the level\'s start stays where it is. Playtests and resets start there until you use the level start. Escape cancels.',
    };
    element(root, '.level-tool-help').textContent = help[tool];
    element(root, '.level-player-note').hidden = !options.player.placed();
    overlay.dataset.tool = tool;
    const { labels } = level.definition();
    element(root, '.level-label-count').textContent = `${labels.length} course labels. Edits, saves and exports preserve them unless you remove them.`;
    element<HTMLButtonElement>(root, '.level-clear-labels').disabled = labels.length === 0;
    renderSetPieces();
    renderDecorations();
    renderStatus();
  }

  function modelName(id: string): string {
    return builtInDecoration(id)?.name ?? id;
  }

  function decorationButton(model: DecorationModel): HTMLButtonElement {
    const cached = decorationButtons.get(model.id);
    if (cached !== undefined) return cached;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-set-piece level-decoration';
    button.dataset.decoration = model.id;
    button.title = model.description;
    button.setAttribute('aria-pressed', 'false');
    button.append(decorationThumbnail(builtInGeometry(model)), document.createTextNode(model.name));
    button.addEventListener('click', () => { if (active && !released(button)) armDecoration(model); }, listen);
    decorationButtons.set(model.id, button);
    return button;
  }

  function renderDecorations(): void {
    // Models are built, and thumbnails painted, on first view of their category.
    if (active && decorationGridCategory !== decorationCategory) {
      decorationGridCategory = decorationCategory;
      element(root, '.level-decoration-grid').replaceChildren(
        ...DECORATION_MODELS.filter((model) => model.category === decorationCategory).map(decorationButton));
    }
    const full = level.counts().decorations >= DECORATION_LIMITS.objects;
    for (const [id, button] of decorationButtons) {
      button.setAttribute('aria-pressed', String(tool === 'place-decoration' && decorationId === id));
      button.disabled = full;
    }
    const shown = decorationId === null ? null : builtInDecoration(decorationId) ?? null;
    const depth = (z: number): string => z < 0 ? `${-z} m behind the course` : z > 0 ? `${z} m in front of it` : 'on the course';
    element(root, '.level-decoration-detail').textContent = full ? `This level already has ${DECORATION_LIMITS.objects} decorations.`
      : shown === null ? 'Choose a model to see what it is for.'
        : `${shown.name}: ${shown.description} It starts ${shown.height} m tall, ${depth(shown.z)}.`;
  }

  function armDecoration(model: DecorationModel): void {
    cancelGesture();
    const view = camera.state();
    tool = 'place-decoration'; decorationId = model.id; presetId = null; selectedId = null; drawingCursor = null;
    placement = validateLevelObject({
      kind: 'decoration', id: 'placement-preview', model: model.id, x: view.x, y: view.y - model.height / 2, z: model.z,
      height: model.height, angle: 0, mirror: decorationMirror, tint: 0xffffff,
    });
    renderControls();
    draw();
  }

  // The size of a decoration as placed; a model the view does not know yet counts as half as wide as tall.
  function decorationSize(object: DecorationObject): { width: number; height: number } {
    const model = options.decorations.size(object.model);
    return { width: model === null ? object.height / 2 : model.width * object.height / model.height, height: object.height };
  }

  // The decoration's box as it appears on the course plane, or null when it is behind the camera.
  function decorationOutline(object: DecorationObject): Point[] | null {
    const { width, height } = decorationSize(object);
    const cosine = Math.cos(object.angle);
    const sine = Math.sin(object.angle);
    const outline: Point[] = [];
    for (const [x, y] of [[-width / 2, 0], [width / 2, 0], [width / 2, height], [-width / 2, height]] as const) {
      const screen = camera.projectDepth({ x: object.x + x * cosine - y * sine, y: object.y + x * sine + y * cosine }, object.z);
      if (screen === null) return null;
      outline.push(camera.unproject(screen));
    }
    return outline;
  }

  // The nearest decoration drawn under a client position.
  function hitDecoration(client: Point): DecorationObject | null {
    hitTestCount++;
    let hit: DecorationObject | null = null;
    for (const object of level.definition().objects) {
      if (object.kind !== 'decoration' || (hit !== null && object.z <= hit.z)) continue;
      const at = camera.unprojectDepth(client, object.z);
      if (at === null) continue;
      const { width, height } = decorationSize(object);
      const dx = at.x - object.x;
      const dy = at.y - object.y;
      const along = dx * Math.cos(object.angle) + dy * Math.sin(object.angle);
      const up = -dx * Math.sin(object.angle) + dy * Math.cos(object.angle);
      if (Math.abs(along) <= width / 2 && up >= 0 && up <= height) hit = object;
    }
    return hit;
  }

  // Where a decoration being placed goes: under the pointer at its depth, resting on a terrain top when close to the course.
  function placeDecoration(object: DecorationObject, client: Point): DecorationObject {
    const at = camera.unprojectDepth(client, object.z);
    if (at === null) return object;
    const below = camera.unprojectDepth({ x: client.x, y: client.y + SNAP_PIXELS }, object.z);
    const top = Math.abs(object.z) > DECORATION_SNAP_DEPTH || below === null ? null : surfaces.nearestTop(at.x, at.y, at.y - below.y);
    return { ...object, x: at.x, y: top ?? at.y };
  }

  // Where a bonfire or trap being placed goes: under the pointer, a bonfire's base resting on the terrain top near it.
  function placeHazard(object: HazardObject, world: Point): HazardObject {
    if (object.kind === 'pool') return { ...object, x: world.x, y: world.y - object.height / 2 };
    if (object.kind !== 'bonfire') return { ...object, x: world.x, y: world.y };
    const top = surfaces.nearestTop(world.x, world.y, SNAP_PIXELS * camera.state().worldHeight / Math.max(1, rect.height));
    return { ...object, x: world.x, y: top ?? world.y };
  }

  function setPieceButton(piece: SetPiece): HTMLButtonElement {
    const cached = setPieceButtons.get(piece.id);
    if (cached !== undefined) return cached;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-set-piece';
    button.dataset.setPiece = piece.id;
    button.title = piece.skill;
    button.setAttribute('aria-pressed', 'false');
    button.append(createSetPieceThumbnail(piece), document.createTextNode(piece.name));
    button.addEventListener('click', () => { if (active && !released(button)) armSetPiece(piece); }, listen);
    setPieceButtons.set(piece.id, button);
    return button;
  }

  function renderSetPieces(): void {
    // Thumbnails are built on first view of their category, then reused.
    if (active && setPieceGridCategory !== setPieceCategory) {
      setPieceGridCategory = setPieceCategory;
      element(root, '.level-set-piece-grid').replaceChildren(
        ...SET_PIECES.filter((piece) => piece.category === setPieceCategory).map(setPieceButton));
    }
    const armed = armedSetPiece();
    const current = level.counts();
    const labelCount = level.definition().labels.length;
    const fits = (counts: SetPieceCounts): boolean =>
      current.terrain + counts.terrain <= LEVEL_LIMITS.objects &&
      current.triggers + counts.triggers <= TRIGGER_LIMITS.objects &&
      current.enemies + counts.enemies <= ENEMY_LIMITS.objects &&
      labelCount + counts.labels <= LEVEL_LIMITS.labels;
    for (const [id, button] of setPieceButtons) {
      button.setAttribute('aria-pressed', String(armed?.id === id));
      button.disabled = !fits(setPieceById(id).counts);
    }
    const shown = setPieceId === null ? null : setPieceById(setPieceId);
    const { terrain, triggers, enemies, labels } = shown?.counts ?? { terrain: 0, triggers: 0, enemies: 0, labels: 0 };
    const extras = [
      triggers > 0 ? `${triggers} trigger${triggers === 1 ? '' : 's'}` : '',
      enemies > 0 ? `${enemies} ${enemies === 1 ? 'enemy' : 'enemies'}` : '',
      labels > 0 ? `${labels} course label${labels === 1 ? '' : 's'}` : '',
    ].filter((text) => text !== '');
    element(root, '.level-set-piece-detail').textContent = shown === null
      ? 'Choose a piece to see the skill it tests and what it adds.'
      : `${shown.name}: ${shown.skill} Adds ${terrain} terrain object${terrain === 1 ? '' : 's'}${
        extras.length === 0 ? '' : ` and ${extras.join(', ')}`}.`;
    input('set-piece-mirror').checked = setPieceMirror;
    element<HTMLButtonElement>(root, '.level-set-piece-undo').disabled = setPieceHistory.length === 0;
    element(root, '.level-set-piece-status').textContent = setPieceStatus;
  }

  function drawPolygon(polygon: SVGPathElement, object: TerrainObject | null): void {
    polygon.toggleAttribute('hidden', object === null);
    if (object === null) return;
    polygon.setAttribute('d', loopsPath(objectLoops(object)));
    polygon.classList.toggle('level-illusion-outline', object.illusion);
  }

  function drawOutline(): void {
    const points = gesture?.kind === 'draw' ? [...drawing.vertices, ...gesture.samples] : drawing.vertices;
    drawingGuide.toggleAttribute('hidden', points.length === 0);
    if (points.length === 0) return;
    const unitsPerPixel = camera.state().worldHeight / Math.max(1, rect.height);
    const radius = DRAWING.vertexPixels * unitsPerPixel;
    const first = points[0];
    const last = points[points.length - 1];
    const cursor = tool === 'draw' ? drawingCursor : null;
    drawingLine.setAttribute('points', points.map((point) => `${point.x},${point.y}`).join(' '));
    drawingLinks.setAttribute('d', `M ${last.x} ${last.y}` +
      (cursor === null ? '' : ` L ${cursor.x} ${cursor.y}`) +
      (points.length < 3 ? '' : ` L ${first.x} ${first.y}`));
    drawingNodes.setAttribute('d', drawing.vertices.map((point) =>
      `M ${point.x - radius} ${point.y} h ${radius * 2} M ${point.x} ${point.y - radius} v ${radius * 2}`).join(' '));
    drawingFirst.setAttribute('cx', String(first.x));
    drawingFirst.setAttribute('cy', String(first.y));
    drawingFirst.setAttribute('r', String(DRAWING.closePixels * unitsPerPixel));
    drawingFirst.classList.toggle('level-drawing-close', cursor !== null && drawing.vertices.length >= 3 &&
      Math.hypot(cursor.x - first.x, cursor.y - first.y) <= DRAWING.closePixels * unitsPerPixel);
  }

  function drawSetPieceGhost(): void {
    const piece = armedSetPiece();
    const key = piece === null ? null : `${piece.id}:${setPieceMirror}`;
    if (key !== setPieceGhostKey) {
      setPieceGhost?.remove();
      setPieceGhost = piece === null ? null : createSetPieceGhost(piece, setPieceMirror);
      if (setPieceGhost !== null) cameraGroup.append(setPieceGhost);
      setPieceGhostKey = key;
    }
    if (setPieceGhost === null) return;
    setPieceGhost.setAttribute('transform', `translate(${setPieceAnchor.x} ${setPieceAnchor.y})`);
    setPieceGhost.classList.toggle('level-set-piece-snapped', setPieceSnapped);
  }

  function drawPoints(polygon: SVGPathElement, points: readonly Point[] | null): void {
    polygon.toggleAttribute('hidden', points === null);
    if (points === null) return;
    polygon.setAttribute('d', loopsPath([points]));
    polygon.classList.remove('level-illusion-outline');
  }

  function draw(): void {
    if (!active || disposed || rect.width <= 0 || rect.height <= 0) return;
    drawCount++;
    const selected = selectedObject();
    const ghost = ghostObject();
    const selectedDecoration = asDecoration(selected);
    const ghostDecoration = ghost === null ? null : asDecoration(ghost);
    if (selectedDecoration !== null) drawPoints(selectionPolygon, decorationOutline(selectedDecoration));
    else drawPolygon(selectionPolygon, asTerrain(selected));
    if (ghostDecoration !== null) drawPoints(ghostPolygon, decorationOutline(ghostDecoration));
    else drawPolygon(ghostPolygon, ghost !== null ? asTerrain(ghost) : null);
    if (ghostDecoration !== decorationPreview) {
      decorationPreview = ghostDecoration;
      options.decorations.preview(ghostDecoration);
    }
    entityGizmos.setSelection(selected !== null && !isTerrainObject(selected) && !isDecorationObject(selected) ? selected : null);
    entityGizmos.setGhost(ghost !== null && !isTerrainObject(ghost) && !isDecorationObject(ghost) ? ghost : null);
    drawConnections(selected);
    drawSetPieceGhost();
    drawOutline();
  }

  function objectConnections(id: string | null): readonly ConnectionLink[] {
    return id === null ? [] : connections.outgoing.get(id) ?? connections.incoming.get(id) ?? [];
  }

  function drawConnections(selected: LevelObject | null): void {
    const unitsPerPixel = camera.state().worldHeight / Math.max(1, rect.height);
    const moved = gesture?.kind === 'move' &&
      (connections.outgoing.has(gesture.preview.id) || connections.incoming.has(gesture.preview.id)) ? gesture.preview : null;
    const previous = connectionDrawing;
    if (previous === null || previous.model !== connections || previous.selectedId !== selectedId ||
      previous.shown !== linksShown || previous.unitsPerPixel !== unitsPerPixel) {
      entityGizmos.setConnections(linksShown ? connections.all : objectConnections(selectedId),
        { selectedId, overview: linksShown, unitsPerPixel, handleRadius: handleRadius() }, moved);
    } else if (previous.moved?.id !== moved?.id || previous.moved?.x !== moved?.x || previous.moved?.y !== moved?.y) {
      if (previous.moved !== null && previous.moved.id !== moved?.id) {
        entityGizmos.moveConnections(objectConnections(previous.moved.id), null);
      }
      if (moved !== null) entityGizmos.moveConnections(objectConnections(moved.id), moved);
    }
    connectionDrawing = { model: connections, selectedId, shown: linksShown, unitsPerPixel, moved };
    const selectedPreview = gesture?.kind === 'move' && gesture.preview.id === selectedId ? gesture.preview : selected;
    entityGizmos.setLinkHandle(tool === 'select' ? asTrigger(selectedPreview) : null, unitsPerPixel);
    const connect = gesture?.kind === 'connect' ? gesture : null;
    entityGizmos.setConnectPreview(connect?.trigger ?? null, connect?.world ?? null, connect?.target ?? null,
      unitsPerPixel, handleRadius());
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
      // 1, 2 or 5 times a power of ten metres, so the fine grid meets the board's 10 m lines.
      const spacing = niceStep(GRID_TARGET_PIXELS / pixelsPerUnit) * pixelsPerUnit;
      overlay.style.backgroundSize = `${spacing}px ${spacing}px`;
      overlay.style.backgroundPosition = `${origin.x % spacing}px ${origin.y % spacing}px`;
    }
    drawBoard();
    draw();
  }

  // The course plane maps to the overlay by one affine matrix, the camera group's, projected once per draw so placing
  // the board's names never reads layout again.
  function boardViewport(): BoardViewport {
    const origin = local({ x: 0, y: 0 });
    const unitX = local({ x: 1, y: 0 });
    const unitY = local({ x: 0, y: 1 });
    const ax = unitX.x - origin.x;
    const ay = unitX.y - origin.y;
    const bx = unitY.x - origin.x;
    const by = unitY.y - origin.y;
    const determinant = ax * by - ay * bx;
    return {
      width: rect.width, height: rect.height,
      toScreen: (point) => ({ x: origin.x + point.x * ax + point.y * bx, y: origin.y + point.x * ay + point.y * by }),
      toWorld: (screen) => {
        const dx = screen.x - origin.x;
        const dy = screen.y - origin.y;
        return { x: (dx * by - dy * bx) / determinant, y: (ax * dy - ay * dx) / determinant };
      },
    };
  }

  function drawBoard(): void {
    if (!active || disposed) return;
    board.root.toggleAttribute('hidden', !boardShown);
    if (boardShown) board.draw(boardViewport());
  }

  // Names the square and position at `world`, or says how the board names squares.
  function renderBoardReadout(world: Point | null): void {
    boardReadout.hidden = !boardShown;
    setText(boardReadout, world === null ? 'Board: 10 m squares, columns A, B… from the left, rows 1, 2… up from the ground.'
      : `${boardSquareName(boardSquareAt(boardLeft(terrainLeft), world)) ?? 'Left of column A'} · x ${world.x.toFixed(1)} m, y ${world.y.toFixed(1)} m`);
  }

  function hoverBoard(square: BoardSquare | null): void {
    if (square?.column === boardSquare?.column && square?.row === boardSquare?.row) return;
    boardSquare = square;
    board.setHover(square);
    if (active && boardShown) board.drawHover(boardViewport());
  }

  function pointBoard(event: PointerEvent): void {
    if (!boardShown) return;
    const world = camera.unproject(pointFromEvent(event));
    hoverBoard(boardSquareAt(boardLeft(terrainLeft), world));
    renderBoardReadout(world);
  }

  function setBoardShown(shown: boolean): void {
    boardShown = shown;
    boardToggle.setAttribute('aria-pressed', String(shown));
    try {
      localStorage.setItem(BOARD_KEY, shown ? 'shown' : 'hidden');
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
    hoverBoard(null);
    renderBoardReadout(null);
    drawBoard();
  }

  function setLinksShown(shown: boolean): void {
    linksShown = shown;
    linksToggle.setAttribute('aria-pressed', String(shown));
    try {
      localStorage.setItem(LINKS_KEY, shown ? 'shown' : 'hidden');
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
    draw();
  }

  // Keeps the leftmost terrain point, and so column A, current from an edit's changed objects; the terrain is scanned
  // again only when its leftmost point moved right or went.
  function trackTerrainLeft(upsert: readonly LevelObject[], remove: readonly string[]): void {
    const before = boardLeft(terrainLeft);
    let rescan = false;
    for (const id of remove) {
      const left = terrainLefts.get(id);
      if (left === undefined) continue;
      terrainLefts.delete(id);
      if (left === terrainLeft) rescan = true;
    }
    for (const object of upsert) {
      const previous = terrainLefts.get(object.id);
      if (isTerrainObject(object)) {
        const left = bounds.get(object.id)!.left;
        terrainLefts.set(object.id, left);
        if (previous === terrainLeft && left > previous) rescan = true;
        else if (terrainLeft === null || left < terrainLeft) terrainLeft = left;
      } else if (previous !== undefined) {
        terrainLefts.delete(object.id);
        if (previous === terrainLeft) rescan = true;
      }
    }
    if (rescan) terrainLeft = leastOf(terrainLefts.values());
    if (boardLeft(terrainLeft) === before) return;
    // The columns were lettered again, so the highlighted square's name no longer matches its place.
    hoverBoard(null);
    renderBoardReadout(null);
    board.setLeft(boardLeft(terrainLeft));
    drawBoard();
  }

  function alignOverlay(): void {
    if (!active || disposed) return;
    const next = options.canvas.getBoundingClientRect();
    if (gesture?.kind === 'draw' &&
      (next.left !== rect.left || next.top !== rect.top || next.width !== rect.width || next.height !== rect.height)) {
      cancelGesture();
    }
    rect = next;
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
    if (previous === null) {
      draw();
      return;
    }
    if (previous.kind === 'draw') drawingCursor = null;
    release(previous);
    if (previous.kind === 'pan' && active) setCamera(previous.camera);
    draw();
  }

  function release(finished: Gesture): void {
    for (const id of finished.kind === 'pinch' ? [finished.pointerId, finished.other] : [finished.pointerId]) {
      if (overlay.hasPointerCapture(id)) overlay.releasePointerCapture(id);
    }
    if (finished.kind === 'pan') delete overlay.dataset.panning;
  }

  // A pressed tool or palette button switches off on a second click, back to selecting.
  function released(button: HTMLButtonElement): boolean {
    if (button.getAttribute('aria-pressed') !== 'true') return false;
    chooseTool('select');
    return true;
  }

  function chooseTool(next: 'select' | 'decorate' | 'start' | 'player' | 'draw'): void {
    cancelGesture();
    meshRequest++;
    tool = next;
    drawingCursor = null;
    if (next === 'draw') selectedId = null;
    presetId = null;
    placement = next === 'start' || next === 'player' ? { ...level.start() } : null;
    renderControls();
    draw();
  }

  function fitCourse(): void {
    cancelGesture();
    replays.stopFollowing();
    let combined: Bounds | null = null;
    for (const [id, bound] of bounds) {
      if (level.object(id).kind === 'decoration') continue;
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
    // A view drag carries on from the zoomed view; any other gesture ends.
    const pan = gesture?.kind === 'pan' ? gesture : null;
    if (pan === null) cancelGesture();
    const before = camera.unproject(anchor);
    const state = camera.state();
    const height = Math.max(MIN_VIEW_HEIGHT, Math.min(MAX_VIEW_HEIGHT, state.worldHeight * factor));
    const ratio = height / state.worldHeight;
    setCamera({ x: before.x + (state.x - before.x) * ratio, y: before.y + (state.y - before.y) * ratio, worldHeight: height });
    if (pan === null) return;
    pan.start = pan.last;
    pan.camera = { ...camera.state() };
    pan.unitsPerPixel = camera.state().worldHeight / Math.max(1, rect.height);
  }

  function resetSelection(): void {
    cancelGesture();
    drawing.clear();
    drawingCursor = null;
    selectedId = null;
    chooseTool('select');
  }

  // Null records that the current level has unsaved changes.
  function markSaved(definition: LevelDefinition | null = level.definition()): void {
    savedDefinition = definition;
    renderStatus();
  }

  function prepareLevel(): boolean {
    if (drawing.vertices.length > 0 || gesture?.kind === 'draw') {
      onNotice('Finish shape or cancel your unfinished outline before saving, exporting, or playtesting. Your outline is still available in Level.', 'error');
      return false;
    }
    return triggerEvents.flush();
  }

  function finishDrawing(): void {
    if (gesture?.kind === 'draw') throw new LevelError('Release the current stroke before finishing the outline.');
    const object = terrainFromOutline({
      id: `shape-${crypto.randomUUID()}`, vertices: drawing.vertices,
      color: ROCK_COLOR, depth: DEFAULT_OBJECT_DEPTH, surface: DEFAULT_SURFACE,
    });
    level.upsert(object);
    drawing.clear();
    selectedId = object.id;
    chooseTool('select');
  }

  function undoDrawing(): void {
    const previous = gesture;
    cancelGesture();
    if (previous?.kind !== 'draw') drawing.undo();
    drawingCursor = null;
    renderControls(); draw();
  }

  function cancelDrawing(): void {
    drawing.clear();
    chooseTool('select');
  }

  function moveSetPiece(world: Point): void {
    const reach = SNAP_PIXELS * camera.state().worldHeight / Math.max(1, rect.height);
    const top = surfaces.nearestTop(world.x, world.y, reach);
    setPieceSnapped = top !== null;
    setPieceAnchor = { x: world.x, y: top ?? world.y };
  }

  function armSetPiece(piece: SetPiece): void {
    cancelGesture();
    tool = 'place-set-piece'; setPieceId = piece.id;
    presetId = null; placement = null; selectedId = null; drawingCursor = null;
    moveSetPiece(camera.state());
    renderControls();
    draw();
  }

  function toggleSetPieceMirror(): void {
    setPieceMirror = !setPieceMirror;
    renderControls();
    draw();
  }

  function dropSetPiece(): void {
    const piece = armedSetPiece();
    if (piece === null) return;
    const stamp = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const placed = placeSetPiece(piece, setPieceAnchor, { mirror: setPieceMirror, stamp });
    level.edit({
      add: placed.objects,
      labels: placed.labels.length === 0 ? undefined : [...level.definition().labels, ...placed.labels],
    });
    setPieceHistory.push({ name: piece.name, ids: placed.objects.map((object) => object.id), labels: placed.labels });
    if (setPieceHistory.length > SET_PIECE_HISTORY) setPieceHistory.shift();
    setPieceStatus = `Placed ${piece.name}${setPieceMirror ? ' (mirrored)' : ''}. Select any part to fine-tune it.`;
    selectedId = null;
    chooseTool('select');
  }

  function removeLastSetPiece(): void {
    cancelGesture();
    while (setPieceHistory.length > 0) {
      const entry = setPieceHistory.pop();
      if (entry === undefined) break;
      const ids = entry.ids.filter((id) => bounds.has(id));
      const current = level.definition().labels;
      const remaining = [...current];
      for (const label of entry.labels) {
        const index = remaining.findIndex((candidate) =>
          candidate.x === label.x && candidate.y === label.y && candidate.text === label.text);
        if (index >= 0) remaining.splice(index, 1);
      }
      if (ids.length === 0 && remaining.length === current.length) continue;
      setPieceStatus = `Removed ${entry.name}.`;
      level.edit({ remove: ids, labels: remaining.length === current.length ? undefined : remaining });
      return;
    }
    setPieceStatus = 'Placed set pieces have already been deleted.';
    renderControls();
  }

  // Saving keeps the level as the open project's next version; each change also saves itself a moment later.
  element(root, '.level-save-dock').append(
    createProjectSaveButton({ target: options.projectSave, sections: ['level'], label: 'the level', signal: events.signal }));
  const unsubscribeProject = options.projectSave.subscribe(() => renderStatus());
  events.signal.addEventListener('abort', unsubscribeProject, { once: true });
  const replays = createReplayViewer({
    mount: element(root, '.level-replays'), signal: events.signal, source: options.replays.source, figure: options.replays.figure, onNotice,
    follow: (point) => {
      if (active) setCamera({ x: point.x, y: point.y, worldHeight: camera.state().worldHeight });
    },
  });
  serverList.replaceChildren(...(options.serverLevels.length === 0 ? [new Option('No server levels', '')]
    : options.serverLevels.map((entry, index) => new Option(entry.name, String(index)))));

  function renderLoadControls(): void {
    importButton.disabled = loading !== null;
    serverList.disabled = !active || loading !== null || options.serverLevels.length === 0;
    serverLoad.disabled = serverList.disabled;
  }

  function setLoading(next: typeof loading): void {
    loading = next;
    renderLoadControls();
    renderStatus();
  }
  renderLoadControls();

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
    polygon.setAttribute('points', shapeOutline(preset.shape).map((p) =>
      `${p.x * preset.width / size},${-p.y * preset.height / size}`).join(' '));
    icon.append(polygon);
    button.append(icon, document.createTextNode(preset.label));
    button.addEventListener('click', () => {
      if (!active || released(button)) return;
      cancelGesture();
      const view = camera.state();
      tool = 'place'; presetId = preset.id; selectedId = null;
      placement = {
        kind: 'terrain', id: 'placement-preview', mesh: shapeMesh(preset.shape), x: view.x, y: view.y,
        width: preset.width, height: preset.height, angle: 0, mirror: false,
        depth: DEFAULT_OBJECT_DEPTH, color: ROCK_COLOR, illusion: false, surface: DEFAULT_SURFACE,
      };
      renderControls();
      draw();
    }, listen);
    element(root, '.level-palette').insertBefore(button, element(root, '.level-draw-tool'));
  }

  // Meshes: the project's course meshes, each placed with its collision once its GLB is read.
  const meshPalette = element(root, '.level-mesh-palette');
  const meshFile = element<HTMLInputElement>(root, '.level-mesh-file');

  function terrainName(terrain: TerrainObject): string {
    const { mesh } = terrain;
    if (mesh.type === 'shape') return PRESET_SETTINGS[mesh.shape].label;
    if (mesh.type === 'outline') return 'Drawn shape';
    return options.meshes.list().find((candidate) => candidate.id === mesh.assetId)?.name ?? 'Missing mesh';
  }

  function armMesh(id: string, terrain: MeshTerrain): void {
    cancelGesture();
    tool = 'place'; presetId = `${MESH_PRESET}${id}`; selectedId = null; drawingCursor = null;
    placement = meshPlacement(terrain.mesh, terrain, camera.state());
    renderControls();
    draw();
  }

  // Arms a mesh once it is read, unless the designer has moved on meanwhile: chosen another mesh, preset or tool, or
  // started a gesture.
  async function armWhenRead(read: Promise<{ readonly id: string; readonly terrain: MeshTerrain } | Error>): Promise<void> {
    const request = ++meshRequest;
    const from = { tool, presetId };
    const mesh = await read;
    if (mesh instanceof Error || request !== meshRequest || !active || disposed || gesture !== null ||
      tool !== from.tool || presetId !== from.presetId) return;
    armMesh(mesh.id, mesh.terrain);
  }

  function renderMeshes(): void {
    const meshes = options.meshes.list();
    meshPalette.replaceChildren(...meshes.map((mesh) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button level-preset';
      button.dataset.levelPreset = `${MESH_PRESET}${mesh.id}`;
      button.title = mesh.name;
      button.innerHTML = MESH_ICON;
      button.append(document.createTextNode(mesh.name));
      button.addEventListener('click', () => {
        if (!active || released(button)) return;
        void armWhenRead(options.meshes.terrain(mesh.id).then((terrain) => terrain instanceof Error ? terrain : { id: mesh.id, terrain }));
      }, listen);
      return button;
    }));
    // A mesh taken out of the project can no longer be placed.
    if (presetId?.startsWith(MESH_PRESET) && !meshes.some((mesh) => presetId === `${MESH_PRESET}${mesh.id}`)) chooseTool('select');
    else renderControls();
  }

  element(root, '.level-mesh-import').addEventListener('click', () => { if (active) meshFile.click(); }, listen);
  meshFile.addEventListener('change', () => {
    const file = meshFile.files?.[0];
    meshFile.value = '';
    if (file === undefined) return;
    void armWhenRead(options.meshes.add(file));
  }, listen);
  const unsubscribeMeshes = options.meshes.subscribe(renderMeshes);

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
    if (preset.marker === 'updraft') {
      const glyph = updraftGlyph();
      glyph.setAttribute('transform', 'scale(1,-1)');
      icon.append(glyph);
    }
    button.append(icon, document.createTextNode(preset.label));
    button.addEventListener('click', () => {
      if (!active || released(button)) return;
      cancelGesture();
      const view = camera.state();
      tool = 'place-trigger'; presetId = preset.id; selectedId = null;
      placement = triggerPlacement(preset, view);
      renderControls();
      draw();
    }, listen);
    element(root, '.level-entity-palette').append(button);
  }

  for (const species of ENEMY_SPECIES) {
    const spec = ENEMY_SPECS[species];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-preset';
    button.dataset.levelPreset = species;
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', `${-spec.width / 2} ${-spec.height / 2} ${spec.width} ${spec.height}`);
    icon.setAttribute('aria-hidden', 'true');
    const upright = document.createElementNS(SVG_NS, 'g');
    upright.setAttribute('transform', 'scale(1,-1)');
    upright.append(enemyGlyph(species, 'right'));
    icon.append(upright);
    button.append(icon, document.createTextNode(spec.label));
    button.addEventListener('click', () => {
      if (!active || released(button)) return;
      cancelGesture();
      tool = 'place-enemy'; presetId = species; selectedId = null;
      placement = enemyPlacement(species, camera.state());
      renderControls();
      draw();
    }, listen);
    element(root, '.level-enemy-palette').append(button);
  }

  for (const preset of HAZARD_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-preset';
    button.dataset.levelPreset = preset.id;
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '-0.65 -0.65 1.3 1.3');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = preset.icon;
    button.append(icon, document.createTextNode(preset.label));
    button.addEventListener('click', () => {
      if (!active || released(button)) return;
      cancelGesture();
      tool = 'place-hazard'; presetId = preset.id; selectedId = null;
      placement = placeHazard(preset.create(camera.state()), camera.state());
      renderControls();
      draw();
    }, listen);
    element(root, '.level-hazard-palette').append(button);
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-tool]')) {
    button.addEventListener('click', () => {
      if (!active || released(button)) return;
      const next = button.dataset.levelTool;
      if (next !== 'decorate' && next !== 'start' && next !== 'player' && next !== 'draw') throw new Error('Unknown level tool.');
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
    if (object === null || (object.kind !== 'terrain' && object.kind !== 'start' && object.kind !== 'decoration' && object.kind !== 'shooter')) return;
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
        const circle = meshIsCircle(object.mesh) && (name === 'width' || name === 'height');
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
  input('terrain-mirror').addEventListener('change', () => {
    if (!active) return;
    const object = asTerrain(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, mirror: input('terrain-mirror').checked }));
  }, listen);
  select('surface').addEventListener('change', () => {
    if (!active) return;
    const object = asTerrain(inspectorObject());
    const surface = select('surface').value;
    if (object === null || !isSurface(surface)) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, surface }));
  }, listen);
  const editDecoration = (change: (object: DecorationObject) => Partial<DecorationObject>): void => {
    if (!active) return;
    const object = asDecoration(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, ...change(object) }));
  };
  decorationList.addEventListener('change', () => editDecoration(() => {
    if (tool === 'place-decoration') decorationId = decorationList.value;
    return { model: decorationList.value };
  }), listen);
  for (const [name, field] of [['decoration-z', 'z'], ['decoration-height', 'height']] as const) {
    input(name).addEventListener('change', () => editDecoration(() => ({ [field]: input(name).valueAsNumber })), listen);
  }
  input('decoration-tint').addEventListener('change', () => editDecoration(() => ({ tint: Number.parseInt(input('decoration-tint').value.slice(1), 16) })), listen);
  input('decoration-mirror').addEventListener('change', () => editDecoration(() => {
    if (tool === 'place-decoration') decorationMirror = input('decoration-mirror').checked;
    return { mirror: input('decoration-mirror').checked };
  }), listen);
  select('decoration-category').addEventListener('change', () => {
    const category = DECORATION_CATEGORIES.find((candidate) => candidate.id === select('decoration-category').value);
    if (!active || category === undefined) return;
    decorationCategory = category.id;
    renderControls();
  }, listen);
  input('reach').addEventListener('change', () => {
    if (!active) return;
    const object = asStart(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, reach: input('reach').valueAsNumber }));
  }, listen);
  for (const name of ['patrolDistance', 'speed'] as const) {
    input(`enemy-${name}`).addEventListener('change', () => {
      if (!active) return;
      const object = asEnemy(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(`enemy-${name}`).valueAsNumber }));
    }, listen);
  }
  const editTrap = <K extends 'shooter' | 'axe'>(kind: K, name: string): void => {
    if (!active) return;
    const object = inspectorObject();
    if (object === null || object.kind !== kind) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, [name]: input(`${kind}-${name}`).valueAsNumber }));
  };
  for (const name of Object.keys(SHOOTER_FIELDS)) input(`shooter-${name}`).addEventListener('change', () => editTrap('shooter', name), listen);
  select('shooter-firing').addEventListener('change', () => {
    if (!active) return;
    const object = asShooter(inspectorObject());
    if (object === null) return;
    const firing = select('shooter-firing').value;
    if (firing !== 'timer' && firing !== 'trigger') return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, firing }));
  }, listen);
  for (const name of Object.keys(AXE_FIELDS)) input(`axe-${name}`).addEventListener('change', () => editTrap('axe', name), listen);
  select('pool-liquid').addEventListener('change', () => {
    if (!active) return;
    const object = asPool(inspectorObject());
    const liquid = LIQUIDS.find((candidate) => candidate === select('pool-liquid').value);
    if (object === null || liquid === undefined) return;
    cancelGesture();
    // A pool being placed follows its new liquid in the palette.
    if (tool === 'place-hazard') presetId = liquid;
    applyEdit(() => commitOrPreview({ ...object, liquid }));
  }, listen);
  for (const name of ['width', 'height', 'depth'] as const) {
    input(`pool-${name}`).addEventListener('change', () => {
      if (!active) return;
      const object = asPool(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(`pool-${name}`).valueAsNumber }));
    }, listen);
  }
  for (const name of ['travelX', 'travelY', 'width', 'height', 'depth', 'speed'] as const) {
    input(`platform-${name}`).addEventListener('change', () => {
      if (!active) return;
      const object = asPlatform(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(`platform-${name}`).valueAsNumber }));
    }, listen);
  }
  select('platform-surface').addEventListener('change', () => {
    if (!active) return;
    const object = asPlatform(inspectorObject());
    const surface = SURFACES.find((candidate) => candidate === select('platform-surface').value);
    if (object === null || surface === undefined) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, surface }));
  }, listen);
  input('platform-ride').addEventListener('change', () => {
    if (!active) return;
    const object = asPlatform(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, ride: input('platform-ride').checked }));
  }, listen);
  select('enemy-facing').addEventListener('change', () => {
    if (!active) return;
    const object = asEnemy(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => {
      const facing = ENEMY_FACINGS.find((candidate) => candidate === select('enemy-facing').value);
      if (facing === undefined) throw new LevelError('Choose a supported enemy facing.');
      commitOrPreview({ ...object, facing });
    });
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
    applyEdit(() => {
      const marker = TRIGGER_MARKERS.find((candidate) => candidate === select('trigger-marker').value);
      if (marker === undefined) throw new LevelError('Choose a supported trigger marker.');
      commitOrPreview({ ...object, marker });
    });
  }, listen);

  function action(selector: string, callback: () => void): void {
    element(root, selector).addEventListener('click', () => { if (active) callback(); }, listen);
  }
  select('set-piece-category').addEventListener('change', () => {
    const category = SET_PIECE_CATEGORIES.find((candidate) => candidate.id === select('set-piece-category').value);
    if (!active || category === undefined) return;
    setPieceCategory = category.id;
    renderControls();
  }, listen);
  input('set-piece-mirror').addEventListener('change', () => {
    if (!active || input('set-piece-mirror').checked === setPieceMirror) return;
    toggleSetPieceMirror();
  }, listen);
  action('.level-set-piece-undo', removeLastSetPiece);
  function deleteSelected(): void {
    if (selectedId === null || (tool !== 'select' && tool !== 'decorate')) return;
    const object = selectedObject();
    if (object === null || object.kind === 'start') return;
    cancelGesture();
    const id = selectedId;
    selectedId = null;
    level.remove(id);
  }
  action('.level-delete', deleteSelected);
  action('.level-drawing-finish', () => applyEdit(finishDrawing));
  action('.level-drawing-undo', undoDrawing);
  action('.level-drawing-cancel', cancelDrawing);
  action('.level-play', options.onPlay);
  action('.level-player-clear', () => {
    options.player.clear();
    renderControls();
  });
  action('.level-fit', fitCourse);
  action('.level-zoom-in', () => zoom(1 / ZOOM_FACTOR));
  action('.level-zoom-out', () => zoom(ZOOM_FACTOR));
  action('.level-go-start', () => {
    cancelGesture();
    replays.stopFollowing();
    const { x, y } = level.start();
    setCamera({ ...camera.state(), x, y });
  });
  boardToggle.setAttribute('aria-pressed', String(boardShown));
  linksToggle.setAttribute('aria-pressed', String(linksShown));
  renderBoardReadout(null);
  action('.level-board-toggle', () => setBoardShown(!boardShown));
  action('.level-links-toggle', () => setLinksShown(!linksShown));
  element<HTMLFormElement>(root, '.level-board-controls').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!active) return;
    const square = parseBoardSquare(boardInput.value);
    const name = square === null ? null : boardSquareName(square);
    if (square === null || name === null) {
      onNotice('Name a board square like D7: its column letters, then its row number.', 'error');
      boardInput.focus();
      return;
    }
    cancelGesture();
    replays.stopFollowing();
    boardInput.value = name;
    if (!boardShown) setBoardShown(true);
    const area = boardSquareBounds(boardLeft(terrainLeft), square);
    hoverBoard(square);
    setText(boardReadout, `${name} · x ${area.left} to ${area.right} m, y ${area.bottom} to ${area.top} m`);
    setCamera({ x: (area.left + area.right) / 2, y: (area.bottom + area.top) / 2, worldHeight: Math.min(camera.state().worldHeight, BOARD_CELL * 4) });
  }, listen);
  action('.level-clear-labels', () => {
    const { labels } = level.definition();
    if (labels.length === 0 || !window.confirm(`Remove all ${labels.length} course labels?`)) return;
    level.metadata({ labels: [] });
  });
  action('.level-new', () => {
    const project = options.projectSave.openProject();
    if (!window.confirm(`Start a new level? This keeps flat ground and the start location, and removes all other objects and labels. ${
      project === null ? '' : `Project "${project}" keeps every saved version. `}${
      dirty() ? 'Your unsaved changes will be discarded; export first to keep them.' : ''}`)) return;
    resetSelection();
    level.replace(STARTER_LEVEL);
    fitCourse();
    onNotice(`New level started. Add terrain and place an ending trigger. ${keptNote()}`, 'info');
  });
  action('.level-export', () => {
    if (!prepareLevel()) return;
    const definition = validateLevel(level.definition());
    downloadJson('level.json', `${JSON.stringify(definition, null, 2)}\n`);
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
    setLoading('file');
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
      if (!disposed && generation === importGeneration) setLoading(null);
    }
    if (disposed || !active || generation !== importGeneration || !confirmReplacement('Importing this level')) return;
    resetSelection();
    level.replace(definition);
    markSaved();
    fitCourse();
    onNotice(`Imported level JSON. ${keptNote()}`, 'info');
  }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (active && file !== undefined) void importFile(file);
  }, listen);

  async function loadServerLevel(): Promise<void> {
    const entry = options.serverLevels[Number(serverList.value)];
    if (entry === undefined || loading !== null) return;
    const generation = ++importGeneration;
    setLoading('server');
    let definition: LevelDefinition;
    try {
      definition = await downloadServerLevel(entry, events.signal);
    } catch (error) {
      if (!disposed && generation === importGeneration) report(error);
      else if (!(error instanceof LevelError) && !(error instanceof DOMException)) throw error;
      return;
    } finally {
      if (!disposed && generation === importGeneration) setLoading(null);
    }
    // Leaving the Level tab cancels the load, as it cancels a file import.
    if (disposed || !active || generation !== importGeneration || !confirmReplacement('Loading this server level')) return;
    resetSelection();
    level.replace(definition);
    markSaved();
    fitCourse();
    onNotice(`Loaded "${entry.name}" from the server. ${keptNote()}`, 'info');
  }
  action('.level-server-load', () => { void loadServerLevel(); });

  // How a level that replaced the page's is kept, for its notice.
  function keptNote(): string {
    const project = options.projectSave.openProject();
    return project === null ? 'Export it to keep it.' : `It saves to project "${project}" as its next version.`;
  }


  function hitTest(world: Point): LevelObject | null {
    hitTestCount++;
    const objects = level.definition().objects;
    const radius = handleRadius();
    // Small entity handles, including platform ends, and enemy/hazard bodies take priority; trigger regions never
    // block terrain.
    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index];
      if (isTerrainObject(object) || isDecorationObject(object) || object.kind === 'pool') continue;
      if (object.kind === 'platform' &&
        Math.hypot(world.x - (object.x + object.travelX), world.y - (object.y + object.travelY)) <= radius) return object;
      if (Math.hypot(world.x - object.x, world.y - object.y) <= radius) return object;
      if (object.kind === 'enemy' || isHazard(object)) {
        const bound = bounds.get(object.id);
        if (bound === undefined) throw new Error('Missing authored object bounds.');
        if (boundsContain(bound, world)) return object;
      }
    }
    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index];
      if (!isTerrainObject(object)) continue;
      const bound = bounds.get(object.id);
      if (bound === undefined) throw new Error('Missing authored object bounds.');
      if (boundsContain(bound, world) && objectContains(object, world)) return object;
    }
    // Pools take what nothing else does, so the rock of their basins stays easy to pick.
    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index];
      if (object.kind !== 'pool') continue;
      const bound = bounds.get(object.id);
      if (bound === undefined) throw new Error('Missing authored object bounds.');
      if (boundsContain(bound, world)) return object;
    }
    return null;
  }

  function hitConnectionTarget(world: Point): ConnectionTarget | null {
    const radius = handleRadius();
    for (let index = connections.targets.length - 1; index >= 0; index--) {
      const target = connections.targets[index];
      if (Math.hypot(world.x - target.x, world.y - target.y) <= radius) return target;
      if (target.kind === 'platform' &&
        Math.hypot(world.x - target.x - target.travelX, world.y - target.y - target.travelY) <= radius) return target;
      const bound = bounds.get(target.id);
      if (bound === undefined) throw new Error('Missing authored connection target bounds.');
      if (boundsContain(bound, world)) return target;
    }
    return null;
  }

  function movePreview(event: PointerEvent): void {
    const client = pointFromEvent(event);
    const world = camera.unproject(client);
    if (gesture?.kind === 'pan') {
      gesture.last = client;
      if (!gesture.moved) {
        if (Math.hypot(client.x - gesture.start.x, client.y - gesture.start.y) < DRAG_DISTANCE) return;
        gesture.moved = true;
        overlay.dataset.panning = '';
        replays.stopFollowing();
      }
      setCamera({
        ...gesture.camera,
        x: gesture.camera.x - (client.x - gesture.start.x) * gesture.unitsPerPixel,
        y: gesture.camera.y + (client.y - gesture.start.y) * gesture.unitsPerPixel,
      });
      return;
    }
    if (gesture?.kind === 'pinch') return;
    if (gesture?.kind === 'connect') {
      gesture.world = world;
      gesture.target = hitConnectionTarget(world);
    } else if (gesture?.kind === 'draw') {
      const previous = gesture.samples[gesture.samples.length - 1];
      if (Math.hypot(world.x - previous.x, world.y - previous.y) >= DRAWING.samplePixels * gesture.unitsPerPixel) {
        if (gesture.samples.length >= DRAWING.samples - 1) {
          cancelGesture();
          throw new LevelError(`A stroke supports up to ${DRAWING.samples} samples. It was canceled; use shorter strokes to continue your outline.`);
        }
        gesture.samples.push(world);
      }
      drawingCursor = world;
    } else if (tool === 'draw') {
      drawingCursor = world;
    } else if (gesture?.kind === 'move') {
      const moved = Math.hypot(client.x - gesture.start.x, client.y - gesture.start.y) >= DRAG_DISTANCE;
      // A decoration moves in its own depth plane, so it stays under the pointer at any depth.
      const at = gesture.original.kind === 'decoration' ? camera.unprojectDepth(client, gesture.original.z) ?? gesture.world : world;
      gesture.preview = moved ? {
        ...gesture.original, x: gesture.original.x + at.x - gesture.world.x,
        y: gesture.original.y + at.y - gesture.world.y,
      } : gesture.original;
    } else if (gesture?.kind === 'platform-end') {
      const moved = Math.hypot(client.x - gesture.start.x, client.y - gesture.start.y) >= DRAG_DISTANCE;
      gesture.preview = moved ? {
        ...gesture.original, travelX: world.x - gesture.original.x, travelY: world.y - gesture.original.y,
      } : gesture.original;
    } else if (tool === 'place' && placement !== null) {
      placement = { ...placement, x: world.x, y: world.y };
    } else if (tool === 'place-trigger' && placement !== null && placement.kind === 'trigger') {
      const preset = TRIGGER_PRESETS.find((candidate) => candidate.id === presetId) ?? null;
      const moved = { ...placement, x: world.x, y: world.y };
      placement = preset === null ? moved : anchorTrigger(moved, preset);
    } else if (tool === 'place-enemy' && placement !== null && placement.kind === 'enemy') {
      placement = anchorEnemy({ ...placement, x: world.x, y: world.y });
    } else if (tool === 'place-hazard' && placement !== null && isHazard(placement)) {
      placement = placeHazard(placement, world);
    } else if (tool === 'place-set-piece' && setPieceId !== null) {
      moveSetPiece(world);
    } else if (tool === 'place-decoration' && placement !== null && placement.kind === 'decoration') {
      placement = placeDecoration(placement, client);
    } else if ((tool === 'start' || tool === 'player') && placement !== null && placement.kind === 'start') {
      placement = { ...placement, x: world.x, y: world.y };
    }
    draw();
  }

  // The view drag a pointer starts here: the middle button's from anywhere, or one from empty space while selecting.
  function panFrom(event: PointerEvent, deselects: boolean): Gesture {
    const client = pointFromEvent(event);
    return {
      kind: 'pan', pointerId: event.pointerId, start: client, last: client, camera: { ...camera.state() },
      unitsPerPixel: camera.state().worldHeight / Math.max(1, rect.height), moved: false, deselects,
    };
  }

  // A second finger takes over from whatever the first began, none of which is committed before it lifts, and moves the
  // view with both.
  function startPinch(): void {
    const [first, second] = [...touches.keys()] as [number, number];
    for (const id of [first, second]) {
      try {
        overlay.setPointerCapture(id);
      } catch (error) {
        // A finger the browser no longer tracks; the finger that just came down acts alone instead.
        if (!(error instanceof DOMException)) throw error;
        touches.delete(id);
        return;
      }
    }
    const a = touches.get(first)!;
    const b = touches.get(second)!;
    if (gesture?.kind === 'draw') drawingCursor = null;
    if (gesture?.kind === 'pan') delete overlay.dataset.panning;
    if (gesture?.kind === 'move' || gesture?.kind === 'platform-end') {
      selectedId = gesture.selected;
      renderControls();
    }
    gesture = { kind: 'pinch', pointerId: first, other: second, starts: [a, b], anchor: camera.unproject(midpoint(a, b)), camera: { ...camera.state() } };
    replays.stopFollowing();
    draw();
  }

  function pinchView(pinch: Extract<Gesture, { kind: 'pinch' }>): void {
    const a = touches.get(pinch.pointerId);
    const b = touches.get(pinch.other);
    if (a === undefined || b === undefined) return;
    const [a0, b0] = pinch.starts;
    const start = pinch.camera;
    // Fingers spreading apart zoom in; closing together zoom out.
    const spread = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y)) / Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const height = Math.max(MIN_VIEW_HEIGHT, Math.min(MAX_VIEW_HEIGHT, start.worldHeight * spread));
    const ratio = height / start.worldHeight;
    const unitsPerPixel = height / Math.max(1, rect.height);
    const from = midpoint(a0, b0);
    const to = midpoint(a, b);
    setCamera({
      x: pinch.anchor.x + (start.x - pinch.anchor.x) * ratio - (to.x - from.x) * unitsPerPixel,
      y: pinch.anchor.y + (start.y - pinch.anchor.y) * ratio + (to.y - from.y) * unitsPerPixel,
      worldHeight: height,
    });
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (!active) return;
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, pointFromEvent(event));
      if (touches.size === 2) startPinch();
      if (touches.size > 1) return;
    }
    if (gesture !== null || (event.button !== 0 && event.button !== 1)) return;
    // Also keeps the middle button from starting the browser's autoscroll.
    event.preventDefault();
    const client = pointFromEvent(event);
    const world = camera.unproject(client);
    if (event.button === 1) {
      gesture = panFrom(event, false);
    } else if (tool === 'select' || tool === 'decorate') {
      overlay.focus({ preventScroll: true });
      const trigger = tool === 'select' ? asTrigger(selectedObject()) : null;
      const handle = trigger === null ? null : triggerLinkHandle(trigger, camera.state().worldHeight / Math.max(1, rect.height));
      if (trigger !== null && handle !== null && Math.hypot(world.x - handle.x, world.y - handle.y) <= handleRadius()) {
        gesture = { kind: 'connect', pointerId: event.pointerId, trigger, world, target: hitConnectionTarget(world) };
        draw();
      } else {
        const decoration = tool === 'decorate' ? hitDecoration(client) : null;
        const object = tool === 'decorate' ? decoration : hitTest(world);
        if (object === null) {
          gesture = panFrom(event, true);
        } else {
          const selected = selectedId;
          selectedId = object.id;
          const platform = asPlatform(object);
          if (platform !== null &&
            Math.hypot(world.x - (platform.x + platform.travelX), world.y - (platform.y + platform.travelY)) <= handleRadius()) {
            gesture = { kind: 'platform-end', pointerId: event.pointerId, start: client, original: platform, preview: platform, selected };
          } else {
            const grab = decoration === null ? world : camera.unprojectDepth(client, decoration.z);
            if (grab !== null) gesture = { kind: 'move', pointerId: event.pointerId, start: client, world: grab, original: object, preview: object, selected };
          }
          renderControls(); draw();
        }
      }
    } else if (tool === 'draw') {
      overlay.focus({ preventScroll: true });
      gesture = {
        kind: 'draw', pointerId: event.pointerId, start: client, samples: [world],
        unitsPerPixel: camera.state().worldHeight / Math.max(1, rect.height),
      };
      drawingCursor = world;
      draw();
    } else {
      overlay.focus({ preventScroll: true });
      gesture = { kind: tool, pointerId: event.pointerId };
      movePreview(event);
    }
    if (gesture !== null) overlay.setPointerCapture(event.pointerId);
  }, listen);
  overlay.addEventListener('pointermove', (event) => {
    if (!active) return;
    if (touches.has(event.pointerId)) touches.set(event.pointerId, pointFromEvent(event));
    if (gesture?.kind === 'pinch') {
      if (event.pointerId === gesture.pointerId || event.pointerId === gesture.other) pinchView(gesture);
      return;
    }
    if (gesture !== null && gesture.pointerId !== event.pointerId) return;
    pointBoard(event);
    if (gesture === null && !isPlacementTool(tool) && tool !== 'draw') return;
    applyEdit(() => movePreview(event));
  }, listen);
  overlay.addEventListener('pointerup', (event) => {
    if (!active || gesture === null) return;
    if (gesture.kind === 'pinch') {
      // Lifting either finger ends the pinch. The other stays captured, so its lifting is heard, and starts nothing on
      // its own; another finger pinches again with it.
      if (event.pointerId !== gesture.pointerId && event.pointerId !== gesture.other) return;
      gesture = null;
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    applyEdit(() => movePreview(event));
    if (gesture === null) return;
    const finished = gesture;
    gesture = null;
    release(finished);
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    applyEdit(() => {
      if (finished.kind === 'move') {
        if (finished.preview !== finished.original) level.upsert(finished.preview);
      } else if (finished.kind === 'platform-end') {
        if (finished.preview !== finished.original) level.upsert(finished.preview);
      } else if (finished.kind === 'connect' && inside && finished.target !== null) {
        triggerEvents.appendEvent(finished.trigger.id, finished.target.kind === 'shooter'
          ? { type: 'fire-trap', trap: finished.target.id, shots: 3 }
          : { type: 'move-platform', platform: finished.target.id, to: 'toggle' });
      } else if (finished.kind === 'pan') {
        if (finished.deselects && !finished.moved) selectedId = null;
      } else if (finished.kind === 'draw' && inside) {
        const client = pointFromEvent(event);
        const moved = finished.samples.length > 1 || Math.hypot(client.x - finished.start.x, client.y - finished.start.y) >= DRAG_DISTANCE;
        const samples = moved ? [...finished.samples, camera.unproject(client)] : [finished.samples[0]];
        const closure = drawing.append(samples, {
          tolerance: DRAWING.tolerancePixels * finished.unitsPerPixel,
          closeDistance: DRAWING.closePixels * finished.unitsPerPixel,
        });
        if (closure === 'closed') finishDrawing();
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
      } else if (finished.kind === 'place-enemy' && inside && placement !== null) {
        const object = { ...placement, id: `enemy-${crypto.randomUUID()}` };
        level.upsert(object);
        selectedId = object.id;
        chooseTool('select');
      } else if (finished.kind === 'place-hazard' && inside && placement !== null) {
        const object = { ...placement, id: `${placement.kind}-${crypto.randomUUID()}` };
        level.upsert(object);
        selectedId = object.id;
        chooseTool('select');
      } else if (finished.kind === 'place-set-piece' && inside) {
        dropSetPiece();
      } else if (finished.kind === 'place-decoration' && inside && placement !== null) {
        const object = { ...placement, id: `decoration-${crypto.randomUUID()}` };
        level.upsert(object);
        selectedId = object.id;
        chooseTool('decorate');
      } else if (finished.kind === 'start' && inside && placement !== null) {
        level.upsert(placement);
        selectedId = placement.id;
        chooseTool('select');
      } else if (finished.kind === 'player' && inside && placement !== null) {
        options.player.place({ x: placement.x, y: placement.y });
        chooseTool('select');
      }
    });
    renderControls(); draw();
  }, listen);
  const cancelPointer = (event: PointerEvent): void => {
    if (gesture === null) return;
    if (event.pointerId === gesture.pointerId || (gesture.kind === 'pinch' && event.pointerId === gesture.other)) cancelGesture();
  };
  overlay.addEventListener('pointercancel', cancelPointer, listen);
  overlay.addEventListener('lostpointercapture', cancelPointer, listen);
  // Fingers lift anywhere, even off the canvas, so the window hears it first.
  const forgetTouch = (event: PointerEvent): void => { touches.delete(event.pointerId); };
  window.addEventListener('pointerup', forgetTouch, { ...listen, capture: true });
  window.addEventListener('pointercancel', forgetTouch, { ...listen, capture: true });
  overlay.addEventListener('pointerleave', () => {
    if (gesture !== null) return;
    drawingCursor = null;
    draw();
    hoverBoard(null);
    renderBoardReadout(null);
  }, listen);
  overlay.addEventListener('wheel', (event) => {
    if (!active) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS :
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1);
    zoom(Math.exp(Math.max(-1, Math.min(1, delta * WHEEL_ZOOM_RATE))), { x: event.clientX, y: event.clientY });
  }, { ...listen, passive: false });
  window.addEventListener('keydown', (event) => {
    if (!active || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() !== 'z' || event.shiftKey || (drawing.vertices.length === 0 && gesture?.kind !== 'draw')) return;
      undoDrawing();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    switch (event.key.toLowerCase()) {
      case 'escape':
        if (gesture?.kind === 'connect') cancelGesture();
        else { selectedId = null; cancelDrawing(); }
        break;
      case 'v': chooseTool('select'); break;
      case 'm':
        if (tool === 'place-set-piece') toggleSetPieceMirror();
        else if (tool === 'place' && placement !== null && placement.kind === 'terrain') {
          placement = { ...placement, mirror: !placement.mirror };
          renderControls(); draw();
        } else if (tool === 'place-decoration' && placement !== null && placement.kind === 'decoration') {
          decorationMirror = !placement.mirror;
          placement = { ...placement, mirror: decorationMirror };
          renderControls(); draw();
        } else return;
        break;
      case 'enter':
        if (target instanceof Element && target.closest('button, a[href], summary, [role="button"], [role="tab"]')) return;
        if (tool !== 'draw' && drawing.vertices.length === 0) return;
        applyEdit(finishDrawing);
        break;
      case 'delete':
        deleteSelected(); break;
      case 'backspace':
        if (tool === 'draw' || drawing.vertices.length > 0) undoDrawing();
        else deleteSelected();
        break;
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
  if (options.warnBeforeUnload !== false) {
    window.addEventListener('beforeunload', (event) => {
      if (!dirty()) return;
      event.preventDefault();
      event.returnValue = '';
    }, listen);
  }
  window.addEventListener('resize', alignOverlay, listen);
  window.addEventListener('scroll', alignOverlay, { ...listen, capture: true, passive: true });
  const resize = new ResizeObserver(alignOverlay);
  resize.observe(options.canvas);
  const unsubscribe = level.subscribe((change) => {
    commitCount++;
    surfaces.invalidate();
    connections = deriveConnectionLinks(change.level.objects);
    for (const id of change.remove) { bounds.delete(id); triggerEvents.forget(id); }
    for (const object of change.upsert) {
      bounds.set(object.id, objectBounds(object));
      if (object.kind !== 'trigger') triggerEvents.forget(object.id);
    }
    trackTerrainLeft(change.upsert, change.remove);
    entityGizmos.sync(change.upsert, change.remove);
    if (change.kind === 'replace') {
      triggerEvents.clear();
      setPieceHistory.length = 0;
      setPieceStatus = '';
    }
    if (selectedId !== null && !bounds.has(selectedId)) selectedId = null;
    // An edit ends gestures on objects; dragging the view goes on.
    if (gesture !== null && gesture.kind !== 'pan' && gesture.kind !== 'pinch') cancelGesture();
    renderControls();
    draw();
  });
  renderMeshes();
  root.inert = true;

  return {
    preparePlay: prepareLevel,
    // Replaces the whole level, for example when a project opens, and treats it as saved.
    loadLevel(definition: LevelDefinition): void {
      if (disposed) return;
      resetSelection();
      level.replace(definition);
      markSaved();
      if (active) fitCourse();
    },
    // Applies a newer version of the same level, e.g. from the project server, as one edit.
    syncLevel(definition: LevelDefinition): void {
      if (disposed) return;
      level.merge(definition);
      markSaved();
    },
    markSaved,
    isDirty: () => dirty(),
    setMode(mode: 'edit' | 'inactive'): void {
      if (disposed) return;
      if (mode === 'edit') {
        if (!active) {
          active = true;
          root.hidden = false; root.inert = false; overlay.hidden = false;
          camera.set(savedCamera === null ? camera.state() : savedCamera);
          renderLoadControls();
          renderControls();
          replays.setActive(true);
        }
        alignOverlay();
      } else {
        cancelGesture();
        if (active && drawing.vertices.length > 0) {
          onNotice('Your unfinished outline is kept in Workshop / Level. Finish shape to include it in the level.', 'info');
        }
        active = false;
        replays.setActive(false);
        importGeneration++;
        // The hidden canvas never hears these fingers lift.
        touches.clear();
        root.hidden = true; root.inert = true; overlay.hidden = true;
        setLoading(null);
        decorationPreview = null;
        options.decorations.preview(null);
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
        drawing: Object.freeze({
          vertices: Object.freeze(drawing.vertices.map((point) => Object.freeze({ ...point }))),
          strokeSamples: gesture?.kind === 'draw' ? gesture.samples.length : 0,
        }),
        dirty: dirty(), loading, objectCount: current.objects.length,
        start: level.start(), counts: level.counts(), labelCount: current.labels.length,
        camera: Object.freeze({ ...camera.state() }),
        overlay: Object.freeze({ visible: active && !overlay.hidden, x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
        commits: commitCount, hitTests: hitTestCount, draws: drawCount,
        setPieces: Object.freeze({
          armed: armedSetPiece()?.id ?? null, chosen: setPieceId, mirror: setPieceMirror, category: setPieceCategory,
          anchor: Object.freeze({ ...setPieceAnchor }), snapped: setPieceSnapped,
          history: Object.freeze(setPieceHistory.map((entry) => Object.freeze({
            name: entry.name, ids: Object.freeze([...entry.ids]), labels: Object.freeze([...entry.labels]),
          }))),
          surfaceIndexBuilds: surfaces.builds, catalog: SET_PIECE_CATALOG,
        }),
        decorations: Object.freeze({
          armed: tool === 'place-decoration' ? decorationId : null, category: decorationCategory, mirror: decorationMirror,
          preview: decorationPreview === null ? null : Object.freeze({ ...decorationPreview }),
        }),
      });
    },
    dispose(): void {
      if (disposed) return;
      cancelGesture();
      drawing.clear();
      active = false; disposed = true; importGeneration++;
      options.decorations.preview(null);
      replays.dispose();
      events.abort(); resize.disconnect(); unsubscribe(); unsubscribeMeshes();
      camera.set(null);
      bounds.clear();
      entityGizmos.destroy();
      root.remove(); overlay.remove();
    },
  };
}
