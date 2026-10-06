import { Box3, BoxGeometry, Color, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Sphere } from 'three';
import type { InstancedBufferAttribute } from 'three';
import type { PlatformObject } from './level';
import { PLATFORM_LIMITS } from './level';
import { InstanceSlots, markInstanceSlot } from './instancing';
import { OBSTACLE_LINE } from './obstacle-line';
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
const DECK_PLATE = { width: 0.6, height: 0.06, depth: 0.6 } as const;

interface DrawnPlatform {
  readonly id: string;
  object: PlatformObject;
  slot: number;
  plateSlot: number;
  x: number;
  y: number;
}

interface MatrixUploads {
  readonly attribute: InstancedBufferAttribute;
  readonly ranges: { start: number; count: number }[];
  readonly pending: Uint8Array;
  readonly slots: Uint8Array;
  count: number;
}

function matrixUploads(mesh: InstancedMesh): MatrixUploads {
  const attribute = mesh.instanceMatrix;
  attribute.setUsage(DynamicDrawUsage);
  const uploads: MatrixUploads = {
    attribute,
    ranges: Array.from({ length: PLATFORM_LIMITS.objects }, (_, slot) => ({
      start: slot * attribute.itemSize, count: attribute.itemSize,
    })),
    pending: new Uint8Array(PLATFORM_LIMITS.objects),
    slots: new Uint8Array(PLATFORM_LIMITS.objects),
    count: 0,
  };
  attribute.onUpload(() => {
    for (let index = 0; index < uploads.count; index++) uploads.pending[uploads.slots[index]!] = 0;
    uploads.count = 0;
    attribute.clearUpdateRanges();
  });
  return uploads;
}

function markMatrix(uploads: MatrixUploads, slot: number): void {
  const { attribute } = uploads;
  if (uploads.pending[slot] === 0) {
    // three.js merges ranges in place; restore and reuse each slot's range after its upload.
    const range = uploads.ranges[slot]!;
    range.start = slot * attribute.itemSize;
    range.count = attribute.itemSize;
    attribute.updateRanges.push(range);
    uploads.pending[slot] = 1;
    uploads.slots[uploads.count++] = slot;
  }
  attribute.needsUpdate = true;
}

/** Draws moving platform slabs centred on the obstacle line. */
export class PlatformView {
  readonly passes: LookPasses;
  private readonly root = new Group();
  private readonly geometry = new BoxGeometry(1, 1, 1);
  private readonly material = new MeshStandardMaterial({ roughness: 0.82, metalness: 0.18 });
  private readonly plateMaterial = new MeshStandardMaterial({ color: 0x343c42, roughness: 0.6, metalness: 0.55 });
  private readonly mesh: InstancedMesh;
  private readonly plates: InstancedMesh;
  private readonly slots = new InstanceSlots<DrawnPlatform>({ capacity: PLATFORM_LIMITS.objects, label: 'Platform' });
  private readonly plateSlots = new InstanceSlots<DrawnPlatform>({ capacity: PLATFORM_LIMITS.objects, label: 'Platform plate' });
  private readonly drawn = new Map<string, DrawnPlatform>();
  private readonly matrix = new Matrix4();
  private readonly colour = new Color();
  private readonly matrixUploads: MatrixUploads;
  private readonly plateUploads: MatrixUploads;
  private readonly bounds = new Box3();
  private readonly sphere = new Sphere();
  private disposed = false;
  private matrixWrites = 0;
  private plateMatrixWrites = 0;
  private boundsDirty = false;
  private boundsUpdates = 0;

  constructor() {
    this.mesh = new InstancedMesh(this.geometry, this.material, PLATFORM_LIMITS.objects);
    this.plates = new InstancedMesh(this.geometry, this.plateMaterial, PLATFORM_LIMITS.objects);
    this.mesh.count = 0;
    this.plates.count = 0;
    this.root.matrixAutoUpdate = this.mesh.matrixAutoUpdate = this.plates.matrixAutoUpdate = false;
    this.mesh.boundingSphere = this.plates.boundingSphere = this.sphere;
    this.matrixUploads = matrixUploads(this.mesh);
    this.plateUploads = matrixUploads(this.plates);
    this.root.add(this.mesh, this.plates);
    this.passes = { course: this.root };
  }

  set(objects: readonly PlatformObject[]): void {
    this.ensureLive();
    const ids = new Set(objects.map((object) => object.id));
    for (const id of [...this.slots.ids()]) if (!ids.has(id)) this.remove(id);
    for (const object of objects) this.upsert(object);
    this.mesh.visible = this.slots.size > 0;
    this.plates.visible = this.plateSlots.size > 0;
    this.updateBounds();
  }

  update(poses: readonly PlatformPose[]): void {
    this.ensureLive();
    for (let index = 0; index < poses.length; index++) {
      const pose = poses[index]!;
      const drawn = this.drawn.get(pose.id);
      if (drawn === undefined) throw new Error(`Unknown platform pose: ${pose.id}.`);
      if (drawn.x !== pose.x || drawn.y !== pose.y) this.write(drawn, pose.x, pose.y);
    }
    if (this.boundsDirty) this.updateSphere();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.root.clear();
    this.mesh.dispose();
    this.plates.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.plateMaterial.dispose();
    this.slots.clear();
    this.plateSlots.clear();
    this.drawn.clear();
    this.matrixUploads.count = this.plateUploads.count = 0;
  }

  inspect() {
    return {
      instances: this.slots.size, plates: this.plateSlots.size,
      matrixWrites: this.matrixWrites, plateMatrixWrites: this.plateMatrixWrites, boundsUpdates: this.boundsUpdates,
    };
  }

  private upsert(object: PlatformObject): void {
    const previous = this.drawn.get(object.id);
    const drawn = previous ?? { id: object.id, object, slot: -1, plateSlot: -1, x: object.x, y: object.y };
    const slot = this.slots.upsert(drawn);
    this.mesh.count = this.slots.size;
    if (previous !== undefined && previous.object === object && previous.slot === slot) return;
    drawn.object = object;
    drawn.slot = slot;
    this.drawn.set(object.id, drawn);
    if (object.ride) drawn.plateSlot = this.plateSlots.upsert(drawn);
    else this.removePlate(drawn);
    this.plates.count = this.plateSlots.size;
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
    const drawn = this.drawn.get(id);
    if (drawn === undefined) throw new Error('Platform drawing slots are inconsistent.');
    this.removePlate(drawn);
    this.drawn.delete(id);
    if (removed.moved !== undefined) this.upsert(removed.moved.object);
    this.mesh.count = this.slots.size;
  }

  private removePlate(drawn: DrawnPlatform): void {
    if (drawn.plateSlot < 0) return;
    const removed = this.plateSlots.remove(drawn.id);
    if (removed === undefined) throw new Error('Platform plate slots are inconsistent.');
    drawn.plateSlot = -1;
    if (removed.moved !== undefined) {
      removed.moved.plateSlot = removed.slot;
      this.writePlate(removed.moved, removed.moved.x, removed.moved.y);
    }
    this.plates.count = this.plateSlots.size;
  }

  private updateBounds(): void {
    // The whole travel envelope, including a pose retained across an edit, bounds every frame without rescanning it.
    this.bounds.makeEmpty();
    for (const drawn of this.slots.values()) {
      const object = drawn.object;
      this.includePose(object, object.x, object.y);
      this.includePose(object, object.x + object.travelX, object.y + object.travelY);
      this.includePose(object, drawn.x, drawn.y);
    }
    this.updateSphere();
  }

  private includePose(object: PlatformObject, x: number, y: number): void {
    const { min, max } = this.bounds;
    const minX = x - object.width / 2, maxX = x + object.width / 2;
    const minY = y - object.height / 2, maxY = y + object.height / 2 + (object.ride ? DECK_PLATE.height : 0);
    const minZ = OBSTACLE_LINE - object.depth / 2, maxZ = OBSTACLE_LINE + object.depth / 2;
    if (minX >= min.x && maxX <= max.x && minY >= min.y && maxY <= max.y && minZ >= min.z && maxZ <= max.z) return;
    min.set(Math.min(min.x, minX), Math.min(min.y, minY), Math.min(min.z, minZ));
    max.set(Math.max(max.x, maxX), Math.max(max.y, maxY), Math.max(max.z, maxZ));
    this.boundsDirty = true;
  }

  private updateSphere(): void {
    this.bounds.getBoundingSphere(this.sphere);
    this.boundsDirty = false;
    this.boundsUpdates++;
  }

  private write(drawn: DrawnPlatform, x: number, y: number): void {
    const { slot, object } = drawn;
    this.matrix.makeScale(object.width, object.height, object.depth);
    this.matrix.setPosition(x, y, OBSTACLE_LINE);
    this.mesh.setMatrixAt(slot, this.matrix);
    markMatrix(this.matrixUploads, slot);
    if (drawn.plateSlot >= 0) this.writePlate(drawn, x, y);
    drawn.x = x;
    drawn.y = y;
    this.includePose(object, x, y);
    this.matrixWrites++;
  }

  private writePlate(drawn: DrawnPlatform, x: number, y: number): void {
    const { plateSlot, object } = drawn;
    this.matrix.makeScale(object.width * DECK_PLATE.width, DECK_PLATE.height, object.depth * DECK_PLATE.depth);
    this.matrix.setPosition(x, y + object.height / 2 + DECK_PLATE.height / 2, OBSTACLE_LINE);
    this.plates.setMatrixAt(plateSlot, this.matrix);
    markMatrix(this.plateUploads, plateSlot);
    this.plateMatrixWrites++;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed platform view.');
  }
}
