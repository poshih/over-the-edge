import { BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshStandardMaterial } from 'three';
import type { PlatformObject } from './level';
import { PLATFORM_LIMITS } from './level';
import { InstanceSlots, markInstanceSlot } from './instancing';
import type { PlatformPose } from './platform-world';
import type { LookPasses } from './object-looks';
import type { Surface } from './surfaces';

const SURFACE_COLOURS: Readonly<Record<Surface, number>> = {
  rock: 0x74716a,
  wood: 0x7a5130,
  metal: 0x68727a,
  ice: 0x9fc7d8,
  rubber: 0x2f3030,
};

interface DrawnPlatform {
  readonly id: string;
  object: PlatformObject;
  slot: number;
  x: number;
  y: number;
}

/** Draws moving platform slabs centred on the obstacle line. */
export class PlatformView {
  readonly passes: LookPasses;
  private readonly mesh: InstancedMesh;
  private readonly slots = new InstanceSlots<DrawnPlatform>({ capacity: PLATFORM_LIMITS.objects, label: 'Platform' });
  private readonly drawn = new Map<string, DrawnPlatform>();
  private readonly matrix = new Matrix4();
  private readonly colour = new Color();
  private readonly matrixRanges: { start: number; count: number }[];
  private readonly pendingMatrices = new Uint8Array(PLATFORM_LIMITS.objects);
  private readonly pendingSlots: number[] = [];
  private disposed = false;
  private matrixWrites = 0;
  private boundsDirty = false;
  private boundsUpdates = 0;

  constructor() {
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.82, metalness: 0.18 }), PLATFORM_LIMITS.objects);
    this.mesh.count = 0;
    this.mesh.matrixAutoUpdate = false;
    const attribute = this.mesh.instanceMatrix;
    attribute.setUsage(DynamicDrawUsage);
    this.matrixRanges = Array.from({ length: PLATFORM_LIMITS.objects }, (_, slot) => ({
      start: slot * attribute.itemSize, count: attribute.itemSize,
    }));
    attribute.onUpload(() => {
      for (const slot of this.pendingSlots) this.pendingMatrices[slot] = 0;
      this.pendingSlots.length = 0;
      attribute.clearUpdateRanges();
    });
    this.passes = { course: this.mesh };
  }

  set(objects: readonly PlatformObject[]): void {
    this.ensureLive();
    const ids = new Set(objects.map((object) => object.id));
    for (const id of [...this.slots.ids()]) if (!ids.has(id)) this.remove(id);
    for (const object of objects) this.upsert(object);
    this.mesh.visible = this.slots.size > 0;
  }

  update(poses: readonly PlatformPose[]): void {
    this.ensureLive();
    for (let index = 0; index < poses.length; index++) {
      const pose = poses[index]!;
      const drawn = this.drawn.get(pose.id);
      if (drawn === undefined) throw new Error(`Unknown platform pose: ${pose.id}.`);
      if (drawn.x !== pose.x || drawn.y !== pose.y) this.write(drawn, pose.x, pose.y);
    }
    if (!this.boundsDirty) return;
    this.mesh.computeBoundingSphere();
    this.boundsDirty = false;
    this.boundsUpdates++;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) for (const material of this.mesh.material) material.dispose();
    else this.mesh.material.dispose();
    this.slots.clear();
    this.drawn.clear();
    this.pendingSlots.length = 0;
  }

  inspect() {
    return { instances: this.slots.size, matrixWrites: this.matrixWrites, boundsUpdates: this.boundsUpdates };
  }

  private upsert(object: PlatformObject): void {
    const previous = this.drawn.get(object.id);
    const drawn = previous ?? { id: object.id, object, slot: -1, x: object.x, y: object.y };
    const slot = this.slots.upsert(drawn);
    this.mesh.count = this.slots.size;
    if (previous !== undefined && previous.object === object && previous.slot === slot) return;
    drawn.object = object;
    drawn.slot = slot;
    this.drawn.set(object.id, drawn);
    this.write(drawn, drawn.x, drawn.y);
    const hadColours = this.mesh.instanceColor !== null;
    this.mesh.setColorAt(slot, this.colour.setHex(SURFACE_COLOURS[object.surface]));
    if (this.mesh.instanceColor !== null) {
      const attribute = this.mesh.instanceColor;
      if (!hadColours) {
        attribute.setUsage(DynamicDrawUsage);
        attribute.onUpload(() => attribute.clearUpdateRanges());
      }
      markInstanceSlot(attribute, slot);
    }
  }

  private remove(id: string): void {
    const removed = this.slots.remove(id);
    if (removed === undefined) return;
    this.drawn.delete(id);
    if (removed.moved !== undefined) this.upsert(removed.moved.object);
    this.mesh.count = this.slots.size;
    this.boundsDirty = true;
  }

  private write(drawn: DrawnPlatform, x: number, y: number): void {
    const { slot, object } = drawn;
    this.matrix.makeScale(object.width, object.height, object.depth);
    this.matrix.setPosition(x, y, 0);
    this.mesh.setMatrixAt(slot, this.matrix);
    const attribute = this.mesh.instanceMatrix;
    if (this.pendingMatrices[slot] === 0) {
      // three.js merges ranges in place; restore and reuse each slot's range after its upload.
      const range = this.matrixRanges[slot]!;
      range.start = slot * attribute.itemSize;
      range.count = attribute.itemSize;
      attribute.updateRanges.push(range);
      this.pendingMatrices[slot] = 1;
      this.pendingSlots.push(slot);
    }
    attribute.needsUpdate = true;
    drawn.x = x;
    drawn.y = y;
    this.matrixWrites++;
    this.boundsDirty = true;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed platform view.');
  }
}
