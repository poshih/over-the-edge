import { BufferGeometry, CylinderGeometry, DynamicDrawUsage, ExtrudeGeometry, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Shape } from 'three';
import { markInstanceSlot } from './instancing';
import { triggerBounds, TRIGGER_LIMITS } from './level';
import type { LevelChange, LevelObject, TriggerObject } from './level';

const FLAG = {
  poleHeight: 1.5, poleTopRadius: 0.025, poleBottomRadius: 0.035, poleSides: 8,
  poleDepth: -0.15, poleColor: 0xdbc9a0,
  width: 0.72, pointDrop: 0.12, height: 0.35, depth: 0.015,
  x: 0.03, y: 1.4, z: -0.1, color: 0xdc714d,
} as const;

function isFlag(object: LevelObject): object is TriggerObject {
  return object.kind === 'trigger' && object.marker === 'flag';
}

export class FlagView {
  readonly root = new Group();
  private readonly meshes: readonly InstancedMesh<BufferGeometry, MeshStandardMaterial>[];
  private readonly entries: TriggerObject[] = [];
  private readonly slots = new Map<string, number>();
  private readonly matrix = new Matrix4();
  private dirty = false;
  private disposed = false;
  private matrixWrites = 0;
  private boundsUpdates = 0;

  constructor() {
    this.root.visible = false;
    const pole = new CylinderGeometry(FLAG.poleTopRadius, FLAG.poleBottomRadius, FLAG.poleHeight, FLAG.poleSides);
    pole.translate(0, FLAG.poleHeight / 2, FLAG.poleDepth);
    const outline = new Shape();
    outline.moveTo(0, 0);
    outline.lineTo(FLAG.width, -FLAG.pointDrop);
    outline.lineTo(0, -FLAG.height);
    outline.closePath();
    const banner = new ExtrudeGeometry(outline, { depth: FLAG.depth, bevelEnabled: false });
    banner.translate(FLAG.x, FLAG.y, FLAG.z);
    this.meshes = [
      new InstancedMesh(pole, new MeshStandardMaterial({ color: FLAG.poleColor, roughness: 0.45, metalness: 0.4 }), TRIGGER_LIMITS.objects),
      new InstancedMesh(banner, new MeshStandardMaterial({ color: FLAG.color, roughness: 1 }), TRIGGER_LIMITS.objects),
    ];
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
    if (this.disposed) throw new Error('Cannot update disposed flags.');
    const flags = objects.filter(isFlag);
    const ids = new Set(flags.map((object) => object.id));
    for (const id of this.slots.keys()) if (!ids.has(id)) this.remove(id);
    for (const object of flags) this.upsert(object);
  }

  apply(change: LevelChange): void {
    if (this.disposed) throw new Error('Cannot update disposed flags.');
    if (change.kind === 'replace') { this.setObjects(change.level.objects); return; }
    for (const id of change.remove) this.remove(id);
    // Release retyped objects before allocating replacement slots at capacity.
    for (const object of change.upsert) if (!isFlag(object)) this.remove(object.id);
    for (const object of change.upsert) if (isFlag(object)) this.upsert(object);
  }

  update(): void {
    if (!this.dirty || this.disposed) return;
    this.root.visible = this.entries.length > 0;
    for (const mesh of this.meshes) mesh.computeBoundingSphere();
    this.boundsUpdates++;
    this.dirty = false;
  }

  inspect() {
    return { instances: this.entries.length, matrixWrites: this.matrixWrites, boundsUpdates: this.boundsUpdates };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) {
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.entries.length = 0;
    this.slots.clear();
    this.root.clear();
    this.root.removeFromParent();
  }

  private upsert(object: TriggerObject): void {
    const slot = this.slots.get(object.id);
    if (slot === undefined) {
      if (this.entries.length >= TRIGGER_LIMITS.objects) throw new Error('Flag instance capacity exceeded.');
      const index = this.entries.length;
      this.entries.push(object);
      this.slots.set(object.id, index);
      for (const mesh of this.meshes) mesh.count = this.entries.length;
      this.write(index, object);
    } else {
      const previous = this.entries[slot];
      this.entries[slot] = object;
      if (previous.x !== object.x || triggerBounds(previous).minY !== triggerBounds(object).minY) this.write(slot, object);
    }
  }

  private remove(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    const last = this.entries.pop();
    if (!last) throw new Error('Flag slots and instances are inconsistent.');
    this.slots.delete(id);
    if (slot < this.entries.length) {
      this.entries[slot] = last;
      this.slots.set(last.id, slot);
      this.write(slot, last);
    }
    for (const mesh of this.meshes) mesh.count = this.entries.length;
    this.dirty = true;
  }

  private write(slot: number, object: TriggerObject): void {
    this.matrix.makeTranslation(object.x, triggerBounds(object).minY, 0);
    for (const mesh of this.meshes) {
      mesh.setMatrixAt(slot, this.matrix);
      markInstanceSlot(mesh.instanceMatrix, slot);
    }
    this.matrixWrites++;
    this.dirty = true;
  }
}
