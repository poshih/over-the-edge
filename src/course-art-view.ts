import {
  Box3, BufferAttribute, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, SkinnedMesh, Sphere, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { ART_LIMITS, ArtError } from './art-types';
import { ILLUSION, LEVEL_LIMITS, turnedTerrainBox } from './level';
import type { TerrainEvent, TerrainObject } from './level';
import { markInstanceSlot } from './instancing';
import { OBSTACLE_LINE } from './obstacle-line';
import type { SceneFrame } from './scene-frame';
import type { SceneLayer } from './scene-layer';
import type { TerrainView } from './terrain-view';
import { geometryBytes, loadVisualModel } from './visual-model';
import type { LoadedVisual } from './visual-model';
import { validateCourseModel } from './course-art-model';
import type { DecorationMesh } from './decoration-view';

interface Primitive { geometry: BufferGeometry; material: Material | Material[] }
// A mesh turned about its vertical axis and fitted to the bounds of every turned vertex, as its collision is baked
// (src/mesh-collision.ts).
interface Turned {
  // Its own size as turned.
  readonly size: Vector3;
  // What takes the unit box, as the templates fit the mesh to it, to the unit box of the turned mesh, plain and for
  // mirrored templates, which are reflected, so their fit is reflected on both sides; null for no turn.
  readonly plain: Matrix4 | null;
  readonly mirrored: Matrix4 | null;
}
interface Asset {
  model: LoadedVisual;
  // Its geometry fitted to the unit box, plain and mirrored.
  templates: Map<boolean, Primitive[]>;
  // The mesh by turn, each worked out once.
  turns: Map<number, Turned>;
  // The asset as a decoration model, built when a decoration first draws it.
  decoration: DecorationMesh | null;
  readonly decorationMirrors: Set<BufferGeometry>;
  pixels: number;
  bytes: number;
  loadMs: number;
}
interface AssetFootprint {
  readonly compressedBytes: number;
  readonly textureBytes: number;
  readonly modelGeometryBytes: number;
  readonly derivedGeometryBytes: number;
  readonly loadMs: number;
}
interface Entry { object: TerrainObject; batch: Batch; slot: number }
interface Batch {
  key: string;
  readonly cell: string;
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

// three.js turns an instance's normals as though its matrix never shears, but a turned mesh stretched along the course's
// axes does, so course meshes turn their normals by the inverse transpose of the instance's matrix instead.
const EXACT_INSTANCE_NORMALS = `#include <defaultnormal_vertex>
#ifdef USE_INSTANCING
  transformedNormal = normalMatrix * ( transpose( inverse( mat3( instanceMatrix ) ) ) * objectNormal );
  #ifdef FLIP_SIDED
    transformedNormal = - transformedNormal;
  #endif
#endif`;
const exactlyNormal = new WeakSet<Material>();

function exactNormals(material: Material): Material {
  if (exactlyNormal.has(material)) return material;
  exactlyNormal.add(material);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>', EXACT_INSTANCE_NORMALS);
  };
  // A decoration drawing the same GLB may have compiled it already.
  material.needsUpdate = true;
  return material;
}

function disposeAsset(asset: Asset): void {
  for (const primitives of asset.templates.values()) for (const primitive of primitives) primitive.geometry.dispose();
  for (const part of asset.decoration?.parts ?? []) part.geometry.dispose();
  asset.model.dispose();
}

/**
 * Draws the course's meshes: each terrain object whose mesh is a GLB draws that GLB, turned, fitted to its box and
 * mirrored as placed, in place of its collision's extrusion, and decorations may draw GLBs in place of their built-in
 * models. It draws only the GLBs the course artwork lists (`setAssets`), loading each one the terrain uses as it first
 * appears and letting go of one nothing uses any more; terrain keeps drawing as its collision until its GLB loads, or
 * if it cannot.
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
  // Terrain objects drawn at turns the level does not hold yet, by ID, while the Workshop bakes their collision.
  private turnPreviews: ReadonlyMap<string, number> = new Map();
  private readonly unsubscribe: () => void;
  private readonly lifecycle = new AbortController();
  // The GLBs the course artwork lists, the only ones drawn.
  private listed: ReadonlySet<string> = new Set();
  private disposed = false;
  private matrixWrites = 0;
  private boundsUpdates = 0;
  private materialUpdates = 0;

  constructor(options: {
    terrain: TerrainView;
    subscribe: (listener: (event: TerrainEvent) => void) => () => void;
    // A GLB's bytes, by asset ID: a release's packaged content, or the Workshop's project file.
    fetch: (assetId: string, signal: AbortSignal) => Promise<Blob>;
    // A GLB that could not load; its terrain keeps drawing as its collision.
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
    const startedAt = performance.now();
    const model = await loadVisualModel(blob);
    // Wall time of loadVisualModel: Blob read and GLB parse, excluding fetch.
    const loadMs = performance.now() - startedAt;
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
    this.assets.set(id, {
      model, pixels, bytes: blob.size, loadMs, templates: new Map(), turns: new Map(), decoration: null, decorationMirrors: new Set(),
    });
    for (const state of this.states.values()) if (meshAsset(state.object) === id) this.sync(state);
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
      asset.decoration = Object.freeze({
        parts: Object.freeze(parts), flatShaded: false, width: size.x, height: size.y, depth: size.z,
        onMirror: (geometry: BufferGeometry): void => { asset.decorationMirrors.add(geometry); },
      });
    }
    return asset.decoration;
  }

  /**
   * Draws each GLB terrain object `turns` lists turned about its vertical axis as it lists, instead of as the level turns
   * it, each axis keeping its scale, until the next call; the rest as the level turns them. The Workshop shows turns this
   * way while it bakes their collision.
   */
  previewTurns(turns: ReadonlyMap<string, number>): void {
    const previous = this.turnPreviews;
    this.turnPreviews = new Map(turns);
    for (const id of new Set([...previous.keys(), ...turns.keys()])) {
      const entry = previous.get(id) === turns.get(id) ? undefined : this.entries.get(id);
      if (entry) this.write(entry);
    }
  }

  // Draws the GLBs `ids` lists, and only those: terrain placing another draws as its collision.
  setAssets(ids: Iterable<string>): void {
    const previous = this.listed;
    const listed = new Set(ids);
    if (listed.size === previous.size && [...listed].every((id) => previous.has(id))) return;
    this.listed = listed;
    for (const state of this.states.values()) {
      const asset = meshAsset(state.object);
      if (asset !== null && previous.has(asset) !== listed.has(asset)) this.sync(state);
    }
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
    const cells = new Set<string>();
    const buffers = new Set<ArrayBufferLike>();
    let meshes = 0;
    let instanceCapacity = 0;
    let usedInstanceSlots = 0;
    let instanceBufferBytes = 0;
    for (const batch of this.batches.values()) {
      cells.add(batch.cell);
      meshes += batch.meshes.length;
      for (const mesh of batch.meshes) {
        instanceCapacity += mesh.instanceMatrix.count;
        usedInstanceSlots += mesh.count;
        buffers.add(mesh.instanceMatrix.array.buffer);
        if (mesh.instanceColor !== null) buffers.add(mesh.instanceColor.array.buffer);
      }
    }
    for (const buffer of buffers) instanceBufferBytes += buffer.byteLength;
    const assets: Record<string, AssetFootprint> = Object.fromEntries([...this.assets].map(([id, asset]): [string, AssetFootprint] => {
      const footprint = asset.model.footprint();
      const derived = new Set<BufferGeometry>(asset.decorationMirrors);
      for (const primitives of asset.templates.values()) for (const primitive of primitives) derived.add(primitive.geometry);
      for (const part of asset.decoration?.parts ?? []) derived.add(part.geometry);
      return [id, {
        compressedBytes: asset.bytes, textureBytes: footprint.textureBytes, modelGeometryBytes: footprint.geometryBytes,
        derivedGeometryBytes: geometryBytes(derived), loadMs: asset.loadMs,
      }];
    }));
    return {
      listed: this.listed.size, assets, loading: this.loading.size, failed: [...this.failed],
      instances: this.entries.size, chunks: cells.size, batches: this.batches.size, meshes,
      instanceCapacity, usedInstanceSlots, instanceBufferBytes,
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
    const available = asset !== null && this.listed.has(asset) && this.assets.has(asset);
    const visible = active && available;
    this.terrain.setHidden(object.id, available);
    let entry = this.entries.get(object.id);
    if (!visible || asset === null) {
      if (entry) this.remove(entry);
      if (asset !== null && this.listed.has(asset) && !available && !this.failed.has(asset) && !this.loading.has(asset)) {
        this.request(asset, this.lifecycle.signal).catch((error: unknown) => {
          if (this.disposed) return;
          this.failed.add(asset);
          this.failure(asset, error);
        });
      }
      return;
    }
    const cell = `${Math.floor(object.x / 32)},${Math.floor(object.y / 32)}`;
    const key = `${cell}:${asset}:${object.mirror}:${fade ?? 'solid'}`;
    if (entry?.batch.key === key) {
      const previous = entry.object;
      entry.object = object;
      if (previous.x !== object.x || previous.y !== object.y || previous.angle !== object.angle || previous.mesh !== object.mesh ||
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
        if (fade === null) return exactNormals(source);
        let clone = clones.get(source);
        if (!clone) {
          clone = exactNormals(source.clone()); clone.transparent = true; clone.depthWrite = false;
          clones.set(source, clone); materials.set(clone, source.opacity);
        }
        return clone;
      };
      const meshes = primitives.map((primitive) => this.mesh(primitive.geometry,
        Array.isArray(primitive.material) ? primitive.material.map(material) : material(primitive.material), 8));
      batch = { key, cell, entries: [], meshes, fade, materials };
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

  // The mesh turned `turn` about its vertical axis, worked out once per mesh and turn.
  private turned(asset: Asset, turn: number): Turned {
    let turned = asset.turns.get(turn);
    if (turned !== undefined) return turned;
    const unturnedSize = asset.model.bounds.getSize(new Vector3());
    if (turn === 0) {
      turned = { size: unturnedSize, plain: null, mirrored: null };
    } else {
      const rotation = new Matrix4().makeRotationY(turn);
      const bounds = new Box3();
      const point = new Vector3();
      const transform = new Matrix4();
      asset.model.scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        const positions = node.geometry.getAttribute('position');
        transform.multiplyMatrices(rotation, node.matrixWorld);
        for (let index = 0; index < positions.count; index++) bounds.expandByPoint(point.fromBufferAttribute(positions, index).applyMatrix4(transform));
      });
      const size = bounds.getSize(new Vector3());
      const center = bounds.getCenter(new Vector3());
      const unturnedCenter = asset.model.bounds.getCenter(new Vector3());
      const plain = new Matrix4().makeScale(1 / size.x, 1 / size.y, 1 / size.z)
        .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z))
        .multiply(rotation)
        .multiply(new Matrix4().makeTranslation(unturnedCenter.x, unturnedCenter.y, unturnedCenter.z))
        .multiply(new Matrix4().makeScale(unturnedSize.x, unturnedSize.y, unturnedSize.z));
      const reflect = new Matrix4().makeScale(-1, 1, 1);
      turned = { size, plain, mirrored: reflect.clone().multiply(plain).multiply(reflect) };
    }
    asset.turns.set(turn, turned);
    return turned;
  }

  private write(entry: Entry): void {
    const o = entry.object;
    const asset = o.mesh.type === 'asset' ? this.assets.get(o.mesh.assetId) : undefined;
    let turn = o.mesh.type === 'asset' ? o.mesh.turn : 0;
    let { width, height, depth } = o;
    const shown = this.turnPreviews.get(o.id);
    if (asset !== undefined && shown !== undefined && shown !== turn) {
      // The box the turn will have once its collision is baked.
      const size = (vector: Vector3) => ({ width: vector.x, height: vector.y, depth: vector.z });
      ({ width, height, depth } = turnedTerrainBox(o, size(this.turned(asset, turn).size), size(this.turned(asset, shown).size)));
      turn = shown;
    }
    const c = Math.cos(o.angle), s = Math.sin(o.angle);
    this.matrix.set(c * width, -s * height, 0, o.x, s * width, c * height, 0, o.y, 0, 0, depth, OBSTACLE_LINE, 0, 0, 0, 1);
    const turned = asset === undefined ? null : this.turned(asset, turn);
    const fit = turned === null ? null : o.mirror ? turned.mirrored : turned.plain;
    if (fit !== null) this.matrix.multiply(fit);
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
