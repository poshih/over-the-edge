// Editor-only rendering helpers for non-terrain objects at their authored positions.
// Terrain keeps using shapeVertices/objectVertices/objectContains from ../level; these gizmos
// share lightweight SVG geometry between persistent objects, selection, and placement previews.
import type { Point } from '../config';
import { ENEMY_DIRECTION, ENEMY_SPECS, enemyBounds } from '../enemy-types';
import type { EnemyFacing, EnemySpecies } from '../enemy-types';
import { AXE, BONFIRE, SHOOTER } from '../hazards';
import { triggerBounds } from '../level';
import type { AxeObject, EnemyObject, LevelObject, PlatformObject, PoolObject, ShooterObject, StartObject, TriggerObject } from '../level';
import type { ConnectionLink, ConnectionTarget } from './connection-links';

export interface Bounds { left: number; right: number; bottom: number; top: number }
// Starts, triggers, enemies, bonfires, traps, liquid pools and platforms; terrain and decorations draw themselves in the scene.
export type GizmoObject = Exclude<LevelObject, { kind: 'terrain' } | { kind: 'decoration' }>;

const SVG_NS = 'http://www.w3.org/2000/svg';
export const START_MARKER_RADIUS = 0.6;
const START_CROSS = 0.42;
const HANDLE_RADIUS = 0.22;
const LINK_HANDLE_PIXELS = 6;
const LINK_HANDLE_OFFSET_PIXELS = 32;
const CONNECTION_GAP_PIXELS = 4;
const ARROW_PIXELS = { length: 9, halfWidth: 4 } as const;
const FLAG_POLE_HEIGHT = 0.6;
const FLAG_WIDTH = 0.36;
const UPDRAFT_GLYPH = { halfWidth: 0.2, rise: 0.16, spacing: 0.24, rows: 2 } as const;
const SWITCH_HEIGHT = 0.08;
// A flame standing on a bonfire's base, in metres.
const FLAME_GLYPH = 'M 0 .15 C .32 .4 .36 .78 0 1.15 C -.08 .9 -.3 .78 -.2 .55 C -.3 .4 -.16 .25 0 .15 Z';
// How far a projectile trap's aim shows when it is not selected; selected, it shows the projectiles' whole range.
const AIM_GUIDE = 1.6;
// The top of an axe's mount above its pivot, and half its width, which the blade, edge-on, never exceeds.
const AXE_MOUNT = 0.45;
const AXE_MOUNT_HALF_WIDTH = 0.4;
const ENEMY_GLYPHS: Record<EnemySpecies, { body: string; detail: string }> = {
  bird: {
    body: 'M -.49 .07 L -.18 .03 L -.3 .45 L -.06 .2 L .11 .11 C .13 .34 .37 .35 .37 .1 L .49 .03 L .35 -.06 C .23 -.32 -.06 -.4 -.22 -.15 L -.49 -.02 Z',
    detail: 'M -.19 .05 Q -.02 -.06 .07 -.12 M .25 .16 L .29 .16',
  },
  'hollow-soldier': {
    body: 'M -.2 .46 L .12 .49 L .24 .31 L .22 .17 L .11 .1 L .17 -.05 L .32 -.02 L .34 .38 L .42 .46 L .47 .37 L .43 -.14 L .26 -.16 L .17 -.13 L .14 -.28 L .25 -.49 L .01 -.49 L -.06 -.24 L -.15 -.49 L -.37 -.49 L -.23 -.24 L -.22 -.05 L -.43 -.12 L -.49 .12 L -.32 .23 L -.2 .17 L -.23 .29 Z',
    detail: 'M -.12 .3 L .14 .3 M -.32 .15 L -.34 -.04 M -.12 .08 L .05 .08 M -.08 .04 L -.08 -.13',
  },
  // Hooded, a quiver on its back, drawing a longbow with an arrow nocked.
  'hollow-archer': {
    body: 'M -.1 .5 L .06 .44 L .1 .3 L .09 .2 L .03 .16 L .16 .11 L .13 -.16 L .14 -.3 L .2 -.49 L .02 -.49 L -.04 -.3 L -.1 -.49 L -.28 -.49 L -.2 -.3 L -.22 -.16 L -.3 .1 L -.2 .2 L -.2 .36 Z',
    detail: 'M .22 .43 Q .5 .04 .22 -.35 M .22 .43 L .12 .06 L .22 -.35 M .06 .06 L .47 .06 M -.24 .34 L -.3 -.04',
  },
};

function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function line(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const element = svg('line');
  element.setAttribute('x1', String(x1));
  element.setAttribute('y1', String(y1));
  element.setAttribute('x2', String(x2));
  element.setAttribute('y2', String(y2));
  element.setAttribute('vector-effect', 'non-scaling-stroke');
  return element;
}

function rect(x: number, y: number, width: number, height: number): SVGRectElement {
  const element = svg('rect');
  element.setAttribute('x', String(x));
  element.setAttribute('y', String(y));
  element.setAttribute('width', String(width));
  element.setAttribute('height', String(height));
  element.setAttribute('vector-effect', 'non-scaling-stroke');
  return element;
}

function circle(radius: number, cy = 0): SVGCircleElement {
  const element = svg('circle');
  element.setAttribute('r', String(radius));
  element.setAttribute('cy', String(cy));
  element.setAttribute('vector-effect', 'non-scaling-stroke');
  return element;
}

/** A small pole-and-pennant glyph anchored so its base sits at (0, baseY). */
function flagGlyph(baseY: number): SVGGElement {
  const group = svg('g');
  group.setAttribute('class', 'level-gizmo-flag');
  const pole = line(0, baseY, 0, baseY - FLAG_POLE_HEIGHT);
  const pennant = svg('path');
  const top = baseY - FLAG_POLE_HEIGHT;
  pennant.setAttribute('d', `M 0 ${top} L ${FLAG_WIDTH} ${top + FLAG_POLE_HEIGHT * 0.22} L 0 ${top + FLAG_POLE_HEIGHT * 0.44} Z`);
  group.append(pole, pennant);
  return group;
}

export function updraftGlyph(): SVGGElement {
  const group = svg('g');
  group.setAttribute('class', 'level-gizmo-updraft');
  for (let row = 0; row < UPDRAFT_GLYPH.rows; row++) {
    const y = (row - 0.5) * UPDRAFT_GLYPH.spacing;
    const arrow = svg('path');
    arrow.setAttribute('d', `M ${-UPDRAFT_GLYPH.halfWidth} ${y} L 0 ${y + UPDRAFT_GLYPH.rise} L ${UPDRAFT_GLYPH.halfWidth} ${y}`);
    arrow.setAttribute('vector-effect', 'non-scaling-stroke');
    group.append(arrow);
  }
  return group;
}

export function enemyGlyph(species: EnemySpecies, facing: EnemyFacing): SVGGElement {
  const spec = ENEMY_SPECS[species];
  const glyph = ENEMY_GLYPHS[species];
  const group = svg('g');
  group.setAttribute('class', 'level-enemy-glyph');
  group.setAttribute('transform', `scale(${spec.width * ENEMY_DIRECTION[facing]} ${spec.height})`);
  for (const part of ['body', 'detail'] as const) {
    const path = svg('path');
    path.setAttribute('class', `level-enemy-glyph-${part}`);
    path.setAttribute('d', glyph[part]);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    group.append(path);
  }
  return group;
}

function startGizmo(object: StartObject): SVGElement[] {
  const direction = line(0, 0, Math.cos(object.angle) * object.reach * 0.5, Math.sin(object.angle) * object.reach * 0.5);
  direction.setAttribute('class', 'level-gizmo-direction');
  return [
    circle(START_MARKER_RADIUS * 0.55),
    line(-START_CROSS, 0, START_CROSS, 0),
    line(0, -START_CROSS, 0, START_CROSS),
    direction,
  ];
}

function triggerGizmo(object: TriggerObject): SVGElement[] {
  const children: SVGElement[] = [];
  const region: SVGElement = object.region.type === 'circle' ? svg('circle') : svg('rect');
  if (object.region.type === 'circle') {
    region.setAttribute('r', String(object.region.radius));
  } else {
    region.setAttribute('x', String(-object.region.width / 2));
    region.setAttribute('y', String(-object.region.height / 2));
    region.setAttribute('width', String(object.region.width));
    region.setAttribute('height', String(object.region.height));
  }
  region.setAttribute('vector-effect', 'non-scaling-stroke');
  region.setAttribute('class', 'level-gizmo-region');
  children.push(region);
  children.push(circle(HANDLE_RADIUS));
  if (object.marker === 'flag') {
    const baseY = object.region.type === 'circle' ? -object.region.radius : -object.region.height / 2;
    children.push(flagGlyph(baseY));
  } else if (object.marker === 'updraft') children.push(updraftGlyph());
  else if (object.marker === 'switch') {
    const width = object.region.type === 'circle' ? object.region.radius * 2 : object.region.width;
    const bottom = object.region.type === 'circle' ? -object.region.radius : -object.region.height / 2;
    const plate = rect(-width / 2, bottom, width, SWITCH_HEIGHT);
    plate.setAttribute('class', 'level-gizmo-region level-gizmo-switch-plate');
    children.push(plate);
  }
  return children;
}

function enemyGizmo(object: EnemyObject, mode: GizmoMode): SVGElement[] {
  const spec = ENEMY_SPECS[object.species];
  const region = svg('rect');
  region.setAttribute('class', 'level-gizmo-region');
  region.setAttribute('x', String(-spec.width / 2));
  region.setAttribute('y', String(-spec.height / 2));
  region.setAttribute('width', String(spec.width));
  region.setAttribute('height', String(spec.height));
  const children: SVGElement[] = [region, enemyGlyph(object.species, object.facing)];
  if (mode !== 'normal' && object.patrolDistance > 0) {
    const patrol = svg('g');
    patrol.setAttribute('class', 'level-gizmo-patrol');
    patrol.append(
      line(-object.patrolDistance, 0, object.patrolDistance, 0),
      line(-object.patrolDistance, -HANDLE_RADIUS, -object.patrolDistance, HANDLE_RADIUS),
      line(object.patrolDistance, -HANDLE_RADIUS, object.patrolDistance, HANDLE_RADIUS),
    );
    children.unshift(patrol);
  }
  return children;
}

function bonfireGizmo(): SVGElement[] {
  // Its fire, where the hammer head lights it.
  const region = rect(-BONFIRE.width / 2, 0, BONFIRE.width, BONFIRE.height);
  region.setAttribute('class', 'level-gizmo-region');
  const flame = svg('path');
  flame.setAttribute('class', 'level-gizmo-flame');
  flame.setAttribute('d', FLAME_GLYPH);
  return [region, flame];
}

// The trap's body, as its corners turned by its angle about the muzzle.
function shooterCorners(object: ShooterObject): Point[] {
  const cos = Math.cos(object.angle);
  const sin = Math.sin(object.angle);
  return ([[0, -SHOOTER.height / 2], [-SHOOTER.length, -SHOOTER.height / 2], [-SHOOTER.length, SHOOTER.height / 2], [0, SHOOTER.height / 2]] as const)
    .map(([x, y]) => ({ x: x * cos - y * sin, y: x * sin + y * cos }));
}

function shooterGizmo(object: ShooterObject, mode: GizmoMode): SVGElement[] {
  const body = svg('path');
  body.setAttribute('class', 'level-gizmo-region');
  body.setAttribute('d', `M ${shooterCorners(object).map((point) => `${point.x} ${point.y}`).join(' L ')} Z`);
  const length = mode === 'normal' ? AIM_GUIDE : SHOOTER.range;
  const aim = line(0, 0, Math.cos(object.angle) * length, Math.sin(object.angle) * length);
  aim.setAttribute('class', 'level-gizmo-aim');
  return [body, aim, circle(HANDLE_RADIUS)];
}

function axeGizmo(object: AxeObject): SVGElement[] {
  const haft = line(0, 0, 0, -object.length);
  haft.setAttribute('class', 'level-gizmo-haft');
  // The blade where it crosses the obstacle line, hanging straight down: edge-on, as thin as the blade.
  const blade = rect(-AXE.bladeThickness / 2, -object.length - AXE.bladeHeight / 2, AXE.bladeThickness, AXE.bladeHeight);
  blade.setAttribute('class', 'level-gizmo-region');
  return [haft, blade, circle(HANDLE_RADIUS)];
}

// The pool's box, and its surface along the top.
function poolGizmo(object: PoolObject): SVGElement[] {
  const region = rect(-object.width / 2, -object.height / 2, object.width, object.height);
  region.setAttribute('class', 'level-gizmo-region');
  const surface = line(-object.width / 2, object.height / 2, object.width / 2, object.height / 2);
  surface.setAttribute('class', 'level-gizmo-surface');
  return [region, surface];
}

function platformGizmo(object: PlatformObject): SVGElement[] {
  const start = rect(-object.width / 2, -object.height / 2, object.width, object.height);
  start.setAttribute('class', 'level-gizmo-region');
  const travel = line(0, 0, object.travelX, object.travelY);
  travel.setAttribute('class', 'level-gizmo-aim');
  const end = rect(object.travelX - object.width / 2, object.travelY - object.height / 2, object.width, object.height);
  end.setAttribute('class', 'level-gizmo-region level-gizmo-platform-end');
  const endHandle = circle(HANDLE_RADIUS);
  endHandle.setAttribute('cx', String(object.travelX));
  endHandle.setAttribute('cy', String(object.travelY));
  return [start, end, travel, circle(HANDLE_RADIUS), endHandle];
}

export function objectGizmoBounds(object: GizmoObject): Bounds {
  switch (object.kind) {
    case 'start':
      return {
        left: object.x - START_MARKER_RADIUS, right: object.x + START_MARKER_RADIUS,
        bottom: object.y - START_MARKER_RADIUS, top: object.y + START_MARKER_RADIUS,
      };
    case 'bonfire':
      return { left: object.x - BONFIRE.width / 2, right: object.x + BONFIRE.width / 2, bottom: object.y, top: object.y + BONFIRE.height };
    case 'shooter': {
      const corners = shooterCorners(object);
      return {
        left: object.x + Math.min(...corners.map((point) => point.x)), right: object.x + Math.max(...corners.map((point) => point.x)),
        bottom: object.y + Math.min(...corners.map((point) => point.y)), top: object.y + Math.max(...corners.map((point) => point.y)),
      };
    }
    case 'axe':
      return {
        left: object.x - AXE_MOUNT_HALF_WIDTH, right: object.x + AXE_MOUNT_HALF_WIDTH,
        bottom: object.y - object.length - AXE.bladeHeight / 2, top: object.y + AXE_MOUNT,
      };
    case 'pool':
      return {
        left: object.x - object.width / 2, right: object.x + object.width / 2,
        bottom: object.y - object.height / 2, top: object.y + object.height / 2,
      };
    case 'platform':
      return {
        left: object.x - object.width / 2, right: object.x + object.width / 2,
        bottom: object.y - object.height / 2, top: object.y + object.height / 2,
      };
    case 'trigger':
    case 'enemy': {
      const region = object.kind === 'trigger' ? triggerBounds(object) : enemyBounds(object);
      return { left: region.minX, right: region.maxX, bottom: region.minY, top: region.maxY };
    }
  }
}

export type GizmoMode = 'normal' | 'selected' | 'ghost';

function applyGizmo(node: SVGGElement, object: GizmoObject, mode: GizmoMode): void {
  let children: SVGElement[];
  switch (object.kind) {
    case 'start': children = startGizmo(object); break;
    case 'trigger': children = triggerGizmo(object); break;
    case 'enemy': children = enemyGizmo(object, mode); break;
    case 'bonfire': children = bonfireGizmo(); break;
    case 'shooter': children = shooterGizmo(object, mode); break;
    case 'axe': children = axeGizmo(object); break;
    case 'pool': children = poolGizmo(object); break;
    case 'platform': children = platformGizmo(object); break;
  }
  node.replaceChildren(...children);
  node.setAttribute('transform', `translate(${object.x} ${object.y})`);
  const liquid = object.kind === 'pool' ? ` level-gizmo-${object.liquid}` : '';
  node.setAttribute('class', `level-gizmo level-gizmo-${object.kind}${liquid} level-gizmo-${mode}`);
}

/** A standalone gizmo node, e.g. for multi-object previews that manage their own container. */
export function createGizmo(object: GizmoObject, mode: GizmoMode): SVGGElement {
  const node = svg('g');
  applyGizmo(node, object, mode);
  return node;
}

export function triggerLinkHandle(object: TriggerObject, unitsPerPixel: number): Point {
  const right = object.region.type === 'circle' ? object.region.radius : object.region.width / 2;
  return { x: object.x + Math.max(HANDLE_RADIUS, right) + LINK_HANDLE_OFFSET_PIXELS * unitsPerPixel, y: object.y };
}

interface ConnectionView {
  readonly selectedId: string | null;
  readonly overview: boolean;
  readonly unitsPerPixel: number;
  readonly handleRadius: number;
}

interface ConnectionNodes {
  readonly root: SVGGElement;
  readonly path: SVGPathElement;
  readonly arrow: SVGPathElement;
  readonly label: SVGTextElement;
}

function connectionNodes(): ConnectionNodes {
  const root = svg('g');
  const path = svg('path');
  path.setAttribute('class', 'level-gizmo-connection');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  const arrow = svg('path');
  arrow.setAttribute('class', 'level-gizmo-connection-arrow');
  const label = svg('text');
  label.setAttribute('class', 'level-gizmo-connection-label');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('y', '-6');
  root.append(path, arrow, label);
  return { root, path, arrow, label };
}

function placeConnection(nodes: ConnectionNodes, link: ConnectionLink, view: ConnectionView, preview: LevelObject | null): void {
  const from = preview?.id === link.trigger.id ? preview : link.trigger;
  const to = preview?.id === link.target.id ? preview : link.target;
  const scale = view.unitsPerPixel;
  const clearance = Math.max(HANDLE_RADIUS, view.handleRadius) + CONNECTION_GAP_PIXELS * scale;
  const arrowLength = ARROW_PIXELS.length * scale;
  const halfWidth = ARROW_PIXELS.halfWidth * scale;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  let end: Point;
  let direction: Point;
  let centre: Point;
  if (distance > clearance * 2 + arrowLength) {
    direction = { x: dx / distance, y: dy / distance };
    const start = { x: from.x + direction.x * clearance, y: from.y + direction.y * clearance };
    end = { x: to.x - direction.x * clearance, y: to.y - direction.y * clearance };
    centre = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    nodes.path.setAttribute('d', `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
  } else {
    // Close or coincident endpoints need a loop, not a reversed line through their handles.
    const rise = clearance + 24 * scale;
    const start = { x: from.x, y: from.y + clearance };
    end = { x: to.x + clearance, y: to.y };
    const a = { x: start.x, y: start.y + rise };
    const b = { x: end.x + rise, y: end.y };
    direction = { x: -1, y: 0 };
    centre = { x: (start.x + 3 * a.x + 3 * b.x + end.x) / 8, y: (start.y + 3 * a.y + 3 * b.y + end.y) / 8 };
    nodes.path.setAttribute('d', `M ${start.x} ${start.y} C ${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`);
  }
  const base = { x: end.x - direction.x * arrowLength, y: end.y - direction.y * arrowLength };
  nodes.arrow.setAttribute('d', `M ${end.x} ${end.y} L ${base.x - direction.y * halfWidth} ${base.y + direction.x * halfWidth} ` +
    `L ${base.x + direction.y * halfWidth} ${base.y - direction.x * halfWidth} Z`);
  // Inverse camera scale keeps the guide's pixel-sized text upright in the world-space layer.
  nodes.label.setAttribute('transform', `translate(${centre.x} ${centre.y}) scale(${scale} ${-scale})`);
  if (nodes.label.textContent !== link.label) nodes.label.textContent = link.label;
}

/**
 * Authored gizmos share one camera-transformed world-space group; only `sync` rebuilds changed
 * objects. Connections reuse their nodes as selection or zoom changes, and moving an endpoint
 * updates only its links. Selection, ghost, link handle and connect preview are bounded overlays.
 */
export class EntityGizmos {
  private readonly persistent = new Map<string, SVGGElement>();
  private readonly layer: SVGGElement;
  private readonly connectionNode: SVGGElement;
  private readonly selectionNode: SVGGElement;
  private readonly ghostNode: SVGGElement;
  private connectionEdges = new Map<ConnectionLink, ConnectionNodes>();
  private connectionView: ConnectionView | null = null;
  private readonly linkHandleNode = svg('g');
  private linkHandleObject: TriggerObject | null = null;
  private linkHandleScale = 0;
  private readonly connectPreviewNode = svg('path');
  private readonly connectTargetNode = svg('g');
  private connectPreview: {
    readonly trigger: TriggerObject | null; readonly pointer: Point | null; readonly target: ConnectionTarget | null;
    readonly unitsPerPixel: number; readonly handleRadius: number;
  } | null = null;

  constructor(cameraGroup: SVGGElement) {
    this.layer = svg('g');
    this.layer.setAttribute('class', 'level-gizmo-layer');
    this.connectionNode = svg('g');
    this.connectionNode.setAttribute('class', 'level-gizmo-connection-layer');
    this.selectionNode = svg('g');
    this.selectionNode.setAttribute('class', 'level-gizmo-selection-layer');
    this.ghostNode = svg('g');
    this.ghostNode.setAttribute('class', 'level-gizmo-ghost-layer');
    this.linkHandleNode.setAttribute('class', 'level-gizmo-link-handle');
    this.linkHandleNode.setAttribute('hidden', '');
    const title = svg('title');
    title.textContent = 'Drag to a projectile trap or platform to connect';
    const handle = circle(LINK_HANDLE_PIXELS);
    const glyph = svg('path');
    glyph.setAttribute('d', 'M -3 0 H 3 M 0 -3 L 3 0 L 0 3');
    this.linkHandleNode.append(title, handle, glyph);
    this.connectPreviewNode.setAttribute('class', 'level-gizmo-connection level-gizmo-connection-preview');
    this.connectPreviewNode.setAttribute('vector-effect', 'non-scaling-stroke');
    this.connectPreviewNode.setAttribute('hidden', '');
    this.connectTargetNode.setAttribute('hidden', '');
    cameraGroup.append(this.layer, this.connectionNode, this.selectionNode, this.ghostNode,
      this.connectTargetNode, this.connectPreviewNode, this.linkHandleNode);
  }

  sync(upsert: readonly LevelObject[], remove: readonly string[]): void {
    for (const id of remove) this.remove(id);
    for (const object of upsert) {
      if (object.kind === 'terrain' || object.kind === 'decoration') { this.remove(object.id); continue; }
      let node = this.persistent.get(object.id);
      if (node === undefined) {
        node = svg('g');
        this.layer.append(node);
        this.persistent.set(object.id, node);
      }
      applyGizmo(node, object, 'normal');
    }
  }

  private remove(id: string): void {
    this.persistent.get(id)?.remove();
    this.persistent.delete(id);
  }

  setSelection(object: GizmoObject | null): void {
    if (object === null) { this.selectionNode.replaceChildren(); return; }
    applyGizmo(this.selectionNode, object, 'selected');
  }

  setConnections(links: readonly ConnectionLink[], view: ConnectionView, preview: LevelObject | null): void {
    const children: SVGElement[] = [];
    const edges = new Map<ConnectionLink, ConnectionNodes>();
    this.connectionView = view;
    for (const link of links) {
      const nodes = this.connectionEdges.get(link) ?? connectionNodes();
      const selected = link.trigger.id === view.selectedId || link.target.id === view.selectedId;
      nodes.root.setAttribute('class', `level-gizmo-connection-link${selected ? ' level-gizmo-connection-selected' :
        view.overview && view.selectedId !== null ? ' level-gizmo-connection-muted' : ''}`);
      placeConnection(nodes, link, view, preview);
      edges.set(link, nodes);
      children.push(nodes.root);
    }
    this.connectionEdges = edges;
    this.connectionNode.replaceChildren(...children);
  }

  moveConnections(links: readonly ConnectionLink[], preview: LevelObject | null): void {
    if (this.connectionView === null) throw new Error('Connection view is not initialised.');
    for (const link of links) {
      const nodes = this.connectionEdges.get(link);
      if (nodes !== undefined) placeConnection(nodes, link, this.connectionView, preview);
    }
  }

  setLinkHandle(object: TriggerObject | null, unitsPerPixel: number): void {
    if (object === this.linkHandleObject && unitsPerPixel === this.linkHandleScale) return;
    this.linkHandleObject = object;
    this.linkHandleScale = unitsPerPixel;
    this.linkHandleNode.toggleAttribute('hidden', object === null);
    if (object === null) return;
    const at = triggerLinkHandle(object, unitsPerPixel);
    this.linkHandleNode.setAttribute('transform', `translate(${at.x} ${at.y}) scale(${unitsPerPixel} ${-unitsPerPixel})`);
  }

  setConnectPreview(trigger: TriggerObject | null, pointer: Point | null, target: ConnectionTarget | null,
    unitsPerPixel: number, handleRadius: number): void {
    const previous = this.connectPreview;
    if (previous !== null && previous.trigger === trigger && previous.pointer?.x === pointer?.x &&
      previous.pointer?.y === pointer?.y && previous.target === target && previous.unitsPerPixel === unitsPerPixel &&
      previous.handleRadius === handleRadius) return;
    this.connectPreview = { trigger, pointer, target, unitsPerPixel, handleRadius };
    if (previous?.target !== target) {
      this.connectTargetNode.toggleAttribute('hidden', target === null);
      if (target !== null) {
        applyGizmo(this.connectTargetNode, target, 'selected');
        this.connectTargetNode.classList.add('level-gizmo-connect-target');
      }
    }
    if (trigger === null || pointer === null) {
      this.connectPreviewNode.setAttribute('hidden', '');
      return;
    }
    const dx = pointer.x - trigger.x;
    const dy = pointer.y - trigger.y;
    const distance = Math.hypot(dx, dy);
    const clearance = Math.max(HANDLE_RADIUS, handleRadius) + CONNECTION_GAP_PIXELS * unitsPerPixel;
    this.connectPreviewNode.toggleAttribute('hidden', distance <= clearance);
    if (distance <= clearance) return;
    this.connectPreviewNode.setAttribute('d', `M ${trigger.x + dx / distance * clearance} ${trigger.y + dy / distance * clearance} ` +
      `L ${pointer.x} ${pointer.y}`);
  }

  setGhost(object: GizmoObject | null): void {
    if (object === null) { this.ghostNode.replaceChildren(); return; }
    applyGizmo(this.ghostNode, object, 'ghost');
  }

  destroy(): void {
    this.layer.remove();
    this.connectionNode.remove();
    this.selectionNode.remove();
    this.ghostNode.remove();
    this.linkHandleNode.remove();
    this.connectPreviewNode.remove();
    this.connectTargetNode.remove();
    this.connectionEdges.clear();
    this.persistent.clear();
  }
}
