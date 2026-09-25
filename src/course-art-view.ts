import {
  Box3, BufferAttribute, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, SkinnedMesh, Sphere, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { ART_LIMITS, ArtError } from './art-types';
import type { ArtMirror, ArtMode, ArtResource } from './art-types';
import { ILLUSION, LEVEL_LIMITS } from './level';
import type { TerrainEvent, TerrainObject } from './level';
import { markInstanceSlot } from './instancing';
import type { PhysicsFrame } from './simulation';
import type { TerrainView } from './terrain-view';
import { loadVisualModel } from './visual-model';
import type { LoadedVisual } from './visual-model';
import { fetchModelBlob } from './model-data';
import { validateCourseModel } from './course-art-model';

interface Primitive { geometry: BufferGeometry; material: Material | Material[] }
interface Asset {
  model: LoadedVisual;
  templates: Map<ArtMirror, Primitive[]>;
  pixels: number;
  bytes: number;
}
interface Entry { object: TerrainObject; batch: Batch; slot: number }
interface Batch {
  key: string;
  entries: Entry[];
  meshes: InstancedMesh[];
  fade: number | null;
  materials: Map<Material, number>;
}
interface State { object: TerrainObject; fade: number | null; active: boolean }

export class CourseArtView {
  readonly root = new Group();
  private readonly terrain: TerrainView;
  private readonly missing: (message: string) => void;
  private readonly assets = new Map<string, Asset>();
  private readonly states = new Map<string, State>();
  private readonly entries = new Map<string, Entry>();
  private readonly batches = new Map<string, Batch>();
  private readonly dirty = new Set<Batch>();
  private readonly fading = new Set<Batch>();
  private readonly reported = new Set<string>();
  private readonly matrix = new Matrix4();
  private readonly unsubscribe: () => void;
  private readonly lifecycle = new AbortController();
  private mode: ArtMode = 'shapes';
  private disposed = false;
  private matrixWrites = 0;
  private boundsUpdates = 0;
  private materialUpdates = 0;

  constructor(options: {
    terrain: TerrainView;
    subscribe: (listener: (event: TerrainEvent) => void) => () => void;
    onMissing: (message: string) => void;
  }) {
    this.terrain = options.terrain;
    this.missing = options.onMissing;
    this.root.name = 'course-artwork';
    this.root.matrixAutoUpdate = false;
    this.unsubscribe = options.subscribe((event) => this.apply(event));
  }

  async load(resources: readonly ArtResource[], signal?: AbortSignal): Promise<void> {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    if (resources.length > ART_LIMITS.assets) throw new ArtError('A course can use at most 64 distinct artwork assets.');
    const retained = new Set(resources.map((resource) => resource.id));
    for (const state of this.states.values()) {
      if (state.object.art && this.assets.has(state.object.art.assetId)) retained.add(state.object.art.assetId);
    }
    for (const [id, asset] of this.assets) {
      if (retained.has(id)) continue;
      for (const primitives of asset.templates.values()) for (const primitive of primitives) primitive.geometry.dispose();
      asset.model.dispose();
      this.assets.delete(id);
    }
    if (retained.size > ART_LIMITS.assets) throw new ArtError('A course can use at most 64 distinct artwork assets.');
    for (const resource of resources) {
      signal?.throwIfAborted();
      if (this.disposed) throw new ArtError('The course artwork renderer was closed.');
      if (this.assets.has(resource.id)) continue;
      const blob = await fetchModelBlob(resource.source, signal);
      const bytes = [...this.assets.values()].reduce((sum, asset) => sum + asset.bytes, blob.size);
      if (blob.size > ART_LIMITS.bytes || bytes > ART_LIMITS.totalBytes) throw new ArtError('Course artwork exceeds its download budget.');
      const { pixels } = validateCourseModel(await blob.arrayBuffer());
      if ([...this.assets.values()].reduce((sum, asset) => sum + asset.pixels, pixels) > ART_LIMITS.texturePixels) {
        throw new ArtError('Course artwork exceeds 32 million decoded texture pixels. Reuse assets or reduce texture sizes.');
      }
      const model = await loadVisualModel(blob);
      try {
        signal?.throwIfAborted();
        if (this.disposed) throw new ArtError('The course artwork renderer was closed.');
        let meshes = 0;
        model.scene.traverse((node) => {
          if (!(node instanceof Mesh)) return;
          if (node instanceof SkinnedMesh || node instanceof InstancedMesh || Object.keys(node.geometry.morphAttributes).length > 0) {
            throw new ArtError('Course artwork must contain ordinary static meshes, not skins, morphs, or nested instances.');
          }
          meshes++;
        });
        if (meshes > ART_LIMITS.meshes || model.triangles > ART_LIMITS.triangles) {
          throw new ArtError(`"${resource.name}" exceeds 16 meshes or 50,000 triangles. Optimize it before using it on the course.`);
        }
        const size = model.bounds.getSize(new Vector3());
        if (Math.min(size.x, size.y, size.z) < 0.000001) throw new ArtError('Course meshes need nonzero width, height, and depth.');
        this.assets.set(resource.id, { model, pixels, bytes: blob.size, templates: new Map() });
        this.reported.delete(resource.id);
      } catch (error) {
        model.dispose();
        throw error;
      }
    }
    if (this.mode === 'meshes') for (const state of this.states.values()) this.sync(state);
  }

  hasAssets(ids: Iterable<string>): boolean {
    for (const id of ids) if (!this.assets.has(id)) return false;
    return true;
  }

  clearLoaded(): void {
    if (this.mode !== 'shapes') throw new ArtError('Switch to editor shapes before releasing course artwork.');
    for (const asset of this.assets.values()) {
      for (const primitives of asset.templates.values()) for (const primitive of primitives) primitive.geometry.dispose();
      asset.model.dispose();
    }
    this.assets.clear();
    this.reported.clear();
  }

  setMode(mode: ArtMode): void {
    if (mode === 'meshes') {
      const absent = [...this.states.values()].find((state) => state.object.art && !this.assets.has(state.object.art.assetId));
      if (absent) throw new ArtError(`Load artwork for "${absent.object.id}" before switching to meshes.`);
    }
    if (this.mode === mode) return;
    this.mode = mode;
    for (const state of this.states.values()) this.sync(state);
  }

  update(frame: PhysicsFrame): void {
    if (this.disposed) return;
    for (const batch of this.fading) {
      const opacity = Math.max(0, Math.min(1, 1 - (frame.time - batch.fade!) / ILLUSION.fadeSeconds));
      for (const [material, original] of batch.materials) {
        if (material.opacity !== original * opacity) { material.opacity = original * opacity; this.materialUpdates++; }
      }
    }
    for (const batch of this.dirty) {
      for (const mesh of batch.meshes) {
        mesh.computeBoundingBox();
        mesh.boundingBox!.getBoundingSphere(mesh.boundingSphere!);
      }
      this.boundsUpdates++;
    }
    this.dirty.clear();
  }

  inspect() {
    return {
      mode: this.mode, assets: this.assets.size, instances: this.entries.size, batches: this.batches.size,
      fadingBatches: this.fading.size, matrixWrites: this.matrixWrites, boundsUpdates: this.boundsUpdates,
      materialUpdates: this.materialUpdates,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.lifecycle.abort();
    this.unsubscribe();
    for (const entry of [...this.entries.values()]) this.remove(entry);
    for (const id of this.states.keys()) this.terrain.setHidden(id, false);
    for (const asset of this.assets.values()) {
      for (const primitives of asset.templates.values()) for (const primitive of primitives) primitive.geometry.dispose();
      asset.model.dispose();
    }
    this.assets.clear(); this.states.clear(); this.reported.clear();
    this.root.removeFromParent();
    this.disposed = true;
  }

  private apply(event: TerrainEvent): void {
    if (event.type === 'reset') {
      for (const entry of [...this.entries.values()]) this.remove(entry);
      for (const id of this.states.keys()) this.terrain.setHidden(id, false);
      this.states.clear();
      for (const object of event.objects) this.apply({ type: 'upsert', object });
    } else if (event.type === 'upsert') {
      const state: State = { object: event.object, fade: null, active: true };
      this.states.set(event.object.id, state);
      this.sync(state);
    } else if (event.type === 'remove' || event.type === 'disappear') {
      const entry = this.entries.get(event.id);
      if (entry) this.remove(entry);
      const state = this.states.get(event.id);
      if (state) state.active = false;
      if (event.type === 'remove') { this.states.delete(event.id); this.terrain.setHidden(event.id, false); }
    } else if (event.type === 'fade') {
      const state = this.states.get(event.id);
      if (state?.object.illusion) { state.fade = event.startedAt; this.sync(state); }
    }
  }

  private sync(state: State): void {
    const { object, active, fade } = state;
    const art = object.art;
    const available = art !== undefined && this.assets.has(art.assetId);
    const visible = this.mode === 'meshes' && active && available;
    this.terrain.setHidden(object.id, this.mode === 'meshes' && available);
    let entry = this.entries.get(object.id);
    if (!visible || art === undefined) {
      if (entry) this.remove(entry);
      if (this.mode === 'meshes' && art && !available && !this.reported.has(art.assetId)) {
        this.reported.add(art.assetId);
        this.missing(`Artwork for "${object.id}" is not loaded. Its editor shape remains visible until you load the shared asset.`);
      }
      return;
    }
    const key = `${Math.floor(object.x / 32)},${Math.floor(object.y / 32)}:${art.assetId}:${art.mirror}:${fade ?? 'solid'}`;
    if (entry?.batch.key === key) {
      const previous = entry.object;
      entry.object = object;
      if (previous.x !== object.x || previous.y !== object.y || previous.angle !== object.angle ||
        previous.width !== object.width || previous.height !== object.height || previous.depth !== object.depth) this.write(entry);
      return;
    }
    if (entry) this.remove(entry);
    let batch = this.batches.get(key);
    if (!batch) {
      const primitives = this.template(art.assetId, art.mirror);
      const materials = new Map<Material, number>();
      const clones = new Map<Material, Material>();
      const material = (source: Material): Material => {
        if (fade === null) return source;
        let clone = clones.get(source);
        if (!clone) {
          clone = source.clone(); clone.transparent = true; clone.depthWrite = false;
          clones.set(source, clone); materials.set(clone, source.opacity);
        }
        return clone;
      };
      const meshes = primitives.map((primitive) => this.mesh(primitive.geometry,
        Array.isArray(primitive.material) ? primitive.material.map(material) : material(primitive.material), 8));
      batch = { key, entries: [], meshes, fade, materials };
      this.batches.set(key, batch);
      if (fade !== null) this.fading.add(batch);
      this.root.add(...meshes);
    }
    if (batch.entries.length === batch.meshes[0].instanceMatrix.count) {
      batch.meshes = batch.meshes.map((old) => {
        const next = this.mesh(old.geometry, old.material, Math.min(LEVEL_LIMITS.objects, old.instanceMatrix.count * 2));
        next.instanceMatrix.array.set(old.instanceMatrix.array);
        next.count = old.count;
        old.removeFromParent(); old.dispose(); this.root.add(next);
        return next;
      });
    }
    entry = { object, batch, slot: batch.entries.length };
    batch.entries.push(entry);
    this.entries.set(object.id, entry);
    for (const mesh of batch.meshes) mesh.count = batch.entries.length;
    this.write(entry);
  }

  private template(id: string, mirror: ArtMirror): Primitive[] {
    const asset = this.assets.get(id);
    if (!asset) throw new ArtError('The artwork asset was not loaded.');
    const cached = asset.templates.get(mirror);
    if (cached) return cached;
    const size = asset.model.bounds.getSize(new Vector3());
    const center = asset.model.bounds.getCenter(new Vector3());
    const normalize = new Matrix4().makeScale(1 / size.x, 1 / size.y, 1 / size.z)
      .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -asset.model.bounds.max.z));
    const reflect = mirror === 'x' ? new Matrix4().makeScale(-1, 1, 1) :
      mirror === 'diagonal' ? new Matrix4().set(0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) : new Matrix4();
    const primitives: Primitive[] = [];
    asset.model.scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const geometry = node.geometry.clone();
      const transform = new Matrix4().multiplyMatrices(reflect, normalize).multiply(node.matrixWorld);
      geometry.applyMatrix4(transform);
      if (transform.determinant() < 0) {
        const length = geometry.index?.count ?? geometry.getAttribute('position').count;
        const indices = new Uint32Array(length);
        for (let i = 0; i < length; i += 3) {
          indices[i] = geometry.index?.getX(i) ?? i;
          indices[i + 1] = geometry.index?.getX(i + 2) ?? i + 2;
          indices[i + 2] = geometry.index?.getX(i + 1) ?? i + 1;
        }
        geometry.setIndex(new BufferAttribute(indices, 1));
        const tangents = geometry.getAttribute('tangent');
        if (tangents) for (let index = 0; index < tangents.count; index++) tangents.setW(index, -tangents.getW(index));
      }
      primitives.push({ geometry, material: node.material });
    });
    asset.templates.set(mirror, primitives);
    return primitives;
  }

  private mesh(geometry: BufferGeometry, material: Material | Material[], capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.count = 0; mesh.matrixAutoUpdate = false;
    mesh.boundingBox = new Box3(); mesh.boundingSphere = new Sphere();
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceMatrix.onUpload(() => mesh.instanceMatrix.clearUpdateRanges());
    return mesh;
  }

  private write(entry: Entry): void {
    const o = entry.object;
    const c = Math.cos(o.angle), s = Math.sin(o.angle);
    this.matrix.set(c * o.width, -s * o.height, 0, o.x, s * o.width, c * o.height, 0, o.y, 0, 0, o.depth, 0, 0, 0, 0, 1);
    for (const mesh of entry.batch.meshes) { mesh.setMatrixAt(entry.slot, this.matrix); markInstanceSlot(mesh.instanceMatrix, entry.slot); }
    this.matrixWrites++;
    this.dirty.add(entry.batch);
  }

  private remove(entry: Entry): void {
    const batch = entry.batch;
    const last = batch.entries.pop()!;
    this.entries.delete(entry.object.id);
    if (last !== entry) {
      last.slot = entry.slot; batch.entries[entry.slot] = last;
      this.write(last);
    }
    for (const mesh of batch.meshes) mesh.count = batch.entries.length;
    if (batch.entries.length === 0) {
      for (const mesh of batch.meshes) { mesh.removeFromParent(); mesh.dispose(); }
      for (const material of batch.materials.keys()) material.dispose();
      this.batches.delete(batch.key); this.fading.delete(batch); this.dirty.delete(batch);
    } else this.dirty.add(batch);
  }
}
