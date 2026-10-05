// Editor-only rendering helpers for non-terrain objects at their authored positions.
// Terrain keeps using shapeVertices/objectVertices/objectContains from ../level; these gizmos
// share lightweight SVG geometry between persistent objects, selection, and placement previews.
import type { Point } from '../config';
import { ENEMY_DIRECTION, ENEMY_SPECS, enemyBounds } from '../enemy-types';
import type { EnemyFacing, EnemySpecies } from '../enemy-types';
import { AXE, BONFIRE, SHOOTER } from '../hazards';
import { triggerBounds } from '../level';
import type { AxeObject, EnemyObject, LevelObject, PoolObject, ShooterObject, StartObject, TriggerObject } from '../level';

export interface Bounds { left: number; right: number; bottom: number; top: number }
// Starts, triggers, enemies, bonfires, traps and liquid pools; terrain and decorations draw themselves in the scene.
export type GizmoObject = Exclude<LevelObject, { kind: 'terrain' } | { kind: 'decoration' }>;

const SVG_NS = 'http://www.w3.org/2000/svg';
export const START_MARKER_RADIUS = 0.6;
const START_CROSS = 0.42;
const HANDLE_RADIUS = 0.22;
const FLAG_POLE_HEIGHT = 0.6;
const FLAG_WIDTH = 0.36;
const UPDRAFT_GLYPH = { halfWidth: 0.2, rise: 0.16, spacing: 0.24, rows: 2 } as const;
// A flame standing on a bonfire's base, in metres.
const FLAME_GLYPH = 'M 0 .15 C .32 .4 .36 .78 0 1.15 C -.08 .9 -.3 .78 -.2 .55 C -.3 .4 -.16 .25 0 .15 Z';
// How far a projectile trap's aim shows when it is not selected; selected, it shows the projectiles' whole range.
const AIM_GUIDE = 1.6;
// The top of an axe's mount above its pivot.
const AXE_MOUNT = 0.45;
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

function bonfireGizmo(mode: GizmoMode): SVGElement[] {
  const region = rect(-BONFIRE.width / 2, 0, BONFIRE.width, BONFIRE.height);
  region.setAttribute('class', 'level-gizmo-region');
  const flame = svg('path');
  flame.setAttribute('class', 'level-gizmo-flame');
  flame.setAttribute('d', FLAME_GLYPH);
  const children: SVGElement[] = [region, flame];
  if (mode !== 'normal') {
    // Where the player's foot lights it.
    const reach = circle(BONFIRE.reach);
    reach.setAttribute('class', 'level-gizmo-reach');
    children.unshift(reach);
  }
  return children;
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
  // The blade where it crosses the obstacle line, hanging straight down.
  const blade = rect(-AXE.bladeWidth / 2, -object.length - AXE.bladeHeight / 2, AXE.bladeWidth, AXE.bladeHeight);
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
        left: object.x - AXE.bladeWidth / 2, right: object.x + AXE.bladeWidth / 2,
        bottom: object.y - object.length - AXE.bladeHeight / 2, top: object.y + AXE_MOUNT,
      };
    case 'pool':
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
    case 'bonfire': children = bonfireGizmo(mode); break;
    case 'shooter': children = shooterGizmo(object, mode); break;
    case 'axe': children = axeGizmo(object); break;
    case 'pool': children = poolGizmo(object); break;
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
