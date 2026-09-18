import { DynamicDrawUsage, Group, Matrix4 } from 'three';
import type { BufferGeometry, InstancedMesh, Material } from 'three';
import { InstanceSlots, markInstanceSlot } from './instancing';
import { TRIGGER_LIMITS } from './level';
import type { LevelChange, LevelObject, TriggerObject } from './level';

type MarkerKind = Exclude<TriggerObject['marker'], 'none'>;

export class MarkerView {
  readonly root = new Group();
  private readonly kind: MarkerKind;
  private readonly meshes: readonly InstancedMesh<BufferGeometry, Material>[];
  private readonly transform: (object: TriggerObject, matrix: Matrix4) => Matrix4;
  private readonly instances = new InstanceSlots<TriggerObject>({
    capacity: TRIGGER_LIMITS.objects, label: 'Trigger marker',
  });
  private readonly matrix = new Matrix4();
  private dirty = false;
  private disposed = false;
  private matrixWrites = 0;
  private boundsUpdates = 0;

  protected constructor(options: {
    kind: MarkerKind;
    meshes: readonly InstancedMesh<BufferGeometry, Material>[];
    transform: (object: TriggerObject, matrix: Matrix4) => Matrix4;
  }) {
    if (options.meshes.length === 0) throw new Error('A trigger marker needs at least one render batch.');
    this.kind = options.kind;
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

  setObjects(objects: readonly LevelObject[]): void {
    this.ensureLive();
    const markers = objects.filter((object): object is TriggerObject => this.matches(object));
    const ids = new Set(markers.map((object) => object.id));
    for (const id of this.instances.ids()) if (!ids.has(id)) this.remove(id);
    for (const object of markers) this.upsert(object);
  }

  apply(change: LevelChange): void {
    this.ensureLive();
    if (change.kind === 'replace') { this.setObjects(change.level.objects); return; }
    for (const id of change.remove) this.remove(id);
    for (const object of change.upsert) if (!this.matches(object)) this.remove(object.id);
    for (const object of change.upsert) if (this.matches(object)) this.upsert(object);
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

  private matches(object: LevelObject): object is TriggerObject {
    return object.kind === 'trigger' && object.marker === this.kind;
  }

  private upsert(object: TriggerObject): void {
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
  }

  private remove(id: string): void {
    const removed = this.instances.remove(id);
    if (removed === undefined) return;
    if (removed.moved !== undefined) this.write(removed.slot, this.transform(removed.moved, this.matrix));
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
    if (this.disposed) throw new Error('Cannot update disposed trigger markers.');
  }
}
