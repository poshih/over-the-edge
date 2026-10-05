import { DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { ModelKit } from './decoration-geometry';
import type { ProjectilePose } from './hazard-world';
import { HAZARD_LIMITS, SHOOTER } from './hazards';
import type { LevelObject, ShooterObject } from './level';
import { ObjectView } from './object-view';

const STONE = 0x6f6a62;
const STONE_DARK = 0x4d4944;
const IRON = 0x3b3b40;
const IRON_LIGHT = 0x767a80;
const BORE = 0x0e0d0d;
const EMBER = 0xff7a1f;
const FLAME = 0xffc35a;

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

/** Projectiles in flight, in the actors pass. Each frame writes only the instances of those flying. */
export class ProjectileView {
  readonly root: InstancedMesh<BufferGeometry, MeshBasicMaterial>;
  private readonly matrix = new Matrix4();

  constructor() {
    this.root = new InstancedMesh(projectileModel(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      SHOOTER.projectiles);
    this.root.count = 0;
    // They move every frame, so bounds would be recomputed every frame for the few they could cull.
    this.root.frustumCulled = false;
    this.root.matrixAutoUpdate = false;
    this.root.instanceMatrix.setUsage(DynamicDrawUsage);
  }

  update(projectiles: readonly ProjectilePose[]): void {
    const count = projectiles.length;
    if (count === 0 && this.root.count === 0) return;
    for (let index = 0; index < count; index++) {
      const projectile = projectiles[index];
      this.root.setMatrixAt(index, this.matrix.makeRotationZ(projectile.angle).setPosition(projectile.x, projectile.y, 0));
    }
    this.root.count = count;
    if (count === 0) return;
    const attribute = this.root.instanceMatrix;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  inspect() {
    return { instances: this.root.count };
  }

  dispose(): void {
    this.root.dispose();
    this.root.geometry.dispose();
    this.root.material.dispose();
    this.root.removeFromParent();
  }
}
