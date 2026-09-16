import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments } from 'three';
import type { ArmPose } from '../arm-ik';
import type { Point } from '../config';
import { objectVertices } from '../level';
import type { TerrainEvent } from '../level';
import { transformPoint } from '../math';
import type { PhysicsFrame } from '../simulation';
import type { ViewLayer } from '../view';

const DEPTH = 0.95;
const MARKER_RADIUS = 0.07;
const GUIDE_RADIUS = 0.09;
const DYNAMIC_EDGES = 64;

export class CollisionOverlay implements ViewLayer {
  readonly root = new Group();
  private readonly material = new LineBasicMaterial({ color: 0x35ffbe, depthTest: false, transparent: true, opacity: 0.9 });
  private readonly fixed = new LineSegments(new BufferGeometry(), this.material);
  private readonly moving = new LineSegments(new BufferGeometry(), this.material);
  private readonly positions = new Float32Array(DYNAMIC_EDGES * 6);
  private readonly outlines = new Map<string, readonly Point[]>();
  private dirty = true;

  constructor() {
    this.root.visible = false;
    this.moving.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    for (const lines of [this.fixed, this.moving]) { lines.frustumCulled = false; lines.renderOrder = 30; }
    this.root.add(this.fixed, this.moving);
  }

  setMode(mode: 'visible' | 'hidden'): void {
    this.root.visible = mode === 'visible';
  }

  apply(event: TerrainEvent): void {
    switch (event.type) {
      case 'reset':
        this.outlines.clear();
        for (const object of event.objects) this.outlines.set(object.id, objectVertices(object));
        break;
      case 'upsert':
        this.outlines.set(event.object.id, objectVertices(event.object));
        break;
      case 'remove':
      case 'disappear':
        this.outlines.delete(event.id);
        break;
      case 'fade':
        return;
    }
    this.dirty = true;
  }

  update(frame: PhysicsFrame, arms: readonly ArmPose[]): void {
    if (!this.root.visible) return;
    if (this.dirty) {
      const positions: number[] = [];
      for (const vertices of this.outlines.values()) {
        for (let index = 0; index < vertices.length; index++) {
          const a = vertices[index];
          const b = vertices[(index + 1) % vertices.length];
          positions.push(a.x, a.y, DEPTH, b.x, b.y, DEPTH);
        }
      }
      this.fixed.geometry.dispose();
      this.fixed.geometry = new BufferGeometry();
      this.fixed.geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      this.dirty = false;
    }
    let offset = 0;
    const line = (a: Point, b: Point): void => {
      this.positions.set([a.x, a.y, DEPTH, b.x, b.y, DEPTH], offset);
      offset += 6;
    };
    for (const part of frame.parts) {
      if (part.collides) {
        for (let index = 0; index < part.vertices.length; index++) {
          line(transformPoint(part.vertices[index], part, part.angle),
            transformPoint(part.vertices[(index + 1) % part.vertices.length], part, part.angle));
        }
      }
      if (part.vertices.length === 0) {
        line({ x: part.x - GUIDE_RADIUS, y: part.y }, { x: part.x + GUIDE_RADIUS, y: part.y });
        line({ x: part.x, y: part.y - GUIDE_RADIUS }, { x: part.x, y: part.y + GUIDE_RADIUS });
      }
    }
    for (const arm of arms) {
      line(arm.shoulder, arm.elbow);
      line(arm.elbow, arm.hand);
      line(arm.shoulder, arm.hint);
      line({ x: arm.hint.x - MARKER_RADIUS, y: arm.hint.y }, { x: arm.hint.x + MARKER_RADIUS, y: arm.hint.y });
      line({ x: arm.hint.x, y: arm.hint.y - MARKER_RADIUS }, { x: arm.hint.x, y: arm.hint.y + MARKER_RADIUS });
    }
    this.moving.geometry.setDrawRange(0, offset / 3);
    this.moving.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.fixed.geometry.dispose();
    this.moving.geometry.dispose();
    this.material.dispose();
    this.outlines.clear();
    this.root.clear();
  }
}
