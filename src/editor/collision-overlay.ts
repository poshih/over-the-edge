import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, LineBasicMaterial, LineSegments } from 'three';
import type { Vector3 } from 'three';
import { ChainShape, CircleShape, EdgeShape, PolygonShape } from 'planck';
import type { AABBValue, Fixture, Transform, Vec2Value, World } from 'planck';
import type { ArmPose } from '../arm-ik';
import { OBSTACLE_LINE } from '../obstacle-line';
import type { SceneFrame } from '../scene-frame';
import type { SceneLayer } from '../scene-layer';

const MARKER_RADIUS = 0.07;
const GUIDE_RADIUS = 0.09;
// A joint's anchors closer than this, in metres, share one marker.
const ANCHOR_GAP = 0.001;
const CIRCLE_SEGMENTS = 32;
// The unit circle's points as x, y pairs, its first point repeated at the end.
const CIRCLE = new Float64Array((CIRCLE_SEGMENTS + 1) * 2);
for (let index = 0; index <= CIRCLE_SEGMENTS; index++) {
  const angle = index * 2 * Math.PI / CIRCLE_SEGMENTS;
  CIRCLE[2 * index] = Math.cos(angle);
  CIRCLE[2 * index + 1] = Math.sin(angle);
}
// A segment's two 3D points.
const SEGMENT_FLOATS = 6;
// The first allocation, in segments; it doubles whenever a frame draws more.
const INITIAL_SEGMENTS = 1024;

// What the physics collides with, read from its world every frame, so nothing that collides can be missing and only
// what is on screen costs anything: every fixture that can collide, as its own shape where its body is, and every joint's
// anchors. Bodies show where the last physics step left them, at most one step ahead of their drawing. Both draw on the
// obstacle line, where the physics is and every collider's visual is centred, so in perspective each outline runs
// through the middle of what it shows. The 3D arms' guides draw at their own points, like the arms.
export class CollisionOverlay implements SceneLayer {
  readonly root = new Group();
  // Over everything, the tool included, so no model hides the outline it is compared with.
  readonly pass = 'top';
  private readonly material = new LineBasicMaterial({
    color: 0x35ffbe, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9,
  });
  private readonly lines = new LineSegments(new BufferGeometry(), this.material);
  // Rewritten every frame, and grown to fit whatever one frame draws.
  private positions = new Float32Array(INITIAL_SEGMENTS * SEGMENT_FLOATS);
  private attribute = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
  // Floats written this frame.
  private written = 0;
  // The shown course, as the world query's box.
  private readonly area: AABBValue = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  // The frame each fixture was last drawn in: the query meets a chain once for each of its edges near the view.
  private readonly drawnIn = new WeakMap<Fixture, number>();
  private frames = 0;
  private readonly world: World;
  private readonly armPoses: () => readonly ArmPose[];
  private readonly drawFixture = (fixture: Fixture): boolean => {
    if (fixture.isSensor() || fixture.getFilterMaskBits() === 0 || this.drawnIn.get(fixture) === this.frames) return true;
    this.drawnIn.set(fixture, this.frames);
    const shape = fixture.getShape(), transform = fixture.getBody().getTransform();
    if (shape instanceof PolygonShape) {
      for (let index = 0; index < shape.m_count; index++) {
        this.edge(shape.m_vertices[index], shape.m_vertices[(index + 1) % shape.m_count], transform);
      }
    } else if (shape instanceof ChainShape) {
      for (let index = 0; index < shape.getChildCount(); index++) this.edge(shape.getVertex(index), shape.getVertex(index + 1), transform);
    } else if (shape instanceof EdgeShape) {
      this.edge(shape.m_vertex1, shape.m_vertex2, transform);
    } else if (shape instanceof CircleShape) {
      this.circle(shape.getCenter(), shape.getRadius(), transform);
    }
    return true;
  };

  constructor(world: World, armPoses: () => readonly ArmPose[]) {
    this.world = world;
    this.armPoses = armPoses;
    this.root.visible = false;
    this.lines.geometry.setAttribute('position', this.attribute);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 30;
    this.root.add(this.lines);
  }

  setMode(mode: 'visible' | 'hidden'): void {
    this.root.visible = mode === 'visible';
  }

  update(frame: SceneFrame): void {
    if (!this.root.visible) return;
    this.written = 0;
    this.frames++;
    const { view } = frame, { lowerBound, upperBound } = this.area;
    lowerBound.x = view.left;
    lowerBound.y = view.bottom;
    upperBound.x = view.right;
    upperBound.y = view.top;
    this.world.queryAABB(this.area, this.drawFixture);
    for (let joint = this.world.getJointList(); joint !== null; joint = joint.getNext()) {
      if (!joint.isActive()) continue;
      const a = joint.getAnchorA(), b = joint.getAnchorB();
      this.cross(a.x, a.y, OBSTACLE_LINE, GUIDE_RADIUS);
      if (Math.abs(b.x - a.x) > ANCHOR_GAP || Math.abs(b.y - a.y) > ANCHOR_GAP) this.cross(b.x, b.y, OBSTACLE_LINE, GUIDE_RADIUS);
    }
    for (const arm of this.armPoses()) {
      const { hint } = arm;
      this.guide(arm.shoulder, arm.elbow);
      this.guide(arm.elbow, arm.hand);
      this.guide(arm.shoulder, hint);
      this.cross(hint.x, hint.y, hint.z, MARKER_RADIUS);
    }
    this.lines.geometry.setDrawRange(0, this.written / 3);
    if (this.written === 0) return;
    // Uploads only what this frame wrote.
    const attribute = this.attribute;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, this.written);
    attribute.needsUpdate = true;
  }

  // The edge between two of a body's local points.
  private edge(a: Vec2Value, b: Vec2Value, { p, q }: Transform): void {
    this.segment(p.x + q.c * a.x - q.s * a.y, p.y + q.s * a.x + q.c * a.y, OBSTACLE_LINE,
      p.x + q.c * b.x - q.s * b.y, p.y + q.s * b.x + q.c * b.y, OBSTACLE_LINE);
  }

  private circle(centre: Vec2Value, radius: number, { p, q }: Transform): void {
    const x = p.x + q.c * centre.x - q.s * centre.y, y = p.y + q.s * centre.x + q.c * centre.y;
    for (let index = 0; index < CIRCLE_SEGMENTS; index++) {
      const at = 2 * index;
      this.segment(x + radius * CIRCLE[at], y + radius * CIRCLE[at + 1], OBSTACLE_LINE,
        x + radius * CIRCLE[at + 2], y + radius * CIRCLE[at + 3], OBSTACLE_LINE);
    }
  }

  private cross(x: number, y: number, z: number, radius: number): void {
    this.segment(x - radius, y, z, x + radius, y, z);
    this.segment(x, y - radius, z, x, y + radius, z);
  }

  private guide(a: Vector3, b: Vector3): void {
    this.segment(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  private segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    if (this.written + SEGMENT_FLOATS > this.positions.length) this.grow();
    const positions = this.positions, at = this.written;
    positions[at] = ax; positions[at + 1] = ay; positions[at + 2] = az;
    positions[at + 3] = bx; positions[at + 4] = by; positions[at + 5] = bz;
    this.written = at + SEGMENT_FLOATS;
  }

  // Doubles the room, keeping this frame's segments. A drawn buffer cannot change size, so the geometry is replaced and
  // the old one disposed with its GPU buffer.
  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2);
    positions.set(this.positions);
    this.positions = positions;
    this.attribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
    this.lines.geometry.dispose();
    this.lines.geometry = new BufferGeometry();
    this.lines.geometry.setAttribute('position', this.attribute);
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.material.dispose();
    this.root.clear();
  }
}
