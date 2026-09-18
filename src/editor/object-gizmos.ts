// Editor-only rendering helpers for non-terrain objects at their authored positions.
// Terrain keeps using shapeVertices/objectVertices/objectContains from ../level; these gizmos
// share lightweight SVG geometry between persistent objects, selection, and placement previews.
import { RIG } from '../config';
import { ENEMY_DIRECTION, ENEMY_SPECS, enemyBounds } from '../enemy-types';
import type { EnemyFacing, EnemySpecies } from '../enemy-types';
import { triggerBounds } from '../level';
import type { EnemyObject, LevelObject, StartObject, TriggerObject } from '../level';

export interface Bounds { left: number; right: number; bottom: number; top: number }
type GizmoObject = Exclude<LevelObject, { kind: 'terrain' }>;

const SVG_NS = 'http://www.w3.org/2000/svg';
export const START_MARKER_RADIUS = 0.6;
const START_CROSS = 0.42;
const HANDLE_RADIUS = 0.22;
const FLAG_POLE_HEIGHT = 0.6;
const FLAG_WIDTH = 0.36;
const UPDRAFT_GLYPH = { halfWidth: 0.2, rise: 0.16, spacing: 0.24, rows: 2 } as const;
const ENEMY_GLYPHS: Record<EnemySpecies, { body: string; detail: string }> = {
  bird: {
    body: 'M -.49 .07 L -.18 .03 L -.3 .45 L -.06 .2 L .11 .11 C .13 .34 .37 .35 .37 .1 L .49 .03 L .35 -.06 C .23 -.32 -.06 -.4 -.22 -.15 L -.49 -.02 Z',
    detail: 'M -.19 .05 Q -.02 -.06 .07 -.12 M .25 .16 L .29 .16',
  },
  'hollow-soldier': {
    body: 'M -.2 .46 L .12 .49 L .24 .31 L .22 .17 L .11 .1 L .17 -.05 L .32 -.02 L .34 .38 L .42 .46 L .47 .37 L .43 -.14 L .26 -.16 L .17 -.13 L .14 -.28 L .25 -.49 L .01 -.49 L -.06 -.24 L -.15 -.49 L -.37 -.49 L -.23 -.24 L -.22 -.05 L -.43 -.12 L -.49 .12 L -.32 .23 L -.2 .17 L -.23 .29 Z',
    detail: 'M -.12 .3 L .14 .3 M -.32 .15 L -.34 -.04 M -.12 .08 L .05 .08 M -.08 .04 L -.08 -.13',
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
  const reach = RIG.handleLength + object.extension;
  const direction = line(0, 0, Math.cos(object.angle) * reach * 0.5, Math.sin(object.angle) * reach * 0.5);
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

export function objectGizmoBounds(object: GizmoObject): Bounds {
  if (object.kind === 'start') {
    return {
      left: object.x - START_MARKER_RADIUS, right: object.x + START_MARKER_RADIUS,
      bottom: object.y - START_MARKER_RADIUS, top: object.y + START_MARKER_RADIUS,
    };
  }
  const region = object.kind === 'trigger' ? triggerBounds(object) : enemyBounds(object);
  return { left: region.minX, right: region.maxX, bottom: region.minY, top: region.maxY };
}

export type GizmoMode = 'normal' | 'selected' | 'ghost';

function applyGizmo(node: SVGGElement, object: GizmoObject, mode: GizmoMode): void {
  let children: SVGElement[];
  switch (object.kind) {
    case 'start': children = startGizmo(object); break;
    case 'trigger': children = triggerGizmo(object); break;
    case 'enemy': children = enemyGizmo(object, mode); break;
  }
  node.replaceChildren(...children);
  node.setAttribute('transform', `translate(${object.x} ${object.y})`);
  node.setAttribute('class', `level-gizmo level-gizmo-${object.kind} level-gizmo-${mode}`);
}

/**
 * Manages the SVG representation of every non-terrain object plus one bounded selection node
 * and one bounded ghost (drag/placement preview) node. All nodes live in world-space coordinates
 * inside a single camera-transformed group, so panning/zooming never touches per-object geometry;
 * only `sync` (driven by LevelChange deltas) rebuilds the handful of nodes that actually changed.
 */
export class EntityGizmos {
  private readonly persistent = new Map<string, SVGGElement>();
  private readonly layer: SVGGElement;
  private readonly selectionNode: SVGGElement;
  private readonly ghostNode: SVGGElement;

  constructor(cameraGroup: SVGGElement) {
    this.layer = svg('g');
    this.layer.setAttribute('class', 'level-gizmo-layer');
    this.selectionNode = svg('g');
    this.selectionNode.setAttribute('class', 'level-gizmo-selection-layer');
    this.ghostNode = svg('g');
    this.ghostNode.setAttribute('class', 'level-gizmo-ghost-layer');
    cameraGroup.append(this.layer, this.selectionNode, this.ghostNode);
  }

  sync(upsert: readonly LevelObject[], remove: readonly string[]): void {
    for (const id of remove) this.remove(id);
    for (const object of upsert) {
      if (object.kind === 'terrain') { this.remove(object.id); continue; }
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

  setGhost(object: GizmoObject | null): void {
    if (object === null) { this.ghostNode.replaceChildren(); return; }
    applyGizmo(this.ghostNode, object, 'ghost');
  }

  destroy(): void {
    this.layer.remove();
    this.selectionNode.remove();
    this.ghostNode.remove();
    this.persistent.clear();
  }
}
