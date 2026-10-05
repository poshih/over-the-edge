import { DynamicDrawUsage, Group, Matrix4 } from 'three';
import type { BufferGeometry, InstancedMesh, Material } from 'three';
import { InstanceSlots, markInstanceSlot } from './instancing';
import type { LevelObject } from './level';

/**
 * Draws the level's objects of one kind as instances of a few meshes, one instance each, all placed by one matrix.
 * setObjects takes all of them each time; an object's instance is written only when the object changes or moves to
 * another slot, and subclasses keep any per-instance attributes of their own in step through `written`.
 */
export class ObjectView<T extends LevelObject> {
  readonly root = new Group();
  private readonly matches: (object: LevelObject) => object is T;
  private readonly meshes: readonly InstancedMesh<BufferGeometry, Material>[];
  private readonly transform: (object: T, matrix: Matrix4) => Matrix4;
  private readonly instances: InstanceSlots<T>;
  private readonly matrix = new Matrix4();
  private dirty = false;
  private disposed = false;
  private matrixWrites = 0;
  private boundsUpdates = 0;

  protected constructor(options: {
    matches: (object: LevelObject) => object is T;
    // At most this many objects, named in errors by `label`.
    capacity: number;
    label: string;
    meshes: readonly InstancedMesh<BufferGeometry, Material>[];
    transform: (object: T, matrix: Matrix4) => Matrix4;
  }) {
    if (options.meshes.length === 0) throw new Error(`${options.label} needs at least one render batch.`);
    this.matches = options.matches;
    this.instances = new InstanceSlots<T>({ capacity: options.capacity, label: options.label });
    this.meshes = options.meshes;
    this.transform = options.transform;
    this.root.visible = false;
    for (const mesh of this.meshes) {
      mesh.count = 0;
      mesh.matrixAutoUpdate = false;
      const attribute = mesh.instanceMatrix;
      attribute.setUsage(DynamicDrawUsage);
      attribute.onUpload(() => attribute.clearUpdateRanges());
      this.root.add(mesh);
    }
  }

  get count(): number {
    return this.instances.size;
  }

  setObjects(objects: readonly LevelObject[]): void {
    this.ensureLive();
    const drawn = objects.filter(this.matches);
    const ids = new Set(drawn.map((object) => object.id));
    for (const id of [...this.instances.ids()]) if (!ids.has(id)) this.remove(id);
    for (const object of drawn) this.upsert(object);
  }

  protected updateBounds(): void {
    if (!this.dirty || this.disposed) return;
    this.root.visible = this.instances.size > 0;
    for (const mesh of this.meshes) mesh.computeBoundingSphere();
    this.boundsUpdates++;
    this.dirty = false;
  }

  inspect() {
    return { instances: this.instances.size, matrixWrites: this.matrixWrites, boundsUpdates: this.boundsUpdates };
  }

  // After `object` takes `slot`, changes in it or moves to it.
  protected written(_slot: number, _object: T): void {}

  // The slot of the object with `id`, and the object, if it is drawn.
  protected drawn(id: string): { readonly slot: number; readonly object: T } | undefined {
    return this.instances.find(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) {
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.instances.clear();
    this.root.clear();
    this.root.removeFromParent();
  }

  private upsert(object: T): void {
    const matrix = this.transform(object, this.matrix);
    const count = this.instances.size;
    const slot = this.instances.upsert(object);
    if (this.instances.size !== count) {
      for (const mesh of this.meshes) mesh.count = this.instances.size;
      this.write(slot, matrix);
    } else {
      const values = this.meshes[0].instanceMatrix.array;
      const offset = slot * this.meshes[0].instanceMatrix.itemSize;
      if (matrix.elements.some((value, index) => Math.fround(value) !== values[offset + index])) {
        this.write(slot, matrix);
      }
    }
    this.written(slot, object);
  }

  private remove(id: string): void {
    const removed = this.instances.remove(id);
    if (removed === undefined) return;
    if (removed.moved !== undefined) {
      this.write(removed.slot, this.transform(removed.moved, this.matrix));
      this.written(removed.slot, removed.moved);
    }
    for (const mesh of this.meshes) mesh.count = this.instances.size;
    this.dirty = true;
  }

  private write(slot: number, matrix: Matrix4): void {
    for (const mesh of this.meshes) {
      mesh.setMatrixAt(slot, matrix);
      markInstanceSlot(mesh.instanceMatrix, slot);
    }
    this.matrixWrites++;
    this.dirty = true;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot update a disposed level object view.');
  }
}
