import {
  Box3, Color, DynamicDrawUsage, ExtrudeGeometry, Group, InstancedBufferAttribute,
  InstancedMesh, Matrix4, MeshStandardMaterial, Shape, Sphere,
} from 'three';
import { geometryKey, ILLUSION, LEVEL_LIMITS, shapeVertices } from './level';
import type { TerrainObject, LevelShape, TerrainEvent } from './level';
import { markInstanceSlot } from './instancing';

const CHUNK_SIZE = 32;
const INITIAL_CAPACITY = 8;
const SIDE_SHADE = 0.62;
type MaterialPair = [MeshStandardMaterial, MeshStandardMaterial];
type TerrainMesh = InstancedMesh<ExtrudeGeometry, MaterialPair>;

interface Template {
  readonly geometry: ExtrudeGeometry;
  references: number;
}

interface Phase {
  readonly startedAt: number;
  readonly materials: MaterialPair;
  readonly batches: Map<string, Batch>;
}

interface Batch {
  readonly key: string;
  readonly template: Template;
  readonly phase: Phase | null;
  readonly entries: Instance[];
  mesh: TerrainMesh;
}

interface Instance {
  object: TerrainObject;
  readonly batch: Batch;
  slot: number;
}

function materials(options: { fading: boolean }): MaterialPair {
  const front = new MeshStandardMaterial({
    roughness: 0.95, metalness: 0.02, flatShading: true,
    transparent: options.fading, depthWrite: !options.fading,
  });
  const side = front.clone();
  side.color.setScalar(SIDE_SHADE);
  side.roughness = 1;
  return [front, side];
}

function batchKey(object: TerrainObject, shapeKey: string): string {
  return `${Math.floor(object.x / CHUNK_SIZE)},${Math.floor(object.y / CHUNK_SIZE)}:${shapeKey}`;
}

export class TerrainView {
  readonly root = new Group();
  private readonly instances = new Map<string, Instance>();
  private readonly templates = new Map<string, Template>();
  private readonly opaque = new Map<string, Batch>();
  private readonly phases = new Map<number, Phase>();
  private readonly batches = new Set<Batch>();
  private readonly dirtyBounds = new Set<Batch>();
  private readonly opaqueMaterials = materials({ fading: false });
  private readonly matrix = new Matrix4();
  private readonly color = new Color();
  private disposed = false;
  private readonly counters = {
    geometriesBuilt: 0, geometryEvictions: 0, batchesCreated: 0, batchesDisposed: 0,
    capacityGrowths: 0, matrixWrites: 0, colorWrites: 0, boundsUpdates: 0, phaseUpdates: 0,
  };

  constructor() {
    this.root.name = 'authored-terrain';
    this.root.matrixAutoUpdate = false;
  }

  apply(event: TerrainEvent): void {
    if (this.disposed) throw new Error('Cannot update disposed terrain.');
    switch (event.type) {
      case 'reset':
        this.clearInstances();
        for (const object of event.objects) this.upsert(object);
        break;
      case 'upsert':
        this.upsert(event.object);
        break;
      case 'remove':
      case 'disappear': {
        const instance = this.instances.get(event.id);
        if (instance) this.remove(instance);
        break;
      }
      case 'fade': {
        const instance = this.instances.get(event.id);
        if (!instance || !instance.object.illusion || instance.batch.phase?.startedAt === event.startedAt) break;
        const object = instance.object;
        this.remove(instance);
        let phase = this.phases.get(event.startedAt);
        if (!phase) {
          phase = { startedAt: event.startedAt, materials: materials({ fading: true }), batches: new Map() };
          this.phases.set(event.startedAt, phase);
        }
        const key = geometryKey(object.shape);
        this.insert(object, this.getBatch(object, key, phase));
        break;
      }
    }
  }

  update(time: number): void {
    if (this.disposed || (this.phases.size === 0 && this.dirtyBounds.size === 0)) return;
    for (const phase of this.phases.values()) {
      const opacity = Math.max(0, Math.min(1, 1 - (time - phase.startedAt) / ILLUSION.fadeSeconds));
      if (time >= phase.startedAt + ILLUSION.fadeSeconds) {
        for (const batch of phase.batches.values()) {
          for (const instance of batch.entries) this.instances.delete(instance.object.id);
          this.destroyBatch(batch);
        }
      } else if (phase.materials[0].opacity !== opacity) {
        for (const material of phase.materials) material.opacity = opacity;
        this.counters.phaseUpdates++;
      }
    }
    for (const batch of this.dirtyBounds) {
      batch.mesh.computeBoundingBox();
      batch.mesh.boundingBox!.getBoundingSphere(batch.mesh.boundingSphere!);
      this.counters.boundsUpdates++;
    }
    this.dirtyBounds.clear();
  }

  inspect() {
    let capacity = 0;
    let fadingInstances = 0;
    let unusedGeometries = 0;
    for (const batch of this.batches) {
      capacity += batch.mesh.instanceMatrix.count;
      if (batch.phase) fadingInstances += batch.entries.length;
    }
    for (const template of this.templates.values()) {
      if (template.references === 0) unusedGeometries++;
    }
    return {
      instances: this.instances.size, fadingInstances, batches: this.batches.size,
      opaqueBatches: this.opaque.size, activePhases: this.phases.size,
      geometries: this.templates.size, unusedGeometries,
      materials: this.disposed ? 0 : this.opaqueMaterials.length + this.phases.size * 2,
      capacity, dirtyBounds: this.dirtyBounds.size, ...this.counters,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearInstances();
    for (const template of this.templates.values()) template.geometry.dispose();
    this.templates.clear();
    for (const material of this.opaqueMaterials) material.dispose();
    this.root.removeFromParent();
    this.disposed = true;
  }

  private upsert(object: TerrainObject): void {
    const instance = this.instances.get(object.id);
    const key = geometryKey(object.shape);
    const destination = batchKey(object, key);
    // Authored edits revive illusions, just as recreating their physics body does.
    if (instance && instance.batch.phase === null && instance.batch.key === destination) {
      const previous = instance.object;
      instance.object = object;
      if (previous.x !== object.x || previous.y !== object.y || previous.angle !== object.angle ||
        previous.width !== object.width || previous.height !== object.height || previous.depth !== object.depth) {
        this.writeMatrix(instance);
      }
      if (previous.color !== object.color) this.writeColor(instance);
      return;
    }
    if (instance) this.remove(instance);
    if (this.instances.size >= LEVEL_LIMITS.objects) throw new Error('Terrain instance limit exceeded.');
    this.insert(object, this.getBatch(object, key, null));
  }

  private getTemplate(shape: LevelShape, key: string): Template {
    const existing = this.templates.get(key);
    if (existing) {
      this.templates.delete(key);
      this.templates.set(key, existing);
      return existing;
    }
    if (this.templates.size >= LEVEL_LIMITS.geometryKinds) {
      for (const [candidate, template] of this.templates) {
        if (template.references !== 0) continue;
        template.geometry.dispose();
        this.templates.delete(candidate);
        this.counters.geometryEvictions++;
        break;
      }
      if (this.templates.size >= LEVEL_LIMITS.geometryKinds) throw new Error('Terrain geometry limit exceeded.');
    }
    const vertices = shapeVertices(shape);
    const outline = new Shape();
    outline.moveTo(vertices[0].x, vertices[0].y);
    for (let index = 1; index < vertices.length; index++) outline.lineTo(vertices[index].x, vertices[index].y);
    outline.closePath();
    const geometry = new ExtrudeGeometry(outline, { depth: 1, steps: 1, bevelEnabled: false });
    geometry.translate(0, 0, -1);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const template = { geometry, references: 0 };
    this.templates.set(key, template);
    this.counters.geometriesBuilt++;
    return template;
  }

  private getBatch(object: TerrainObject, shapeKey: string, phase: Phase | null): Batch {
    const key = batchKey(object, shapeKey);
    const collection = phase ? phase.batches : this.opaque;
    const existing = collection.get(key);
    if (existing) return existing;
    const template = this.getTemplate(object.shape, shapeKey);
    const batch: Batch = {
      key, template, phase, entries: [],
      mesh: this.createMesh(template, phase ? phase.materials : this.opaqueMaterials, INITIAL_CAPACITY),
    };
    template.references++;
    collection.set(key, batch);
    this.batches.add(batch);
    this.root.add(batch.mesh);
    this.counters.batchesCreated++;
    return batch;
  }

  private createMesh(template: Template, pair: MaterialPair, capacity: number): TerrainMesh {
    const mesh = new InstancedMesh(template.geometry, pair, capacity);
    mesh.count = 0;
    mesh.matrixAutoUpdate = false;
    mesh.boundingBox = new Box3();
    mesh.boundingSphere = new Sphere();
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    const matrix = mesh.instanceMatrix;
    const color = mesh.instanceColor;
    matrix.onUpload(() => matrix.clearUpdateRanges());
    color.onUpload(() => color.clearUpdateRanges());
    return mesh;
  }

  private insert(object: TerrainObject, batch: Batch): void {
    const slot = batch.entries.length;
    if (slot === batch.mesh.instanceMatrix.count) this.grow(batch);
    const instance: Instance = { object, batch, slot };
    batch.entries.push(instance);
    this.instances.set(object.id, instance);
    batch.mesh.count = batch.entries.length;
    this.writeMatrix(instance);
    this.writeColor(instance);
  }

  private grow(batch: Batch): void {
    const previous = batch.mesh;
    const capacity = Math.min(previous.instanceMatrix.count * 2, LEVEL_LIMITS.objects);
    const mesh = this.createMesh(batch.template, previous.material, capacity);
    mesh.instanceMatrix.array.set(previous.instanceMatrix.array);
    mesh.instanceColor!.array.set(previous.instanceColor!.array);
    mesh.count = previous.count;
    this.root.remove(previous);
    previous.dispose();
    batch.mesh = mesh;
    this.root.add(mesh);
    this.counters.capacityGrowths++;
  }

  private writeMatrix(instance: Instance): void {
    const object = instance.object;
    const cosine = Math.cos(object.angle);
    const sine = Math.sin(object.angle);
    this.matrix.set(
      cosine * object.width, -sine * object.height, 0, object.x,
      sine * object.width, cosine * object.height, 0, object.y,
      0, 0, object.depth, 0,
      0, 0, 0, 1,
    );
    instance.batch.mesh.setMatrixAt(instance.slot, this.matrix);
    markInstanceSlot(instance.batch.mesh.instanceMatrix, instance.slot);
    this.dirtyBounds.add(instance.batch);
    this.counters.matrixWrites++;
  }

  private writeColor(instance: Instance): void {
    instance.batch.mesh.setColorAt(instance.slot, this.color.setHex(instance.object.color));
    markInstanceSlot(instance.batch.mesh.instanceColor!, instance.slot);
    this.counters.colorWrites++;
  }

  private remove(instance: Instance): void {
    const batch = instance.batch;
    const last = batch.entries.pop()!;
    this.instances.delete(instance.object.id);
    if (last !== instance) {
      last.slot = instance.slot;
      batch.entries[instance.slot] = last;
      const matrix = batch.mesh.instanceMatrix;
      const color = batch.mesh.instanceColor!;
      matrix.array.copyWithin(instance.slot * 16, batch.entries.length * 16, (batch.entries.length + 1) * 16);
      color.array.copyWithin(instance.slot * 3, batch.entries.length * 3, (batch.entries.length + 1) * 3);
      markInstanceSlot(matrix, instance.slot);
      markInstanceSlot(color, instance.slot);
      this.counters.matrixWrites++;
      this.counters.colorWrites++;
    }
    batch.mesh.count = batch.entries.length;
    if (batch.entries.length === 0) this.destroyBatch(batch);
    else this.dirtyBounds.add(batch);
  }

  private destroyBatch(batch: Batch): void {
    this.root.remove(batch.mesh);
    batch.mesh.dispose();
    batch.template.references--;
    this.batches.delete(batch);
    this.dirtyBounds.delete(batch);
    const phase = batch.phase;
    if (phase) {
      phase.batches.delete(batch.key);
      if (phase.batches.size === 0) {
        this.phases.delete(phase.startedAt);
        for (const material of phase.materials) material.dispose();
      }
    } else {
      this.opaque.delete(batch.key);
    }
    this.counters.batchesDisposed++;
  }

  private clearInstances(): void {
    for (const batch of this.batches) this.destroyBatch(batch);
    this.instances.clear();
  }
}
