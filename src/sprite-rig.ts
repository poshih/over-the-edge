import * as THREE from 'three';
import {
  embeddedPng,
  flipbookSizeMessage,
  inspectPng,
  DEFAULT_CHARACTER_RIGGING_TYPE,
  SPRITE_LIMITS,
  SpriteError,
  validateArmForwardDistance,
  validateCharacterRiggingType,
  validateDirectionalReferences,
  validateSpriteAnchors,
  validateSpriteLayer,
  validateSpriteMetadata,
  validateSpriteRigging,
} from './sprite-data';
import type { CharacterPresentation, CharacterRiggingType, SpriteDocument, SpriteFlipbook, SpriteLayer } from './sprite-data';
import { DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth';
import {
  characterAssets, DEFAULT_CHARACTER_SHADING, sameShading, validateCharacterShading,
} from './character-profile';
import type { CharacterAssets, CharacterShading } from './character-profile';
import { DirectionalError, validateDirectionalPresentation } from './directional-data';
import type { DirectionalPresentation } from './directional-data';
import { DirectionalPose } from './directional-pose';
import type { DirectionalFrame } from './directional-pose';
import { FACING_DIRECTIONS, SkeletonError, validateSkeleton, validateSkeletonPreview } from './skeleton-data';
import type { FacingDirection, SkeletonDefinition, SkeletonPreview } from './skeleton-data';
import { SkeletonPose, restPose } from './skeleton-pose';
import type { RigPoint as RuntimePoint, RigTarget as RuntimeTarget, BoneWorld as RuntimeBoneWorld, SkeletonRotation } from './skeleton-pose';
import { compileSpriteHeadTracking } from './sprite-head-aim';
import type { SpriteHeadTracking, SpriteHeadTrackingPlan } from './sprite-head-aim';
import { selectFlipbookFrame } from './sprite-flipbook';

export interface SpriteAnchor {
  readonly node: THREE.Object3D;
  readonly renderRoot?: THREE.Object3D;
  readonly setCovered: (options: { covered: boolean }) => void;
}

// Loads and validates a profile's character models before the rig commits it, so failures
// leave the previous presentation untouched. Hosts without one reject documents with models.
export interface CharacterAssetHost {
  prepare(document: SpriteDocument, signal: AbortSignal): Promise<void>;
}

interface ImageResource {
  readonly bitmap: ImageBitmap;
  readonly texture: THREE.Texture;
  readonly material: THREE.MeshBasicMaterial;
  readonly bytes: number;
  readonly pixels: number;
  disposed: boolean;
  prepared: boolean;
}

// One timeline's hysteresis memory; it restarts whenever its DirectionalPose initializes directly.
interface FlipbookTrack {
  frame: number | null;
  pose: DirectionalPose | null;
  epoch: number;
}

interface FlipbookRuntime {
  readonly definition: SpriteFlipbook;
  readonly frames: readonly ImageResource[];
  readonly live: FlipbookTrack;
  readonly preview: FlipbookTrack;
  shown: number;
  changes: number;
}

interface Attachment {
  readonly group: THREE.Group;
  count: number;
  legacyCount: number;
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
  flipbook: FlipbookRuntime | null;
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
type FlipbookLayerInstance = LayerInstance & { flipbook: FlipbookRuntime };

interface Replacement {
  readonly controller: AbortController;
  readonly staged: Map<string, ImageResource>;
}

interface SkeletonRuntime {
  readonly definition: SkeletonDefinition;
  pose: SkeletonPose;
  previewPose: SkeletonPose | null;
  readonly group: THREE.Group;
  readonly bones: readonly THREE.Bone[];
  readonly boneIndex: ReadonlyMap<string, number>;
  readonly skeleton: THREE.Skeleton;
  evaluated: readonly RuntimeBoneWorld[];
  originWorld: RuntimePoint;
}

interface BuildState extends CharacterPresentation {
  readonly resources: Map<string, ImageResource>;
  readonly images: Map<string, ImageResource>;
  readonly layers: Map<string, LayerInstance>;
  readonly attachments: Map<string, Attachment>;
  readonly skeletonMounts: Map<THREE.Object3D, THREE.Group>;
  readonly skeleton: SkeletonRuntime | null;
  readonly presentation: DirectionalPresentation | null;
  readonly headTracking: SpriteHeadTrackingPlan;
  readonly mode: 'replace' | 'edit';
}

const ALPHA_CUTOFF = 0.5;
const TILE_EPSILON = 1e-6;
const EMPTY_POSE: SkeletonPreview['pose'] = Object.freeze([]);
const EMPTY_BONES: readonly string[] = Object.freeze([]);
const EMPTY_TARGETS = new Map<string, RuntimeTarget>();
const SKIN_SAMPLE_LIMIT = 4;
const DIRECTION_STEP_DEGREES = 360 / FACING_DIRECTIONS.length;
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
  private readonly onCharacterPresentationChange: ((settings: CharacterPresentation) => void) | undefined;
  private readonly prepareTexture: ((texture: THREE.Texture) => void) | undefined;
  private readonly headTracking: SpriteHeadTracking | null;
  private headTrackingPlan: SpriteHeadTrackingPlan;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly coverage = new Map<string, boolean>();
  private characterRiggingType: CharacterRiggingType = DEFAULT_CHARACTER_RIGGING_TYPE;
  private armForwardDistance: number = DEFAULT_ARM_FORWARD_DISTANCE;
  private assets: CharacterAssets = {};
  private readonly assetHost: CharacterAssetHost | undefined;
  private images = new Map<string, ImageResource>();
  private resources = new Map<string, ImageResource>();
  private layers = new Map<string, LayerInstance>();
  private attachments = new Map<string, Attachment>();
  private skeletonMounts = new Map<THREE.Object3D, THREE.Group>();
  private skeleton: SkeletonRuntime | null = null;
  private preview: SkeletonPreview | null = null;
  private presentation: DirectionalPresentation | null = null;
  private directionPose = new DirectionalPose(null);
  private previewDirectionPose: DirectionalPose | null = null;
  private directionalPreview: { readonly aim: RuntimePoint } | null = null;
  private previewTime = 0;
  private rotatedLayers: readonly LegacyLayerInstance[] = [];
  private flipbooks: readonly FlipbookLayerInstance[] = [];
  private displayedPresentation: Readonly<DirectionalFrame> = this.directionPose.snapshot();
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
  private readonly presentationPivot = new THREE.Vector3();
  private readonly presentationMatrix = new THREE.Matrix4();

  constructor(anchors: ReadonlyMap<string, SpriteAnchor>, options: {
    root: THREE.Object3D;
    targetIds: readonly string[];
    onCharacterPresentationChange?: (settings: CharacterPresentation) => void;
    headTracking?: SpriteHeadTracking;
    // Uploads a texture ahead of first use, so flipbook frame changes never upload during play.
    prepareTexture?: (texture: THREE.Texture) => void;
    characterAssets?: CharacterAssetHost;
  }) {
    this.anchors = new Map(anchors);
    for (const name of this.anchors.keys()) this.coverage.set(name, false);
    this.root = options.root;
    this.targetIds = new Set(options.targetIds);
    this.onCharacterPresentationChange = options.onCharacterPresentationChange;
    this.prepareTexture = options.prepareTexture;
    this.assetHost = options.characterAssets;
    this.headTracking = options.headTracking === undefined ? null : {
      anchor: options.headTracking.anchor,
      pivot: { ...options.headTracking.pivot },
    };
    if (this.headTracking !== null) {
      this.anchor(this.headTracking.anchor);
      this.anchor(this.headTracking.pivot.anchor);
      if (!Number.isFinite(this.headTracking.pivot.x) || !Number.isFinite(this.headTracking.pivot.y)) {
        throw new SpriteError('The sprite head pivot must have finite coordinates.');
      }
    }
    this.headTrackingPlan = compileSpriteHeadTracking(this.headTracking, [], null, null);
  }

  async replace(document: SpriteDocument, options: { signal: AbortSignal } = { signal: new AbortController().signal }): Promise<void> {
    this.assertMutable();
    if (options.signal.aborted) throw cancellation(options.signal);
    document = validateSpriteMetadata(document);
    validateSpriteAnchors(document, this.anchors.keys(), this.targetIds);
    this.assertCharacterRenderer(document.characterRiggingType);
    if (document.models !== undefined && this.assetHost === undefined) {
      throw new SpriteError('This host cannot load character models.');
    }
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
      if (document.models !== undefined) {
        await this.assetHost!.prepare(document, signal);
        checkSignal(signal);
      }
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
      const next = this.buildState(document.layers, document.skeleton, images, resources,
        { mode: 'replace', presentation: document.presentation, characterRiggingType: document.characterRiggingType,
          armForwardDistance: document.armForwardDistance, ...characterAssets(document) });
      operation.staged.clear();
      this.commit(next, { preview: null });
    } finally {
      options.signal.removeEventListener('abort', abort);
      for (const resource of operation.staged.values()) this.releaseResource(resource);
      operation.staged.clear();
      if (this.replacement === operation) this.replacement = null;
    }
  }

  setCharacterRiggingType(value: CharacterRiggingType): void {
    this.assertMutable();
    const characterRiggingType = validateCharacterRiggingType(value, this.layers.size);
    if (characterRiggingType === this.characterRiggingType) return;
    const next = this.buildState(this.layerData(), this.skeleton?.definition ?? null, new Map(this.images), new Map(this.resources),
      { ...this.currentCharacterPresentation(), mode: 'edit', presentation: this.presentation, characterRiggingType });
    this.commit(next, { preview: null });
  }

  setArmForwardDistance(value: number): void {
    this.assertMutable();
    const distance = validateArmForwardDistance(value);
    if (distance === this.armForwardDistance) return;
    this.armForwardDistance = distance;
    this.onCharacterPresentationChange?.(this.currentCharacterPresentation());
  }

  // Applies shading to the loaded models without reloading them; the default look is stored as absent.
  setShading(value: CharacterShading): void {
    this.assertMutable();
    const validated = validateCharacterShading(value);
    const shading = sameShading(validated, DEFAULT_CHARACTER_SHADING) ? undefined : validated;
    const current = this.assets.shading;
    if (current === shading || current !== undefined && shading !== undefined && sameShading(current, shading)) return;
    this.assets = characterAssets({ ...this.assets, shading });
    this.onCharacterPresentationChange?.(this.currentCharacterPresentation());
  }

  configureSkeleton(
    definition: SkeletonDefinition | null,
    options: { preview: SkeletonPreview | null } = { preview: null },
  ): void {
    this.assertMutable();
    try {
      if (options.preview !== null) this.assertSpritePreview();
      const skeleton = definition === null ? null : validateSkeleton(definition);
      const layers = this.layerData();
      validateSpriteRigging(layers, skeleton);
      validateDirectionalReferences(this.presentation, layers, skeleton);
      validateSpriteAnchors({ schemaVersion: 6, ...this.currentCharacterPresentation(),
        images: [], layers, skeleton, presentation: this.presentation },
        this.anchors.keys(), this.targetIds);
      const preview = options.preview === null ? null : (() => {
        if (skeleton === null) throw new SpriteError('Create a skeleton before previewing a pose.');
        return validateSkeletonPreview(options.preview, skeleton);
      })();
      const next = this.buildState(layers, skeleton, new Map(this.images), new Map(this.resources),
        { ...this.currentCharacterPresentation(), mode: 'edit', presentation: this.presentation });
      this.commit(next, { preview });
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  setPreview(preview: SkeletonPreview | null): void {
    this.assertLive();
    if (preview !== null) this.assertMutable();
    try {
      if (preview !== null) {
        this.assertSpritePreview();
        if (this.skeleton === null) throw new SpriteError('Create a skeleton before previewing a pose.');
        preview = validateSkeletonPreview(preview, this.skeleton.definition);
      }
      if (this.skeleton !== null && (this.preview === null || preview === null)) this.skeleton.previewPose = null;
      this.preview = preview;
      this.directionalPreview = null;
      this.previewDirectionPose = null;
      this.refreshScene({ forceVisibility: true });
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  configurePresentation(presentation: DirectionalPresentation | null): void {
    this.assertMutable();
    try {
      const settings = presentation === null ? null : validateDirectionalPresentation(presentation);
      const layers = this.layerData();
      const skeleton = this.skeleton?.definition ?? null;
      validateDirectionalReferences(settings, layers, skeleton);
      validateSpriteAnchors({ schemaVersion: 6, ...this.currentCharacterPresentation(),
        images: [], layers, skeleton, presentation: settings },
        this.anchors.keys(), this.targetIds);
      const next = this.buildState(layers, skeleton, new Map(this.images), new Map(this.resources),
        { ...this.currentCharacterPresentation(), mode: 'edit', presentation: settings });
      this.commit(next, { preview: this.preview });
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  setDirectionalPreview(preview: { readonly aim: RuntimePoint } | null): void {
    this.assertLive();
    if (preview === null && this.directionalPreview === null) return;
    if (preview !== null) {
      this.assertMutable();
      this.assertSpritePreview();
    }
    if (preview !== null && (!Number.isFinite(preview.aim.x) || !Number.isFinite(preview.aim.y))) {
      throw new SpriteError('Directional preview aim must have finite coordinates.');
    }
    if (preview === null) {
      this.directionalPreview = null;
      this.previewDirectionPose = null;
      if (this.skeleton !== null) this.skeleton.previewPose = null;
    } else {
      if (this.directionalPreview === null) {
        this.previewTime = this.lastFrame.time;
        this.previewDirectionPose = new DirectionalPose(this.runtimePresentation());
        this.previewDirectionPose.update({ time: this.previewTime, aim: preview.aim });
        if (this.skeleton !== null) this.skeleton.previewPose = null;
      }
      this.preview = null;
      this.directionalPreview = { aim: point(preview.aim) };
    }
    this.refreshScene({ forceVisibility: true });
  }

  resetPresentation(): void {
    this.assertLive();
    this.directionPose.reset();
    this.preview = null;
    this.directionalPreview = null;
    this.previewDirectionPose = null;
    if (this.skeleton !== null) {
      this.skeleton.pose = new SkeletonPose(this.skeleton.definition);
      this.skeleton.pose.configureRotation(this.runtimePresentation()?.bones ?? EMPTY_BONES);
      this.skeleton.previewPose = null;
    }
  }

  presentationState() {
    const active = this.characterRiggingType === 'sprite-2d';
    const runtime = active ? this.skeleton : null;
    return {
      ...this.displayedPresentation,
      // Automatic tilt is runtime-only, separate from the editor's authored rotation readouts.
      targetRotation: this.presentation === null ? 0 : this.displayedPresentation.targetRotation,
      displayedRotation: this.presentation === null ? 0 : this.displayedPresentation.displayedRotation,
      enabled: active && this.presentation !== null,
      headTracking: this.headTrackingState(),
      preview: this.directionalPreview !== null,
      posePreview: this.preview !== null,
      pivot: !active || this.presentation === null ? null : {
        x: this.presentationPivot.x, y: this.presentationPivot.y, z: this.presentationPivot.z,
      },
      sockets: runtime === null ? [] : runtime.definition.hair.map(chain => {
        const index = runtime.boneIndex.get(chain.bones[0]);
        if (index === undefined) throw new SpriteError(`Missing hair attachment "${chain.bones[0]}".`);
        const bone = runtime.evaluated[index];
        return { id: chain.id, bone: bone.id, x: bone.x + runtime.originWorld.x, y: bone.y + runtime.originWorld.y };
      }),
    };
  }

  headTrackingState() {
    const active = !this.disposed && this.characterRiggingType === 'sprite-2d';
    const plan = this.headTrackingPlan;
    const automatic = active && plan.presentation !== null;
    return {
      status: active ? plan.status : 'inactive',
      reason: active ? plan.reason : 'Sprite head tracking is inactive while sprite rendering is off.',
      layers: plan.layers,
      bones: plan.bones,
      issues: plan.issues,
      targetRotation: automatic ? this.displayedPresentation.targetRotation : 0,
      displayedRotation: automatic ? this.displayedPresentation.displayedRotation : 0,
    };
  }

  update(frame: {
    time: number;
    dt?: number;
    aim: { x: number; y: number };
    targets: ReadonlyMap<string, { x: number; y: number; angle: number }>;
  }): void {
    this.assertLive();
    const dt = frame.dt === undefined ? Math.max(0, frame.time - this.lastFrame.time) : frame.dt;
    if (!Number.isFinite(dt) || dt < 0) throw new SpriteError('Sprite frame duration must be finite and nonnegative.');
    const active = this.characterRiggingType === 'sprite-2d';
    if (active) {
      this.directionPose.update(frame);
      if (this.directionalPreview !== null && this.previewDirectionPose !== null) {
        if (frame.time < this.lastFrame.time) {
          this.previewTime = frame.time;
          this.previewDirectionPose.reset();
          if (this.skeleton !== null) this.skeleton.previewPose = null;
        } else {
          this.previewTime += dt;
        }
        this.previewDirectionPose.update({ time: this.previewTime, aim: this.directionalPreview.aim });
      }
    } else if (!Number.isFinite(frame.time) || !Number.isFinite(frame.aim.x) || !Number.isFinite(frame.aim.y)) {
      throw new SpriteError('Sprite frame time and aim must be finite.');
    }
    this.hasFrame = true;
    this.lastFrame = {
      time: frame.time,
      aim: { x: frame.aim.x, y: frame.aim.y },
      targets: new Map([...frame.targets].map(([name, target]) => [name, { ...target }])),
    };
    if (active) this.refreshScene();
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
    validateDirectionalReferences(this.presentation, nextLayers, this.skeleton?.definition ?? null);
    const next = this.buildState(nextLayers, this.skeleton?.definition ?? null, new Map(this.images), new Map(this.resources),
      { ...this.currentCharacterPresentation(), mode: 'edit', presentation: this.presentation });
    this.commit(next, { preview: this.preview });
  }

  remove(id: string): void {
    this.assertMutable();
    if (!this.layers.has(id)) throw new SpriteError(`Unknown sprite layer "${id}".`);
    const nextLayers = this.layerData().filter(layer => layer.id !== id);
    validateDirectionalReferences(this.presentation, nextLayers, this.skeleton?.definition ?? null);
    const next = this.buildState(nextLayers, this.skeleton?.definition ?? null, new Map(this.images), new Map(this.resources),
      { ...this.currentCharacterPresentation(), mode: 'edit', presentation: this.presentation });
    this.commit(next, { preview: this.preview });
  }

  hasLayers(anchor: string): boolean {
    this.assertLive();
    this.anchor(anchor);
    return (this.attachments.get(anchor)?.count ?? 0) > 0;
  }

  replaces(anchor: string): boolean {
    this.assertLive();
    this.anchor(anchor);
    const covered = this.coverage.get(anchor);
    if (covered === undefined) throw new SpriteError(`Missing coverage state for "${anchor}".`);
    return covered;
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
        flipbookFrame: instance.flipbook?.shown ?? null,
        flipbookImage: instance.flipbook === null ? null : instance.flipbook.definition.images[instance.flipbook.shown]!,
        flipbookFrameChanges: instance.flipbook?.changes ?? null,
      };
    });
    return {
      disposed: this.disposed,
      characterRiggingType: this.characterRiggingType,
      armForwardDistance: this.armForwardDistance,
      shading: this.assets.shading ?? DEFAULT_CHARACTER_SHADING,
      models: (this.assets.models ?? []).map(model => ({ id: model.id, name: model.name })),
      avatarModel: this.assets.avatar === undefined ? null : { model: this.assets.avatar.model, boneMap: { ...this.assets.avatar.boneMap } },
      hammerModel: this.assets.hammer?.model ?? null,
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
      presentation: this.presentationState(),
      headTracking: this.headTrackingState(),
      animation: this.characterRiggingType !== 'sprite-2d' ? null :
        this.preview !== null ? this.preview.clip : this.hasFrame ? this.skeleton?.definition.animation ?? null : null,
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
        clip: this.characterRiggingType !== 'sprite-2d' ? null :
          this.preview !== null ? this.preview.clip : this.hasFrame ? this.skeleton.definition.animation : null,
        constraints: this.characterRiggingType !== 'sprite-2d' ? 'disabled' :
          this.preview !== null ? this.preview.constraints : this.hasFrame ? 'enabled' : 'disabled',
        bones: this.skeleton.evaluated.map(bone => ({ ...bone })),
        skinnedLayers,
      },
    };
  }

  // Cheap per-frame readout of the displayed flipbook frame; null for single-image layers.
  flipbookState(id: string): { frame: number; image: string; frameCount: number; frameChanges: number } | null {
    this.assertLive();
    const instance = this.layers.get(id);
    if (instance === undefined) throw new SpriteError(`Unknown sprite layer "${id}".`);
    const flipbook = instance.flipbook;
    return flipbook === null ? null : {
      frame: flipbook.shown,
      image: flipbook.definition.images[flipbook.shown]!,
      frameCount: flipbook.frames.length,
      frameChanges: flipbook.changes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replacement?.controller.abort(new DOMException('The sprite rig was disposed.', 'AbortError'));
    for (const resource of this.replacement?.staged.values() ?? []) this.releaseResource(resource);
    this.replacement?.staged.clear();
    const previousCoverage = new Map(this.coverage);
    this.detachScene();
    this.disposeLayers(this.layers.values());
    this.layers.clear();
    this.rotatedLayers = [];
    this.flipbooks = [];
    this.directionalPreview = null;
    this.previewDirectionPose = null;
    this.disposeSkeleton(this.skeleton);
    this.skeleton = null;
    for (const resource of this.resources.values()) this.releaseResource(resource);
    this.resources.clear();
    this.images.clear();
    this.geometry.dispose();
    this.attachments.clear();
    this.skeletonMounts.clear();
    this.coverage.clear();
    for (const [name, covered] of previousCoverage) if (covered) this.anchor(name).setCovered({ covered: false });
    this.assets = {};
    this.onCharacterPresentationChange?.({
      characterRiggingType: DEFAULT_CHARACTER_RIGGING_TYPE, armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
    });
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

  private assertSpritePreview(): void {
    if (this.characterRiggingType !== 'sprite-2d') {
      throw new SpriteError('Sprite rendering is off. Choose 2D sprites in Character before previewing a sprite rig.');
    }
  }

  private assertCharacterRenderer(type: CharacterRiggingType): void {
    if (type === 'avatar-3d' && this.onCharacterPresentationChange === undefined) {
      throw new SpriteError('This host has no connected avatar renderer.');
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
      return { bitmap, texture, material, bytes, pixels: bitmap.width * bitmap.height, disposed: false, prepared: false };
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

  private currentCharacterPresentation(): CharacterPresentation {
    return { characterRiggingType: this.characterRiggingType, armForwardDistance: this.armForwardDistance, ...this.assets };
  }

  private buildState(
    layers: readonly SpriteLayer[],
    definition: SkeletonDefinition | null,
    images: Map<string, ImageResource>,
    resources: Map<string, ImageResource>,
    options: CharacterPresentation & { mode: 'replace' | 'edit'; presentation: DirectionalPresentation | null },
  ): BuildState {
    validateCharacterRiggingType(options.characterRiggingType, layers.length);
    validateArmForwardDistance(options.armForwardDistance);
    this.assertCharacterRenderer(options.characterRiggingType);
    const attachments = new Map<string, Attachment>();
    const skeletonMounts = new Map<THREE.Object3D, THREE.Group>();
    const instances = new Map<string, LayerInstance>();
    let skeleton: SkeletonRuntime | null = null;
    try {
      skeleton = options.mode === 'edit' && definition === (this.skeleton?.definition ?? null)
        ? this.skeleton : definition === null ? null : this.createSkeleton(definition);
      for (const data of layers) {
        const image = images.get(data.image);
        if (image === undefined) throw new SpriteError(`Sprite ${data.id} references missing image "${data.image}".`);
        const frames = this.flipbookFrames(data, images);
        const attachment = this.attachment(data.anchor, attachments, options.mode);
        const instance = options.mode === 'edit'
          ? this.createOrReuseLayer(data, image, frames, skeleton) : this.createLayer(data, image, frames, skeleton);
        if (instance.kind === 'legacy') {
          if (instance.mesh.parent !== attachment.group) attachment.group.add(instance.mesh);
          attachment.legacyCount++;
        } else {
          if (skeleton !== null) {
            const mount = this.anchor(data.anchor).renderRoot ?? this.root;
            const group = mount === this.root ? skeleton.group : this.skeletonMount(mount, skeletonMounts, options.mode);
            if (instance.mesh.parent !== group) group.add(instance.mesh);
          }
        }
        attachment.count++;
        instances.set(data.id, instance);
      }
      return { resources, images, layers: instances, attachments, skeletonMounts, skeleton,
        presentation: options.presentation,
        headTracking: compileSpriteHeadTracking(this.headTracking, layers, definition, options.presentation),
        characterRiggingType: options.characterRiggingType, armForwardDistance: options.armForwardDistance, mode: options.mode,
        ...characterAssets(options) };
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
        previewPose: null,
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

  private createOrReuseLayer(
    data: SpriteLayer,
    image: ImageResource,
    frames: readonly ImageResource[] | null,
    skeleton: SkeletonRuntime | null,
  ): LayerInstance {
    const previous = this.layers.get(data.id);
    if (previous !== undefined && previous.data === data && previous.resource === image &&
      this.sameFlipbook(previous.flipbook, data, frames) &&
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
      previous.flipbook = this.reuseFlipbook(previous.flipbook, data, frames);
      previous.mesh.name = data.name;
      // An unchanged flipbook keeps its displayed frame and hysteresis memory across layer edits.
      previous.mesh.material = previous.flipbook === null ? image.material : previous.flipbook.frames[previous.flipbook.shown]!.material;
      previous.localMatrix.copy(this.layerMatrix(data));
      if (previous.kind === 'legacy') previous.mesh.matrix.copy(previous.localMatrix);
      previous.mesh.matrixWorldNeedsUpdate = true;
      if (previous.tile !== null && data.tileLength !== null) {
        previous.tile.tileLength = data.tileLength;
        previous.tile.lastRepeat = NaN;
      }
      return previous;
    }
    return this.createLayer(data, image, frames, skeleton);
  }

  private createLayer(
    data: SpriteLayer,
    image: ImageResource,
    frames: readonly ImageResource[] | null,
    skeleton: SkeletonRuntime | null,
  ): LayerInstance {
    const mask = directionMask(data.directions);
    if (data.skin !== null) {
      if (skeleton === null) throw new SpriteError(`Sprite "${data.name}" requires a skeleton.`);
      if (frames !== null) throw new SpriteError(`Flipbook "${data.name}" cannot be a weighted mesh.`);
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
        flipbook: null,
        bindMatrix,
      };
    }
    const tile = data.tileLength === null ? null : this.createTileRuntime(data.tileLength);
    const flipbook = this.reuseFlipbook(null, data, frames);
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
        flipbook,
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
      flipbook,
      localMatrix,
    };
  }

  // Frame 0 is the layer image, so a new flipbook starts on the image material the mesh already uses.
  private flipbookFrames(data: SpriteLayer, images: ReadonlyMap<string, ImageResource>): readonly ImageResource[] | null {
    if (data.flipbook === undefined) return null;
    const frames = data.flipbook.images.map(id => {
      const frame = images.get(id);
      if (frame === undefined) throw new SpriteError(`Sprite ${data.id} flipbook references unloaded image "${id}".`);
      return frame;
    });
    const first = frames[0]!.bitmap;
    for (const [index, frame] of frames.entries()) {
      if (frame.bitmap.width === first.width && frame.bitmap.height === first.height) continue;
      throw new SpriteError(flipbookSizeMessage(data.name,
        { id: data.flipbook.images[index]!, width: frame.bitmap.width, height: frame.bitmap.height },
        { id: data.flipbook.images[0]!, width: first.width, height: first.height }));
    }
    return frames;
  }

  // Returns the existing runtime when the definition and frame resources are unchanged, otherwise a fresh one.
  private reuseFlipbook(
    previous: FlipbookRuntime | null,
    data: SpriteLayer,
    frames: readonly ImageResource[] | null,
  ): FlipbookRuntime | null {
    const definition = data.flipbook;
    if (definition === undefined || frames === null) return null;
    if (this.sameFlipbook(previous, data, frames)) return previous;
    const track = (): FlipbookTrack => ({ frame: null, pose: null, epoch: 0 });
    return { definition, frames, live: track(), preview: track(), shown: 0, changes: 0 };
  }

  private sameFlipbook(previous: FlipbookRuntime | null, data: SpriteLayer, frames: readonly ImageResource[] | null): boolean {
    const definition = data.flipbook;
    if (previous === null || definition === undefined || frames === null) {
      return previous === null && (definition === undefined || frames === null);
    }
    return previous.definition.startAngle === definition.startAngle &&
      previous.definition.hysteresis === definition.hysteresis &&
      previous.frames.length === frames.length &&
      previous.frames.every((frame, index) => frame === frames[index] &&
        previous.definition.images[index] === definition.images[index]);
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
      };
      attachments.set(name, attachment);
    }
    return attachment;
  }

  private skeletonMount(
    root: THREE.Object3D,
    mounts: Map<THREE.Object3D, THREE.Group>,
    mode: 'replace' | 'edit',
  ): THREE.Group {
    let group = mounts.get(root);
    if (group === undefined) {
      group = mode === 'edit' ? this.skeletonMounts.get(root) ?? new THREE.Group() : new THREE.Group();
      group.name = 'sprites:skeleton-render-mount';
      group.matrixAutoUpdate = false;
      mounts.set(root, group);
    }
    return group;
  }

  private commit(next: BuildState, options: { preview: SkeletonPreview | null }): void {
    const oldResources = this.resources;
    const oldLayers = this.layers;
    const oldSkeleton = this.skeleton;
    const changedType = next.characterRiggingType !== this.characterRiggingType;
    const nextAssets = characterAssets(next);
    const changedAssets = nextAssets.models !== this.assets.models || nextAssets.avatar !== this.assets.avatar ||
      nextAssets.hammer !== this.assets.hammer || nextAssets.shading !== this.assets.shading;
    const changedCharacter = changedType || next.armForwardDistance !== this.armForwardDistance || changedAssets;
    const presentation = next.presentation ?? next.headTracking.presentation;
    const resetDirection = changedType || next.mode === 'replace' || presentation !== this.runtimePresentation();
    const previousCoverage = new Map(this.coverage);
    const retained = new Set(next.layers.values());
    for (const instance of this.rotatedLayers) {
      instance.mesh.matrix.copy(instance.localMatrix);
      instance.mesh.matrixWorldNeedsUpdate = true;
    }
    this.detachScene();
    for (const layer of oldLayers.values()) if (!retained.has(layer)) layer.mesh.removeFromParent();
    this.resources = next.resources;
    this.images = next.images;
    this.layers = next.layers;
    this.attachments = next.attachments;
    this.skeletonMounts = next.skeletonMounts;
    this.skeleton = next.skeleton;
    this.presentation = next.presentation;
    this.headTrackingPlan = next.headTracking;
    this.characterRiggingType = next.characterRiggingType;
    this.armForwardDistance = next.armForwardDistance;
    this.assets = nextAssets;
    if (changedType && next.mode === 'edit') this.resetPresentation();
    this.preview = options.preview;
    if (changedType || next.mode === 'replace' || this.preview !== null) {
      this.directionalPreview = null;
      this.previewDirectionPose = null;
    }
    if (resetDirection) {
      this.directionPose = new DirectionalPose(presentation);
      if (this.hasFrame) this.directionPose.update(this.lastFrame);
      if (this.directionalPreview !== null) {
        this.previewDirectionPose = new DirectionalPose(presentation);
        this.previewDirectionPose.update({ time: this.previewTime, aim: this.directionalPreview.aim });
      }
    }
    const rotationBones = presentation === null ? EMPTY_BONES : presentation.bones;
    this.skeleton?.pose.configureRotation(rotationBones);
    this.skeleton?.previewPose?.configureRotation(rotationBones);
    this.rotatedLayers = presentation === null ? [] : presentation.layers.map(id => {
      const instance = this.layers.get(id);
      if (instance === undefined || instance.kind !== 'legacy') {
        throw new SpriteError(`Directional layer "${id}" must be an unbound rigid layer.`);
      }
      return instance;
    });
    this.flipbooks = [...this.layers.values()].filter((instance): instance is FlipbookLayerInstance => instance.flipbook !== null);
    for (const instance of this.layers.values()) {
      if (instance.tile !== null && instance.resource.texture.wrapS !== THREE.RepeatWrapping) {
        instance.resource.texture.wrapS = THREE.RepeatWrapping;
        instance.resource.texture.needsUpdate = true;
      }
    }
    this.attachScene();
    this.refreshScene({ forceVisibility: true, notifyCoverage: false });
    for (const [name, covered] of this.coverage) {
      if (previousCoverage.get(name) !== covered) this.anchor(name).setCovered({ covered });
    }
    if (changedCharacter) this.onCharacterPresentationChange?.(this.currentCharacterPresentation());
    for (const layer of oldLayers.values()) if (!retained.has(layer)) this.disposeLayer(layer);
    if (oldSkeleton !== this.skeleton) this.disposeSkeleton(oldSkeleton);
    for (const [source, resource] of oldResources) {
      if (!this.resources.has(source)) this.releaseResource(resource);
    }
    this.prepareFlipbookTextures();
  }

  private detachScene(): void {
    for (const attachment of this.attachments.values()) attachment.group.removeFromParent();
    this.skeleton?.group.removeFromParent();
    for (const group of this.skeletonMounts.values()) group.removeFromParent();
  }

  private attachScene(): void {
    if (this.characterRiggingType !== 'sprite-2d') return;
    for (const [name, attachment] of this.attachments) {
      if (attachment.legacyCount > 0) this.anchor(name).node.add(attachment.group);
      else attachment.group.removeFromParent();
    }
    if (this.skeleton !== null) this.root.add(this.skeleton.group);
    for (const [root, group] of this.skeletonMounts) root.add(group);
  }

  private refreshScene(options: { forceVisibility?: boolean; notifyCoverage?: boolean } = {}): void {
    this.displayedPresentation = this.activePresentation();
    const direction = this.displayedPresentation.direction;
    const changedDirection = direction !== this.currentDirection;
    if (changedDirection) this.currentDirection = direction;
    if (options.forceVisibility || changedDirection) this.applyDirection(direction, options.notifyCoverage !== false);
    if (this.characterRiggingType !== 'sprite-2d') return;
    this.updateFlipbooks();
    const presentation = this.runtimePresentation();
    if (presentation !== null && (this.presentation !== null || this.rotatedLayers.length > 0)) {
      const { pivot } = presentation;
      const anchor = this.anchor(pivot.anchor).node;
      anchor.updateWorldMatrix(true, false);
      this.presentationPivot.set(pivot.x, pivot.y, 0).applyMatrix4(anchor.matrixWorld);
    }
    if (this.skeleton !== null) {
      this.updateSkeletonRoot(this.skeleton);
      this.evaluateSkeleton(this.skeleton);
      this.updateBoneAttachments(this.skeleton);
      this.skeleton.group.updateWorldMatrix(true, true);
      for (const group of this.skeletonMounts.values()) group.updateWorldMatrix(true, true);
    }
    this.rotateLayers();
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

  private activePresentation(): Readonly<DirectionalFrame> {
    if (this.preview !== null) {
      const index = directionIndex(this.preview.direction);
      return {
        direction: this.preview.direction,
        aimAngle: this.presentation === null ? index * DIRECTION_STEP_DEGREES : this.presentation.directions[index].neutralAngle,
        targetRotation: 0, displayedRotation: 0,
      };
    }
    if (this.directionalPreview !== null) {
      if (this.previewDirectionPose === null) throw new SpriteError('Directional preview is missing its presentation state.');
      return this.previewDirectionPose.snapshot();
    }
    return this.directionPose.snapshot();
  }

  private runtimePresentation(): DirectionalPresentation | null {
    return this.presentation ?? this.headTrackingPlan.presentation;
  }

  // Per-frame cost is constant per flipbook layer, independent of its frame count. The live
  // timeline keeps running under previews, so leaving a preview shows its current frame.
  private updateFlipbooks(): void {
    if (this.flipbooks.length === 0) return;
    const live = this.directionPose;
    const liveAngle = live.snapshot().aimAngle;
    const previewing = this.preview !== null || this.directionalPreview !== null;
    // A pose preview has no preview clock; its fixed aim always selects directly.
    const previewPose = this.preview === null ? this.previewDirectionPose : null;
    for (const instance of this.flipbooks) {
      const flipbook = instance.flipbook;
      const liveFrame = this.selectFlipbookTrack(flipbook, flipbook.live, live, liveAngle);
      const frame = previewing
        ? this.selectFlipbookTrack(flipbook, flipbook.preview, previewPose, this.displayedPresentation.aimAngle)
        : liveFrame;
      if (!previewing && flipbook.preview.pose !== null) {
        flipbook.preview.frame = null;
        flipbook.preview.pose = null;
      }
      if (frame === flipbook.shown) continue;
      flipbook.shown = frame;
      flipbook.changes += 1;
      instance.mesh.material = flipbook.frames[frame]!.material;
    }
  }

  private selectFlipbookTrack(
    flipbook: FlipbookRuntime,
    track: FlipbookTrack,
    pose: DirectionalPose | null,
    aimAngle: number,
  ): number {
    const continuing = track.frame !== null && pose !== null && track.pose === pose && track.epoch === pose.epoch;
    track.frame = selectFlipbookFrame(flipbook.definition, aimAngle, continuing ? track.frame : null);
    track.pose = pose;
    track.epoch = pose === null ? 0 : pose.epoch;
    return track.frame;
  }

  private prepareFlipbookTextures(): void {
    if (this.prepareTexture === undefined || this.characterRiggingType !== 'sprite-2d') return;
    for (const instance of this.flipbooks) {
      for (const frame of instance.flipbook.frames) {
        if (frame.prepared) continue;
        frame.prepared = true;
        this.prepareTexture(frame.texture);
      }
    }
  }

  private rotateLayers(): void {
    if (this.rotatedLayers.length === 0) return;
    const angle = THREE.MathUtils.degToRad(this.displayedPresentation.displayedRotation);
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const { x, y } = this.presentationPivot;
    this.presentationMatrix.makeRotationZ(angle).setPosition(x - cosine * x + sine * y, y - sine * x - cosine * y, 0);
    for (const instance of this.rotatedLayers) {
      if (!instance.visible) continue;
      if (angle === 0) {
        this.tempMatrixA.copy(instance.localMatrix);
      } else {
        const parent = instance.mesh.parent;
        if (parent === null) throw new SpriteError(`Directional layer "${instance.data.name}" is not attached.`);
        parent.updateWorldMatrix(true, false);
        const determinant = parent.matrixWorld.determinant();
        if (!Number.isFinite(determinant) || determinant === 0) {
          throw new SpriteError(`Directional layer "${instance.data.name}" needs an invertible anchor transform.`);
        }
        this.tempMatrixA.copy(parent.matrixWorld).invert();
        this.tempMatrixB.multiplyMatrices(this.presentationMatrix, parent.matrixWorld);
        this.tempMatrixA.multiply(this.tempMatrixB).multiply(instance.localMatrix);
      }
      if (!instance.mesh.matrix.equals(this.tempMatrixA)) {
        instance.mesh.matrix.copy(this.tempMatrixA);
        instance.mesh.matrixWorldNeedsUpdate = true;
      }
    }
  }

  private applyDirection(direction: FacingDirection, notifyCoverage: boolean): void {
    const index = directionIndex(direction);
    for (const instance of this.layers.values()) {
      const visible = this.characterRiggingType === 'sprite-2d' && (instance.directionMask & (1 << index)) !== 0;
      if (visible === instance.visible) continue;
      instance.visible = visible;
      instance.mesh.visible = visible;
    }
    for (const [name, anchor] of this.anchors) {
      const covered = this.characterRiggingType === 'sprite-2d';
      if (this.coverage.get(name) === covered) continue;
      this.coverage.set(name, covered);
      if (notifyCoverage) anchor.setCovered({ covered });
    }
  }

  private updateSkeletonRoot(runtime: SkeletonRuntime): void {
    const host = this.anchor(runtime.definition.anchor).node;
    host.getWorldPosition(this.tempWorld);
    runtime.originWorld = { x: this.tempWorld.x, y: this.tempWorld.y };
    this.positionSkeletonMount(runtime.group, this.root, this.tempWorld);
    for (const [root, group] of this.skeletonMounts) this.positionSkeletonMount(group, root, this.tempWorld);
  }

  private positionSkeletonMount(group: THREE.Group, root: THREE.Object3D, origin: THREE.Vector3): void {
    root.updateWorldMatrix(true, false);
    const determinant = root.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) throw new SpriteError('The sprite render mount needs an invertible world transform.');
    this.tempMatrixA.copy(root.matrixWorld).invert();
    this.tempMatrixB.makeTranslation(origin.x, origin.y, origin.z);
    group.matrix.multiplyMatrices(this.tempMatrixA, this.tempMatrixB);
    group.matrixWorldNeedsUpdate = true;
  }

  private skeletonRotation(runtime: SkeletonRuntime, frame: Readonly<DirectionalFrame>): SkeletonRotation | null {
    const presentation = this.runtimePresentation();
    if (presentation === null || !presentation.rotation || presentation.bones.length === 0) return null;
    return {
      pivot: this.presentation === null ? 'bone-origin' : {
        x: this.presentationPivot.x - runtime.originWorld.x, y: this.presentationPivot.y - runtime.originWorld.y,
      },
      angle: THREE.MathUtils.degToRad(frame.displayedRotation),
    };
  }

  private evaluateSkeleton(runtime: SkeletonRuntime): void {
    try {
      const live = this.directionPose.snapshot();
      const constraints: 'enabled' | 'disabled' = this.hasFrame ? 'enabled' : 'disabled';
      const input = {
        time: this.lastFrame.time,
        origin: runtime.originWorld,
        direction: live.direction,
        targets: this.hasFrame ? this.rigTargets(runtime.originWorld) : EMPTY_TARGETS,
        clip: this.hasFrame ? runtime.definition.animation : null,
        pose: EMPTY_POSE,
        constraints,
        rotation: this.skeletonRotation(runtime, live),
      };
      // Keep the live braid running independently while an editor preview owns the displayed pose.
      let bones = runtime.pose.evaluate(input);
      if (this.preview !== null || this.directionalPreview !== null) {
        if (runtime.previewPose === null) {
          runtime.previewPose = runtime.pose.fork();
        }
        bones = runtime.previewPose.evaluate({
          ...input,
          time: this.preview === null ? this.previewTime : this.preview.time,
          direction: this.displayedPresentation.direction,
          clip: this.preview === null ? input.clip : this.preview.clip,
          pose: this.preview === null ? EMPTY_POSE : this.preview.pose,
          constraints: this.preview === null ? constraints : this.preview.constraints,
          rotation: this.skeletonRotation(runtime, this.displayedPresentation),
        });
      }
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
    if (error instanceof DirectionalError) return new SpriteError(error.message, { cause: error });
    throw error;
  }
}
