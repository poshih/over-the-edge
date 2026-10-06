import {
  BufferAttribute, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial, Plane, Sphere,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Point } from './config';
import { ModelKit } from './decoration-geometry';
import { AXE, AXE_FIELDS, HAZARD_LIMITS } from './hazards';
import { markInstanceSlot } from './instancing';
import type { AxeObject, LevelObject } from './level';
import { ObjectView } from './object-view';

const WOOD = 0x4a3526;
const WOOD_DARK = 0x33261c;
const IRON = 0x3b3b40;
const IRON_DARK = 0x29292d;
const STEEL = 0x9a9ea4;

// A broad head, its curved cutting edge below, centred on the origin. The swing model turns it into the plane of the
// swing, edge-on to the camera, so the edge leads the cut.
const BLADE: readonly Point[] = [
  { x: -0.18, y: 0.35 }, { x: 0.18, y: 0.35 }, { x: 0.42, y: 0.12 }, { x: 0.65, y: -0.05 }, { x: 0.45, y: -0.22 },
  { x: 0.2, y: -0.32 }, { x: 0, y: -0.35 }, { x: -0.2, y: -0.32 }, { x: -0.45, y: -0.22 }, { x: -0.65, y: -0.05 },
  { x: -0.42, y: 0.12 },
].map((point) => ({ x: point.x * AXE.bladeWidth / 1.3, y: point.y * AXE.bladeHeight / 0.7 }));

// Each vertex's `stretch` moves it down by that many times the axe's length beyond 1 m.
function stretched(kit: ModelKit, stretch: (y: number) => number): BufferGeometry {
  const { lit } = kit.build('own');
  if (lit === null) throw new Error('An axe part needs a surface.');
  const position = lit.getAttribute('position');
  const values = new Float32Array(position.count);
  for (let index = 0; index < position.count; index++) values[index] = stretch(position.getY(index));
  lit.setAttribute('stretch', new BufferAttribute(values, 1));
  return lit;
}

// The mount, which stays still: an axle along the obstacle line at the pivot, held from above.
function mountModel(): BufferGeometry {
  const kit = new ModelKit(0xa8e);
  kit.cylinder(0.06, 0.06, 0.7, IRON, { rz: Math.PI / 2 }, 8);
  for (const x of [-0.3, 0.3]) kit.box(0.08, 0.34, 0.16, IRON_DARK, { x, y: 0.15 });
  kit.box(0.8, 0.12, 0.3, WOOD_DARK, { y: 0.36 });
  const { lit } = kit.build('own');
  if (lit === null) throw new Error('An axe mount needs a surface.');
  return lit;
}

// What swings, modelled 1 m long: a ring on the axle, which keeps its place; the haft, from the pivot to 1 m below,
// which stretches to the axe's length; and the blade at its end, which moves down with it.
function swingModel(): BufferGeometry {
  const ring = new ModelKit(1).torus(0.11, 0.035, IRON, { ry: Math.PI / 2 }, 10, 4);
  const haft = new ModelKit(2).box(0.07, 1, 0.07, WOOD, { y: -0.5 });
  const blade = new ModelKit(3)
    .extrude(BLADE, AXE.bladeThickness, STEEL, { y: -1, ry: Math.PI / 2 })
    .box(0.12, 0.3, 0.2, IRON, { y: -1 + AXE.bladeHeight / 2 - 0.13 });
  const geometry = mergeGeometries([stretched(ring, () => 0), stretched(haft, (y) => y), stretched(blade, () => -1)]);
  // Culling covers the longest axe through its whole swing, not the 1 m model.
  geometry.boundingSphere = new Sphere(new Vector3(), AXE_FIELDS.length.max + AXE.bladeHeight);
  return geometry;
}

// Swings each instance as src/hazards.ts axeAngle does, about the x axis through its pivot, keeping the side of the
// obstacle line that `keep` faces.
function swingMaterial(clock: { value: number }, keep: Plane): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true, roughness: 0.5, metalness: 0.45, flatShading: true, clippingPlanes: [keep],
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.swingTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float stretch;\nattribute vec3 swing;\nuniform float swingTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // swing: the axe's length, period and offset.
          float angle = ${AXE.amplitude.toFixed(6)} * sin(${(2 * Math.PI).toFixed(9)} * (swingTime - swing.z) / swing.y);
          transformed.y += stretch * (swing.x - 1.0);
          float c = cos(angle);
          float s = sin(angle);
          transformed = vec3(transformed.x, transformed.y * c - transformed.z * s, transformed.y * s + transformed.z * c);
        }`);
  };
  return material;
}

/**
 * The level's swinging axes. The mount and the swing's half behind the obstacle line draw in the course pass, and the
 * half in front in the front pass, over the actors, so a blade swung toward the camera passes in front of the
 * character and one swung away behind it. The swing runs in the vertex shader from each axe's length, period and
 * offset and the run's time, so a frame costs nothing per axe.
 */
export class AxeView extends ObjectView<AxeObject> {
  // The swing's half in front of the obstacle line.
  readonly front = new Group();
  private readonly swing: InstancedBufferAttribute;
  private readonly clock: { value: number };

  constructor() {
    const clock = { value: 0 };
    const geometry = swingModel();
    const swing = new InstancedBufferAttribute(new Float32Array(HAZARD_LIMITS.traps * 3), 3);
    swing.setUsage(DynamicDrawUsage);
    swing.onUpload(() => swing.clearUpdateRanges());
    geometry.setAttribute('swing', swing);
    const front = new InstancedMesh(geometry, swingMaterial(clock, new Plane(new Vector3(0, 0, 1), 0)), HAZARD_LIMITS.traps);
    super({
      matches: (object: LevelObject): object is AxeObject => object.kind === 'axe',
      capacity: HAZARD_LIMITS.traps, label: 'Swinging axe',
      meshes: [
        new InstancedMesh(mountModel(),
          new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2, flatShading: true }), HAZARD_LIMITS.traps),
        new InstancedMesh(geometry, swingMaterial(clock, new Plane(new Vector3(0, 0, -1), 0)), HAZARD_LIMITS.traps),
        front,
      ],
      transform: (object, matrix) => matrix.makeTranslation(object.x, object.y, 0),
    });
    this.front.add(front);
    this.swing = swing;
    this.clock = clock;
  }

  update(time: number): void {
    this.updateBounds();
    this.front.visible = this.root.visible;
    if (this.root.visible) this.clock.value = time;
  }

  override dispose(): void {
    super.dispose();
    this.front.clear();
    this.front.removeFromParent();
  }

  protected override written(slot: number, object: AxeObject): void {
    const values = this.swing.array;
    const at = slot * 3;
    if (values[at] === Math.fround(object.length) && values[at + 1] === Math.fround(object.period) &&
      values[at + 2] === Math.fround(object.offset)) return;
    this.swing.setXYZ(slot, object.length, object.period, object.offset);
    markInstanceSlot(this.swing, slot);
  }
}
