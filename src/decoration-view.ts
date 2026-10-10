import { Box3, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, Sphere } from 'three';
import type { BufferGeometry, Material } from 'three';
import { DECORATION_LIMITS } from './level';
import type { DecorationObject, LevelChange, LevelObject } from './level';
import { markInstanceSlot } from './instancing';
import { OBSTACLE_LINE } from './obstacle-line';
import { decorationAsset, NO_DECORATION_ART } from './decoration-art';
import type { DecorationArt } from './decoration-art';
import { mirroredGeometry } from './decoration-geometry';

const CHUNK_SIZE = 32;
// Chunks double in size with each band of depth, so a far chunk covers about as much of the view
// as a near one: distant scenery, visible from almost anywhere, shares few batches and draw calls.
const BAND_DEPTH = 16;
const INITIAL_CAPACITY = 4;
const PREVIEW_OPACITY = 0.55;

/**
 * A model ready to draw: its parts in model space, standing on the centre of its base. A flat-shaded
 * model lights each pixel from its on-screen slope, so it can be mirrored by a negative scale and
 * share batches with unmirrored copies; any other model draws mirrored copies from mirrored geometry.
 */
export interface DecorationMesh {
  readonly parts: readonly { readonly geometry: BufferGeometry; readonly material: Material | Material[] }[];
  readonly flatShaded: boolean;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  // Accounts for lazy mirrors in the source model's footprint.
  readonly onMirror?: (geometry: BufferGeometry) => void;
}

/** Where decoration models come from; null while a model is unknown or still loading. */
export type DecorationSource = (id: string) => DecorationMesh | null;

/**
 * The GLBs course artwork draws decoration models with, by asset ID. A decoration holds the GLB it draws, or waits for,
 * so each loads once, as the first needs it, and is let go of once none does.
 */
export interface DecorationArtwork {
  // The asset as a model, or null while it loads or if it could not.
  decorationMesh(assetId: string): DecorationMesh | null;
  // Whether the asset could not load; its decorations draw their built-in model, if there is one.
  hasFailed(assetId: string): boolean;
  // Holds the asset while a decoration draws it, loading it if it has not loaded yet; release() lets go of it.
  acquire(assetId: string): void;
  release(assetId: string): void;
  // Tells `listener` the ID of each asset that arrives or cannot load; returns its removal.
  subscribe(listener: (assetId: string) => void): () => void;
}

// What draws a decoration: its built-in model, or the course artwork asset drawing its model instead.
interface Look {
  readonly key: string;
  readonly mesh: DecorationMesh | null;
  // The asset, or null for the built-in model.
  readonly asset: string | null;
}

interface Batch {
  readonly key: string;
  readonly cell: string;
  readonly artwork: boolean;
  // `root` or `front`, by the batch's side of the obstacle line.
  readonly group: Group;
  readonly meshes: InstancedMesh[];
  readonly entries: Instance[];
}

interface Instance {
  object: DecorationObject;
  readonly batch: Batch;
  slot: number;
}

// Whether a decoration stands on or in front of the obstacle line, where it draws after the characters.
function inFront(object: DecorationObject): boolean {
  return object.z >= OBSTACLE_LINE;
}

function cellKey(object: DecorationObject): string {
  const band = Math.floor(Math.log2(1 + Math.max(0, -object.z) / BAND_DEPTH));
  const size = CHUNK_SIZE * 2 ** band;
  return `${inFront(object) ? 'front' : 'back'}:${band}:${Math.floor(object.x / size)},${Math.floor(object.y / size)}`;
}

function batchKey(object: DecorationObject, look: Look, model: DecorationMesh): string {
  const side = mirroredGeometryFor(object, model) ? 'mirrored' : 'plain';
  return `${cellKey(object)}:${look.key}:${side}`;
}

// Whether a mirrored decoration draws mirrored geometry rather than a negative scale.
function mirroredGeometryFor(object: DecorationObject, model: DecorationMesh): boolean {
  return object.mirror && !model.flatShaded;
}

/**
 * The transform that stands a model on a decoration's base: turned about its vertical axis, mirrored left to right,
 * scaled to its height, tilted in the view plane and moved. Mirrored geometry is already reflected, and reflecting
 * reverses a turn, so it turns the other way.
 */
export function decorationMatrix(object: DecorationObject, model: DecorationMesh, target: Matrix4): Matrix4 {
  const scale = object.height / model.height;
  const cosine = Math.cos(object.angle) * scale;
  const sine = Math.sin(object.angle) * scale;
  const flip = object.mirror && model.flatShaded ? -1 : 1;
  const turn = mirroredGeometryFor(object, model) ? -object.turn : object.turn;
  const turnCosine = Math.cos(turn);
  const turnSine = Math.sin(turn);
  return target.set(
    cosine * flip * turnCosine, -sine, cosine * flip * turnSine, object.x,
    sine * flip * turnCosine, cosine, sine * flip * turnSine, object.y,
    -scale * turnSine, 0, scale * turnCosine, object.z,
    0, 0, 0, 1,
  );
}

/**
 * Draws decorations: scenery only, never colliders. Instances are batched by 32 m chunk, model and
 * mirror side, so frustum culling skips distant chunks, and an edit rewrites only its own instances.
 * Idle frames do no work. A preview mesh shows a placement without changing the level. Course
 * artwork can draw any model as the game's own GLB, in the Workshop as in releases. Decorations
 * behind the obstacle line draw in `root`, with the course; those on or in front of it in `front`,
 * over the characters but under a 3D character's arms and the tool.
 */
export class DecorationView {
  readonly root = new Group();
  readonly front = new Group();
  private readonly source: DecorationSource;
  private artwork: { readonly art: DecorationArt; readonly source: DecorationArtwork; readonly unsubscribe: () => void } | null = null;
  private readonly instances = new Map<string, Instance>();
  // Decorations whose model is unknown or whose GLB has not arrived; each appears once it does.
  private readonly waiting = new Map<string, DecorationObject>();
  // The GLB each decoration, drawn or waiting, holds, by decoration ID; and the one the preview holds.
  private readonly held = new Map<string, string>();
  private previewAsset: string | null = null;
  private previewObject: DecorationObject | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly batches = new Map<string, Batch>();
  private readonly dirtyBounds = new Set<InstancedMesh>();
  private readonly mirrored = new WeakMap<BufferGeometry, BufferGeometry>();
  private readonly translucent = new WeakMap<Material, Material>();
  private readonly preview = new Group();
  // The model and side the preview meshes show; a preview that only moves keeps them.
  private previewKey: string | null = null;
  private readonly matrix = new Matrix4();
  private readonly color = new Color();
  private disposed = false;
  private readonly counters = {
    matrixWrites: 0, colorWrites: 0, boundsUpdates: 0, batchesCreated: 0, batchesDisposed: 0, capacityGrowths: 0, previewUpdates: 0,
  };

  constructor(source: DecorationSource) {
    this.source = source;
    this.root.name = 'decorations';
    this.root.matrixAutoUpdate = false;
    this.front.name = 'decorations-front';
    this.front.matrixAutoUpdate = false;
    this.preview.matrixAutoUpdate = false;
    this.root.add(this.preview);
  }

  setObjects(objects: readonly LevelObject[]): void {
    this.clear();
    for (const object of objects) if (object.kind === 'decoration') this.upsert(object);
  }

  apply(change: LevelChange): void {
    if (change.kind === 'replace') {
      this.setObjects(change.level.objects);
      return;
    }
    for (const id of change.remove) this.forget(id);
    for (const object of change.upsert) {
      if (object.kind === 'decoration') this.upsert(object);
      else this.forget(object.id);
    }
  }

  /**
   * Draws the models `art` maps as those GLBs from now on, which `source` holds, and the rest as their built-in models.
   * Only the decorations of models whose GLB changed redraw, each as its GLB arrives.
   */
  useArtwork(art: DecorationArt, source: DecorationArtwork): void {
    const previous = this.artwork;
    if (previous !== null && previous.source !== source) throw new Error('Decorations draw course artwork from one source.');
    if (previous?.art === art) return;
    this.artwork = { art, source, unsubscribe: previous?.unsubscribe ?? source.subscribe((asset) => this.arrived(asset)) };
    const before = previous?.art ?? NO_DECORATION_ART;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(art)])]
      .filter((model) => decorationAsset(before, model) !== decorationAsset(art, model));
    for (const model of changed) this.refresh(model);
    if (changed.length > 0) this.changed();
  }

  /** Tells `listener` whenever a model's drawn size may have changed: its GLB arrived or failed, or the artwork changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A model's natural size, or null while it is unknown or loading. */
  size(model: string): { readonly width: number; readonly height: number; readonly depth: number } | null {
    return this.look(model).mesh;
  }

  /** Shows `object` as a translucent placement preview, or nothing; it shows once its GLB arrives. */
  setPreview(object: DecorationObject | null): void {
    this.counters.previewUpdates++;
    this.previewObject = object;
    const look = object === null ? null : this.look(object.model);
    this.holdPreview(look?.asset ?? null);
    const model = look?.mesh ?? null;
    if (object === null || look === null || model === null) {
      this.preview.clear();
      this.previewKey = null;
      return;
    }
    const mirrored = mirroredGeometryFor(object, model);
    const key = `${look.key}:${mirrored}`;
    if (key !== this.previewKey) {
      this.preview.clear();
      for (const part of model.parts) {
        const mesh = new Mesh(mirrored ? this.mirror(part.geometry, model) : part.geometry, this.translucentMaterial(part.material));
        mesh.renderOrder = 10;
        this.preview.add(mesh);
      }
      this.previewKey = key;
    }
    decorationMatrix(object, model, this.preview.matrix);
    this.preview.matrixWorldNeedsUpdate = true;
    const group = inFront(object) ? this.front : this.root;
    if (this.preview.parent !== group) group.add(this.preview);
  }

  /** Recomputes the culling bounds of batches that changed since the last frame. */
  update(): void {
    if (this.dirtyBounds.size === 0) return;
    for (const mesh of this.dirtyBounds) {
      mesh.computeBoundingBox();
      mesh.boundingBox!.getBoundingSphere(mesh.boundingSphere!);
      this.counters.boundsUpdates++;
    }
    this.dirtyBounds.clear();
  }

  inspect() {
    const cells = new Set<string>();
    const buffers = new Set<ArrayBufferLike>();
    let capacity = 0;
    let instanceCapacity = 0;
    let usedInstanceSlots = 0;
    let instanceBufferBytes = 0;
    let meshes = 0;
    let artwork = 0;
    for (const batch of this.batches.values()) {
      cells.add(batch.cell);
      meshes += batch.meshes.length;
      capacity += batch.meshes[0]?.instanceMatrix.count ?? 0;
      for (const mesh of batch.meshes) {
        instanceCapacity += mesh.instanceMatrix.count;
        usedInstanceSlots += mesh.count;
        buffers.add(mesh.instanceMatrix.array.buffer);
        if (mesh.instanceColor !== null) buffers.add(mesh.instanceColor.array.buffer);
      }
      if (batch.artwork) artwork += batch.entries.length;
    }
    for (const buffer of buffers) instanceBufferBytes += buffer.byteLength;
    return {
      instances: this.instances.size, artwork, waiting: [...new Set([...this.waiting.values()].map((object) => object.model))],
      chunks: cells.size, batches: this.batches.size, meshes,
      capacity, instanceCapacity, usedInstanceSlots, instanceBufferBytes,
      preview: this.preview.children.length > 0, previewMeshes: this.preview.children.length, ...this.counters,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.holdPreview(null);
    this.previewObject = null;
    this.artwork?.unsubscribe();
    this.artwork = null;
    this.listeners.clear();
    this.preview.clear();
    this.previewKey = null;
    this.root.removeFromParent();
    this.front.removeFromParent();
    this.disposed = true;
  }

  private upsert(object: DecorationObject): void {
    if (this.disposed) throw new Error('Cannot update disposed decorations.');
    const look = this.look(object.model);
    const model = look.mesh;
    const instance = this.instances.get(object.id);
    if (model !== null && instance !== undefined && instance.batch.key === batchKey(object, look, model)) {
      const previous = instance.object;
      instance.object = object;
      if (previous.x !== object.x || previous.y !== object.y || previous.z !== object.z ||
        previous.height !== object.height || previous.angle !== object.angle || previous.turn !== object.turn ||
        previous.mirror !== object.mirror) this.writeMatrix(instance);
      if (previous.tint !== object.tint) this.writeColor(instance);
      return;
    }
    this.forget(object.id);
    if (look.asset !== null) {
      this.held.set(object.id, look.asset);
      this.artwork!.source.acquire(look.asset);
    }
    if (model === null) {
      this.waiting.set(object.id, object);
      return;
    }
    if (this.instances.size >= DECORATION_LIMITS.objects) throw new Error('Decoration instance limit exceeded.');
    const batch = this.batch(object, look, model);
    const inserted: Instance = { object, batch, slot: batch.entries.length };
    if (inserted.slot === batch.meshes[0]!.instanceMatrix.count) this.grow(batch);
    batch.entries.push(inserted);
    for (const mesh of batch.meshes) mesh.count = batch.entries.length;
    this.instances.set(object.id, inserted);
    this.writeMatrix(inserted);
    this.writeColor(inserted);
  }

  private forget(id: string): void {
    this.waiting.delete(id);
    const asset = this.held.get(id);
    if (asset !== undefined) {
      this.held.delete(id);
      this.artwork!.source.release(asset);
    }
    const instance = this.instances.get(id);
    if (instance === undefined) return;
    const batch = instance.batch;
    const last = batch.entries.pop()!;
    this.instances.delete(id);
    if (last !== instance) {
      last.slot = instance.slot;
      batch.entries[instance.slot] = last;
      for (const mesh of batch.meshes) {
        const matrix = mesh.instanceMatrix;
        const color = mesh.instanceColor!;
        matrix.array.copyWithin(instance.slot * 16, batch.entries.length * 16, (batch.entries.length + 1) * 16);
        color.array.copyWithin(instance.slot * 3, batch.entries.length * 3, (batch.entries.length + 1) * 3);
        markInstanceSlot(matrix, instance.slot);
        markInstanceSlot(color, instance.slot);
      }
      this.counters.matrixWrites++;
      this.counters.colorWrites++;
    }
    for (const mesh of batch.meshes) {
      mesh.count = batch.entries.length;
      this.dirtyBounds.add(mesh);
    }
    if (batch.entries.length === 0) this.destroy(batch);
  }

  private batch(object: DecorationObject, look: Look, model: DecorationMesh): Batch {
    const key = batchKey(object, look, model);
    const existing = this.batches.get(key);
    if (existing !== undefined) return existing;
    const mirrored = mirroredGeometryFor(object, model);
    const batch: Batch = {
      key, cell: cellKey(object), artwork: look.asset !== null, group: inFront(object) ? this.front : this.root, entries: [],
      meshes: model.parts.map((part) => this.mesh(mirrored ? this.mirror(part.geometry, model) : part.geometry, part.material, INITIAL_CAPACITY)),
    };
    for (const mesh of batch.meshes) batch.group.add(mesh);
    this.batches.set(key, batch);
    this.counters.batchesCreated++;
    return batch;
  }

  private mesh(geometry: BufferGeometry, material: Material | Material[], capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
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

  private grow(batch: Batch): void {
    for (const [index, previous] of batch.meshes.entries()) {
      const mesh = this.mesh(previous.geometry, previous.material,
        Math.min(previous.instanceMatrix.count * 2, DECORATION_LIMITS.objects));
      mesh.instanceMatrix.array.set(previous.instanceMatrix.array);
      mesh.instanceColor!.array.set(previous.instanceColor!.array);
      mesh.count = previous.count;
      batch.group.remove(previous);
      this.dirtyBounds.delete(previous);
      previous.dispose();
      batch.meshes[index] = mesh;
      batch.group.add(mesh);
    }
    this.counters.capacityGrowths++;
  }

  private writeMatrix(instance: Instance): void {
    const model = this.look(instance.object.model).mesh;
    if (model === null) throw new Error(`Decoration model ${instance.object.model} disappeared while drawn.`);
    decorationMatrix(instance.object, model, this.matrix);
    for (const mesh of instance.batch.meshes) {
      mesh.setMatrixAt(instance.slot, this.matrix);
      markInstanceSlot(mesh.instanceMatrix, instance.slot);
      this.dirtyBounds.add(mesh);
    }
    this.counters.matrixWrites++;
  }

  private writeColor(instance: Instance): void {
    this.color.setHex(instance.object.tint);
    for (const mesh of instance.batch.meshes) {
      mesh.setColorAt(instance.slot, this.color);
      markInstanceSlot(mesh.instanceColor!, instance.slot);
    }
    this.counters.colorWrites++;
  }

  private destroy(batch: Batch): void {
    for (const mesh of batch.meshes) {
      batch.group.remove(mesh);
      this.dirtyBounds.delete(mesh);
      mesh.dispose();
    }
    this.batches.delete(batch.key);
    this.counters.batchesDisposed++;
  }

  private clear(): void {
    for (const batch of [...this.batches.values()]) this.destroy(batch);
    this.instances.clear();
    this.waiting.clear();
    for (const asset of this.held.values()) this.artwork!.source.release(asset);
    this.held.clear();
  }

  private look(model: string): Look {
    const artwork = this.artwork;
    const asset = artwork === null ? undefined : decorationAsset(artwork.art, model);
    if (artwork === null || asset === undefined || artwork.source.hasFailed(asset)) {
      return { key: model, mesh: this.source(model), asset: null };
    }
    // Model IDs never contain a colon, so an artwork key cannot equal a model's.
    return { key: `art:${asset}`, mesh: artwork.source.decorationMesh(asset), asset };
  }

  // Redraws every decoration of a model whose GLB arrived, failed or changed, and the preview if it shows one.
  private refresh(model: string): void {
    this.previewKey = null;
    const affected = [...this.instances.values()].filter((instance) => instance.object.model === model).map((instance) => instance.object);
    for (const object of this.waiting.values()) if (object.model === model) affected.push(object);
    for (const object of affected) this.forget(object.id);
    for (const object of affected) this.upsert(object);
    if (this.previewObject?.model === model) this.setPreview(this.previewObject);
  }

  // A GLB arrived, or could not load: the models it draws redraw with it, or with their built-in models.
  private arrived(asset: string): void {
    const art = this.artwork?.art ?? NO_DECORATION_ART;
    let redrawn = false;
    for (const [model, mapped] of Object.entries(art)) {
      if (mapped !== asset) continue;
      this.refresh(model);
      redrawn = true;
    }
    if (redrawn) this.changed();
  }

  // Holds the GLB the preview shows, letting go of the one it showed.
  private holdPreview(asset: string | null): void {
    const previous = this.previewAsset;
    if (asset === previous) return;
    this.previewAsset = asset;
    if (asset !== null) this.artwork!.source.acquire(asset);
    if (previous !== null) this.artwork!.source.release(previous);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private mirror(geometry: BufferGeometry, model: DecorationMesh): BufferGeometry {
    let mirrored = this.mirrored.get(geometry);
    if (mirrored === undefined) {
      mirrored = mirroredGeometry(geometry);
      this.mirrored.set(geometry, mirrored);
      model.onMirror?.(mirrored);
    }
    return mirrored;
  }

  private translucentMaterial(material: Material | Material[]): Material | Material[] {
    if (Array.isArray(material)) return material.map((each) => this.translucentMaterial(each) as Material);
    let translucent = this.translucent.get(material);
    if (translucent === undefined) {
      translucent = material.clone();
      translucent.transparent = true;
      translucent.opacity = PREVIEW_OPACITY;
      translucent.depthWrite = false;
      this.translucent.set(material, translucent);
    }
    return translucent;
  }
}
