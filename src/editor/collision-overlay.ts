import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments } from 'three';
import type { Vector3 } from 'three';
import type { ArmPose } from '../arm-ik';
import type { Point } from '../config';
import { objectLoops } from '../level';
import type { TerrainEvent } from '../level';
import { transformPoint } from '../math';
import { OBSTACLE_LINE } from '../obstacle-line';
import type { PhysicsFrame } from '../simulation';
import type { ViewLayer } from '../view';

const MARKER_RADIUS = 0.07;
const GUIDE_RADIUS = 0.09;
const DYNAMIC_EDGES = 64;

// Collision outlines draw on the obstacle line, where the physics is and every collider's visual is centred,
// so in perspective each outline runs through the middle of what it shows. The arm guides draw at their own
// 3D points, like the arms.
export class CollisionOverlay implements ViewLayer {
  readonly root = new Group();
  // Over the course, the characters and their arms; the tool still draws on top.
  readonly pass = 'marks';
  private readonly material = new LineBasicMaterial({ color: 0x35ffbe, depthTest: false, transparent: true, opacity: 0.9 });
  private readonly fixed = new LineSegments(new BufferGeometry(), this.material);
  private readonly moving = new LineSegments(new BufferGeometry(), this.material);
  private readonly positions = new Float32Array(DYNAMIC_EDGES * 6);
  private readonly outlines = new Map<string, readonly (readonly Point[])[]>();
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
        for (const object of event.objects) this.outlines.set(object.id, objectLoops(object));
        break;
      case 'upsert':
        this.outlines.set(event.object.id, objectLoops(event.object));
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
      for (const loops of this.outlines.values()) {
        for (const vertices of loops) {
          for (let index = 0; index < vertices.length; index++) {
            const a = vertices[index];
            const b = vertices[(index + 1) % vertices.length];
            positions.push(a.x, a.y, OBSTACLE_LINE, b.x, b.y, OBSTACLE_LINE);
          }
        }
      }
      this.fixed.geometry.dispose();
      this.fixed.geometry = new BufferGeometry();
      this.fixed.geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      this.dirty = false;
    }
    let offset = 0;
    const segment = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      this.positions.set([ax, ay, az, bx, by, bz], offset);
      offset += 6;
    };
    const line = (a: Point, b: Point): void => segment(a.x, a.y, OBSTACLE_LINE, b.x, b.y, OBSTACLE_LINE);
    const guide = (a: Vector3, b: Vector3): void => segment(a.x, a.y, a.z, b.x, b.y, b.z);
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
      const { hint } = arm;
      guide(arm.shoulder, arm.elbow);
      guide(arm.elbow, arm.hand);
      guide(arm.shoulder, hint);
      segment(hint.x - MARKER_RADIUS, hint.y, hint.z, hint.x + MARKER_RADIUS, hint.y, hint.z);
      segment(hint.x, hint.y - MARKER_RADIUS, hint.z, hint.x, hint.y + MARKER_RADIUS, hint.z);
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
