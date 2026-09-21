import * as THREE from 'three';
import {
  embeddedPng,
  inspectPng,
  SPRITE_LIMITS,
  SpriteError,
  validateSpriteAnchors,
  validateSpriteLayer,
  validateSpriteMetadata,
  validateSpriteRigging,
} from './sprite-data';
import type { SpriteDocument, SpriteLayer } from './sprite-data';
import { FACING_DIRECTIONS, SkeletonError, validateSkeleton, validateSkeletonPreview } from './skeleton-data';
import type { FacingDirection, SkeletonDefinition, SkeletonPreview } from './skeleton-data';
import { SkeletonPose, restPose, facingDirection } from './skeleton-pose';
import type { RigPoint as RuntimePoint, RigTarget as RuntimeTarget, BoneWorld as RuntimeBoneWorld } from './skeleton-pose';

export interface SpriteAnchor {
  readonly node: THREE.Object3D;
  readonly setCovered: (options: { covered: boolean }) => void;
}

interface ImageResource {
  readonly bitmap: ImageBitmap;
  readonly texture: THREE.Texture;
  readonly material: THREE.MeshBasicMaterial;
  readonly bytes: number;
  readonly pixels: number;
  disposed: boolean;
}

interface Attachment {
  readonly group: THREE.Group;
  count: number;
  legacyCount: number;
  covered: boolean;
  readonly coverageCounts: number[];
}

interface TileRuntime {
  readonly geometry: THREE.PlaneGeometry;
  readonly uv: THREE.BufferAttribute;
  readonly baseUvs: Float32Array;
  tileLength: number;
  lastRepeat: number;
}

interface BaseLayerInstance<TMesh extends THREE.Object3D> {
  data: SpriteLayer;
  resource: ImageResource;
  readonly mesh: TMesh;
  directionMask: number;
  visible: boolean;
  tile: TileRuntime | null;
}

interface LegacyLayerInstance extends BaseLayerInstance<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>> {
  readonly kind: 'legacy';
  readonly localMatrix: THREE.Matrix4;
}

interface BoneLayerInstance extends BaseLayerInstance<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>> {
  readonly kind: 'bone';
  readonly boneId: string;
  localMatrix: THREE.Matrix4;
}

interface SkinLayerInstance extends BaseLayerInstance<THREE.SkinnedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>> {
  readonly kind: 'skin';
  bindMatrix: THREE.Matrix4;
}

type LayerInstance = LegacyLayerInstance | BoneLayerInstance | SkinLayerInstance;
type TiledLayerInstance = LegacyLayerInstance | BoneLayerInstance;

interface Replacement {
  readonly controller: AbortController;
  readonly staged: Map<string, ImageResource>;
}

interface SkeletonRuntime {
  readonly definition: SkeletonDefinition;
  readonly pose: SkeletonPose;
  readonly group: THREE.Group;
  readonly bones: readonly THREE.Bone[];
  readonly boneIndex: ReadonlyMap<string, number>;
  readonly skeleton: THREE.Skeleton;
  evaluated: readonly RuntimeBoneWorld[];
  originWorld: RuntimePoint;
}

interface BuildState {
  readonly resources: Map<string, ImageResource>;
  readonly images: Map<string, ImageResource>;
  readonly layers: Map<string, LayerInstance>;
  readonly attachments: Map<string, Attachment>;
  readonly skeleton: SkeletonRuntime | null;
}

const ALPHA_CUTOFF = 0.5;
const AIM_EPSILON = 1e-6;
const TILE_EPSILON = 1e-6;
const EMPTY_POSE: SkeletonPreview['pose'] = Object.freeze([]);
const EMPTY_TARGETS = new Map<string, RuntimeTarget>();
const SKIN_SAMPLE_LIMIT = 4;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function cancellation(signal: AbortSignal): DOMException {
  if (signal.reason instanceof DOMException && signal.reason.name === 'AbortError') return signal.reason;
  return new DOMException('Sprite replacement was cancelled.', 'AbortError');
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof SpriteError ? signal.reason : cancellation(signal);
}

function decodeFailure(error: unknown): unknown {
  if (error instanceof DOMException &&
    ['InvalidStateError', 'EncodingError', 'NotSupportedError'].includes(error.name)) {
    return new SpriteError('The PNG could not be decoded.', { cause: error });
  }
  return error;
}

function decodePng(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal, onSettled: () => void): Promise<ImageBitmap> {
  checkSignal(signal);
  const blob = new Blob([bytes], { type: 'image/png' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (settled) return;
      finish();
      reject(cancellation(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    let decoding: Promise<ImageBitmap>;
    try {
      decoding = createImageBitmap(blob, {
        imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
      });
    } catch (error) {
      finish();
      onSettled();
      reject(decodeFailure(error));
      return;
    }
    decoding.then(bitmap => {
      onSettled();
      if (settled) {
        bitmap.close();
        return;
      }
      finish();
      resolve(bitmap);
    }, error => {
      onSettled();
      if (settled) return;
      finish();
      reject(decodeFailure(error));
    });
  });
}

async function downloadPng(source: string, signal: AbortSignal, maximumBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  checkSignal(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(cancellation(signal));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new SpriteError('The PNG download timed out.'));
  }, SPRITE_LIMITS.fetchMilliseconds);
  try {
    const response = await fetch(source, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new SpriteError(`The PNG download failed (HTTP ${response.status}).`);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
      throw new SpriteError('The PNG download exceeds its image or document byte budget.');
    }
    if (response.body === null) throw new SpriteError('The PNG download has no response body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        checkSignal(controller.signal);
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          throw new SpriteError('The PNG download exceeds its image or document byte budget.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    checkSignal(controller.signal);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    checkSignal(controller.signal);
    if (error instanceof TypeError || error instanceof DOMException && error.name === 'NetworkError') {
      throw new SpriteError('The PNG could not be downloaded. Check the URL and its CORS permissions.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

function directionIndex(direction: FacingDirection): number {
  const index = FACING_DIRECTIONS.indexOf(direction);
  if (index < 0) throw new Error(`Unknown facing direction: ${direction}`);
  return index;
}

function directionMask(directions: readonly FacingDirection[]): number {
  let mask = 0;
  for (const direction of directions) mask |= 1 << directionIndex(direction);
  return mask;
}

function attributeComponent(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, component: number): number {
  switch (component) {
    case 0: return attribute.getX(index);
    case 1: return attribute.getY(index);
    case 2: return attribute.getZ(index);
    case 3: return attribute.getW(index);
    default: throw new Error(`Unsupported attribute component ${component}.`);
  }
}

function point(value: RuntimePoint): RuntimePoint {
  return { x: value.x, y: value.y };
}

export class SpriteRig {
  private readonly anchors: ReadonlyMap<string, SpriteAnchor>;
  private readonly root: THREE.Object3D;
  private readonly targetIds: ReadonlySet<string>;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private images = new Map<string, ImageResource>();
  private resources = new Map<string, ImageResource>();
  private layers = new Map<string, LayerInstance>();
  private attachments = new Map<string, Attachment>();
  private skeleton: SkeletonRuntime | null = null;
  private preview: SkeletonPreview | null = null;
  private replacement: Replacement | null = null;
  private disposed = false;
  private pendingDecodes = 0;
  private texturesCreated = 0;
  private texturesDisposed = 0;
  private currentDirection: FacingDirection = 'right';
  private hasFrame = false;
  private lastFrame: { time: number; aim: RuntimePoint; targets: ReadonlyMap<string, RuntimeTarget> } = {
    time: 0,
    aim: { x: 1, y: 0 },
    targets: new Map<string, RuntimeTarget>(),
  };

  private readonly tempMatrixA = new THREE.Matrix4();
  private readonly tempMatrixB = new THREE.Matrix4();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempWorld = new THREE.Vector3();
  private readonly tempWorldB = new THREE.Vector3();
  private readonly tempWorldC = new THREE.Vector3();

  constructor(anchors: ReadonlyMap<string, SpriteAnchor>, options: { root: THREE.Object3D; targetIds: readonly string[] }) {
    this.anchors = new Map(anchors);
    this.root = options.root;
    this.targetIds = new Set(options.targetIds);
  }

  async replace(document: SpriteDocument, options: { signal: AbortSignal } = { signal: new AbortController().signal }): Promise<void> {
    this.assertMutable();
    if (options.signal.aborted) throw cancellation(options.signal);
    document = validateSpriteMetadata(document);
    validateSpriteAnchors(document, this.anchors.keys(), this.targetIds);
    const operation: Replacement = { controller: new AbortController(), staged: new Map() };
    const signal = operation.controller.signal;
    const abort = () => operation.controller.abort(cancellation(options.signal));
    options.signal.addEventListener('abort', abort, { once: true });
    this.replacement = operation;
    const resources = new Map<string, ImageResource>();
    const images = new Map<string, ImageResource>();
    let pixels = 0;
    let bytes = 0;
    try {
      for (const image of document.images) {
        checkSignal(signal);
        let resource = resources.get(image.source);
        if (resource === undefined) {
          resource = this.resources.get(image.source);
          if (resource === undefined) {
            const remainingBytes = Math.min(SPRITE_LIMITS.imageBytes, SPRITE_LIMITS.documentBytes - bytes);
            const embedded = embeddedPng(image.source);
            const png = embedded === null
              ? await downloadPng(image.source, signal, remainingBytes)
              : embedded;
            checkSignal(signal);
            if (png.byteLength > remainingBytes) throw new SpriteError('The sprite document exceeds its image byte budget.');
            const size = inspectPng(png);
            if (pixels + size.width * size.height > SPRITE_LIMITS.decodedPixels) {
              throw new SpriteError('The sprite document exceeds its decoded-pixel budget.');
            }
            const bitmap = await this.decode(png, signal);
            if (signal.aborted) {
              bitmap.close();
              checkSignal(signal);
            }
            if (bitmap.width !== size.width || bitmap.height !== size.height) {
              bitmap.close();
              throw new SpriteError('The decoded PNG dimensions do not match its header.');
            }
            resource = this.createResource(bitmap, png.byteLength);
            operation.staged.set(image.source, resource);
          }
          pixels += resource.pixels;
          bytes += resource.bytes;
          if (pixels > SPRITE_LIMITS.decodedPixels || bytes > SPRITE_LIMITS.documentBytes) {
            throw new SpriteError('The sprite document exceeds its image-memory or byte budget.');
          }
          resources.set(image.source, resource);
        }
        images.set(image.id, resource);
      }
      checkSignal(signal);
      const next = this.buildState(document.layers, document.skeleton, images, resources, { mode: 'replace', preview: null });
      operation.staged.clear();
      this.commit(next, { preview: null });
    } finally {
      options.signal.removeEventListener('abort', abort);
      for (const resource of operation.staged.values()) this.releaseResource(resource);
      operation.staged.clear();
      if (this.replacement === operation) this.replacement = null;
    }
  }

  configureSkeleton(
    definition: SkeletonDefinition | null,
    options: { preview: SkeletonPreview | null } = { preview: null },
  ): void {
    this.assertMutable();
    try {
      const skeleton = definition === null ? null : validateSkeleton(definition);
      const layers = this.layerData();
      validateSpriteRigging(layers, skeleton);
      validateSpriteAnchors({ schemaVersion: 2, images: [], layers, skeleton }, this.anchors.keys(), this.targetIds);
      const preview = options.preview === null ? null : (() => {
        if (skeleton === null) throw new SpriteError('Create a skeleton before previewing a pose.');
        return validateSkeletonPreview(options.preview, skeleton);
      })();
      const next = this.buildState(layers, skeleton, new Map(this.images), new Map(this.resources), { mode: 'edit', preview });
      this.commit(next, { preview });
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  setPreview(preview: SkeletonPreview | null): void {
    this.assertMutable();
    try {
      if (preview !== null) {
        if (this.skeleton === null) throw new SpriteError('Create a skeleton before previewing a pose.');
        preview = validateSkeletonPreview(preview, this.skeleton.definition);
      }
      if (this.skeleton !== null) {
        this.updateSkeletonRoot(this.skeleton);
        this.evaluateSkeleton(this.skeleton, this.queryDirection(null, preview), preview);
      }
      this.preview = preview;
      this.refreshScene({ forceVisibility: true });
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  update(frame: {
    time: number;
    aim: { x: number; y: number };
    targets: ReadonlyMap<string, { x: number; y: number; angle: number }>;
  }): void {
    this.assertLive();
    this.hasFrame = true;
    this.lastFrame = {
      time: frame.time,
      aim: { x: frame.aim.x, y: frame.aim.y },
      targets: new Map([...frame.targets].map(([name, target]) => [name, { ...target }])),
    };
    this.refreshScene();
  }

  upsert(layer: SpriteLayer): void {
    this.assertMutable();
    layer = validateSpriteLayer(layer);
    this.anchor(layer.anchor);
    const image = this.images.get(layer.image);
    if (image === undefined) throw new SpriteError(`Sprite ${layer.id} references unloaded image "${layer.image}".`);
    const nextLayers = this.layerData();
    const index = nextLayers.findIndex(candidate => candidate.id === layer.id);
    if (index < 0) {
      if (nextLayers.length >= SPRITE_LIMITS.layers) {
        throw new SpriteError(`A sprite rig supports at most ${SPRITE_LIMITS.layers} layers.`);
      }
      nextLayers.push(layer);
    } else {
      nextLayers[index] = layer;
    }
    validateSpriteRigging(nextLayers, this.skeleton?.definition ?? null);
    const next = this.buildState(nextLayers, this.skeleton?.definition ?? null, new Map(this.images), new Map(this.resources),
      { mode: 'edit', preview: this.preview });
    this.commit(next, { preview: this.preview });
  }

  remove(id: string): void {
    this.assertMutable();
    if (!this.layers.has(id)) throw new SpriteError(`Unknown sprite layer "${id}".`);
    const nextLayers = this.layerData().filter(layer => layer.id !== id);
    const next = this.buildState(nextLayers, this.skeleton?.definition ?? null, new Map(this.images), new Map(this.resources),
      { mode: 'edit', preview: this.preview });
    this.commit(next, { preview: this.preview });
  }

  hasLayers(anchor: string): boolean {
    this.assertLive();
    this.anchor(anchor);
    return (this.attachments.get(anchor)?.count ?? 0) > 0;
  }

  replaces(anchor: string, aim?: { x: number; y: number }): boolean {
    this.assertLive();
    this.anchor(anchor);
    const attachment = this.attachments.get(anchor);
    if (attachment === undefined) return false;
    return attachment.coverageCounts[directionIndex(this.queryDirection(aim))] > 0;
  }

  inspect() {
    const resources = [...this.resources.values()];
    const staged = [...this.replacement?.staged.values() ?? []];
    const geometries = new Set<string>();
    if (!this.disposed) geometries.add(this.geometry.uuid);
    const skinnedLayers = [] as Array<{
      id: string;
      vertexCount: number;
      sampleVertices: readonly unknown[];
    }>;
    const layers = [...this.layers.values()].map(instance => {
      geometries.add(instance.mesh.geometry.uuid);
      const local = this.describeMatrix(instance.mesh.matrix);
      if (instance.kind === 'skin' && this.skeleton !== null) {
        skinnedLayers.push({
          id: instance.data.id,
          vertexCount: instance.mesh.geometry.getAttribute('position').count,
          sampleVertices: this.sampleSkinnedVertices(instance),
        });
      }
      return {
        ...instance.data,
        offset: { ...instance.data.offset },
        kind: instance.kind,
        visible: instance.visible,
        localTransform: local,
        worldTransform: this.describeMatrix(instance.mesh.matrixWorld),
        textureId: instance.mesh.material.map!.uuid,
        materialId: instance.mesh.material.uuid,
        geometryId: instance.mesh.geometry.uuid,
        vertexCount: instance.mesh.geometry.getAttribute('position').count,
        tileRepeat: instance.tile?.lastRepeat ?? null,
      };
    });
    return {
      disposed: this.disposed,
      busy: !this.disposed && (this.replacement !== null || this.pendingDecodes > 0),
      pendingDecodeCount: this.pendingDecodes,
      layerCount: this.layers.size,
      imageCount: this.images.size,
      textureCount: resources.length,
      materialCount: resources.length,
      geometryCount: this.disposed ? 0 : geometries.size,
      pixelCount: resources.reduce((total, resource) => total + resource.pixels, 0),
      byteCount: resources.reduce((total, resource) => total + resource.bytes, 0),
      stagedTextureCount: staged.length,
      stagedPixelCount: staged.reduce((total, resource) => total + resource.pixels, 0),
      texturesCreated: this.texturesCreated,
      texturesDisposed: this.texturesDisposed,
      direction: this.currentDirection,
      animation: this.preview !== null ? this.preview.clip : this.hasFrame ? this.skeleton?.definition.animation ?? null : null,
      preview: this.preview === null ? null : {
        ...this.preview,
        pose: this.preview.pose.map(value => ({ ...value })),
      },
      resources: resources.map(resource => ({
        textureId: resource.texture.uuid,
        materialId: resource.material.uuid,
        width: resource.bitmap.width,
        height: resource.bitmap.height,
        pixels: resource.pixels,
        bytes: resource.bytes,
      })),
      layers,
      skeleton: this.skeleton === null ? null : {
        anchor: this.skeleton.definition.anchor,
        originWorld: point(this.skeleton.originWorld),
        clip: this.preview !== null ? this.preview.clip : this.hasFrame ? this.skeleton.definition.animation : null,
        constraints: this.preview !== null ? this.preview.constraints : this.hasFrame ? 'enabled' : 'disabled',
        bones: this.skeleton.evaluated.map(bone => ({ ...bone })),
        skinnedLayers,
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replacement?.controller.abort(new DOMException('The sprite rig was disposed.', 'AbortError'));
    for (const resource of this.replacement?.staged.values() ?? []) this.releaseResource(resource);
    this.replacement?.staged.clear();
    const previousCoverage = new Map([...this.attachments].map(([name, attachment]) => [name, attachment.covered]));
    this.detachScene();
    this.disposeLayers(this.layers.values());
    this.layers.clear();
    this.disposeSkeleton(this.skeleton);
    this.skeleton = null;
    for (const resource of this.resources.values()) this.releaseResource(resource);
    this.resources.clear();
    this.images.clear();
    this.geometry.dispose();
    this.attachments.clear();
    for (const [name, covered] of previousCoverage) if (covered) this.anchor(name).setCovered({ covered: false });
  }

  private assertLive(): void {
    if (this.disposed) throw new SpriteError('The sprite rig has been disposed.');
  }

  private assertMutable(): void {
    this.assertLive();
    if (this.replacement !== null || this.pendingDecodes > 0) {
      throw new SpriteError('A sprite replacement or cancelled PNG decode is still in progress.');
    }
  }

  private decode(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<ImageBitmap> {
    this.pendingDecodes++;
    try {
      return decodePng(bytes, signal, () => { this.pendingDecodes--; });
    } catch (error) {
      this.pendingDecodes--;
      throw error;
    }
  }

  private anchor(name: string): SpriteAnchor {
    const anchor = this.anchors.get(name);
    if (anchor === undefined) throw new SpriteError(`Unknown sprite anchor "${name}".`);
    return anchor;
  }

  private createResource(bitmap: ImageBitmap, bytes: number): ImageResource {
    let texture: THREE.Texture | undefined;
    try {
      texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      const material = new THREE.MeshBasicMaterial({
        map: texture, side: THREE.DoubleSide, alphaTest: ALPHA_CUTOFF, depthWrite: true, toneMapped: false,
      });
      this.texturesCreated++;
      return { bitmap, texture, material, bytes, pixels: bitmap.width * bitmap.height, disposed: false };
    } catch (error) {
      texture?.dispose();
      bitmap.close();
      throw error;
    }
  }

  private releaseResource(resource: ImageResource): void {
    if (resource.disposed) return;
    resource.disposed = true;
    resource.material.dispose();
    resource.texture.dispose();
    resource.bitmap.close();
    this.texturesDisposed++;
  }

  private layerData(): SpriteLayer[] {
    return [...this.layers.values()].map(instance => instance.data);
  }

  private buildState(
    layers: readonly SpriteLayer[],
    definition: SkeletonDefinition | null,
    images: Map<string, ImageResource>,
    resources: Map<string, ImageResource>,
    options: { mode: 'replace' | 'edit'; preview: SkeletonPreview | null },
  ): BuildState {
    const attachments = new Map<string, Attachment>();
    const instances = new Map<string, LayerInstance>();
    let skeleton: SkeletonRuntime | null = null;
    try {
      skeleton = options.mode === 'edit' && definition === (this.skeleton?.definition ?? null)
        ? this.skeleton : definition === null ? null : this.createSkeleton(definition);
      if (skeleton !== null && skeleton !== this.skeleton) {
        this.updateSkeletonRoot(skeleton);
        this.evaluateSkeleton(skeleton, this.queryDirection(null, options.preview), options.preview);
      }
      for (const data of layers) {
        const image = images.get(data.image);
        if (image === undefined) throw new SpriteError(`Sprite ${data.id} references missing image "${data.image}".`);
        const attachment = this.attachment(data.anchor, attachments, options.mode);
        const instance = options.mode === 'edit' ? this.createOrReuseLayer(data, image, skeleton) : this.createLayer(data, image, skeleton);
        if (instance.kind === 'legacy') {
          if (instance.mesh.parent !== attachment.group) attachment.group.add(instance.mesh);
          attachment.legacyCount++;
        } else {
          if (skeleton !== null && instance.mesh.parent !== skeleton.group) skeleton.group.add(instance.mesh);
        }
        attachment.count++;
        if (data.underlay === 'replace') {
          for (const direction of data.directions) {
            const index = directionIndex(direction);
            attachment.coverageCounts[index]++;
          }
        }
        instances.set(data.id, instance);
      }
      return { resources, images, layers: instances, attachments, skeleton };
    } catch (error) {
      for (const instance of instances.values()) if (this.layers.get(instance.data.id) !== instance) this.disposeLayer(instance);
      if (skeleton !== this.skeleton) this.disposeSkeleton(skeleton);
      throw error;
    }
  }

  private createSkeleton(definition: SkeletonDefinition): SkeletonRuntime {
    try {
      const group = new THREE.Group();
      group.name = `sprites:skeleton:${definition.anchor}`;
      group.matrixAutoUpdate = false;
      group.matrix.identity();
      const rest = restPose(definition);
      const pose = new SkeletonPose(definition);
      const bones = definition.bones.map((bone) => {
        const runtime = new THREE.Bone();
        runtime.name = bone.id;
        runtime.matrixAutoUpdate = false;
        runtime.matrix.identity();
        runtime.matrixWorld.identity();
        return runtime;
      });
      const boneIndex = new Map(definition.bones.map((bone, index) => [bone.id, index]));
      const inverses = rest.map((bone) => this.composeBoneMatrix(bone).invert());
      const skeleton = new THREE.Skeleton([...bones], inverses);
      const runtime: SkeletonRuntime = {
        definition,
        pose,
        group,
        bones,
        boneIndex,
        skeleton,
        evaluated: rest,
        originWorld: { x: 0, y: 0 },
      };
      this.applyBoneMatrices(runtime, rest);
      skeleton.update();
      return runtime;
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  private createOrReuseLayer(data: SpriteLayer, image: ImageResource, skeleton: SkeletonRuntime | null): LayerInstance {
    const previous = this.layers.get(data.id);
    if (previous !== undefined && previous.data === data && previous.resource === image &&
      (previous.kind !== 'skin' || skeleton === this.skeleton)) return previous;
    if (previous?.kind === 'skin' && data.skin !== null && previous.data.skin !== null &&
      this.sameSkinGrid(previous.data, data) && skeleton !== null) {
      if (skeleton !== this.skeleton || !this.sameWeights(previous.data, data)) {
        this.updateSkinnedGeometry(previous.mesh.geometry, data, skeleton);
      }
      previous.data = data;
      previous.resource = image;
      previous.directionMask = directionMask(data.directions);
      previous.visible = false;
      previous.mesh.visible = false;
      previous.mesh.name = data.name;
      previous.mesh.material = image.material;
      previous.bindMatrix.copy(this.layerMatrix(data));
      previous.mesh.matrix.copy(previous.bindMatrix);
      previous.mesh.matrixWorldNeedsUpdate = true;
      previous.mesh.bindMode = 'detached';
      previous.mesh.bind(skeleton.skeleton, previous.bindMatrix.clone());
      return previous;
    }
    if (previous !== undefined && previous.kind !== 'skin' && data.skin === null &&
      (previous.kind === 'legacy' ? data.bone === null : data.bone === previous.boneId) &&
      (previous.tile === null) === (data.tileLength === null)) {
      previous.data = data;
      previous.resource = image;
      previous.directionMask = directionMask(data.directions);
      previous.mesh.name = data.name;
      previous.mesh.material = image.material;
      previous.localMatrix.copy(this.layerMatrix(data));
      if (previous.kind === 'legacy') previous.mesh.matrix.copy(previous.localMatrix);
      previous.mesh.matrixWorldNeedsUpdate = true;
      if (previous.tile !== null && data.tileLength !== null) {
        previous.tile.tileLength = data.tileLength;
        previous.tile.lastRepeat = NaN;
      }
      return previous;
    }
    return this.createLayer(data, image, skeleton);
  }

  private createLayer(data: SpriteLayer, image: ImageResource, skeleton: SkeletonRuntime | null): LayerInstance {
    const mask = directionMask(data.directions);
    if (data.skin !== null) {
      if (skeleton === null) throw new SpriteError(`Sprite "${data.name}" requires a skeleton.`);
      const geometry = this.createSkinnedGeometry(data, skeleton);
      const mesh = new THREE.SkinnedMesh(geometry, image.material);
      mesh.name = data.name;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      const bindMatrix = this.layerMatrix(data);
      mesh.matrix.copy(bindMatrix);
      mesh.matrixWorldNeedsUpdate = true;
      mesh.bindMode = 'detached';
      mesh.bind(skeleton.skeleton, bindMatrix.clone());
      return {
        kind: 'skin',
        data,
        resource: image,
        mesh,
        directionMask: mask,
        visible: false,
        tile: null,
        bindMatrix,
      };
    }
    const tile = data.tileLength === null ? null : this.createTileRuntime(data.tileLength);
    const geometry = tile?.geometry ?? this.geometry;
    const mesh = new THREE.Mesh(geometry, image.material);
    mesh.name = data.name;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    if (data.bone !== null) {
      if (skeleton === null) throw new SpriteError(`Sprite "${data.name}" requires a skeleton.`);
      return {
        kind: 'bone',
        data,
        resource: image,
        mesh,
        directionMask: mask,
        visible: false,
        tile,
        boneId: data.bone,
        localMatrix: this.layerMatrix(data),
      };
    }
    const localMatrix = this.layerMatrix(data);
    mesh.matrix.copy(localMatrix);
    mesh.matrixWorldNeedsUpdate = true;
    return {
      kind: 'legacy',
      data,
      resource: image,
      mesh,
      directionMask: mask,
      visible: false,
      tile,
      localMatrix,
    };
  }

  private sameSkinGrid(left: SpriteLayer, right: SpriteLayer): boolean {
    return left.skin !== null && right.skin !== null &&
      left.skin.columns === right.skin.columns &&
      left.skin.rows === right.skin.rows;
  }

  private sameWeights(left: SpriteLayer, right: SpriteLayer): boolean {
    if (left.skin === null || right.skin === null) return false;
    const expected = right.skin.weights;
    return left.skin.weights.length === expected.length && left.skin.weights.every((weights, vertex) =>
      weights.length === expected[vertex].length && weights.every((influence, index) =>
        influence.bone === expected[vertex][index].bone && influence.weight === expected[vertex][index].weight));
  }

  private createTileRuntime(tileLength: number): TileRuntime {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const baseUvs = new Float32Array((uv.array as ArrayLike<number>));
    return { geometry, uv, baseUvs, tileLength, lastRepeat: NaN };
  }

  private createSkinnedGeometry(data: SpriteLayer, skeleton: SkeletonRuntime): THREE.PlaneGeometry {
    const skin = data.skin;
    if (skin === null) throw new Error('Skinned geometry requires skin data.');
    const geometry = new THREE.PlaneGeometry(1, 1, skin.columns, skin.rows);
    this.updateSkinnedGeometry(geometry, data, skeleton);
    return geometry;
  }

  private updateSkinnedGeometry(
    geometry: THREE.PlaneGeometry,
    data: SpriteLayer,
    skeleton: SkeletonRuntime,
  ): void {
    const skin = data.skin;
    if (skin === null) throw new Error('Skinned geometry requires skin data.');
    let indexAttribute = geometry.getAttribute('skinIndex');
    let weightAttribute = geometry.getAttribute('skinWeight');
    if (indexAttribute === undefined) {
      indexAttribute = new THREE.Uint16BufferAttribute(new Uint16Array(skin.weights.length * 4), 4);
      geometry.setAttribute('skinIndex', indexAttribute);
    }
    if (weightAttribute === undefined) {
      weightAttribute = new THREE.Float32BufferAttribute(new Float32Array(skin.weights.length * 4), 4);
      geometry.setAttribute('skinWeight', weightAttribute);
    }
    const skinIndices = indexAttribute.array, skinWeights = weightAttribute.array;
    skinIndices.fill(0);
    skinWeights.fill(0);
    for (let vertex = 0; vertex < skin.weights.length; vertex++) {
      const influences = skin.weights[vertex]!;
      for (let slot = 0; slot < influences.length; slot++) {
        const influence = influences[slot]!;
        const bone = skeleton.boneIndex.get(influence.bone);
        if (bone === undefined) throw new SpriteError(`Sprite "${data.name}" has a missing weight bone "${influence.bone}".`);
        skinIndices[vertex * 4 + slot] = bone;
        skinWeights[vertex * 4 + slot] = influence.weight;
      }
    }
    indexAttribute.needsUpdate = true;
    weightAttribute.needsUpdate = true;
  }

  private layerMatrix(data: SpriteLayer): THREE.Matrix4 {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(data.offset.x, data.offset.y, data.offset.z),
      new THREE.Quaternion().setFromAxisAngle(Z_AXIS, THREE.MathUtils.degToRad(data.rotation)),
      new THREE.Vector3(data.width, data.height, 1),
    );
  }

  private composeBoneMatrix(bone: RuntimeBoneWorld): THREE.Matrix4 {
    return new THREE.Matrix4().makeRotationZ(bone.angle).setPosition(bone.x, bone.y, 0);
  }

  private attachment(name: string, attachments: Map<string, Attachment>, mode: 'replace' | 'edit'): Attachment {
    let attachment = attachments.get(name);
    if (attachment === undefined) {
      const group = mode === 'edit' ? this.attachments.get(name)?.group ?? new THREE.Group() : new THREE.Group();
      group.name = `sprites:${name}`;
      group.matrixAutoUpdate = false;
      group.matrix.identity();
      attachment = {
        group,
        count: 0,
        legacyCount: 0,
        covered: false,
        coverageCounts: FACING_DIRECTIONS.map(() => 0),
      };
      attachments.set(name, attachment);
    }
    return attachment;
  }

  private commit(next: BuildState, options: { preview: SkeletonPreview | null }): void {
    const oldResources = this.resources;
    const oldLayers = this.layers;
    const oldAttachments = this.attachments;
    const oldSkeleton = this.skeleton;
    const previousCoverage = new Map([...oldAttachments].map(([name, attachment]) => [name, attachment.covered]));
    const retained = new Set(next.layers.values());
    this.detachScene();
    for (const layer of oldLayers.values()) if (!retained.has(layer)) layer.mesh.removeFromParent();
    this.resources = next.resources;
    this.images = next.images;
    this.layers = next.layers;
    this.attachments = next.attachments;
    this.skeleton = next.skeleton;
    this.preview = options.preview;
    for (const instance of this.layers.values()) {
      if (instance.tile !== null && instance.resource.texture.wrapS !== THREE.RepeatWrapping) {
        instance.resource.texture.wrapS = THREE.RepeatWrapping;
        instance.resource.texture.needsUpdate = true;
      }
    }
    this.attachScene();
    this.refreshScene({ forceVisibility: true, notifyCoverage: false });
    const affectedCoverage = new Set([...previousCoverage.keys(), ...this.attachments.keys()]);
    for (const name of affectedCoverage) {
      const wasCovered = previousCoverage.get(name) ?? false;
      const covered = this.attachments.get(name)?.covered ?? false;
      if (wasCovered !== covered) this.anchor(name).setCovered({ covered });
    }
    for (const layer of oldLayers.values()) if (!retained.has(layer)) this.disposeLayer(layer);
    if (oldSkeleton !== this.skeleton) this.disposeSkeleton(oldSkeleton);
    for (const [source, resource] of oldResources) {
      if (!this.resources.has(source)) this.releaseResource(resource);
    }
  }

  private detachScene(): void {
    for (const attachment of this.attachments.values()) attachment.group.removeFromParent();
    this.skeleton?.group.removeFromParent();
  }

  private attachScene(): void {
    for (const [name, attachment] of this.attachments) {
      if (attachment.legacyCount > 0) this.anchor(name).node.add(attachment.group);
      else attachment.group.removeFromParent();
    }
    if (this.skeleton !== null) this.root.add(this.skeleton.group);
  }

  private refreshScene(options: { forceVisibility?: boolean; notifyCoverage?: boolean } = {}): void {
    const direction = this.queryDirection();
    const changedDirection = direction !== this.currentDirection;
    if (changedDirection) this.currentDirection = direction;
    if (options.forceVisibility || changedDirection) this.applyDirection(direction, options.notifyCoverage !== false);
    if (this.skeleton !== null) {
      this.updateSkeletonRoot(this.skeleton);
      this.evaluateSkeleton(this.skeleton, direction, this.preview);
      this.updateBoneAttachments(this.skeleton);
      this.skeleton.group.updateWorldMatrix(true, true);
    }
    for (const attachment of this.attachments.values()) {
      // Manual local matrices must follow moving anchors before UV density is measured.
      if (attachment.legacyCount > 0) attachment.group.updateWorldMatrix(true, true, true);
    }
    for (const instance of this.layers.values()) {
      if (instance.kind === 'skin' || instance.tile === null || !instance.visible) continue;
      instance.mesh.updateWorldMatrix(true, false);
      this.updateTileUv(instance);
    }
  }

  private queryDirection(aim: RuntimePoint | null = null, preview: SkeletonPreview | null = this.preview): FacingDirection {
    if (preview !== null) return preview.direction;
    aim ??= this.lastFrame.aim;
    if (Math.hypot(aim.x, aim.y) <= AIM_EPSILON) return this.currentDirection;
    return facingDirection(Math.atan2(aim.y, aim.x));
  }

  private applyDirection(direction: FacingDirection, notifyCoverage: boolean): void {
    const index = directionIndex(direction);
    for (const instance of this.layers.values()) {
      const visible = (instance.directionMask & (1 << index)) !== 0;
      if (visible === instance.visible) continue;
      instance.visible = visible;
      instance.mesh.visible = visible;
    }
    for (const [name, attachment] of this.attachments) {
      const covered = attachment.coverageCounts[index] > 0;
      if (covered === attachment.covered) continue;
      attachment.covered = covered;
      if (notifyCoverage) this.anchor(name).setCovered({ covered });
    }
  }

  private updateSkeletonRoot(runtime: SkeletonRuntime): void {
    this.root.updateWorldMatrix(true, false);
    const determinant = this.root.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) throw new SpriteError('The sprite render mount needs an invertible world transform.');
    const host = this.anchor(runtime.definition.anchor).node;
    host.getWorldPosition(this.tempWorld);
    runtime.originWorld = { x: this.tempWorld.x, y: this.tempWorld.y };
    this.tempMatrixA.copy(this.root.matrixWorld).invert();
    this.tempMatrixB.makeTranslation(this.tempWorld.x, this.tempWorld.y, this.tempWorld.z);
    runtime.group.matrix.multiplyMatrices(this.tempMatrixA, this.tempMatrixB);
    runtime.group.matrixWorldNeedsUpdate = true;
  }

  private evaluateSkeleton(runtime: SkeletonRuntime, direction: FacingDirection, preview: SkeletonPreview | null): void {
    try {
      const input = preview !== null ? {
        time: preview.time,
        origin: runtime.originWorld,
        direction: preview.direction,
        targets: this.rigTargets(runtime.originWorld),
        clip: preview.clip,
        pose: preview.pose,
        constraints: preview.constraints,
      } : !this.hasFrame ? {
        time: this.lastFrame.time,
        origin: runtime.originWorld,
        direction,
        targets: EMPTY_TARGETS,
        clip: null,
        pose: EMPTY_POSE,
        constraints: 'disabled' as const,
      } : {
        time: this.lastFrame.time,
        origin: runtime.originWorld,
        direction,
        targets: this.rigTargets(runtime.originWorld),
        clip: runtime.definition.animation,
        pose: EMPTY_POSE,
        constraints: 'enabled' as const,
      };
      const bones = runtime.pose.evaluate(input);
      runtime.evaluated = bones;
      this.applyBoneMatrices(runtime, bones);
      runtime.skeleton.update();
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  private updateBoneAttachments(runtime: SkeletonRuntime): void {
    for (const instance of this.layers.values()) {
      if (instance.kind !== 'bone') continue;
      const index = runtime.boneIndex.get(instance.boneId);
      if (index === undefined) throw new SpriteError(`Sprite "${instance.data.name}" references a missing bone.`);
      instance.mesh.matrix.multiplyMatrices(runtime.bones[index]!.matrixWorld, instance.localMatrix);
      instance.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  private rigTargets(origin: RuntimePoint): ReadonlyMap<string, RuntimeTarget> {
    const targets = new Map<string, RuntimeTarget>();
    for (const [name, anchor] of this.anchors) {
      anchor.node.getWorldPosition(this.tempWorld);
      targets.set(name, {
        x: this.tempWorld.x - origin.x,
        y: this.tempWorld.y - origin.y,
        angle: this.worldAngle(anchor.node),
      });
    }
    for (const [name, target] of this.lastFrame.targets) {
      targets.set(name, { x: target.x - origin.x, y: target.y - origin.y, angle: target.angle });
    }
    return targets;
  }

  private worldAngle(node: THREE.Object3D): number {
    const e = node.matrixWorld.elements;
    return Math.atan2(e[1]!, e[0]!);
  }

  private applyBoneMatrices(runtime: SkeletonRuntime, bones: readonly RuntimeBoneWorld[]): void {
    for (let index = 0; index < bones.length; index++) {
      const source = bones[index]!;
      const bone = runtime.bones[index]!;
      bone.matrix.makeRotationZ(source.angle).setPosition(source.x, source.y, 0);
      bone.matrixWorld.copy(bone.matrix);
    }
  }

  private updateTileUv(instance: TiledLayerInstance): void {
    const tile = instance.tile;
    if (tile === null) return;
    const length = this.worldLengthX(instance.mesh.matrixWorld);
    const repeat = length / tile.tileLength;
    if (Number.isFinite(tile.lastRepeat) && Math.abs(tile.lastRepeat - repeat) <= TILE_EPSILON) return;
    tile.lastRepeat = repeat;
    for (let index = 0; index < tile.baseUvs.length; index += 2) {
      tile.uv.array[index] = tile.baseUvs[index]! * repeat;
      tile.uv.array[index + 1] = tile.baseUvs[index + 1]!;
    }
    tile.uv.needsUpdate = true;
  }

  private worldLengthX(matrix: THREE.Matrix4): number {
    const e = matrix.elements;
    return Math.hypot(e[0]!, e[1]!, e[2]!);
  }

  private disposeLayers(layers: Iterable<LayerInstance>): void {
    for (const layer of layers) this.disposeLayer(layer);
  }

  private disposeLayer(layer: LayerInstance): void {
    layer.mesh.removeFromParent();
    if (layer.kind === 'skin' || layer.tile !== null) layer.mesh.geometry.dispose();
  }

  private disposeSkeleton(runtime: SkeletonRuntime | null): void {
    if (runtime === null) return;
    runtime.group.removeFromParent();
    runtime.skeleton.dispose();
  }

  private describeMatrix(matrix: THREE.Matrix4) {
    matrix.decompose(this.tempPosition, this.tempQuaternion, this.tempScale);
    return {
      position: { x: this.tempPosition.x, y: this.tempPosition.y, z: this.tempPosition.z },
      scale: { x: this.tempScale.x, y: this.tempScale.y, z: this.tempScale.z },
      rotationZ: new THREE.Euler().setFromQuaternion(this.tempQuaternion).z,
    };
  }

  private sampleSkinnedVertices(instance: SkinLayerInstance): readonly unknown[] {
    if (this.skeleton === null) return [];
    const position = instance.mesh.geometry.getAttribute('position');
    const skinIndex = instance.mesh.geometry.getAttribute('skinIndex');
    const skinWeight = instance.mesh.geometry.getAttribute('skinWeight');
    const sample = [] as unknown[];
    const bind = instance.mesh.bindMatrix;
    const bindInverse = instance.mesh.bindMatrixInverse;
    for (let index = 0; index < Math.min(position.count, SKIN_SAMPLE_LIMIT); index++) {
      this.tempWorld.fromBufferAttribute(position, index).applyMatrix4(bind);
      this.tempWorldB.set(0, 0, 0);
      const influences = [] as Array<{ bone: string; weight: number }>;
      for (let slot = 0; slot < 4; slot++) {
        const weight = attributeComponent(skinWeight, index, slot);
        if (weight <= 0) continue;
        const boneIndexValue = attributeComponent(skinIndex, index, slot);
        const bone = this.skeleton.bones[boneIndexValue];
        const restInverse = this.skeleton.skeleton.boneInverses[boneIndexValue];
        if (bone === undefined || restInverse === undefined) continue;
        this.tempMatrixA.multiplyMatrices(bone.matrixWorld, restInverse);
        this.tempWorldC.copy(this.tempWorld).applyMatrix4(this.tempMatrixA).multiplyScalar(weight);
        this.tempWorldB.add(this.tempWorldC);
        influences.push({ bone: this.skeleton.definition.bones[boneIndexValue]!.id, weight });
      }
      this.tempWorldC.copy(this.tempWorldB).applyMatrix4(bindInverse);
      const world = new THREE.Vector3(this.tempWorldC.x, this.tempWorldC.y, this.tempWorldC.z).applyMatrix4(instance.mesh.matrixWorld);
      sample.push({
        index,
        local: { x: position.getX(index), y: position.getY(index), z: position.getZ(index) },
        deformedLocal: { x: this.tempWorldC.x, y: this.tempWorldC.y, z: this.tempWorldC.z },
        world: { x: world.x, y: world.y, z: world.z },
        influences,
      });
    }
    return sample;
  }

  private spriteFailure(error: unknown): SpriteError {
    if (error instanceof SpriteError) return error;
    if (error instanceof SkeletonError) return new SpriteError(error.message, { cause: error });
    throw error;
  }
}
