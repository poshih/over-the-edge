import type { Point } from '../config';
import { STARTER_LEVEL } from '../default-course';
import { ENEMY_BEHAVIOR, ENEMY_FACINGS, ENEMY_FIELDS, ENEMY_LIMITS, ENEMY_SPECIES, ENEMY_SPECS } from '../enemy-types';
import type { EnemySpecies } from '../enemy-types';
import {
  DECORATION_LIMITS, ILLUSION, isDecorationObject, isTerrainObject, isTriggerObject, LEVEL_LIMITS, LevelError,
  meshIsCircle, PLATFORM_LIMITS, ROCK_COLOR, SHAPE_KINDS, objectContains, objectLoops, shapeMesh, shapeOutline, terrainFromOutline, TRIGGER_LIMITS,
  TRIGGER_MARKERS, turnedTerrainBox, validateLevel, validateLevelObject,
} from '../level';
import type {
  AxeObject, BonfireObject, DecorationObject, EnemyObject, LevelDefinition, LevelObject, PlatformObject, PoolObject, ShapeKind,
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
import type { PendingEdit } from './document/history';
import type { SectionChange, Selection, StepPlace } from './document/project-document';
import type { EditorCamera, LevelEditorHandle, LevelEditorOptions, LevelEditorSnapshot, LevelEditorTool } from './level-editor-host';
import type { LevelState } from './level-state';
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
import type { LevelChecksState, ShownFinding } from './level-checks';
import { DRAWING, PolygonDraft } from './polygon-draft';
import { sectionMarkup, showSection } from './workshop-section';
import './level-editor.css';

export type { LevelEditorOptions } from './level-editor-host';

type PlacementTool = Exclude<LevelEditorTool, 'select' | 'decorate' | 'draw'>;
type Tool = LevelEditorTool;
// The depths Scenery mode picks decorations at: all of them, or one of the depth guide's layers.
type SceneryBand = 'all' | 'front' | 'near' | 'middle' | 'far';
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
  // Drags a selected object's tilt handle round its pivot.
  | { kind: 'tilt'; pointerId: number; original: TiltedObject; preview: TiltedObject }
  // Drags a selected object's turn dial left or right from the turn `from`. A decoration previews its turn; terrain's
  // draws on the course, its collision baked once the drag ends.
  | { kind: 'turn'; pointerId: number; start: Point; original: TurnedObject; from: number; turn: number; preview: DecorationObject | null }
  | { kind: PlacementTool; pointerId: number };
// What tilts in the view plane: terrain and decorations, the start's hammer and a projectile trap's aim.
type TiltedObject = TerrainObject | DecorationObject | StartObject | ShooterObject;
// What turns about its own vertical axis: decorations, and terrain a GLB draws (see asTurned).
type TurnedObject = DecorationObject | TerrainObject;
// A GLB turn whose collision bakes, shown on the course meanwhile, by the ID of what it turns.
interface Turn {
  readonly turn: number;
  readonly from: number;
  readonly assetId: string;
  // The pending edit that makes it one step once baked: the turn of an object the level holds, or the placing of `placed`
  // turned. Null for the placement's turn, which is no edit.
  readonly edit: {
    readonly pending: PendingEdit;
    readonly label: string;
    readonly coalesce: string | null;
    readonly placed: TerrainObject | null;
  } | null;
  // Its bake, kept while a drag holds objects.
  baked: readonly [MeshTerrain, MeshTerrain] | null;
}
// A level file being read or a server level being downloaded: a pending edit until it replaces the level.
interface Load {
  readonly kind: 'file' | 'server';
  readonly label: string;
  readonly pending: PendingEdit;
}
// The Level tab's sections a step can open, each a details[data-section] its markup always has.
type LevelSection = 'level-build' | 'level-inspector' | 'level-set-pieces' | 'level-decorations' | 'level-server' | 'level-file' |
  'level-labels';
type Outline = readonly Readonly<Point>[];

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEGREES = 180 / Math.PI;
const DRAG_DISTANCE = 4;
const HANDLE_PIXELS = 16;
// Q and E tilt by this, and Shift snaps a tilt drag to it.
const TILT_STEP = Math.PI / 12;
// The tilt handle's arm beyond the object, and its knob's radius, in pixels.
const TILT_ARM_PIXELS = 36;
const TILT_KNOB_PIXELS = 7;
// [ and ] turn by this, and Shift snaps a turn drag to it.
const TURN_STEP = Math.PI / 12;
// The turn dial's half width and half height, and its gap below the object, in pixels. Dragging its knob a half width
// turns the object a radian.
const TURN_DIAL_WIDTH_PIXELS = 28;
const TURN_DIAL_HEIGHT_PIXELS = 8;
const TURN_DIAL_GAP_PIXELS = 14;
const MIN_VIEW_HEIGHT = 3;
const MAX_VIEW_HEIGHT = LEVEL_LIMITS.coordinate * 4;
const VIEW_PADDING = 1.2;
const ZOOM_FACTOR = 1.35;
const WHEEL_ZOOM_RATE = 0.0015;
const GRID_TARGET_PIXELS = 48;
const DEFAULT_OBJECT_DEPTH = 1.5;
// Where a project's own model starts when placed: 3 m behind the course, 4 m tall until its GLB says how tall it is.
const PROJECT_MODEL = { height: 4, z: -3 } as const;
const WHEEL_LINE_PIXELS = 16;
/** Vertical pointer distance within which a set piece rests on the terrain top below or above it. */
const SNAP_PIXELS = 28;
// The Checks list shows this many findings, and marks the course for as many.
const CHECK_FINDINGS_SHOWN = 200;
// A finding's ring on the course, in screen pixels, and how far in picking one zooms at least, in metres of view height.
const CHECK_MARKER_PIXELS = 9;
const FOCUS_VIEW_HEIGHT = 24;
// The section each kind of load starts from.
const LOAD_SECTIONS: Readonly<Record<Load['kind'], LevelSection>> = { file: 'level-file', server: 'level-server' };
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
  if (!('loops' in mesh.collision)) return `Collides as the ${mesh.collision.type} its GLB declares, fitted to its box.`;
  const { type, loops } = mesh.collision;
  return `Collides as its ${type === 'slice' ? 'slice on the obstacle line' : 'projection along the view, its outermost outline'}: ` +
    `${loops.length} outline${loops.length === 1 ? '' : 's'}, ${loops.reduce((sum, loop) => sum + loop.length, 0)} points.`;
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
function asTilted(object: LevelObject | null): TiltedObject | null {
  return object !== null && (object.kind === 'terrain' || object.kind === 'decoration' || object.kind === 'start' ||
    object.kind === 'shooter') ? object : null;
}
// A start's hammer and a trap aim along their angle; terrain and decorations stand up from theirs.
function aimsAlongAngle(object: TiltedObject): boolean {
  return object.kind === 'start' || object.kind === 'shooter';
}
function asTurned(object: LevelObject | null): TurnedObject | null {
  return object !== null && (object.kind === 'decoration' || (object.kind === 'terrain' && object.mesh.type === 'asset')) ? object : null;
}
function turnOf(object: TurnedObject): number {
  return object.kind === 'decoration' ? object.turn : object.mesh.type === 'asset' ? object.mesh.turn : 0;
}
// `object` as what `turn` turns: GLB terrain of its asset, still at the turn it turns from; null for anything else.
function targetOf(turn: Turn, object: LevelObject | null): TerrainObject | null {
  return object !== null && object.kind === 'terrain' && object.mesh.type === 'asset' && object.mesh.assetId === turn.assetId &&
    object.mesh.turn === turn.from ? object : null;
}
// `angle` turned into -π to π, where every level angle lies.
function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
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

// Whether `tool` edits the scenery rather than the course.
function editsScenery(tool: Tool): boolean {
  return tool === 'decorate' || tool === 'place-decoration';
}

// Where the depth guide's scenery layers meet, in metres behind the course: Near reaches 12 m back and Middle 80 m; Far
// lies beyond, and Front is on or in front of the course.
const SCENERY_DEPTHS = { middle: 12, far: 80 } as const;

function inBand(z: number, band: SceneryBand): boolean {
  switch (band) {
    case 'all': return true;
    case 'front': return z >= 0;
    case 'near': return z < 0 && z >= -SCENERY_DEPTHS.middle;
    case 'middle': return z < -SCENERY_DEPTHS.middle && z >= -SCENERY_DEPTHS.far;
    case 'far': return z < -SCENERY_DEPTHS.far;
  }
}

function isSceneryBand(value: string | undefined): value is SceneryBand {
  return value === 'all' || value === 'front' || value === 'near' || value === 'middle' || value === 'far';
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
    create: (at) => ({ kind: 'shooter', id: PREVIEW_ID, firing: 'timer', x: at.x, y: at.y, angle: 0, interval: 2, delay: 0, speed: 12, damage: 20 }),
  },
  {
    id: 'axe', label: 'Swinging axe', tally: 'traps', limit: HAZARD_LIMITS.traps,
    icon: '<circle cy="-0.48" r="0.08" fill="currentColor" /><path d="M0 -0.44 L0 0.2" stroke="currentColor" stroke-width="0.08" />' +
      '<path d="M-0.44 0.14 Q0 0.32 0.44 0.14 Q0.3 0.52 0 0.56 Q-0.3 0.52 -0.44 0.14 Z" fill="currentColor" />',
    create: (at) => ({ kind: 'axe', id: PREVIEW_ID, x: at.x, y: at.y, length: 4, period: 3, offset: 0, damage: 40 }),
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

// The box around `points`, with the least y as its bottom.
function boxOf(points: readonly Point[]): Bounds {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
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

export function createLevelEditor(options: LevelEditorOptions): LevelEditorHandle {
  const { history, level, camera, onNotice } = options;
  const events = new AbortController();
  const listen = { signal: events.signal };
  const root = document.createElement('section');
  root.className = 'level-editor';
  root.hidden = true;
  root.setAttribute('aria-label', 'Level editor');
  root.innerHTML = `
    <div class="level-top">
      <label class="level-field level-name-field" for="level-name">Level name
        <input id="level-name" type="text" autocomplete="off" spellcheck="false" placeholder="Untitled level"
          title="Shown over the game's title, and to players when the project's HUD shows the level" />
      </label>
      <div class="level-action-row level-top-actions">
        <button type="button" class="button button-primary level-play">Playtest</button>
        <div class="level-save-dock"></div>
        <button type="button" class="button level-new">New level</button>
      </div>
      <p class="level-help level-player-note" hidden>Playtests start where you placed the player.
        <button type="button" class="button level-player-clear">Use the level start</button></p>
      <p class="level-save-status" role="status" aria-live="polite"></p>
      <p class="level-board-readout"></p>
    </div>
    <div class="workshop-scroll level-scroll">
      ${sectionMarkup({ id: 'level-build', title: 'Build', hint: 'Tools, view and object palettes', open: true }, `
      <fieldset class="tuning-group level-tools">
        <legend class="visually-hidden">Build</legend>
        <div class="level-layer-switch" role="group" aria-label="Edit">
          <button type="button" class="button" data-level-layer="course" aria-pressed="true"
            title="Edit what the player climbs: terrain, triggers, enemies, traps and platforms. Scenery cannot be picked.">Course</button>
          <button type="button" class="button" data-level-layer="scenery" aria-pressed="false"
            title="Edit the decorations behind and in front of the course, which never collide. The course cannot be picked.">Scenery</button>
        </div>
        <label class="level-checkbox level-show-scenery" for="level-show-scenery"
          title="Hide the decorations while you edit the course; the level keeps them, and play always shows them">
          <input id="level-show-scenery" type="checkbox" checked /> Show scenery
        </label>
        <div class="level-scenery-pick" hidden>
          <p class="level-help level-palette-label" id="level-scenery-pick-label">Pick scenery at</p>
          <div class="level-scenery-bands" role="group" aria-labelledby="level-scenery-pick-label">
            <button type="button" class="button" data-level-band="all" aria-pressed="true" title="Any depth, nearest first">All</button>
            <button type="button" class="button" data-level-band="front" aria-pressed="false"
              title="On or in front of the course">Front</button>
            <button type="button" class="button" data-level-band="near" aria-pressed="false"
              title="Up to ${SCENERY_DEPTHS.middle} m behind the course">Near</button>
            <button type="button" class="button" data-level-band="middle" aria-pressed="false"
              title="${SCENERY_DEPTHS.middle}-${SCENERY_DEPTHS.far} m behind the course">Middle</button>
            <button type="button" class="button" data-level-band="far" aria-pressed="false"
              title="More than ${SCENERY_DEPTHS.far} m behind the course">Far</button>
          </div>
        </div>
        <button type="button" class="button level-place-player" data-level-tool="player" aria-pressed="false">Place player</button>
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
          (extras.collision on its scene or a root node: box, ramp, triangle, circle or hexagon), as its outermost
          outline seen along the view when it declares projection, or else as its slice where it meets the obstacle
          line, the middle of its depth. Turning a placed GLB, with [ / ] or the dial under it, bakes its collision again
          for the turn. Imported meshes join Project / Course artwork.</p>
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
      `)}
      ${sectionMarkup({ id: 'level-inspector', title: 'Object properties', hint: 'The selected or new object', open: true }, `
      <fieldset class="tuning-group level-inspector">
        <legend class="visually-hidden">Object properties</legend>
        <p class="level-selection-name"></p>
        <div class="level-field-grid level-fields-common">
          ${numericField('x', 'Position X', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
          ${numericField('y', 'Position Y', -LEVEL_LIMITS.coordinate, LEVEL_LIMITS.coordinate)}
        </div>
        <div class="level-field-grid level-fields-angle">
          <label class="level-field" for="level-angle"><span class="level-angle-label">Tilt (°)</span>
            <input id="level-angle" type="number" min="-180" max="180" step="1" inputmode="decimal" />
          </label>
          <label class="level-field level-turn-field" for="level-turn">Turn (°)
            <input id="level-turn" type="number" min="-180" max="180" step="1" inputmode="decimal" />
          </label>
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
          <p class="level-help">Position is the starting pot center. Hammer angle is the hammer's starting direction: drag the round handle to aim it, or press Q / E.
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
            the configured bump damage (Physics / Enemies). Every enemy, dead or alive, comes back home at full
            health when the player lights a bonfire or returns at one after a death, on Reset and on an editor
            rebuild, including entering Level mode.
            Patrol motion and deaths never change saved positions.</p>
        </div>
        <div class="level-fields-bonfire">
          <p class="level-help">Position is the centre of its base; placing it rests the base on the terrain top under the
            pointer. It lights when the player's foot comes within ${BONFIRE.reach} m of the base, the dashed circle: the
            player heals to full and every enemy comes back home at full health. It burns for Physics / Bonfires' burn
            time, then goes out, and only then does coming within reach again light it; a player placed within reach,
            as on returning there after a death, lights it once they leave and come back. A death, from health running
            out or a fall out of the level, brings the player back at the bonfire lit last, healed, protected for
            Physics / Health's Respawn invulnerability and with every enemy back; the run, its clock and the rest of the
            level go on. Before any bonfire is lit, a death restarts the run. Bonfires never collide.</p>
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
          <p class="level-help">Position is the muzzle; Aim is the direction it fires: drag the round handle, or press Q / E. Timer traps fire at First shot
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
            decorations look smaller and drift slowly by. Turn spins the model about its own vertical axis to show another
            side: drag the dial under it left or right, or press [ / ]. White tint keeps the model's own colours.</p>
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
      ${sectionMarkup({ id: 'level-checks', title: 'Checks', hint: 'Placement rules and reach', open: true }, `
      <div class="level-checks">
        <p class="level-help level-checks-status" role="status" aria-live="polite"></p>
        <ol class="level-checks-list" aria-label="Findings"></ol>
        <p class="level-help">The level is checked once your edits settle, unsaved changes included. Checks never change
          the level or hold up a save. A problem breaks a placement rule; a suggestion comes from a reach model of the
          hammer rig and grip in Physics, which cannot prove or disprove play. Pick a finding to show it on the course.</p>
      </div>
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
        <p class="level-help level-set-piece-status" role="status" aria-live="polite"></p>
      </fieldset>
      `)}
      ${sectionMarkup({ id: 'level-decorations', title: 'Decoration library', hint: `${DECORATION_MODELS.length} placeholder models, scenery only` }, `
      <fieldset class="tuning-group level-decorations">
        <legend class="visually-hidden">Decoration library</legend>
        <p class="level-help">Scenery that never collides, to set the mood: far behind the course, just behind it,
          or in front of it. Pick a model, adjust its depth and height under Object properties, then click / tap the
          canvas. These are placeholders: the project's course artwork (npm run pack:course) can draw any model as the
          game's own GLB, here as in releases, and the Project category lists the models it draws, the game's own
          among them. A level whose decorations use a model neither draws cannot be loaded here.</p>
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
        <p class="level-help">Exports level.json: its name, terrain, start, triggers, enemies, decorations, bonfires, traps, liquid pools and labels only.
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
  const levelName = element<HTMLInputElement>(root, '#level-name');
  levelName.value = level.definition().name ?? '';
  const overlay = document.createElement('div');
  overlay.className = 'level-overlay';
  overlay.hidden = true;
  overlay.tabIndex = 0;
  overlay.setAttribute('aria-label', 'Level canvas. Drag a shape to move it, or empty space to pan; the middle button pans from anywhere. Plus and minus zoom. V returns to selecting. Q and E tilt the selection; [ and ] turn it. Enter finishes a drawing; Backspace undoes a stroke. Escape cancels; Delete removes selection.');
  overlay.innerHTML = `<svg class="level-guides" aria-hidden="true">
    <g class="level-camera-group">
      <path class="level-selection" fill-rule="evenodd" vector-effect="non-scaling-stroke" hidden />
      <path class="level-ghost" fill-rule="evenodd" vector-effect="non-scaling-stroke" hidden />
      <path class="level-ghost level-placing" fill-rule="evenodd" vector-effect="non-scaling-stroke" hidden />
      <g class="level-drawing-guide" hidden>
        <polyline class="level-drawing-line" vector-effect="non-scaling-stroke" />
        <path class="level-drawing-links" vector-effect="non-scaling-stroke" />
        <path class="level-drawing-nodes" vector-effect="non-scaling-stroke" />
        <circle class="level-drawing-first" vector-effect="non-scaling-stroke" />
      </g>
      <g class="level-check-markers"></g>
      <g class="level-turn-dial" hidden>
        <ellipse class="level-turn-track" vector-effect="non-scaling-stroke" />
        <circle class="level-turn-knob" vector-effect="non-scaling-stroke" />
      </g>
      <g class="level-tilt-handle" hidden>
        <line class="level-tilt-arm" vector-effect="non-scaling-stroke" />
        <circle class="level-tilt-knob" vector-effect="non-scaling-stroke" />
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
  // Terrain dropped while its turn bakes, placed once baked.
  const placingPolygon = graphic<SVGPathElement>('.level-placing');
  const drawingGuide = graphic<SVGGElement>('.level-drawing-guide');
  const drawingLine = graphic<SVGPolylineElement>('.level-drawing-line');
  const drawingLinks = graphic<SVGPathElement>('.level-drawing-links');
  const drawingNodes = graphic<SVGPathElement>('.level-drawing-nodes');
  const drawingFirst = graphic<SVGCircleElement>('.level-drawing-first');
  const tiltHandleGroup = graphic<SVGGElement>('.level-tilt-handle');
  const tiltArm = graphic<SVGLineElement>('.level-tilt-arm');
  const tiltKnob = graphic<SVGCircleElement>('.level-tilt-knob');
  const turnDialGroup = graphic<SVGGElement>('.level-turn-dial');
  const turnTrack = graphic<SVGEllipseElement>('.level-turn-track');
  const turnKnob = graphic<SVGCircleElement>('.level-turn-knob');
  const drawing = new PolygonDraft();
  const board = new LevelBoardView();
  svg.insertBefore(board.root, cameraGroup);
  const entityGizmos = new EntityGizmos(cameraGroup);
  // Findings mark the course above the gizmos.
  const checkMarkers = graphic<SVGGElement>('.level-check-markers');
  cameraGroup.append(checkMarkers);
  const checksStatus = element<HTMLParagraphElement>(root, '.level-checks-status');
  const checksList = element<HTMLOListElement>(root, '.level-checks-list');
  const checksHint = element<HTMLElement>(root, '[data-section="level-checks"] .workshop-section-hint');
  // The finding picked last, and what the markers were last drawn for, so a draw redraws them only when that changes.
  let pickedFinding: ShownFinding | null = null;
  let markedChecks: { readonly state: LevelChecksState; readonly picked: ShownFinding | null; readonly unitsPerPixel: number } | null = null;
  const inspector = element<HTMLFieldSetElement>(root, '.level-inspector');
  const levelScroll = element<HTMLElement>(root, '.level-scroll');
  const propertiesSection = element<HTMLDetailsElement>(root, '[data-section="level-inspector"]');
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
        return commit(named('Apply events to', target), 'level-inspector', selectionTo(selection()),
          (state) => state.upsert({ ...target, events: actions }));
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
  // Scenery mode picks only decorations at these depths; Course mode hides them all unless the designer shows them.
  let sceneryBand: SceneryBand = 'all';
  let showScenery = true;
  // Whether the scene was last told to show the decorations.
  let sceneryShown = true;
  let selectedId: string | null = null;
  let presetId: string | null = null;
  // The latest mesh being read to place; one finishing after another request or a change of tool is not armed.
  let meshRequest = 0;
  let placement: LevelObject | null = null;
  let gesture: Gesture | null = null;
  // GLB terrain turned while its collision bakes for the turn, by object ID, shown on the course meanwhile. A newer turn of
  // the same object supersedes one still baking.
  const turning = new Map<string, Turn>();
  // The outline being drawn: a pending edit whose strokes are steps of their own until Finish shape makes it one step.
  let outlineEdit: PendingEdit<Outline> | null = null;
  // The coalescing key of each Q, E, [ or ] burst, by the key's code, sealed when the key is released.
  const bursts = new Map<string, string>();
  // The terrain turns the course was last told to show.
  let terrainPreview: ReadonlyMap<string, number> = new Map();
  let connections = deriveConnectionLinks(level.definition().objects);
  let connectionDrawing: {
    readonly model: ConnectionLinks; readonly selectedId: string | null; readonly shown: boolean;
    readonly unitsPerPixel: number; readonly moved: LevelObject | null;
  } | null = null;
  // Fingers on the canvas, so a second one turns the first's gesture into a pinch.
  const touches = new Map<number, Point>();
  let drawingCursor: Point | null = null;
  // The level last saved or exported, compared by identity, so undoing back to it is clean again; null for unsaved changes.
  let savedDefinition: LevelDefinition | null = level.definition();
  let savedCamera: EditorCamera | null = null;
  // A level file being read, or a server level being downloaded; either blocks other loads.
  let load: Load | null = null;
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
  const setPieceButtons = new Map<string, HTMLButtonElement>();
  // The model being placed or last chosen, and the grid of the category on show: one of the library's, or the project's
  // own models, which its course artwork draws.
  let decorationId: string | null = null;
  let decorationCategory: DecorationCategory | 'project' = DECORATION_CATEGORIES[0].id;
  let decorationGridCategory: DecorationCategory | 'project' | null = null;
  let projectModels: readonly { readonly id: string; readonly name: string }[] = [];
  let projectModelsKey = '';
  // A project model armed before its GLB arrived, which takes the GLB's own height once that is known.
  let sizingModel: string | null = null;
  let decorationMirror = false;
  // A decoration about to be placed keeps the turn of the last one placed, as it keeps its mirroring.
  let decorationTurn = 0;
  let decorationPreview: DecorationObject | null = null;
  const decorationButtons = new Map<string, HTMLButtonElement>();
  const projectButtons = new Map<string, HTMLButtonElement>();
  const decorationList = select('decoration-model');
  // The project's own models in the Model list, and its category in the library.
  const projectOptions = document.createElement('optgroup');
  projectOptions.label = 'Project';
  const projectCategory = document.createElement('option');
  projectCategory.value = 'project';
  projectCategory.textContent = 'Project';
  const surfaces = new SurfaceIndex(() => level.definition());

  // Whether the level differs from the one last saved, or work it does not hold yet is pending.
  const dirty = (): boolean => level.definition() !== savedDefinition || hasPendingEdits();
  const selectedObject = () => selectedId === null ? null : level.object(selectedId);
  // The selection as a step records it, and a step's selection from it to `after`.
  const selection = (): readonly string[] => selectedId === null ? [] : [selectedId];
  const selectionTo = (after: readonly string[]): Selection => ({ before: selection(), after });
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
    if (gesture?.kind === 'move' || gesture?.kind === 'platform-end' || gesture?.kind === 'tilt' || gesture?.kind === 'turn') {
      return gesture.preview;
    }
    if (isPlacementTool(tool)) return placement;
    return null;
  };
  const handleRadius = (): number => HANDLE_PIXELS * camera.state().worldHeight / Math.max(1, rect.height);
  // Whether a drag in progress holds objects, which an edit would end; dragging the view holds none.
  const holdsObjects = (): boolean => gesture !== null && gesture.kind !== 'pan' && gesture.kind !== 'pinch';

  function report(error: unknown): void {
    if (error instanceof LevelError) {
      onNotice(`${error.message} Your current level was left unchanged.`, 'error');
    } else if (error instanceof DOMException) {
      onNotice('The file could not be read. Your current level was left unchanged.', 'error');
    } else {
      throw error;
    }
  }

  // Shows a refusal, and the controls as the level still has them.
  function refuse(error: unknown): void {
    report(error);
    renderControls();
    draw();
  }

  function applyEdit(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!(error instanceof LevelError)) throw error;
      refuse(error);
    }
  }

  // Where a point lies on the level board, for a step's name: at its square, or left of column A, which names none.
  function where(point: Point): string {
    const square = boardSquareName(boardSquareAt(boardLeft(terrainLeft), point));
    return square === null ? 'left of column A' : `at ${square}`;
  }

  // An object's name as the Level tab gives it.
  function objectName(object: LevelObject): string {
    switch (object.kind) {
      case 'terrain': return terrainName(object);
      case 'start': return 'Start location';
      case 'trigger': return `Trigger "${object.name}"`;
      case 'enemy': return ENEMY_SPECS[object.species].label;
      case 'decoration': return modelName(object.model);
      default: return hazardName(object);
    }
  }

  // A step's name: `verb` and the object it is done to, where it stands as the step is made, as in "Move Block at D7".
  function named(verb: string, object: LevelObject): string {
    return `${verb} ${objectName(object)} ${where(object)}`;
  }

  // Where a Level step is made: its section, null for the top of the tab, and the selection to restore.
  function place(section: LevelSection | null, select: Selection | null): StepPlace {
    return { tab: 'level', section, select };
  }

  // Applies `build`'s change of the level as one step named `label`, a burst keyed `coalesce` being one step; false, the
  // refusal shown, when the level refuses it.
  function commit(label: string, section: LevelSection | null, select: Selection,
    build: (state: LevelState) => SectionChange<'level'> | null, coalesce: string | null = null): boolean {
    const refusal = history.apply(level.command({ label, place: place(section, select), coalesce }, build));
    if (refusal !== null) refuse(refusal);
    return refusal === null;
  }

  // Puts `next` in place of the object it edits: the placement as a preview, or the level's object as one step, named for
  // `verb` done to the object as it was.
  function commitOrPreview(next: LevelObject, verb: string, coalesce: string | null = null): void {
    if (isPlacementTool(tool)) {
      placement = validateLevelObject(next);
      renderControls();
      draw();
    } else {
      commit(named(verb, level.object(next.id)), 'level-inspector', selectionTo(selection()), (state) => state.upsert(next),
        coalesce);
    }
  }

  // Where the level is kept: in the open server project, which saves it a moment after each change, as part of the
  // numbered level version the page plays once its game settings are saved too; or nowhere until it is exported.
  function saveState(): string {
    if (load?.kind === 'file') return 'Reading level file…';
    if (load?.kind === 'server') return 'Downloading server level…';
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
    setText(element(root, '.level-angle-label'), start !== null ? 'Hammer angle (°)' : shooter !== null ? 'Aim (°)' : 'Tilt (°)');
    const turned = asTurned(object);
    element(root, '.level-turn-field').hidden = turned === null;
    if (turned !== null) input('turn').value = String(Number((shownTurn(turned) * DEGREES).toFixed(4)));
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
        `${ENEMY_HELP[enemy.species]} Physics / Enemies sets each species' health in hit points, applied at reset or spawn, ` +
        'its armor, the closing speed a strike must beat to hurt it at all, and the hammer damage a full-force strike ' +
        `deals; slower strikes deal proportionally less. Hits have a ${ENEMY_BEHAVIOR.hitSeconds}s anti-jitter cooldown. ` +
        'Brushing or holding the head against an enemy never deals damage.';
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
    const scenery = editsScenery(tool);
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-layer]')) {
      button.setAttribute('aria-pressed', String((button.dataset.levelLayer === 'scenery') === scenery));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-band]')) {
      button.setAttribute('aria-pressed', String(button.dataset.levelBand === sceneryBand));
    }
    element(root, '.level-scenery-pick').hidden = !scenery;
    element(root, '.level-show-scenery').hidden = scenery;
    input('show-scenery').checked = showScenery;
    syncScenery();
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
      select: 'Click / tap to select; drag to move. Drag a selected object\'s round handle to tilt it, or to aim a start or a trap, ' +
        'Shift snapping to 15°; Q / E tilt or aim it 15° either way. Turn GLB terrain with the dial under it, dragging left or ' +
        'right, or with [ / ]; its collision is baked again for the turn. Drag empty space, or drag with the middle button from anywhere, to pan; the ' +
        'wheel and + / − zoom. On a touch screen, drag with two fingers to pan and pinch to zoom. Pick enemies on their bodies, ' +
        'starts and triggers near their centre handle, and liquid pools in their box where no terrain is. Select a trigger to see ' +
        'outgoing links, or a projectile trap or platform for incoming links. Links shows all; drag a trigger\'s link handle onto ' +
        'a trap or platform to connect. Escape cancels a drag without changing the level. Decorations, the scenery, are picked in ' +
        'Scenery; Show scenery hides them while you edit the course.',
      decorate: 'Click / tap a decoration to select it, nearest first; drag to move it at its own depth, or drag empty space to ' +
        'pan. Pick scenery at a depth to reach far pieces behind nearer ones. Drag its round handle to tilt it, or the dial under it ' +
        'left or right to turn it, Shift snapping to 15°; Q / E tilt it and [ / ] turn it 15°. Delete removes the selection. New ' +
        'scenery comes from the Decoration library; the sky, fog, backdrop mountains and background blur are in Project / Theme. ' +
        'The course cannot be picked in this mode; switch to Course to pick it.',
      draw: 'Click / tap corners, or hold and drag to sketch. Enter finishes; Backspace takes back the last point or stroke, ' +
        'and Undo and Redo step through them. Escape cancels. Pan with the middle button or two fingers and zoom as usual; ' +
        'your unfinished outline is kept.',
      place: 'Click / tap to place it. Adjust its properties first if needed. M mirrors it; Q / E tilt it 15°, and [ / ] turn a GLB ' +
        '15°. Escape cancels placement.',
      'place-trigger': 'Click / tap to place this trigger or pressure switch. Select it after placing, then drag its link handle ' +
        'onto a projectile trap or platform to connect; edit or remove links in Trigger events. Escape cancels placement.',
      'place-enemy': 'Click / tap the desired base to place this enemy. Tune facing, patrol radius and speed before or after placing. Escape cancels.',
      'place-hazard': 'Click / tap to place it: a bonfire by its base, which rests on the terrain top under the pointer; a projectile ' +
        'trap by its muzzle; a swinging axe by its pivot; a liquid pool by the middle of its surface; a platform by its start centre. Tune it before or after ' +
        'placing; Q / E aim a trap 15° either way. Escape cancels.',
      'place-set-piece': 'Click / tap to drop the set piece. Its base rests on the terrain top nearest the pointer; move ' +
        'away from surfaces to place it freely. M mirrors it. Escape cancels.',
      'place-decoration': 'Click / tap to place the decoration. Its base follows the pointer at its depth and rests on nearby ' +
        'terrain tops when it is close to the course. Set depth, height and tint first if you like. M mirrors it; Q / E tilt it and ' +
        '[ / ] turn it 15°. Escape cancels.',
      start: 'Click / tap the new pot-center position. Q / E aim its hammer 15° either way. Escape cancels.',
      player: 'Click / tap where the pot should stand. The player moves there, in the start\'s pose, to test that part of ' +
        'the course; the level\'s start stays where it is. Playtests and resets start there until you use the level start. Escape cancels.',
    };
    element(root, '.level-tool-help').textContent = help[tool];
    element(root, '.level-player-note').hidden = !options.player.placed();
    overlay.dataset.tool = tool;
    const { labels, name } = level.definition();
    // Typing in the field is not overwritten; leaving it commits the name.
    if (document.activeElement !== levelName) levelName.value = name ?? '';
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
    button.addEventListener('click', () => { if (active && !released(button)) armDecoration(model.id); }, listen);
    decorationButtons.set(model.id, button);
    return button;
  }

  // A button for one of the project's own models, named by its ID; its GLB shows on the course once placed.
  function projectDecorationButton(model: { readonly id: string; readonly name: string }): HTMLButtonElement {
    const cached = projectButtons.get(model.id);
    if (cached !== undefined) return cached;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button level-set-piece level-decoration';
    button.dataset.decoration = model.id;
    button.title = `Drawn by ${model.name}`;
    button.setAttribute('aria-pressed', 'false');
    button.textContent = modelName(model.id);
    button.addEventListener('click', () => { if (active && !released(button)) armDecoration(model.id); }, listen);
    projectButtons.set(model.id, button);
    return button;
  }

  // Follows the models the project's course artwork draws: the library's Project category and the Model list offer them.
  function syncProjectModels(): void {
    const models = options.decorations.models();
    const key = models.map(({ id, name }) => `${id}:${name}`).join('/');
    if (key === projectModelsKey) return;
    projectModelsKey = key;
    projectModels = models;
    projectButtons.clear();
    decorationGridCategory = null;
    projectOptions.replaceChildren(...models.filter(({ id }) => builtInDecoration(id) === undefined).map(({ id }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      return option;
    }));
    if (projectOptions.children.length > 0) decorationList.append(projectOptions);
    else projectOptions.remove();
    if (models.length > 0) select('decoration-category').append(projectCategory);
    else projectCategory.remove();
    if (models.length === 0 && decorationCategory === 'project') decorationCategory = DECORATION_CATEGORIES[0].id;
    // A model the project no longer draws cannot be placed.
    if (tool === 'place-decoration' && decorationId !== null && builtInDecoration(decorationId) === undefined &&
      !models.some(({ id }) => id === decorationId)) chooseTool('decorate');
  }

  // Where a model starts when placed: at the library's height and depth for its models, and at the GLB's own height, 3 m
  // behind the course, for the project's own; `sized` is false while that GLB has not arrived.
  function decorationStart(id: string): { readonly height: number; readonly z: number; readonly sized: boolean } {
    const library = builtInDecoration(id);
    if (library !== undefined) return { height: library.height, z: library.z, sized: true };
    const size = options.decorations.size(id);
    const height = size === null ? PROJECT_MODEL.height
      : Math.min(DECORATION_LIMITS.maximumHeight, Math.max(DECORATION_LIMITS.minimumHeight, Math.round(size.height * 100) / 100));
    return { height, z: PROJECT_MODEL.z, sized: size !== null };
  }

  // A project model armed before its GLB arrived takes the GLB's own height, unless its height was changed meanwhile.
  function sizePlacement(): void {
    if (sizingModel === null) return;
    const object = asDecoration(placement);
    if (tool !== 'place-decoration' || object === null || object.model !== sizingModel || object.height !== PROJECT_MODEL.height) {
      sizingModel = null;
      return;
    }
    const start = decorationStart(object.model);
    if (!start.sized) return;
    sizingModel = null;
    placement = validateLevelObject({ ...object, height: start.height });
  }

  function renderDecorations(): void {
    // Models are built, and thumbnails painted, on first view of their category.
    if (active && decorationGridCategory !== decorationCategory) {
      decorationGridCategory = decorationCategory;
      element(root, '.level-decoration-grid').replaceChildren(...decorationCategory === 'project'
        ? projectModels.map(projectDecorationButton)
        : DECORATION_MODELS.filter((model) => model.category === decorationCategory).map(decorationButton));
    }
    const full = level.counts().decorations >= DECORATION_LIMITS.objects;
    for (const buttons of [decorationButtons, projectButtons]) {
      for (const [id, button] of buttons) {
        button.setAttribute('aria-pressed', String(tool === 'place-decoration' && decorationId === id));
        button.disabled = full;
      }
    }
    const shown = decorationId === null ? null : builtInDecoration(decorationId) ?? null;
    const drawn = projectModels.find(({ id }) => id === decorationId);
    const depth = (z: number): string => z < 0 ? `${-z} m behind the course` : z > 0 ? `${z} m in front of it` : 'on the course';
    element(root, '.level-decoration-detail').textContent = full ? `This level already has ${DECORATION_LIMITS.objects} decorations.`
      : drawn !== undefined ? `${modelName(drawn.id)}: the project's course artwork draws it as ${drawn.name}. It starts ${
        shown === null ? 'at its own height' : `${shown.height} m tall`}, ${depth(shown?.z ?? PROJECT_MODEL.z)}.`
        : shown === null ? 'Choose a model to see what it is for.'
          : `${shown.name}: ${shown.description} It starts ${shown.height} m tall, ${depth(shown.z)}.`;
  }

  function armDecoration(id: string): void {
    cancelGesture();
    const view = camera.state();
    const start = decorationStart(id);
    tool = 'place-decoration'; decorationId = id; presetId = null; selectedId = null; drawingCursor = null;
    sizingModel = start.sized ? null : id;
    placement = validateLevelObject({
      kind: 'decoration', id: 'placement-preview', model: id, x: view.x, y: view.y - start.height / 2, z: start.z,
      height: start.height, angle: 0, turn: decorationTurn, mirror: decorationMirror, tint: 0xffffff,
    });
    renderControls();
    draw();
  }

  // The size of a decoration as placed, as wide as its turned model looks; a model the view does not know yet counts as
  // half as wide as tall.
  function decorationSize(object: DecorationObject): { width: number; height: number } {
    const model = options.decorations.size(object.model);
    if (model === null) return { width: object.height / 2, height: object.height };
    const across = Math.abs(model.width * Math.cos(object.turn)) + Math.abs(model.depth * Math.sin(object.turn));
    return { width: across * object.height / model.height, height: object.height };
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

  // The object whose tilt handle shows: the selection, in the selecting mode that picks it, as a move or a tilt drags it.
  function tiltTarget(): TiltedObject | null {
    if (gesture?.kind === 'tilt') return gesture.preview;
    if (tool !== 'select' && tool !== 'decorate') return null;
    const selected = asTilted(gesture?.kind === 'move' && gesture.preview.id === selectedId ? gesture.preview : selectedObject());
    return selected !== null && (selected.kind === 'decoration') === (tool === 'decorate') ? selected : null;
  }

  // Where an object's tilt handle stands on the course plane: its knob at the end of an arm from its pivot, along its aim
  // for a start or a trap, otherwise straight up from it as it is tilted. Null for a decoration behind the camera.
  function tiltHandle(object: TiltedObject): { readonly pivot: Point; readonly knob: Point } | null {
    const arm = TILT_ARM_PIXELS * camera.state().worldHeight / Math.max(1, rect.height);
    const direction = object.angle + (aimsAlongAngle(object) ? 0 : Math.PI / 2);
    const reach = object.kind === 'terrain' ? object.height / 2 + arm : object.kind === 'decoration' ? decorationSize(object).height + arm : arm;
    const knob = { x: object.x + Math.cos(direction) * reach, y: object.y + Math.sin(direction) * reach };
    if (object.kind !== 'decoration') return { pivot: { x: object.x, y: object.y }, knob };
    // A decoration tilts in its own depth plane, which the course plane shows larger or smaller.
    const pivot = camera.projectDepth({ x: object.x, y: object.y }, object.z);
    const end = camera.projectDepth(knob, object.z);
    return pivot === null || end === null ? null : { pivot: camera.unproject(pivot), knob: camera.unproject(end) };
  }

  function drawTiltHandle(): void {
    const target = tiltTarget();
    const handle = target === null ? null : tiltHandle(target);
    tiltHandleGroup.toggleAttribute('hidden', handle === null);
    if (handle === null) return;
    tiltArm.setAttribute('x1', String(handle.pivot.x));
    tiltArm.setAttribute('y1', String(handle.pivot.y));
    tiltArm.setAttribute('x2', String(handle.knob.x));
    tiltArm.setAttribute('y2', String(handle.knob.y));
    tiltKnob.setAttribute('cx', String(handle.knob.x));
    tiltKnob.setAttribute('cy', String(handle.knob.y));
    tiltKnob.setAttribute('r', String(TILT_KNOB_PIXELS * camera.state().worldHeight / Math.max(1, rect.height)));
  }

  // Tilts the selection, or the object about to be placed, by `step` radians, the presses of the key `code` being one step;
  // false when it has no tilt.
  function tiltBy(step: number, code: string): boolean {
    // Placing the player takes only where it stands.
    const object = tool === 'player' ? null : asTilted(inspectorObject());
    if (object === null) return false;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, angle: wrapAngle(object.angle + step) }, aimsAlongAngle(object) ? 'Aim' : 'Tilt',
      burst(code, object, 'angle')));
    return true;
  }

  // The coalescing key of the presses of the key `code` editing `object`'s `field`, which make one step until the key is
  // released; none for the placement, which is no edit.
  function burst(code: string, object: LevelObject, field: 'angle' | 'turn'): string | null {
    if (isPlacementTool(tool)) return null;
    const key = `level:${object.id}:${field}`;
    bursts.set(code, key);
    return key;
  }

  // Ends the burst of the key `code` once it is released.
  function seal(code: string): void {
    const key = bursts.get(code);
    if (key === undefined) return;
    bursts.delete(code);
    history.seal(key);
  }

  function sealBursts(): void {
    for (const code of [...bursts.keys()]) seal(code);
  }

  // The object whose turn dial shows: a selected decoration or GLB terrain, in the selecting mode that picks it, as a move,
  // a tilt or a turn drags it.
  function turnTarget(): TurnedObject | null {
    if (gesture?.kind === 'turn') return gesture.original;
    if (tool !== 'select' && tool !== 'decorate') return null;
    const dragged = gesture?.kind === 'move' || gesture?.kind === 'tilt' ? gesture.preview : null;
    const selected = asTurned(dragged !== null && dragged.id === selectedId ? dragged : selectedObject());
    return selected !== null && (selected.kind === 'decoration') === (tool === 'decorate') ? selected : null;
  }

  // The turn an object shows: the one its dial is dragged to, the one its collision is baking for, or its own.
  function shownTurn(object: TurnedObject): number {
    if (gesture?.kind === 'turn' && gesture.original.id === object.id) return gesture.turn;
    const pending = turning.get(object.id);
    // Every placement has the same ID, so a turn baking for one mesh shows only on that mesh.
    return pending !== undefined && object.kind === 'terrain' && object.mesh.type === 'asset' && object.mesh.assetId === pending.assetId
      ? pending.turn : turnOf(object);
  }

  // Where an object's turn dial stands on the course plane: a turntable under it, seen from a little above, its knob where
  // the object's front faces. Null for a decoration behind the camera.
  function turnDial(object: TurnedObject): { readonly center: Point; readonly rx: number; readonly ry: number; readonly knob: Point } | null {
    let anchor: Point;
    let bottom: number;
    if (object.kind === 'decoration') {
      // A decoration stands in its own depth plane, which the course plane shows larger or smaller.
      const outline = decorationOutline(object);
      const pivot = camera.projectDepth({ x: object.x, y: object.y }, object.z);
      if (outline === null || pivot === null) return null;
      anchor = camera.unproject(pivot);
      bottom = Math.min(...outline.map((point) => point.y));
    } else {
      anchor = object;
      bottom = objectBounds(object).bottom;
    }
    const unitsPerPixel = camera.state().worldHeight / Math.max(1, rect.height);
    const rx = TURN_DIAL_WIDTH_PIXELS * unitsPerPixel;
    const ry = TURN_DIAL_HEIGHT_PIXELS * unitsPerPixel;
    const center = { x: anchor.x, y: bottom - TURN_DIAL_GAP_PIXELS * unitsPerPixel - ry };
    const turn = shownTurn(object);
    // A mirrored object is reflected after it turns, so its front swings the other way.
    const side = object.mirror ? -1 : 1;
    return { center, rx, ry, knob: { x: center.x + side * rx * Math.sin(turn), y: center.y - ry * Math.cos(turn) } };
  }

  function drawTurnDial(): void {
    const target = turnTarget();
    const dial = target === null ? null : turnDial(target);
    turnDialGroup.toggleAttribute('hidden', dial === null);
    if (dial === null) return;
    turnTrack.setAttribute('cx', String(dial.center.x));
    turnTrack.setAttribute('cy', String(dial.center.y));
    turnTrack.setAttribute('rx', String(dial.rx));
    turnTrack.setAttribute('ry', String(dial.ry));
    turnKnob.setAttribute('cx', String(dial.knob.x));
    turnKnob.setAttribute('cy', String(dial.knob.y));
    turnKnob.setAttribute('r', String(TILT_KNOB_PIXELS * camera.state().worldHeight / Math.max(1, rect.height)));
    // On the far side of the turntable, the object faces away.
    turnKnob.classList.toggle('level-turn-behind', dial.knob.y > dial.center.y);
  }

  // Turns the selection, or the object about to be placed, so its front swings right for a positive `direction` and left
  // for a negative one, 15° a press, from the turn it shows, the presses of the key `code` being one step; false when it
  // does not turn.
  function turnBy(direction: number, code: string): boolean {
    const object = asTurned(inspectorObject());
    if (object === null) return false;
    cancelGesture();
    const step = direction * TURN_STEP * (object.mirror ? -1 : 1);
    applyEdit(() => turnObject(object, wrapAngle(shownTurn(object) + step), burst(code, object, 'turn')));
    return true;
  }

  // Turns the selection, or the object about to be placed: a decoration at once, GLB terrain once its collision is baked
  // for the turn. Turns keyed `coalesce` make one step.
  function turnObject(object: TurnedObject, turn: number, coalesce: string | null = null): void {
    if (object.kind === 'decoration') {
      if (tool === 'place-decoration') decorationTurn = turn;
      commitOrPreview({ ...object, turn }, 'Turn', coalesce);
    } else {
      turnTerrain(object, turn, coalesce);
    }
  }

  // Turns GLB terrain to `turn` once the project has baked its collision for it, each axis keeping its scale within the
  // level's limits, and shows the turn on the course meanwhile: the placement's, or an object's the level holds as a
  // pending edit. A newer turn of the same object supersedes it.
  function turnTerrain(object: TerrainObject, turn: number, coalesce: string | null): void {
    const { mesh } = object;
    if (mesh.type !== 'asset') return;
    // The level's own check of the turn, before anything bakes for it.
    validateLevelObject({ ...object, mesh: { ...mesh, turn } });
    turning.get(object.id)?.edit?.pending.cancel();
    bakeTurn(object.id, mesh.assetId, mesh.turn, turn,
      object.id === PREVIEW_ID ? null : { label: named('Turn', object), coalesce, placed: null });
  }

  // Bakes the collision of the object `id` turned from `from` to `to`, showing the turn meanwhile: the placement's, or
  // that of the pending edit `step` describes, which becomes one step once baked.
  function bakeTurn(id: string, assetId: string, from: number, to: number,
    step: Omit<NonNullable<Turn['edit']>, 'pending'> | null): void {
    const entry: Turn = {
      turn: to, from, assetId, baked: null,
      edit: step === null ? null : {
        ...step,
        pending: history.prepare({
          label: step.label, place: place(step.placed === null ? 'level-inspector' : 'level-build', null),
          cancelled: () => endTurn(id, entry),
        }),
      },
    };
    turning.set(id, entry);
    renderControls();
    draw();
    void bake(id, entry);
  }

  // Waits for a turn's bake, then makes the turn once no drag holds objects, unless a newer turn or its cancelling has
  // ended it. The project reports a bake it refuses, and the turn goes.
  async function bake(id: string, entry: Turn): Promise<void> {
    const current = (): boolean => !disposed && turning.get(id) === entry;
    let baked: [MeshTerrain | Error, MeshTerrain | Error];
    try {
      baked = await Promise.all([options.meshes.terrain(entry.assetId, entry.from), options.meshes.terrain(entry.assetId, entry.turn)]);
    } catch (error) {
      if (current()) stopTurn(id, entry);
      throw error;
    }
    if (!current()) return;
    const [before, after] = baked;
    if (before instanceof Error || after instanceof Error) {
      stopTurn(id, entry);
      return;
    }
    entry.baked = [before, after];
    // An edit would end a drag holding objects, so a turn's step waits for it to end; the placement's turn is no edit.
    if (entry.edit === null || !holdsObjects()) settleTurn(id, entry, entry.baked);
  }

  // Drops a turn that will not be made, cancelling its pending edit.
  function stopTurn(id: string, entry: Turn): void {
    if (entry.edit === null) endTurn(id, entry);
    else entry.edit.pending.cancel();
  }

  // Forgets a turn that has ended, so the course shows the object as the level turns it.
  function endTurn(id: string, entry: Turn): void {
    if (turning.get(id) !== entry) return;
    turning.delete(id);
    renderControls();
    draw();
  }

  // A turn baking for an object a change removed, or turned another way, can no longer be made: it goes at once, and its
  // pending edit once the change has been told.
  function forgetTurn(id: string, object: LevelObject | null): void {
    const entry = turning.get(id);
    if (entry === undefined || entry.edit === null || targetOf(entry, object) !== null) return;
    turning.delete(id);
    const { pending } = entry.edit;
    queueMicrotask(() => { if (!pending.done) pending.cancel(); });
  }

  // Makes a turn, baked `before` and `after`: the placement's at once, and a pending edit's as one step, built from the
  // object as the level then holds it, keeping whatever else changed meanwhile; nothing when the object has gone or turned
  // another way, and a refusal when the project no longer has the mesh.
  function settleTurn(id: string, entry: Turn, [before, after]: readonly [MeshTerrain, MeshTerrain]): void {
    const turned = (object: LevelObject | null): TerrainObject | null => {
      const terrain = targetOf(entry, object);
      return terrain === null ? null : { ...terrain, mesh: after.mesh, ...turnedTerrainBox(terrain, before, after) };
    };
    turning.delete(id);
    if (entry.edit === null) {
      const next = turned(placement);
      if (next !== null) applyEdit(() => { placement = validateLevelObject(next); });
      renderControls();
      draw();
      return;
    }
    const { pending, label, coalesce, placed } = entry.edit;
    // A placing selects what it places, unless something else has been selected meanwhile; a turn leaves the selection be.
    const selects = placed !== null && selectedId === null && tool === 'select';
    const refusal = pending.finish(level.command({
      label, coalesce,
      place: place(placed === null ? 'level-inspector' : 'level-build', selectionTo(selects ? [id] : selection())),
    }, (state) => {
      const next = turned(placed ?? (bounds.has(id) ? state.object(id) : null));
      if (next === null) return null;
      if (!options.meshes.list().some((mesh) => mesh.id === entry.assetId)) {
        throw new LevelError(`${label}: its mesh is no longer in the course artwork.`);
      }
      return state.upsert(next);
    }));
    if (refusal !== null) refuse(refusal);
    else if (selects && bounds.has(id)) {
      selectedId = id;
      renderControls();
      draw();
    }
  }

  // Makes the turns baked while a drag held objects, once none does.
  function settleTurns(): void {
    if (disposed || holdsObjects()) return;
    for (const [id, entry] of [...turning]) {
      if (entry.baked !== null && turning.get(id) === entry) settleTurn(id, entry, entry.baked);
    }
  }

  // The nearest decoration drawn under a client position.
  function hitDecoration(client: Point): DecorationObject | null {
    hitTestCount++;
    let hit: DecorationObject | null = null;
    for (const object of level.definition().objects) {
      if (object.kind !== 'decoration' || !inBand(object.z, sceneryBand) || (hit !== null && object.z <= hit.z)) continue;
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
    drawPlacings();
    if (ghostDecoration !== decorationPreview) {
      decorationPreview = ghostDecoration;
      options.decorations.preview(ghostDecoration);
    }
    entityGizmos.setSelection(selected !== null && !isTerrainObject(selected) && !isDecorationObject(selected) ? selected : null);
    entityGizmos.setGhost(ghost !== null && !isTerrainObject(ghost) && !isDecorationObject(ghost) ? ghost : null);
    drawConnections(selected);
    drawSetPieceGhost();
    drawOutline();
    drawCheckMarkers();
    drawTurnDial();
    drawTiltHandle();
    // The course shows each terrain turn still baking, and the one a dial drags.
    const dragged = gesture?.kind === 'turn' && gesture.original.kind === 'terrain' ? gesture : null;
    if (dragged !== null || turning.size > 0 || terrainPreview.size > 0) {
      const turns = new Map<string, number>([...turning].map(([id, { turn }]) => [id, turn]));
      if (dragged !== null) turns.set(dragged.original.id, dragged.turn);
      if (turns.size !== terrainPreview.size || [...turns].some(([id, turn]) => terrainPreview.get(id) !== turn)) {
        terrainPreview = turns;
        options.meshes.preview(turns);
      }
    }
  }

  // Outlines the terrain dropped while its turn bakes, which the level holds once baked.
  function drawPlacings(): void {
    const loops: Point[][] = [];
    for (const { edit } of turning.values()) if (edit !== null && edit.placed !== null) loops.push(...objectLoops(edit.placed));
    placingPolygon.toggleAttribute('hidden', loops.length === 0);
    if (loops.length > 0) placingPolygon.setAttribute('d', loopsPath(loops));
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
    // After whatever ended the drag, which may be a level edit still being told to its listeners.
    if (turning.size > 0) queueMicrotask(settleTurns);
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
    chooseTool(selecting());
    return true;
  }

  // The selecting tool of what is being edited: cancelling in Scenery stays in Scenery.
  function selecting(): 'select' | 'decorate' {
    return editsScenery(tool) ? 'decorate' : 'select';
  }

  // The decorations show, except while the designer edits the course with Show scenery off; leaving Level shows them.
  function syncScenery(): void {
    const shown = !active || editsScenery(tool) || showScenery;
    if (shown === sceneryShown) return;
    sceneryShown = shown;
    options.decorations.show(shown);
  }

  function chooseTool(next: 'select' | 'decorate' | 'start' | 'player' | 'draw'): void {
    cancelGesture();
    meshRequest++;
    // A turn baking for the placement this ends is dropped.
    turning.delete(PREVIEW_ID);
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

  // Starts afresh on a level that replaced the one shown: nothing selected, dragged or being placed.
  function resetSelection(): void {
    selectedId = null;
    chooseTool('select');
  }

  // Records `definition` as the level last saved; null records that the current level has unsaved changes.
  function markSaved(definition: LevelDefinition | null): void {
    savedDefinition = definition;
    renderStatus();
  }

  // Work the level does not hold yet: unapplied trigger events, an outline, and edits waiting for a bake or a level file.
  function hasPendingEdits(): boolean {
    if (triggerEvents.hasPendingDrafts() || drawing.vertices.length > 0 || gesture?.kind === 'draw' || load !== null) return true;
    for (const entry of turning.values()) if (entry.edit !== null) return true;
    return false;
  }

  function prepareLevel(): boolean {
    if (drawing.vertices.length > 0 || gesture?.kind === 'draw') {
      onNotice('Finish shape or cancel your unfinished outline before saving, exporting, or playtesting. Your outline is still available in Level.', 'error');
      return false;
    }
    return triggerEvents.flush();
  }

  // The outline being drawn, which a drawing press prepares as a pending edit: Undo and Redo walk its strokes, Backspace takes
  // them back, and cancelling it, as Undo does once none is left, clears it.
  function prepareOutline(): PendingEdit<Outline> {
    return history.prepare<Outline>({
      label: 'Draw shape', place: place('level-build', null),
      restore: (vertices) => {
        // A stroke being drawn would extend the outline as it was.
        if (gesture?.kind === 'draw') cancelGesture();
        drawing.restore(vertices);
        renderControls();
        draw();
      },
      cancelled: () => {
        outlineEdit = null;
        if (gesture?.kind === 'draw') cancelGesture();
        drawing.clear();
        renderControls();
        draw();
      },
    });
  }

  function liveOutline(): PendingEdit<Outline> {
    if (outlineEdit === null) throw new Error('No outline is being drawn.');
    return outlineEdit;
  }

  // Makes the outline one step, "Draw shape", which selects the shape; an outline the level refuses stays to be corrected.
  function finishDrawing(): void {
    if (gesture?.kind === 'draw') throw new LevelError('Release the current stroke before finishing the outline.');
    const object = terrainFromOutline({
      id: `shape-${crypto.randomUUID()}`, vertices: drawing.vertices,
      color: ROCK_COLOR, depth: DEFAULT_OBJECT_DEPTH, surface: DEFAULT_SURFACE,
    });
    // Built before the outline ends, so a refusal leaves it as it is.
    const change = level.upsert(object);
    const refusal = liveOutline().finish(level.command(
      { label: `Draw shape ${where(object)}`, place: place('level-build', selectionTo([object.id])) }, () => change));
    if (refusal !== null) {
      refuse(refusal);
      return;
    }
    outlineEdit = null;
    drawing.clear();
    selectedId = object.id;
    chooseTool('select');
  }

  // Backspace in Draw shape: drops the stroke being drawn, or else takes back the outline's newest stroke.
  function undoStroke(): void {
    if (gesture?.kind === 'draw') cancelGesture();
    else outlineEdit?.undoStep();
  }

  // Escape and Cancel outline: the outline goes, leaving no step.
  function cancelDrawing(): void {
    outlineEdit?.cancel();
    chooseTool(selecting());
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

  // Drops the armed set piece as one step, its parts and course labels together.
  function dropSetPiece(): void {
    const piece = armedSetPiece();
    if (piece === null) return;
    const stamp = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const placed = placeSetPiece(piece, setPieceAnchor, { mirror: setPieceMirror, stamp });
    const dropped = commit(`Place set piece ${piece.name} ${where(setPieceAnchor)}`, 'level-set-pieces', selectionTo([]),
      (state) => state.edit({
        add: placed.objects,
        labels: placed.labels.length === 0 ? undefined : [...state.definition().labels, ...placed.labels],
      }));
    if (!dropped) return;
    setPieceStatus = `Placed ${piece.name}${setPieceMirror ? ' (mirrored)' : ''}. Select any part to fine-tune it.`;
    selectedId = null;
    chooseTool('select');
  }

  // Places `object` as one step named for `verb` done where it stands, then selects it with the tool `next`.
  function placeObject(object: LevelObject, section: LevelSection, verb: string, next: 'select' | 'decorate'): void {
    if (!commit(named(verb, object), section, selectionTo([object.id]), (state) => state.upsert(object))) return;
    selectedId = object.id;
    chooseTool(next);
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
    : options.serverLevels.map((entry, index) =>
      new Option(entry.levelName === null ? entry.name : `${entry.levelName} (${entry.name})`, String(index)))));

  function renderLoadControls(): void {
    importButton.disabled = load !== null;
    serverList.disabled = !active || load !== null || options.serverLevels.length === 0;
    serverLoad.disabled = serverList.disabled;
  }

  // Starts reading a level file or downloading a server level: a pending edit named `label` until the level it reads
  // replaces the current one. Cancelling it, as Undo, leaving the tab or opening a project does, aborts `download`.
  function startLoad(kind: Load['kind'], label: string, download: AbortController | null): Load {
    const entry: Load = {
      kind, label,
      pending: history.prepare({
        label, place: place(LOAD_SECTIONS[kind], null),
        cancelled: () => {
          download?.abort();
          endLoad(entry);
        },
      }),
    };
    load = entry;
    renderLoadControls();
    renderStatus();
    return entry;
  }

  function endLoad(entry: Load): void {
    if (load !== entry) return;
    load = null;
    renderLoadControls();
    renderStatus();
  }

  // Shows why a load failed and cancels it; a load cancelled meanwhile is forgotten, whatever it read.
  function failLoad(entry: Load, error: unknown): void {
    if (entry.pending.done) {
      if (!(error instanceof LevelError) && !(error instanceof DOMException)) throw error;
      return;
    }
    entry.pending.cancel();
    report(error);
  }

  // Replaces the level with the one a load read, as the load's one step, unless it was cancelled meanwhile; only once it
  // has does the tab start afresh on it and say so. Trigger events edited meanwhile apply first, as steps of their own, so
  // Undo of the replacement brings them back; an invalid one, reported, cancels the load.
  function finishLoad(entry: Load, value: unknown, notice: string): void {
    if (entry.pending.done) return;
    endLoad(entry);
    if (!triggerEvents.flush()) {
      entry.pending.cancel();
      onNotice('The level was not loaded: fix or revert the trigger events, then load it again.', 'error');
      return;
    }
    const refusal = entry.pending.finish(level.command(
      { label: entry.label, place: place(LOAD_SECTIONS[entry.kind], selectionTo([])) }, (state) => state.replace(value)));
    if (refusal !== null) {
      refuse(refusal);
      return;
    }
    resetSelection();
    fitCourse();
    onNotice(notice, 'info');
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
    // A turn baking for the placement this replaces is dropped.
    turning.delete(PREVIEW_ID);
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
        void armWhenRead(options.meshes.terrain(mesh.id, 0).then((terrain) => terrain instanceof Error ? terrain : { id: mesh.id, terrain }));
      }, listen);
      return button;
    }));
    // A mesh taken out of the project can no longer be placed or turned: its turns still baking go, and so does a placing
    // waiting for one.
    for (const [id, entry] of [...turning]) {
      if (!meshes.some((mesh) => mesh.id === entry.assetId)) stopTurn(id, entry);
    }
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
  // The library offers the project's own models, and outlines and handles follow a decoration's model as drawn, which
  // changes as its GLB arrives.
  syncProjectModels();
  const unsubscribeDecorations = options.decorations.subscribe(() => {
    syncProjectModels();
    if (!active) return;
    sizePlacement();
    renderControls();
    draw();
  });

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
      if (next !== 'start' && next !== 'player' && next !== 'draw') throw new Error('Unknown level tool.');
      chooseTool(next);
    }, listen);
  }
  // Course selects the course, Scenery the decorations; choosing either ends any placement.
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-layer]')) {
    button.addEventListener('click', () => {
      if (!active) return;
      const next = button.dataset.levelLayer === 'scenery' ? 'decorate' : 'select';
      if (tool !== next) chooseTool(next);
    }, listen);
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level-band]')) {
    button.addEventListener('click', () => {
      const band = button.dataset.levelBand;
      if (!active || !isSceneryBand(band)) return;
      sceneryBand = band;
      renderControls();
    }, listen);
  }
  input('show-scenery').addEventListener('change', () => {
    if (!active) return;
    showScenery = input('show-scenery').checked;
    renderControls();
  }, listen);
  for (const name of ['x', 'y'] as const) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      const object = inspectorObject();
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(name).valueAsNumber }, 'Move'));
    }, listen);
  }
  input('angle').addEventListener('change', () => {
    if (!active) return;
    const object = inspectorObject();
    if (object === null || (object.kind !== 'terrain' && object.kind !== 'start' && object.kind !== 'decoration' && object.kind !== 'shooter')) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, angle: input('angle').valueAsNumber / DEGREES }, aimsAlongAngle(object) ? 'Aim' : 'Tilt'));
  }, listen);
  input('turn').addEventListener('change', () => {
    if (!active) return;
    const object = asTurned(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => turnObject(object, input('turn').valueAsNumber / DEGREES));
  }, listen);
  // A step's verb for a change of an object's size.
  const sizeVerb = (name: 'width' | 'height' | 'depth'): string => name === 'depth' ? 'Set depth of' : 'Resize';
  for (const name of ['width', 'height', 'depth'] as const) {
    input(name).addEventListener('change', () => {
      if (!active) return;
      const object = asTerrain(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => {
        const value = input(name).valueAsNumber;
        const circle = meshIsCircle(object.mesh) && (name === 'width' || name === 'height');
        commitOrPreview({ ...object, [name]: value, ...(circle ? { width: value, height: value } : {}) }, sizeVerb(name));
      });
    }, listen);
  }
  input('illusion').addEventListener('change', () => {
    if (!active) return;
    const object = asTerrain(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, illusion: input('illusion').checked }, 'Set illusion of'));
  }, listen);
  input('terrain-mirror').addEventListener('change', () => {
    if (!active) return;
    const object = asTerrain(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, mirror: input('terrain-mirror').checked }, 'Mirror'));
  }, listen);
  select('surface').addEventListener('change', () => {
    if (!active) return;
    const object = asTerrain(inspectorObject());
    const surface = select('surface').value;
    if (object === null || !isSurface(surface)) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, surface }, 'Set surface of'));
  }, listen);
  const editDecoration = (verb: string, change: (object: DecorationObject) => Partial<DecorationObject>): void => {
    if (!active) return;
    const object = asDecoration(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, ...change(object) }, verb));
  };
  decorationList.addEventListener('change', () => editDecoration('Set model of', () => {
    if (tool === 'place-decoration') decorationId = decorationList.value;
    return { model: decorationList.value };
  }), listen);
  for (const [name, field] of [['decoration-z', 'z'], ['decoration-height', 'height']] as const) {
    input(name).addEventListener('change', () => editDecoration(field === 'z' ? 'Set depth of' : 'Resize',
      () => ({ [field]: input(name).valueAsNumber })), listen);
  }
  input('decoration-tint').addEventListener('change', () => editDecoration('Set tint of',
    () => ({ tint: Number.parseInt(input('decoration-tint').value.slice(1), 16) })), listen);
  input('decoration-mirror').addEventListener('change', () => editDecoration('Mirror', () => {
    if (tool === 'place-decoration') decorationMirror = input('decoration-mirror').checked;
    return { mirror: input('decoration-mirror').checked };
  }), listen);
  select('decoration-category').addEventListener('change', () => {
    const value = select('decoration-category').value;
    const category = value === 'project' && projectModels.length > 0 ? 'project'
      : DECORATION_CATEGORIES.find((candidate) => candidate.id === value)?.id;
    if (!active || category === undefined) return;
    decorationCategory = category;
    renderControls();
  }, listen);
  input('reach').addEventListener('change', () => {
    if (!active) return;
    const object = asStart(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, reach: input('reach').valueAsNumber }, 'Set reach of'));
  }, listen);
  // A step's verb for setting the numeric field labelled `label`.
  const setField = (label: string): string => `Set ${label.toLowerCase()} of`;
  for (const name of ['patrolDistance', 'speed'] as const) {
    input(`enemy-${name}`).addEventListener('change', () => {
      if (!active) return;
      const object = asEnemy(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(`enemy-${name}`).valueAsNumber }, setField(ENEMY_FIELDS[name].label)));
    }, listen);
  }
  const editTrap = <K extends 'shooter' | 'axe'>(kind: K, name: string, label: string): void => {
    if (!active) return;
    const object = inspectorObject();
    if (object === null || object.kind !== kind) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, [name]: input(`${kind}-${name}`).valueAsNumber }, setField(label)));
  };
  for (const [name, field] of Object.entries(SHOOTER_FIELDS)) {
    input(`shooter-${name}`).addEventListener('change', () => editTrap('shooter', name, field.label), listen);
  }
  select('shooter-firing').addEventListener('change', () => {
    if (!active) return;
    const object = asShooter(inspectorObject());
    if (object === null) return;
    const firing = select('shooter-firing').value;
    if (firing !== 'timer' && firing !== 'trigger') return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, firing }, 'Set firing of'));
  }, listen);
  for (const [name, field] of Object.entries(AXE_FIELDS)) {
    input(`axe-${name}`).addEventListener('change', () => editTrap('axe', name, field.label), listen);
  }
  select('pool-liquid').addEventListener('change', () => {
    if (!active) return;
    const object = asPool(inspectorObject());
    const liquid = LIQUIDS.find((candidate) => candidate === select('pool-liquid').value);
    if (object === null || liquid === undefined) return;
    cancelGesture();
    // A pool being placed follows its new liquid in the palette.
    if (tool === 'place-hazard') presetId = liquid;
    applyEdit(() => commitOrPreview({ ...object, liquid }, 'Set liquid of'));
  }, listen);
  for (const name of ['width', 'height', 'depth'] as const) {
    input(`pool-${name}`).addEventListener('change', () => {
      if (!active) return;
      const object = asPool(inspectorObject());
      if (object === null) return;
      cancelGesture();
      applyEdit(() => commitOrPreview({ ...object, [name]: input(`pool-${name}`).valueAsNumber }, sizeVerb(name)));
    }, listen);
  }
  for (const name of ['travelX', 'travelY', 'width', 'height', 'depth', 'speed'] as const) {
    input(`platform-${name}`).addEventListener('change', () => {
      if (!active) return;
      const object = asPlatform(inspectorObject());
      if (object === null) return;
      cancelGesture();
      const verb = name === 'travelX' || name === 'travelY' ? 'Set travel of' : name === 'speed' ? 'Set speed of' : sizeVerb(name);
      applyEdit(() => commitOrPreview({ ...object, [name]: input(`platform-${name}`).valueAsNumber }, verb));
    }, listen);
  }
  select('platform-surface').addEventListener('change', () => {
    if (!active) return;
    const object = asPlatform(inspectorObject());
    const surface = SURFACES.find((candidate) => candidate === select('platform-surface').value);
    if (object === null || surface === undefined) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, surface }, 'Set surface of'));
  }, listen);
  input('platform-ride').addEventListener('change', () => {
    if (!active) return;
    const object = asPlatform(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, ride: input('platform-ride').checked }, 'Set boarding of'));
  }, listen);
  select('enemy-facing').addEventListener('change', () => {
    if (!active) return;
    const object = asEnemy(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => {
      const facing = ENEMY_FACINGS.find((candidate) => candidate === select('enemy-facing').value);
      if (facing === undefined) throw new LevelError('Choose a supported enemy facing.');
      commitOrPreview({ ...object, facing }, 'Set facing of');
    });
  }, listen);
  input('trigger-name').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, name: input('trigger-name').value }, 'Rename'));
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
      commitOrPreview({ ...object, region }, 'Set region of');
    });
  }, listen);
  input('trigger-radius').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null || object.region.type !== 'circle') return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, region: { type: 'circle', radius: input('trigger-radius').valueAsNumber } }, 'Resize'));
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
      }, 'Resize'));
    }, listen);
  }
  select('trigger-activation').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => commitOrPreview({ ...object, activation: select('trigger-activation').value === 'on-enter' ? 'on-enter' : 'once' },
      'Set activation of'));
  }, listen);
  select('trigger-marker').addEventListener('change', () => {
    if (!active) return;
    const object = asTrigger(inspectorObject());
    if (object === null) return;
    cancelGesture();
    applyEdit(() => {
      const marker = TRIGGER_MARKERS.find((candidate) => candidate === select('trigger-marker').value);
      if (marker === undefined) throw new LevelError('Choose a supported trigger marker.');
      commitOrPreview({ ...object, marker }, 'Set marker of');
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
  function deleteSelected(): void {
    if (selectedId === null || (tool !== 'select' && tool !== 'decorate')) return;
    const object = selectedObject();
    if (object === null || object.kind === 'start') return;
    cancelGesture();
    if (commit(named('Delete', object), 'level-inspector', selectionTo([]), (state) => state.remove(object.id))) selectedId = null;
  }
  action('.level-delete', deleteSelected);
  action('.level-drawing-finish', () => applyEdit(finishDrawing));
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
  // A rename is one level edit, saved and exported with the rest; an empty name leaves the level unnamed.
  levelName.addEventListener('change', () => {
    const typed = levelName.value.trim();
    const name = typed === '' ? null : typed;
    if (active) {
      commit(name === null ? 'Rename level' : `Rename level to "${name}"`, null, selectionTo(selection()),
        (state) => state.metadata({ name }));
    }
    levelName.value = level.definition().name ?? '';
  }, listen);
  action('.level-clear-labels', () => {
    const { labels } = level.definition();
    if (labels.length === 0 || !window.confirm(`Remove all ${labels.length} course labels?`)) return;
    commit('Remove course labels', 'level-labels', selectionTo(selection()), (state) => state.metadata({ labels: [] }));
  });
  // Starts afresh with flat ground and the start location, as one step that Undo takes back. Unapplied trigger events
  // apply first, as steps of their own, so that Undo brings them back; an invalid one, reported, keeps the level.
  action('.level-new', () => {
    if (!triggerEvents.flush()) return;
    if (!commit('Start new level', null, selectionTo([]), (state) => state.replace(STARTER_LEVEL))) return;
    resetSelection();
    fitCourse();
    onNotice(`New level started. Add terrain and place an ending trigger. ${keptNote()}`, 'info');
  });
  action('.level-export', () => {
    if (!prepareLevel()) return;
    const exported = level.definition();
    downloadJson('level.json', `${JSON.stringify(validateLevel(exported), null, 2)}\n`);
    // Exporting saves the level only while no server project is open, which has yet to save it.
    if (options.projectSave.openProject() === null) markSaved(exported);
    onNotice('Exported level.json. It contains only authored level data, ready for a game-only build.', 'info');
  });
  action('.level-import', () => fileInput.click());

  // Reads a level file as a pending edit, then replaces the level with it as one step. Unapplied trigger events apply first,
  // as steps of their own; an invalid one, reported, keeps the level.
  async function importFile(file: File): Promise<void> {
    if (file.size > LEVEL_LIMITS.fileBytes) {
      onNotice(`Level JSON must be at most ${LEVEL_LIMITS.fileBytes / (1024 * 1024)} MiB. Your current level was not changed.`, 'error');
      return;
    }
    if (!triggerEvents.flush()) return;
    // A newer file supersedes one still being read.
    load?.pending.cancel();
    const entry = startLoad('file', `Import level ${file.name}`, null);
    let raw: unknown;
    try {
      const text = await file.text();
      try {
        raw = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new LevelError('Level JSON is malformed.');
      }
    } catch (error) {
      failLoad(entry, error);
      return;
    }
    finishLoad(entry, raw, `Imported level JSON. ${keptNote()}`);
  }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (active && file !== undefined) void importFile(file);
  }, listen);

  // Downloads a server level as a pending edit, then replaces the level with it as one step. Unapplied trigger events apply
  // first, as steps of their own; an invalid one, reported, keeps the level.
  async function loadServerLevel(): Promise<void> {
    const entry = options.serverLevels[Number(serverList.value)];
    if (entry === undefined || load !== null || !triggerEvents.flush()) return;
    const download = new AbortController();
    const started = startLoad('server', `Load level ${entry.levelName ?? entry.name}`, download);
    let definition: LevelDefinition;
    try {
      definition = await downloadServerLevel(entry, download.signal);
    } catch (error) {
      failLoad(started, error);
      return;
    }
    finishLoad(started, definition, `Loaded "${entry.name}" from the server. ${keptNote()}`);
  }
  action('.level-server-load', () => { void loadServerLevel(); });

  // How a level that replaced the page's is kept, for its notice.
  function keptNote(): string {
    const project = options.projectSave.openProject();
    return project === null ? 'Export it to keep it.' : `It saves to project "${project}" as its next version.`;
  }

  // Choosing an object on the canvas brings its properties into view, unless they already fill half of it.
  function revealProperties(): void {
    if (propertiesSection.open) {
      const view = levelScroll.getBoundingClientRect();
      const box = propertiesSection.getBoundingClientRect();
      const seen = Math.min(view.bottom, box.bottom) - Math.max(view.top, box.top);
      if (seen >= Math.min(box.height, view.height) / 2) return;
    }
    showSection(propertiesSection);
  }

  // Checks: their status, counts in the section's heading, and one entry per finding.
  function renderChecks(): void {
    const state = options.checks.state();
    if (pickedFinding !== null && !state.findings.includes(pickedFinding)) pickedFinding = null;
    const problems = state.findings.filter((finding) => finding.severity === 'problem').length;
    const suggestions = state.findings.length - problems;
    const counts = state.findings.length === 0 ? 'No findings' : [
      problems === 0 ? '' : `${problems} problem${problems === 1 ? '' : 's'}`,
      suggestions === 0 ? '' : `${suggestions} suggestion${suggestions === 1 ? '' : 's'}`,
    ].filter((part) => part !== '').join(', ');
    const status: string[] = [];
    if (state.checking) status.push('Checking…');
    if (state.failure !== null) status.push(state.failure);
    else if (state.current || state.findings.length > 0) status.push(state.current ? `${counts}.` : `${counts}, before your latest edits.`);
    if (state.stopped !== null) status.push(`They stopped at their work budget, so the checks after it did not run: ${state.stopped.message}`);
    checksStatus.textContent = status.join(' ');
    const hint = state.findings.length === 0 ? 'Placement rules and reach' : counts;
    if (checksHint.textContent !== hint) {
      checksHint.textContent = hint;
      checksHint.title = hint;
    }
    checksList.dataset.stale = String(!state.current);
    const items = state.findings.slice(0, CHECK_FINDINGS_SHOWN).map((finding, index) => {
      const item = document.createElement('li');
      item.className = 'level-check';
      item.dataset.severity = finding.severity;
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'level-check-pick';
      pick.dataset.finding = String(index);
      if (finding === pickedFinding) pick.setAttribute('aria-current', 'true');
      const kind = document.createElement('span');
      kind.className = 'level-check-kind';
      kind.textContent = finding.severity === 'problem' ? 'Problem' : 'Suggestion';
      const message = document.createElement('span');
      message.className = 'level-check-message';
      message.textContent = finding.message;
      pick.append(kind, message);
      if (finding.source !== null) {
        const source = document.createElement('span');
        source.className = 'level-check-source';
        source.textContent = finding.source;
        pick.append(source);
      }
      item.append(pick);
      return item;
    });
    if (state.findings.length > CHECK_FINDINGS_SHOWN) {
      const more = document.createElement('li');
      more.className = 'level-help';
      more.textContent = `And ${state.findings.length - CHECK_FINDINGS_SHOWN} more, shown once those above are fixed.`;
      items.push(more);
    }
    // Rebuilding the list keeps keyboard focus on the entry in the same place.
    const focused = document.activeElement instanceof HTMLElement && checksList.contains(document.activeElement)
      ? document.activeElement.dataset.finding : undefined;
    checksList.replaceChildren(...items);
    if (focused !== undefined) {
      const entries = checksList.querySelectorAll<HTMLButtonElement>('.level-check-pick');
      (checksList.querySelector<HTMLButtonElement>(`.level-check-pick[data-finding="${focused}"]`) ?? entries[entries.length - 1])
        ?.focus({ preventScroll: true });
    }
  }

  // Shows a finding on the course: centres the view on it, zoomed in at least as far as FOCUS_VIEW_HEIGHT, and selects
  // the first of its objects the level still has.
  function pickFinding(finding: ShownFinding): void {
    pickedFinding = finding;
    const id = finding.objects.find((candidate) => bounds.has(candidate)) ?? null;
    const box = id === null ? undefined : bounds.get(id);
    const at = finding.at ?? (box === undefined ? null : { x: (box.left + box.right) / 2, y: (box.bottom + box.top) / 2 });
    if (id !== null && level.object(id).kind !== 'decoration') {
      if (tool !== 'select') chooseTool('select');
      selectedId = id;
    }
    if (at !== null) centreOn(at);
    // Marked in place, so the entry keeps its focus.
    const index = String(options.checks.state().findings.indexOf(finding));
    for (const pick of checksList.querySelectorAll<HTMLButtonElement>('.level-check-pick')) {
      if (pick.dataset.finding === index) pick.setAttribute('aria-current', 'true');
      else pick.removeAttribute('aria-current');
    }
    renderControls();
    draw();
  }

  // Centres the view on `at`, zoomed in at least as far as FOCUS_VIEW_HEIGHT, and stops following a replay.
  function centreOn(at: Point): void {
    replays.stopFollowing();
    setCamera({ x: at.x, y: at.y, worldHeight: Math.min(camera.state().worldHeight, FOCUS_VIEW_HEIGHT) });
  }

  // The first of `ids` the level holds that the current mode picks: decorations in Scenery, the rest in Course.
  function selectable(ids: readonly string[]): string | null {
    const scenery = editsScenery(tool);
    return ids.find((id) => bounds.has(id) && (level.object(id).kind === 'decoration') === scenery) ?? null;
  }

  // Whether any of the box around the course-plane `points` shows in the overlay.
  function shows(points: readonly Point[]): boolean {
    const seen = boxOf(points.map(local));
    return seen.right >= 0 && seen.left <= rect.width && seen.top >= 0 && seen.bottom <= rect.height;
  }

  // Centres the view on the object `id` when none of it shows: a course object as picking a finding does; a decoration,
  // which its depth draws larger or smaller about the camera, on its middle on its own depth plane, which the middle of the
  // view then shows. A decoration keeps the zoom, since zooming in brings the camera nearer and can put it behind the
  // camera; one already behind it has no outline to show and is centred all the same, ready for zooming out.
  function reveal(id: string): void {
    const object = level.object(id);
    if (object.kind === 'decoration') {
      const outline = decorationOutline(object);
      if (outline !== null && shows(outline)) return;
      const rise = object.height / 2;
      replays.stopFollowing();
      setCamera({ ...camera.state(), x: object.x - Math.sin(object.angle) * rise, y: object.y + Math.cos(object.angle) * rise });
      return;
    }
    const box = bounds.get(id);
    if (box === undefined) throw new Error('Missing authored object bounds.');
    const { left, right, bottom, top } = box;
    if (shows([{ x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }])) return;
    centreOn({ x: (left + right) / 2, y: (bottom + top) / 2 });
  }

  // A ring on the course for each placed finding, a constant size on screen; the picked one is larger.
  function drawCheckMarkers(): void {
    const state = options.checks.state();
    const unitsPerPixel = camera.state().worldHeight / Math.max(1, rect.height);
    const marked = markedChecks;
    if (marked !== null && marked.state === state && marked.picked === pickedFinding && marked.unitsPerPixel === unitsPerPixel) return;
    markedChecks = { state, picked: pickedFinding, unitsPerPixel };
    checkMarkers.dataset.stale = String(!state.current);
    const rings: SVGCircleElement[] = [];
    for (const finding of state.findings.slice(0, CHECK_FINDINGS_SHOWN)) {
      if (finding.at === null) continue;
      const picked = finding === pickedFinding;
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('class', `level-check-marker${finding.severity === 'problem' ? ' is-problem' : ''}${picked ? ' is-picked' : ''}`);
      ring.setAttribute('cx', String(finding.at.x));
      ring.setAttribute('cy', String(finding.at.y));
      ring.setAttribute('r', String(CHECK_MARKER_PIXELS * (picked ? 1.6 : 1) * unitsPerPixel));
      ring.setAttribute('vector-effect', 'non-scaling-stroke');
      rings.push(ring);
    }
    checkMarkers.replaceChildren(...rings);
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
    } else if (gesture?.kind === 'tilt') {
      const original = gesture.original;
      // A decoration tilts in its own depth plane, so its knob stays under the pointer at any depth.
      const at = original.kind === 'decoration' ? camera.unprojectDepth(client, original.z) : world;
      if (at !== null && (at.x !== original.x || at.y !== original.y)) {
        const angle = Math.atan2(at.y - original.y, at.x - original.x) - (aimsAlongAngle(original) ? 0 : Math.PI / 2);
        gesture.preview = { ...original, angle: wrapAngle(event.shiftKey ? Math.round(angle / TILT_STEP) * TILT_STEP : angle) };
      }
    } else if (gesture?.kind === 'turn') {
      // The object's front follows the pointer left and right, a mirrored object's too.
      const original = gesture.original;
      const turn = gesture.from + (original.mirror ? -1 : 1) * (client.x - gesture.start.x) / TURN_DIAL_WIDTH_PIXELS;
      gesture.turn = wrapAngle(event.shiftKey ? Math.round(turn / TURN_STEP) * TURN_STEP : turn);
      if (original.kind === 'decoration') gesture.preview = { ...original, turn: gesture.turn };
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
      const tilted = tiltTarget();
      const tilt = tilted === null ? null : tiltHandle(tilted);
      const turned = turnTarget();
      const dial = turned === null ? null : turnDial(turned);
      const trigger = tool === 'select' ? asTrigger(selectedObject()) : null;
      const handle = trigger === null ? null : triggerLinkHandle(trigger, camera.state().worldHeight / Math.max(1, rect.height));
      if (tilted !== null && tilt !== null && Math.hypot(world.x - tilt.knob.x, world.y - tilt.knob.y) <= handleRadius()) {
        gesture = { kind: 'tilt', pointerId: event.pointerId, original: tilted, preview: tilted };
        draw();
      } else if (turned !== null && dial !== null && Math.hypot(world.x - dial.knob.x, world.y - dial.knob.y) <= handleRadius()) {
        const from = shownTurn(turned);
        gesture = {
          kind: 'turn', pointerId: event.pointerId, start: client, original: turned, from, turn: from,
          preview: turned.kind === 'decoration' ? turned : null,
        };
        draw();
      } else if (trigger !== null && handle !== null && Math.hypot(world.x - handle.x, world.y - handle.y) <= handleRadius()) {
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
          if (object.id !== selected) revealProperties();
        }
      }
    } else if (tool === 'draw') {
      overlay.focus({ preventScroll: true });
      outlineEdit ??= prepareOutline();
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
      settleTurns();
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
      if (finished.kind === 'move' || finished.kind === 'platform-end') {
        if (finished.preview !== finished.original) {
          commit(named(finished.kind === 'move' ? 'Move' : 'Set travel of', finished.original), 'level-inspector',
            { before: finished.selected === null ? [] : [finished.selected], after: [finished.original.id] },
            (state) => state.upsert(finished.preview));
        }
      } else if (finished.kind === 'tilt') {
        if (finished.preview !== finished.original) {
          commit(named(aimsAlongAngle(finished.original) ? 'Aim' : 'Tilt', finished.original), 'level-inspector',
            selectionTo([finished.original.id]), (state) => state.upsert(finished.preview));
        }
      } else if (finished.kind === 'turn') {
        if (finished.turn !== finished.from) turnObject(finished.original, finished.turn);
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
        const before = drawing.vertices;
        const closure = drawing.append(samples, {
          tolerance: DRAWING.tolerancePixels * finished.unitsPerPixel,
          closeDistance: DRAWING.closePixels * finished.unitsPerPixel,
        });
        // A stroke that added points is a step of the outline's own.
        if (drawing.vertices !== before) {
          liveOutline().step(`Draw ${moved ? 'stroke' : 'point'} ${where(samples[0])}`, before, drawing.vertices);
        }
        if (closure === 'closed') finishDrawing();
      } else if (finished.kind === 'place' && inside && placement !== null) {
        const object = { ...placement, id: `shape-${crypto.randomUUID()}` };
        const baking = turning.get(PREVIEW_ID);
        const terrain = baking === undefined ? null : targetOf(baking, object);
        if (baking !== undefined && terrain !== null) {
          // The turn the placement shows is still baking, so it is placed, as one step, once baked.
          validateLevelObject({ ...terrain, mesh: { ...terrain.mesh, turn: baking.turn } });
          bakeTurn(terrain.id, baking.assetId, baking.from, baking.turn, { label: named('Place', terrain), coalesce: null, placed: terrain });
          chooseTool('select');
        } else {
          placeObject(object, 'level-build', 'Place', 'select');
        }
      } else if (finished.kind === 'place-trigger' && inside && placement !== null) {
        placeObject({ ...placement, id: `trigger-${crypto.randomUUID()}` }, 'level-build', 'Place', 'select');
      } else if (finished.kind === 'place-enemy' && inside && placement !== null) {
        placeObject({ ...placement, id: `enemy-${crypto.randomUUID()}` }, 'level-build', 'Place', 'select');
      } else if (finished.kind === 'place-hazard' && inside && placement !== null) {
        placeObject({ ...placement, id: `${placement.kind}-${crypto.randomUUID()}` }, 'level-build', 'Place', 'select');
      } else if (finished.kind === 'place-set-piece' && inside) {
        dropSetPiece();
      } else if (finished.kind === 'place-decoration' && inside && placement !== null) {
        placeObject({ ...placement, id: `decoration-${crypto.randomUUID()}` }, 'level-decorations', 'Place', 'decorate');
      } else if (finished.kind === 'start' && inside && placement !== null) {
        placeObject(placement, 'level-build', 'Move', 'select');
      } else if (finished.kind === 'player' && inside && placement !== null) {
        options.player.place({ x: placement.x, y: placement.y });
        chooseTool('select');
      }
    });
    renderControls(); draw();
    settleTurns();
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
    // Keys with Ctrl or Cmd are the browser's, or Undo and Redo, which the Workshop's history controls handle.
    if (!active || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    // Workshop navigation and the width handle own their keys.
    if (target instanceof Element && target.closest('.workshop-navigation, .workshop-width-handle')) return;
    if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    switch (event.key.toLowerCase()) {
      case 'escape':
        if (gesture?.kind === 'connect') cancelGesture();
        else { selectedId = null; cancelDrawing(); }
        break;
      case 'v': chooseTool(selecting()); break;
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
      case 'q':
      case 'e':
        if (!tiltBy(event.key.toLowerCase() === 'q' ? TILT_STEP : -TILT_STEP, event.code)) return;
        break;
      case '[':
      case ']':
        if (!turnBy(event.key === ']' ? 1 : -1, event.code)) return;
        break;
      case 'enter':
        if (target instanceof Element && target.closest('button, a[href], summary, [role="button"], [role="tab"]')) return;
        if (tool !== 'draw' && drawing.vertices.length === 0) return;
        applyEdit(finishDrawing);
        break;
      case 'delete':
        deleteSelected(); break;
      case 'backspace':
        if (tool === 'draw' || drawing.vertices.length > 0) undoStroke();
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
  // Releasing the key ends its burst, even once the tab is left.
  window.addEventListener('keyup', (event) => seal(event.code), listen);
  window.addEventListener('blur', () => {
    cancelGesture();
    // Keys released while the page has no focus are never heard.
    sealBursts();
  }, listen);
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
  // The tab follows the document's level: each change updates what it draws and indexes from the objects it touched, Undo
  // and Redo restore the selection their step recorded, and another project's level starts the tab afresh. Hearing a
  // change, it never changes the level itself; what must waits a microtask.
  const unsubscribe = history.document.subscribe('level', (change, cause, step) => {
    commitCount++;
    const { kind, upsert, remove } = change.delta;
    const restoring = cause === 'undo' || cause === 'redo';
    surfaces.invalidate();
    connections = deriveConnectionLinks(change.after.objects);
    // Unapplied trigger events go with their trigger, and with any trigger Undo or Redo changes.
    for (const id of remove) { bounds.delete(id); triggerEvents.forget(id); }
    for (const object of upsert) {
      bounds.set(object.id, objectBounds(object));
      if (restoring || object.kind !== 'trigger') triggerEvents.forget(object.id);
    }
    trackTerrainLeft(upsert, remove);
    entityGizmos.sync(upsert, remove);
    if (kind === 'replace') {
      triggerEvents.clear();
      setPieceStatus = '';
    }
    for (const id of remove) forgetTurn(id, null);
    for (const object of upsert) forgetTurn(object.id, object);
    const restored = restoring ? step?.place.select ?? null : null;
    if (cause === 'open') resetSelection();
    else if (restored !== null) selectedId = selectable(cause === 'undo' ? restored.before : restored.after);
    if (selectedId !== null && !bounds.has(selectedId)) selectedId = null;
    // An edit ends gestures on objects; dragging the view goes on.
    if (holdsObjects()) cancelGesture();
    renderControls();
    draw();
    if (!active) return;
    if (cause === 'open') fitCourse();
    else if (restored !== null && selectedId !== null) reveal(selectedId);
  });
  renderMeshes();
  root.inert = true;
  // One listener for the list, which every check rebuilds.
  checksList.addEventListener('click', (event) => {
    const pick = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.level-check-pick') : null;
    const finding = pick === null ? undefined : options.checks.state().findings[Number(pick.dataset.finding)];
    if (finding !== undefined) pickFinding(finding);
  }, listen);
  const unsubscribeChecks = options.checks.subscribe(() => {
    renderChecks();
    // Only the list and the rings, never a full draw: the checks can change while the level tells its listeners of an
    // edit this editor has yet to hear of, so nothing here may read the selection or the level.
    if (active && !disposed && rect.width > 0 && rect.height > 0) drawCheckMarkers();
  });
  renderChecks();

  return {
    preparePlay: prepareLevel,
    markSaved,
    hasPendingEdits,
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
          options.checks.setActive(true);
        }
        alignOverlay();
      } else {
        cancelGesture();
        if (active && drawing.vertices.length > 0) {
          onNotice('Your unfinished outline is kept in Workshop / Level. Finish shape to include it in the level.', 'info');
        }
        active = false;
        replays.setActive(false);
        options.checks.setActive(false);
        // Leaving the tab cancels a level file being read or a server level being downloaded.
        load?.pending.cancel();
        // The hidden canvas never hears these fingers lift.
        touches.clear();
        root.hidden = true; root.inert = true; overlay.hidden = true;
        decorationPreview = null;
        options.decorations.preview(null);
        syncScenery();
        terrainPreview = new Map();
        options.meshes.preview(terrainPreview);
        camera.set(null);
      }
    },
    snapshot(): LevelEditorSnapshot {
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
        dirty: dirty(), loading: load?.kind ?? null, objectCount: current.objects.length,
        start: level.start(), counts: level.counts(), labelCount: current.labels.length,
        camera: Object.freeze({ ...camera.state() }),
        overlay: Object.freeze({ visible: active && !overlay.hidden, x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
        commits: commitCount, hitTests: hitTestCount, draws: drawCount,
        setPieces: Object.freeze({
          armed: armedSetPiece()?.id ?? null, chosen: setPieceId, mirror: setPieceMirror, category: setPieceCategory,
          anchor: Object.freeze({ ...setPieceAnchor }), snapped: setPieceSnapped,
          surfaceIndexBuilds: surfaces.builds, catalog: SET_PIECE_CATALOG,
        }),
        decorations: Object.freeze({
          armed: tool === 'place-decoration' ? decorationId : null, category: decorationCategory, mirror: decorationMirror,
          turn: decorationTurn,
          preview: decorationPreview === null ? null : Object.freeze({ ...decorationPreview }),
        }),
      });
    },
    dispose(): void {
      if (disposed) return;
      cancelGesture();
      // The pending edits it made end with it.
      outlineEdit?.cancel();
      load?.pending.cancel();
      for (const { edit } of [...turning.values()]) edit?.pending.cancel();
      sealBursts();
      active = false; disposed = true;
      options.decorations.preview(null);
      syncScenery();
      options.meshes.preview(new Map());
      replays.dispose();
      options.checks.setActive(false);
      unsubscribeChecks();
      events.abort(); resize.disconnect(); unsubscribe(); unsubscribeMeshes(); unsubscribeDecorations();
      camera.set(null);
      bounds.clear();
      entityGizmos.destroy();
      root.remove(); overlay.remove();
    },
  };
}
