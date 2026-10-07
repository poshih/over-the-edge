import { DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { BufferGeometry, Material } from 'three';
import { ModelKit } from './decoration-geometry';
import type { ProjectilePose } from './hazard-world';
import { ARROW, HAZARD_LIMITS, SHOOTER } from './hazards';
import type { LevelObject, ShooterObject } from './level';
import { ObjectView } from './object-view';

const STONE = 0x6f6a62;
const STONE_DARK = 0x4d4944;
const IRON = 0x3b3b40;
const IRON_LIGHT = 0x767a80;
const BORE = 0x0e0d0d;
const EMBER = 0xff7a1f;
const FLAME = 0xffc35a;
const SHAFT = 0x8a6440;
const STEEL = 0x9ba1a8;
const FLETCHING = 0xd8cfb6;

// A carved block reaching back from its muzzle at the origin, which faces +x.
function shooterModel() {
  const kit = new ModelKit(0x5400e);
  const body = SHOOTER.length - 0.12;
  kit.box(body, SHOOTER.height - 0.08, SHOOTER.height - 0.08, STONE_DARK, { x: -0.12 - body / 2 });
  kit.box(0.1, SHOOTER.height - 0.04, SHOOTER.height - 0.04, IRON, { x: -0.62 });
  kit.box(0.12, SHOOTER.height, SHOOTER.height, STONE, { x: -0.06 });
  kit.torus(0.15, 0.045, IRON_LIGHT, { x: 0.005, ry: Math.PI / 2 }, 12, 4);
  kit.cylinder(0.11, 0.11, 0.03, BORE, { x: 0.005, rz: Math.PI / 2 }, 10);
  const model = kit.build('own');
  if (model.lit === null) throw new Error('A projectile trap needs its body.');
  return model.lit;
}

// A glowing bolt, its tip at the origin, pointing +x.
function projectileModel() {
  const kit = new ModelKit(0x5407);
  const tip = 0.12;
  const shaft = SHOOTER.boltLength - tip;
  kit.cylinder(SHOOTER.boltRadius, SHOOTER.boltRadius, shaft, EMBER, { x: -tip - shaft / 2, rz: Math.PI / 2 }, 6, true);
  kit.cone(SHOOTER.boltRadius * 1.8, tip, FLAME, { x: -tip / 2, rz: -Math.PI / 2 }, 6, true);
  const model = kit.build('own');
  if (model.glow === null) throw new Error('A projectile needs its bolt.');
  return model.glow;
}

// A wooden arrow, its tip at the origin, pointing +x: a steel head, the shaft and two vanes of fletching at its tail,
// one in the view's plane and one across it.
function arrowModel() {
  const kit = new ModelKit(0xa770);
  const head = 0.1;
  const shaft = ARROW.length - head;
  const vane = 0.14;
  kit.cylinder(ARROW.radius, ARROW.radius, shaft, SHAFT, { x: -head - shaft / 2, rz: Math.PI / 2 }, 6);
  kit.cone(ARROW.radius * 2.6, head, STEEL, { x: -head / 2, rz: -Math.PI / 2 }, 4);
  kit.box(vane, ARROW.radius * 4.5, 0.008, FLETCHING, { x: vane / 2 + 0.03 - ARROW.length });
  kit.box(vane, 0.008, ARROW.radius * 4.5, FLETCHING, { x: vane / 2 + 0.03 - ARROW.length });
  const model = kit.build('own');
  if (model.lit === null) throw new Error('An arrow needs its shaft.');
  return model.lit;
}

// One kind of projectile's instances, rewritten every frame.
function flight<M extends Material>(geometry: BufferGeometry, material: M): InstancedMesh<BufferGeometry, M> {
  const mesh = new InstancedMesh(geometry, material, SHOOTER.projectiles);
  mesh.count = 0;
  // They move every frame, so bounds would be recomputed every frame for the few they could cull.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  return mesh;
}

// Draws the first `count` instances written this frame, through a reused update range.
function show(mesh: InstancedMesh, count: number, range: { start: number; count: number }): void {
  mesh.count = count;
  if (count === 0) return;
  const attribute = mesh.instanceMatrix;
  range.count = count * attribute.itemSize;
  attribute.updateRanges.length = 0;
  attribute.updateRanges.push(range);
  attribute.needsUpdate = true;
}

/** The level's projectile traps, on the obstacle line in the course pass, each turned to fire along its angle. */
export class ShooterView extends ObjectView<ShooterObject> {
  constructor() {
    super({
      matches: (object: LevelObject): object is ShooterObject => object.kind === 'shooter',
      capacity: HAZARD_LIMITS.traps, label: 'Projectile trap',
      meshes: [new InstancedMesh(shooterModel(),
        new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15, flatShading: true }), HAZARD_LIMITS.traps)],
      transform: (object, matrix) => matrix.makeRotationZ(object.angle).setPosition(object.x, object.y, 0),
    });
  }

  update(): void {
    this.updateBounds();
  }
}

/**
 * Projectiles in flight, in the actors pass: traps' glowing bolts and archers' wooden arrows, each kind one instanced
 * mesh. Each frame writes only the instances of those flying.
 */
export class ProjectileView {
  readonly root = new Group();
  private readonly bolts = flight(projectileModel(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  private readonly arrows = flight(arrowModel(),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1, flatShading: true }));
  private readonly boltRange = { start: 0, count: 0 };
  private readonly arrowRange = { start: 0, count: 0 };
  private readonly matrix = new Matrix4();

  constructor() {
    this.root.name = 'projectiles';
    this.root.matrixAutoUpdate = false;
    this.root.add(this.bolts, this.arrows);
  }

  update(projectiles: readonly ProjectilePose[]): void {
    const count = projectiles.length;
    if (count === 0 && this.bolts.count === 0 && this.arrows.count === 0) return;
    let bolts = 0;
    let arrows = 0;
    for (let index = 0; index < count; index++) {
      const projectile = projectiles[index]!;
      this.matrix.makeRotationZ(projectile.angle).setPosition(projectile.x, projectile.y, 0);
      if (projectile.kind === 'arrow') this.arrows.setMatrixAt(arrows++, this.matrix);
      else this.bolts.setMatrixAt(bolts++, this.matrix);
    }
    show(this.bolts, bolts, this.boltRange);
    show(this.arrows, arrows, this.arrowRange);
  }

  inspect() {
    return { instances: this.bolts.count + this.arrows.count, bolts: this.bolts.count, arrows: this.arrows.count };
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const mesh of [this.bolts, this.arrows]) {
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
