import {
  Box3, BufferAttribute, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, SkinnedMesh, Sphere, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { ART_LIMITS, ArtError } from './art-types';
import type { ArtMode } from './art-types';
import { ILLUSION, LEVEL_LIMITS } from './level';
import type { TerrainEvent, TerrainObject } from './level';
import { markInstanceSlot } from './instancing';
import { OBSTACLE_LINE } from './obstacle-line';
import type { SceneFrame, SceneLayer } from './scene-layer';
import type { TerrainView } from './terrain-view';
import { loadVisualModel } from './visual-model';
import type { LoadedVisual } from './visual-model';
import { validateCourseModel } from './course-art-model';
import type { DecorationMesh } from './decoration-view';

interface Primitive { geometry: BufferGeometry; material: Material | Material[] }
interface Asset {
  model: LoadedVisual;
  // Its geometry fitted to the unit box, plain and mirrored.
  templates: Map<boolean, Primitive[]>;
  // The asset as a decoration model, built when a decoration first draws it.
  decoration: DecorationMesh | null;
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

// The asset a terrain object draws, or null for a built-in mesh or drawn outline.
function meshAsset(object: TerrainObject): string | null {
  return object.mesh.type === 'asset' ? object.mesh.assetId : null;
}

// A mesh's geometry in the asset's space with `transform` applied; a mirroring transform keeps its faces outward.
function bake(node: Mesh, transform: Matrix4): BufferGeometry {
  const geometry = node.geometry.clone();
  const matrix = new Matrix4().multiplyMatrices(transform, node.matrixWorld);
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
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
  return geometry;
}

function disposeAsset(asset: Asset): void {
  for (const primitives of asset.templates.values()) for (const primitive of primitives) primitive.geometry.dispose();
  for (const part of asset.decoration?.parts ?? []) part.geometry.dispose();
  asset.model.dispose();
}

/**
 * Draws the course's meshes: each terrain object whose mesh is a GLB draws that GLB, fitted to its box and mirrored as
 * placed, in place of its collision's extrusion, and decorations may draw GLBs in place of their placeholders. In the
 * meshes look it loads each GLB the terrain uses as it first appears, and lets go of one nothing uses any more; terrain
 * keeps drawing as its collision until its GLB loads, or if it cannot, and every terrain object does in the shapes look.
 */
export class CourseArtView implements SceneLayer {
  readonly root = new Group();
  // Course meshes are the course's own look: they draw with the terrain.
  readonly pass = 'course';
  private readonly terrain: TerrainView;
  private readonly fetch: (assetId: string, signal: AbortSignal) => Promise<Blob>;
  private readonly failure: (assetId: string, error: unknown) => void;
  private readonly assets = new Map<string, Asset>();
  // GLBs being loaded, and those that could not be, which are not tried again.
  private readonly loading = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  // How many terrain objects draw each GLB, and the GLBs loaded up front, kept while nothing draws them.
  private readonly uses = new Map<string, number>();
  private readonly pinned = new Set<string>();
  // Loaded GLBs nothing draws any more, let go of on the next frame unless the course takes them back first, as it does
  // when an edit replaces a placement.
  private readonly unused = new Set<string>();
  private readonly states = new Map<string, State>();
  private readonly entries = new Map<string, Entry>();
  private readonly batches = new Map<string, Batch>();
  private readonly dirty = new Set<Batch>();
  private readonly fading = new Set<Batch>();
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
    // A GLB's bytes, by asset ID: a release's packaged content, or the Workshop's project file.
    fetch: (assetId: string, signal: AbortSignal) => Promise<Blob>;
    // A GLB the meshes look could not load on its own; its terrain keeps drawing as its collision.
    onFailure: (assetId: string, error: unknown) => void;
  }) {
    this.terrain = options.terrain;
    this.fetch = options.fetch;
    this.failure = options.onFailure;
    this.root.name = 'course-artwork';
    this.root.matrixAutoUpdate = false;
    this.unsubscribe = options.subscribe((event) => this.apply(event));
  }

  // Loads `ids` and keeps them until the view closes, so a release draws every mesh, and the decorations drawn with
  // them, from its first frame.
  async load(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    if (ids.length > ART_LIMITS.assets) throw new ArtError(`A course can use at most ${ART_LIMITS.assets} distinct meshes.`);
    for (const id of ids) this.pinned.add(id);
    for (const id of ids) await this.request(id, signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal);
  }

  // Loads a GLB once, however many ask for it, and draws the terrain waiting for it.
  private request(id: string, signal: AbortSignal): Promise<void> {
    if (this.assets.has(id)) return Promise.resolve();
    let pending = this.loading.get(id);
    if (pending === undefined) {
      pending = this.loadAsset(id, signal).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  private async loadAsset(id: string, signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new ArtError('The course mesh renderer was closed.');
    const blob = await this.fetch(id, signal);
    signal.throwIfAborted();
    const bytes = [...this.assets.values()].reduce((sum, asset) => sum + asset.bytes, blob.size);
    if (this.assets.size >= ART_LIMITS.assets || blob.size > ART_LIMITS.bytes || bytes > ART_LIMITS.totalBytes) {
      throw new ArtError('The course meshes exceed their download budget.');
    }
    const { pixels } = validateCourseModel(await blob.arrayBuffer());
    if ([...this.assets.values()].reduce((sum, asset) => sum + asset.pixels, pixels) > ART_LIMITS.texturePixels) {
      throw new ArtError('The course meshes exceed 32 million decoded texture pixels. Reuse meshes or reduce texture sizes.');
    }
    const model = await loadVisualModel(blob);
    try {
      signal.throwIfAborted();
      if (this.disposed) throw new ArtError('The course mesh renderer was closed.');
      let meshes = 0;
      model.scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        if (node instanceof SkinnedMesh || node instanceof InstancedMesh || Object.keys(node.geometry.morphAttributes).length > 0) {
          throw new ArtError('Course meshes must be ordinary static meshes, not skins, morphs, or nested instances.');
        }
        meshes++;
      });
      if (meshes > ART_LIMITS.meshes || model.triangles > ART_LIMITS.triangles) {
        throw new ArtError('A course mesh has more than 16 meshes or 50,000 triangles. Optimize it before using it on the course.');
      }
      const size = model.bounds.getSize(new Vector3());
      if (Math.min(size.x, size.y, size.z) < 0.000001) throw new ArtError('Course meshes need nonzero width, height, and depth.');
    } catch (error) {
      model.dispose();
      throw error;
    }
    // The terrain that wanted it may have gone while it loaded.
    if (!this.uses.has(id) && !this.pinned.has(id)) {
      model.dispose();
      return;
    }
    this.assets.set(id, { model, pixels, bytes: blob.size, templates: new Map(), decoration: null });
    if (this.mode === 'meshes') for (const state of this.states.values()) if (meshAsset(state.object) === id) this.sync(state);
  }

  /**
   * A loaded asset as a decoration model: its meshes at their own size, standing on the centre of
   * their base, with their own materials. Null until the asset is loaded.
   */
  decorationMesh(id: string): DecorationMesh | null {
    const asset = this.assets.get(id);
    if (asset === undefined) return null;
    if (asset.decoration === null) {
      const { bounds } = asset.model;
      const size = bounds.getSize(new Vector3());
      const base = new Matrix4().makeTranslation(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
      const parts: Primitive[] = [];
      asset.model.scene.traverse((node) => {
        if (node instanceof Mesh) parts.push({ geometry: bake(node, base), material: node.material });
      });
      asset.decoration = Object.freeze({ parts: Object.freeze(parts), flatShaded: false, width: size.x, height: size.y, depth: size.z });
    }
    return asset.decoration;
  }

  setMode(mode: ArtMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const state of this.states.values()) this.sync(state);
  }

  update(frame: SceneFrame): void {
    if (this.disposed) return;
    for (const id of this.unused) {
      const asset = this.assets.get(id);
      if (asset === undefined || this.uses.has(id)) continue;
      disposeAsset(asset);
      this.assets.delete(id);
    }
    this.unused.clear();
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
      mode: this.mode, assets: this.assets.size, loading: this.loading.size, failed: [...this.failed],
      instances: this.entries.size, batches: this.batches.size,
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
    for (const asset of this.assets.values()) disposeAsset(asset);
    this.assets.clear(); this.states.clear(); this.uses.clear(); this.pinned.clear(); this.unused.clear();
    this.root.removeFromParent();
    this.disposed = true;
  }

  private apply(event: TerrainEvent): void {
    if (event.type === 'reset') {
      // A new course tries again the GLBs that could not load.
      this.failed.clear();
      for (const entry of [...this.entries.values()]) this.remove(entry);
      for (const id of this.states.keys()) this.terrain.setHidden(id, false);
      const previous = [...this.states.values()].map((state) => meshAsset(state.object));
      this.states.clear();
      for (const object of event.objects) this.apply({ type: 'upsert', object });
      // Counted after the new objects, so a GLB the course keeps using stays loaded.
      for (const asset of previous) this.release(asset);
    } else if (event.type === 'upsert') {
      const previous = this.states.get(event.object.id);
      const state: State = { object: event.object, fade: null, active: true };
      this.states.set(event.object.id, state);
      this.use(meshAsset(event.object));
      this.sync(state);
      if (previous) this.release(meshAsset(previous.object));
    } else if (event.type === 'remove' || event.type === 'disappear') {
      const entry = this.entries.get(event.id);
      if (entry) this.remove(entry);
      const state = this.states.get(event.id);
      if (state) state.active = false;
      if (event.type === 'remove' && state) {
        this.states.delete(event.id);
        this.terrain.setHidden(event.id, false);
        this.release(meshAsset(state.object));
      }
    } else if (event.type === 'fade') {
      const state = this.states.get(event.id);
      if (state?.object.illusion) { state.fade = event.startedAt; this.sync(state); }
    }
  }

  private use(asset: string | null): void {
    if (asset !== null) this.uses.set(asset, (this.uses.get(asset) ?? 0) + 1);
  }

  // Lets go of a GLB once no terrain draws it, unless it was loaded up front.
  private release(asset: string | null): void {
    if (asset === null) return;
    const uses = (this.uses.get(asset) ?? 0) - 1;
    if (uses > 0) {
      this.uses.set(asset, uses);
      return;
    }
    this.uses.delete(asset);
    if (this.assets.has(asset) && !this.pinned.has(asset)) this.unused.add(asset);
  }

  private sync(state: State): void {
    const { object, active, fade } = state;
    const asset = meshAsset(object);
    const available = asset !== null && this.assets.has(asset);
    const visible = this.mode === 'meshes' && active && available;
    this.terrain.setHidden(object.id, this.mode === 'meshes' && available);
    let entry = this.entries.get(object.id);
    if (!visible || asset === null) {
      if (entry) this.remove(entry);
      if (this.mode === 'meshes' && asset !== null && !available && !this.failed.has(asset) && !this.loading.has(asset)) {
        this.request(asset, this.lifecycle.signal).catch((error: unknown) => {
          if (this.disposed) return;
          this.failed.add(asset);
          this.failure(asset, error);
        });
      }
      return;
    }
    const key = `${Math.floor(object.x / 32)},${Math.floor(object.y / 32)}:${asset}:${object.mirror}:${fade ?? 'solid'}`;
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
      const primitives = this.template(asset, object.mirror);
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

  private template(id: string, mirror: boolean): Primitive[] {
    const asset = this.assets.get(id);
    if (!asset) throw new ArtError('The mesh was not loaded.');
    const cached = asset.templates.get(mirror);
    if (cached) return cached;
    const size = asset.model.bounds.getSize(new Vector3());
    const center = asset.model.bounds.getCenter(new Vector3());
    // A unit box centred on the origin, like the extruded shapes, so the mesh's middle, where its collision is sliced,
    // lies on the obstacle line.
    const normalize = new Matrix4().makeScale(1 / size.x, 1 / size.y, 1 / size.z)
      .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    const reflect = mirror ? new Matrix4().makeScale(-1, 1, 1) : new Matrix4();
    const primitives: Primitive[] = [];
    const transform = new Matrix4().multiplyMatrices(reflect, normalize);
    asset.model.scene.traverse((node) => {
      if (node instanceof Mesh) primitives.push({ geometry: bake(node, transform), material: node.material });
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
    this.matrix.set(c * o.width, -s * o.height, 0, o.x, s * o.width, c * o.height, 0, o.y, 0, 0, o.depth, OBSTACLE_LINE, 0, 0, 0, 1);
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
