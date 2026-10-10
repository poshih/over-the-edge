import * as THREE from 'three';
import {
  embeddedPng,
  flipbookSizeMessage,
  inspectPng,
  DEFAULT_CHARACTER_RIGGING_TYPE,
  SPRITE_LIMITS,
  SPRITE_SCHEMA_VERSION,
  SpriteError,
  validateArmForwardDistance,
  validateCharacterRiggingType,
  validateWaistLean,
  validateDirectionalReferences,
  validateArms,
  validateGrips,
  validateSpriteAnchors,
  validateSpriteLayer,
  validateSpriteMetadata,
  validateSpriteRigging,
} from './sprite-data';
import type { CharacterPresentation, CharacterRiggingType, SpriteDocument, SpriteFlipbook, SpriteLayer } from './sprite-data';
import { DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth';
import { DEFAULT_WAIST_LEAN } from './waist-lean';
import type { ArmSide } from './character';
import { sameArms } from './character-arms';
import type { ArmLengths, CharacterArms } from './character-arms';
import { DEFAULT_GRIPS, sameGrips } from './grips';
import type { Grips } from './grips';
import { characterAssets } from './character-profile';
import type { CharacterAssets } from './character-profile';
import { sameAvatarMotion, validateAvatarMotion } from './avatar-motion-data';
import type { AvatarMotionEntry } from './avatar-motion-data';
import { DirectionalError, sameDirectionalPresentation, validateDirectionalPresentation } from './directional-data';
import type { DirectionalPresentation } from './directional-data';
import { DirectionalPose } from './directional-pose';
import type { DirectionalFrame, MutableDirectionalFrame } from './directional-pose';
import { FACING_DIRECTIONS, SkeletonError, validateSkeleton, validateSkeletonPreview } from './skeleton-data';
import type { FacingDirection, SkeletonDefinition, SkeletonPreview } from './skeleton-data';
import { SkeletonPose, restPose } from './skeleton-pose';
import type { RigPoint as RuntimePoint, RigTarget as RuntimeTarget, BoneWorld as RuntimeBoneWorld, MutableBoneWorld, SkeletonRotation } from './skeleton-pose';
import { compileSpriteHeadTracking } from './sprite-head-aim';
import type { SpriteHeadTracking, SpriteHeadTrackingPlan } from './sprite-head-aim';
import { selectFlipbookFrame } from './sprite-flipbook';
import { isContentRef } from './content-ref';
import type { ContentLoader } from './content-ref';
import type { HeldSkeletonFrame } from './skeleton-pose';

// How a host names one arm: the IK target its hand follows, and the anchors depicting its two segments.
export interface SpriteArmSlots {
  readonly target: string;
  readonly upper: string;
  readonly forearm: string;
}

export interface SpriteAnchor {
  readonly node: THREE.Object3D;
  readonly renderRoot?: THREE.Object3D;
  readonly setCovered: (options: { covered: boolean }) => void;
}

// The host's lease on the models it prepared. The rig releases it once the replacement commits or
// fails, so a refused or superseded preparation holds no model past its own operation.
export interface CharacterAssetLease {
  release(): void;
}

// Loads and validates a profile's character models before the rig commits it, so failures
// leave the previous presentation untouched. Hosts without one reject documents with models.
export interface CharacterAssetHost {
  prepare(document: SpriteDocument, signal: AbortSignal): Promise<CharacterAssetLease>;
}

// A whole document staged off screen. Until it commits, showing it at once, or cancels, letting go of what it staged,
// the rig refuses other changes.
export interface PreparedSpriteReplacement {
  // Throws the rig's SpriteError, or the cancellation once its signal aborted or the rig was disposed, showing nothing.
  commit(): void;
  cancel(): void;
}

interface ImageResource {
  readonly bitmap: ImageBitmap;
  readonly texture: THREE.Texture;
  readonly material: THREE.MeshBasicMaterial;
  readonly colour: THREE.Color;
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
  previewFresh: boolean;
  readonly group: THREE.Group;
  readonly bones: readonly THREE.Bone[];
  readonly boneIndex: ReadonlyMap<string, number>;
  readonly skeleton: THREE.Skeleton;
  evaluated: readonly RuntimeBoneWorld[];
  readonly originWorld: { x: number; y: number };
  readonly liveInput: SkeletonInput;
  readonly previewInput: SkeletonInput;
  readonly liveOutput: readonly MutableBoneWorld[];
  readonly previewOutput: readonly MutableBoneWorld[];
  readonly liveRotation: MutableSkeletonRotation;
  readonly previewRotation: MutableSkeletonRotation;
  readonly livePivot: { x: number; y: number };
  readonly previewPivot: { x: number; y: number };
}

type SkeletonInput = Parameters<SkeletonPose['evaluate']>[0];
type MutableSkeletonRotation = { -readonly [K in keyof SkeletonRotation]: SkeletonRotation[K] };
interface PooledFrameTarget { x: number; y: number; angle: number; used: boolean }

interface BuildState extends CharacterPresentation {
  readonly resources: Map<string, ImageResource>;
  readonly images: Map<string, ImageResource>;
  readonly layers: Map<string, LayerInstance>;
  readonly attachments: Map<string, Attachment>;
  readonly skeletonMounts: Map<THREE.Object3D, THREE.Group>;
  readonly skeleton: SkeletonRuntime | null;
  readonly presentation: DirectionalPresentation | null;
  readonly headTracking: SpriteHeadTrackingPlan;
  // The host's prepared commit for this presentation, or undefined when nothing character-related
  // changed. Built before any allocation and invoked at the old notification point.
  readonly commitPresentation: (() => void) | undefined;
  readonly mode: 'replace' | 'edit';
}

const ALPHA_CUTOFF = 0.5;
const TILE_EPSILON = 1e-6;
const EMPTY_POSE: SkeletonPreview['pose'] = Object.freeze([]);
const EMPTY_BONES: readonly string[] = Object.freeze([]);
const EMPTY_TARGETS = new Map<string, RuntimeTarget>();
const EMPTY_REFRESH = Object.freeze({});
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
  // The host's preflight: runs the pure preparation a presentation needs and returns the commit that
  // installs it. Called before any committed presentation or scene mutation, once per changed
  // presentation, so a strategy refusal leaves the previous presentation untouched.
  private readonly prepareCharacterPresentation: ((settings: CharacterPresentation) => () => void) | undefined;
  private readonly prepareTexture: ((texture: THREE.Texture) => void) | undefined;
  private readonly headTracking: SpriteHeadTracking | null;
  private headTrackingPlan: SpriteHeadTrackingPlan;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly coverage = new Map<string, boolean>();
  private characterRiggingType: CharacterRiggingType = DEFAULT_CHARACTER_RIGGING_TYPE;
  private armForwardDistance: number = DEFAULT_ARM_FORWARD_DISTANCE;
  private waistLean: number = DEFAULT_WAIST_LEAN;
  private grips: Grips = DEFAULT_GRIPS;
  private arms: CharacterArms | null = null;
  // How this host names each arm, so the character's arm lengths reach its 2D arm chains.
  private readonly armSlots: Readonly<Record<ArmSide, SpriteArmSlots>> | null;
  private readonly onNaturalArmsChange: (() => void) | undefined;
  // Stretched arm bones and the anchor whose artwork depicts each; other art on them keeps its size.
  private segmentAnchors: ReadonlyMap<string, string> = new Map();
  // Each hand's authored 2D arm chain lengths, kept current with the skeleton.
  private naturalArms: Readonly<Record<ArmSide, ArmLengths | null>> = Object.freeze({ left: null, right: null });
  private assets: CharacterAssets = {};
  private readonly assetHost: CharacterAssetHost | undefined;
  private readonly loadContent: ContentLoader | undefined;
  private images = new Map<string, ImageResource>();
  private resources = new Map<string, ImageResource>();
  private layers = new Map<string, LayerInstance>();
  private layerEntries: readonly LayerInstance[] = [];
  private boneLayers: readonly BoneLayerInstance[] = [];
  private tiledLayers: readonly TiledLayerInstance[] = [];
  private attachments = new Map<string, Attachment>();
  private attachmentEntries: readonly Attachment[] = [];
  private skeletonMounts = new Map<THREE.Object3D, THREE.Group>();
  private skeletonMountEntries: readonly { readonly root: THREE.Object3D; readonly group: THREE.Group }[] = [];
  private materialResources: readonly ImageResource[] = [];
  private skeleton: SkeletonRuntime | null = null;
  private preview: SkeletonPreview | null = null;
  private presentation: DirectionalPresentation | null = null;
  private directionPose = new DirectionalPose(null);
  private previewDirectionPose: DirectionalPose | null = null;
  private directionalPreview: { readonly aim: RuntimePoint } | null = null;
  private previewTime = 0;
  private rotatedLayers: readonly LegacyLayerInstance[] = [];
  private flipbooks: readonly FlipbookLayerInstance[] = [];
  private readonly liveDirectionFrame: MutableDirectionalFrame = { direction: 'right', aimAngle: 0, targetRotation: 0, displayedRotation: 0 };
  private readonly previewDirectionFrame: MutableDirectionalFrame = { direction: 'right', aimAngle: 0, targetRotation: 0, displayedRotation: 0 };
  private readonly displayedPresentation: MutableDirectionalFrame = { direction: 'right', aimAngle: 0, targetRotation: 0, displayedRotation: 0 };
  private readonly previewDirectionInput = { time: 0, aim: { x: 0, y: 0 } as RuntimePoint };
  private replacement: Replacement | null = null;
  private disposed = false;
  private pendingDecodes = 0;
  private texturesCreated = 0;
  private texturesDisposed = 0;
  private currentDirection: FacingDirection = 'right';
  private dying = false;
  private deathHeadBones: readonly string[] = EMPTY_BONES;
  private deathSkeletonPose: SkeletonPose | null = null;
  private evaluatedBasePose: SkeletonPose | null = null;
  private deathPreview: SkeletonPreview | null = null;
  private deathDirectionalPreview: { readonly aim: RuntimePoint } | null = null;
  private readonly deathTargets = new Map<string, { x: number; y: number; angle: number }>();
  private readonly deathFrameTargets = new Map<string, { x: number; y: number; angle: number; used: boolean }>();
  private readonly heldFrame: { -readonly [K in keyof HeldSkeletonFrame]: HeldSkeletonFrame[K] } = {
    targets: this.deathTargets, rootAngle: 0,
  };
  private deathBrightness = 1;
  private hasFrame = false;
  private readonly liveTargets = new Map<string, RuntimeTarget>();
  private readonly frameTargetPool = new Map<string, PooledFrameTarget>();
  private readonly frameTargetEntries: { readonly name: string; readonly target: PooledFrameTarget }[] = [];
  private readonly targetPool = new Map<string, { x: number; y: number; angle: number }>();
  private readonly translatedTargets = new Map<string, RuntimeTarget>();
  private readonly anchorTargetEntries: {
    readonly name: string; readonly node: THREE.Object3D; readonly target: { x: number; y: number; angle: number };
    readonly death: { x: number; y: number; angle: number };
    readonly setCovered: SpriteAnchor['setCovered'];
  }[] = [];
  private readonly deathTargetEntries: {
    readonly source: PooledFrameTarget; readonly target: { x: number; y: number; angle: number };
  }[] = [];
  private readonly nonAnchorTargets: string[] = [];
  private targetOrigin: RuntimePoint = { x: 0, y: 0 };
  private readonly copyLiveTarget = (target: RuntimeTarget, name: string): void => {
    const out = this.frameTargetPool.get(name);
    if (out === undefined) throw new SpriteError(`Unknown sprite target "${name}".`);
    out.x = target.x; out.y = target.y; out.angle = target.angle; out.used = true;
    if (!this.liveTargets.has(name)) this.liveTargets.set(name, out);
  };
  private readonly copyDeathTarget = (target: RuntimeTarget, name: string): void => {
    const out = this.deathFrameTargets.get(name);
    if (out === undefined) throw new SpriteError(`Unknown death target "${name}".`);
    out.x = target.x; out.y = target.y; out.angle = target.angle; out.used = true;
  };
  private readonly translateTarget = (target: RuntimeTarget, name: string): void => {
    if ('used' in target && !target.used) return;
    const out = this.targetPool.get(name);
    if (out === undefined) throw new SpriteError(`Unknown sprite target "${name}".`);
    out.x = target.x - this.targetOrigin.x; out.y = target.y - this.targetOrigin.y; out.angle = target.angle;
    if (!this.translatedTargets.has(name)) this.translatedTargets.set(name, out);
  };
  private readonly lastFrame = {
    time: 0,
    aim: { x: 1, y: 0 },
    targets: this.liveTargets as ReadonlyMap<string, RuntimeTarget>,
  };

  private readonly tempMatrixA = new THREE.Matrix4();
  private readonly tempMatrixB = new THREE.Matrix4();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempScale = new THREE.Vector3();
  private readonly boneStretch = new THREE.Vector3(1, 1, 1);
  private readonly tempWorld = new THREE.Vector3();
  private readonly tempWorldB = new THREE.Vector3();
  private readonly tempWorldC = new THREE.Vector3();
  private readonly presentationPivot = new THREE.Vector3();
  private readonly presentationMatrix = new THREE.Matrix4();

  constructor(anchors: ReadonlyMap<string, SpriteAnchor>, options: {
    root: THREE.Object3D;
    targetIds: readonly string[];
    prepareCharacterPresentation?: (settings: CharacterPresentation) => () => void;
    headTracking?: SpriteHeadTracking;
    // Uploads a texture ahead of first use, so flipbook frame changes never upload during play.
    prepareTexture?: (texture: THREE.Texture) => void;
    characterAssets?: CharacterAssetHost;
    // Loads a release's packaged images (content: sources); hosts without one reject them.
    loadContent?: ContentLoader;
    armSlots?: Readonly<Record<ArmSide, SpriteArmSlots>>;
    onNaturalArmsChange?: () => void;
  }) {
    this.anchors = new Map(anchors);
    for (const name of this.anchors.keys()) this.coverage.set(name, false);
    this.root = options.root;
    this.targetIds = new Set(options.targetIds);
    for (const name of this.anchors.keys()) this.deathTargets.set(name, { x: 0, y: 0, angle: 0 });
    for (const name of this.targetIds) {
      if (!this.deathTargets.has(name)) this.deathTargets.set(name, { x: 0, y: 0, angle: 0 });
      const source = { x: 0, y: 0, angle: 0, used: false };
      this.deathFrameTargets.set(name, source);
      this.deathTargetEntries.push({ source, target: this.deathTargets.get(name)! });
      const target = { x: 0, y: 0, angle: 0, used: false };
      this.frameTargetPool.set(name, target);
      this.frameTargetEntries.push({ name, target });
      this.targetPool.set(name, { x: 0, y: 0, angle: 0 });
      if (!this.anchors.has(name)) this.nonAnchorTargets.push(name);
    }
    for (const [name, anchor] of this.anchors) {
      let target = this.targetPool.get(name);
      if (target === undefined) {
        target = { x: 0, y: 0, angle: 0 };
        this.targetPool.set(name, target);
      }
      this.translatedTargets.set(name, target);
      this.anchorTargetEntries.push({ name, node: anchor.node, target, death: this.deathTargets.get(name)!, setCovered: anchor.setCovered });
    }
    this.prepareCharacterPresentation = options.prepareCharacterPresentation;
    this.onNaturalArmsChange = options.onNaturalArmsChange;
    this.armSlots = options.armSlots === undefined ? null : Object.freeze({
      left: Object.freeze({ ...options.armSlots.left }), right: Object.freeze({ ...options.armSlots.right }),
    });
    for (const slots of Object.values(this.armSlots ?? {})) {
      if (!this.targetIds.has(slots.target)) throw new SpriteError(`Unknown arm IK target "${slots.target}".`);
      for (const anchor of [slots.upper, slots.forearm]) this.anchor(anchor);
    }
    this.prepareTexture = options.prepareTexture;
    this.assetHost = options.characterAssets;
    this.loadContent = options.loadContent;
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
    (await this.prepareReplacement(document, options)).commit();
  }

  // Loads a whole document's models and decodes its images without showing it.
  async prepareReplacement(document: SpriteDocument, options: { readonly signal: AbortSignal }): Promise<PreparedSpriteReplacement> {
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
    let assetLease: CharacterAssetLease | null = null;
    // Lets go of what the replacement holds once it commits or fails, so the rig takes other changes again.
    const release = (): void => {
      options.signal.removeEventListener('abort', abort);
      assetLease?.release();
      for (const resource of operation.staged.values()) this.releaseResource(resource);
      operation.staged.clear();
      if (this.replacement === operation) this.replacement = null;
    };
    try {
      if (document.models !== undefined) {
        assetLease = await this.assetHost!.prepare(document, signal);
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
            const png = embedded !== null ? embedded
              : isContentRef(image.source) ? await this.packagedPng(image.source, signal)
                : await downloadPng(image.source, signal, remainingBytes);
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
    } catch (error) {
      release();
      throw error;
    }
    let ended = false;
    return {
      // Built only now, against the character's presentation as it stands, so nothing staged pairs with a presentation
      // that moved meanwhile; shown in the same call.
      commit: () => {
        if (ended) throw new Error('The sprite replacement has already ended.');
        ended = true;
        try {
          checkSignal(signal);
          const next = this.buildState(document.layers, document.skeleton, images, resources,
            { mode: 'replace', presentation: document.presentation, characterRiggingType: document.characterRiggingType,
              armForwardDistance: document.armForwardDistance, waistLean: document.waistLean, grips: document.grips, arms: document.arms,
              ...characterAssets(document) });
          operation.staged.clear();
          this.commit(next, { preview: null });
        } finally {
          release();
        }
      },
      cancel: () => {
        if (ended) return;
        ended = true;
        release();
      },
    };
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
    const commit = this.prepareCharacterPresentation?.({ ...this.currentCharacterPresentation(), armForwardDistance: distance });
    this.armForwardDistance = distance;
    commit?.();
    if (this.dying) this.refreshCommittedScene();
  }

  setWaistLean(value: number): void {
    this.assertMutable();
    const lean = validateWaistLean(value);
    if (lean === this.waistLean) return;
    const commit = this.prepareCharacterPresentation?.({ ...this.currentCharacterPresentation(), waistLean: lean });
    this.waistLean = lean;
    commit?.();
    if (this.dying) this.refreshCommittedScene();
  }

  setGrips(value: Grips): void {
    this.assertMutable();
    const grips = validateGrips(value);
    if (sameGrips(grips, this.grips)) return;
    const commit = this.prepareCharacterPresentation?.({ ...this.currentCharacterPresentation(), grips });
    this.grips = grips;
    commit?.();
    if (this.dying) this.refreshCommittedScene();
  }

  // Stretches the 2D arm chains and informs the host, which sizes its 3D arms; nothing reloads.
  setArms(value: CharacterArms | null): void {
    this.assertMutable();
    const arms = validateArms(value);
    if (sameArms(arms, this.arms)) return;
    const commit = this.prepareCharacterPresentation?.({ ...this.currentCharacterPresentation(), arms });
    this.arms = arms;
    this.applyArmLengths(this.skeleton);
    commit?.();
    if (this.dying) this.refreshCommittedScene();
  }

  // Each hand's authored 2D arm chain lengths, or null for a hand without one; nothing is allocated.
  naturalArmLengths(): Readonly<Record<ArmSide, ArmLengths | null>> {
    return this.naturalArms;
  }

  // Replaces the imported avatar's motions without reloading anything. The host prepares them against the model first,
  // so a kind's refusal leaves the motions that were running.
  setAvatarMotion(value: readonly AvatarMotionEntry[]): void {
    this.assertMutable();
    const avatar = this.assets.avatar;
    if (avatar === undefined) throw new SpriteError('Import a skinned avatar GLB before configuring its motions.');
    const motion = validateAvatarMotion(value);
    if (sameAvatarMotion(motion, avatar.motion)) return;
    const next = Object.freeze({ ...avatar, motion });
    const commit = this.prepareCharacterPresentation?.({ ...this.currentCharacterPresentation(), avatar: next });
    this.assets = characterAssets({ ...this.assets, avatar: next });
    commit?.();
    if (this.dying) this.refreshCommittedScene();
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
      validateSpriteAnchors({ schemaVersion: SPRITE_SCHEMA_VERSION, ...this.currentCharacterPresentation(),
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
      this.preparePreviewPose();
      this.refreshCommittedScene({ forceVisibility: true });
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
      validateSpriteAnchors({ schemaVersion: SPRITE_SCHEMA_VERSION, ...this.currentCharacterPresentation(),
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
    this.preparePreviewPose();
    this.refreshCommittedScene({ forceVisibility: true });
  }

  resetPresentation(): void {
    this.assertLive();
    this.resetBasePresentation();
    if (this.dying) this.refreshCommittedScene({ forceVisibility: true });
  }

  // A presenter that stops feeding this rig invalidates its live frame. Commits then evaluate an unconstrained
  // pose, with hair interrupted; the next update seeds fresh targets and motion instead of stale host coordinates.
  forgetLiveFrame(): void {
    this.assertLive();
    this.hasFrame = false;
    this.lastFrame.time = 0;
    this.lastFrame.aim.x = 1; this.lastFrame.aim.y = 0;
    this.liveTargets.clear();
    for (const entry of this.frameTargetEntries) entry.target.used = false;
    for (const name of this.nonAnchorTargets) this.translatedTargets.delete(name);
    this.evaluatedBasePose = null;
    this.resetBasePresentation();
  }

  private resetBasePresentation(): void {
    this.deathSkeletonPose = null;
    if (!this.dying) this.setDeathBrightness(1);
    this.directionPose.reset();
    this.preview = null;
    this.directionalPreview = null;
    this.previewDirectionPose = null;
    if (this.skeleton !== null) {
      this.skeleton.pose = new SkeletonPose(this.skeleton.definition);
      this.skeleton.pose.configureRotation(this.runtimePresentation()?.bones ?? EMPTY_BONES);
      this.skeleton.previewPose = null;
      this.skeleton.previewFresh = false;
      this.applyArmLengths(this.skeleton);
    }
    if (this.dying && this.hasFrame) this.directionPose.update(this.lastFrame);
  }

  setDying(dying: boolean): void {
    this.assertLive();
    if (this.dying === dying) return;
    this.dying = dying;
    if (!dying) {
      this.deathSkeletonPose = null;
      this.deathPreview = null;
      this.deathDirectionalPreview = null;
      return;
    }
    for (const target of this.deathFrameTargets.values()) target.used = false;
    for (const [name, target] of this.lastFrame.targets) {
      const out = this.deathFrameTargets.get(name);
      if (out === undefined) throw new SpriteError(`Unknown death target "${name}".`);
      out.x = target.x; out.y = target.y; out.angle = target.angle; out.used = true;
    }
    const runtime = this.skeleton;
    const pose = this.selectedBasePose();
    if (!this.hasFrame || runtime !== null && pose !== this.evaluatedBasePose) {
      this.refreshScene({ forceVisibility: true }, true);
    }
    this.holdDeathPose(false);
  }

  private holdDeathPose(preserveBase: boolean): void {
    const runtime = this.skeleton;
    this.deathPreview = this.preview;
    this.deathDirectionalPreview = this.directionalPreview;
    this.deathSkeletonPose = null;
    if (runtime !== null) {
      this.updateSkeletonRoot(runtime);
      const targets = this.writeDeathTargets(runtime.originWorld);
      const anchor = this.anchor(runtime.definition.anchor).node;
      const pose = this.selectedBasePose()!;
      this.deathSkeletonPose = pose;
      pose.hold(this.worldAngle(anchor), targets, this.deathHeadBones, preserveBase);
    }
  }

  private selectedBasePose(): SkeletonPose | null {
    const runtime = this.skeleton;
    if (runtime === null) return null;
    return this.preview !== null || this.directionalPreview !== null ? runtime.previewPose ?? runtime.pose : runtime.pose;
  }

  private refreshCommittedScene(options: { forceVisibility?: boolean; notifyCoverage?: boolean } = EMPTY_REFRESH): void {
    if (!this.dying) {
      this.refreshScene(options);
      return;
    }
    const runtime = this.skeleton;
    const pose = this.selectedBasePose();
    const continuing = runtime === null || (this.deathSkeletonPose !== null && pose === this.deathSkeletonPose &&
      this.preview === this.deathPreview && this.directionalPreview === this.deathDirectionalPreview);
    if (continuing) {
      this.activePresentation();
      this.updateFlipbooks();
    } else {
      // A new skeleton or preview must evaluate its base once before hold reads its numeric world arrays.
      this.refreshScene(options, true);
    }
    this.holdDeathPose(continuing);
    this.refreshScene(options, false, true);
    this.rotateLayers();
  }

  // Each material's original colour is captured once. Authored images and layer definitions never change.
  setDeathBrightness(brightness: number): void {
    this.assertLive();
    if (!Number.isFinite(brightness) || brightness < 0 || brightness > 1) {
      throw new SpriteError('Death brightness must be between 0 and 1.');
    }
    if (this.deathBrightness === brightness) return;
    this.deathBrightness = brightness;
    for (const resource of this.materialResources) resource.material.color.copy(resource.colour).multiplyScalar(brightness);
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
    if (this.dying) {
      // The directional choice and flipbook frame are captured, but physical targets still move.
      this.lastFrame.time = frame.time;
      frame.targets.forEach(this.copyDeathTarget);
      if (active) this.refreshScene(EMPTY_REFRESH, false, true);
      return;
    }
    if (active) {
      this.directionPose.update(frame, this.liveDirectionFrame);
      if (this.directionalPreview !== null && this.previewDirectionPose !== null) {
        this.previewTime += dt;
        this.previewDirectionInput.time = this.previewTime;
        this.previewDirectionInput.aim = this.directionalPreview.aim;
        this.previewDirectionPose.update(this.previewDirectionInput, this.previewDirectionFrame);
      }
    } else if (!Number.isFinite(frame.time) || !Number.isFinite(frame.aim.x) || !Number.isFinite(frame.aim.y)) {
      throw new SpriteError('Sprite frame time and aim must be finite.');
    }
    this.hasFrame = true;
    this.lastFrame.time = frame.time;
    this.lastFrame.aim.x = frame.aim.x; this.lastFrame.aim.y = frame.aim.y;
    for (const entry of this.frameTargetEntries) entry.target.used = false;
    frame.targets.forEach(this.copyLiveTarget);
    for (const { name, target } of this.frameTargetEntries) if (!target.used) this.liveTargets.delete(name);
    if (active) this.refreshScene(EMPTY_REFRESH, true);
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
      waistLean: this.waistLean,
      grips: this.grips,
      arms: this.arms,
      models: (this.assets.models ?? []).map(model => ({ id: model.id, name: model.name })),
      avatarModel: this.assets.avatar === undefined ? null : { model: this.assets.avatar.model, boneMap: { ...this.assets.avatar.boneMap } },
      hammerModel: this.assets.hammer?.model ?? null,
      potModel: this.assets.pot?.model ?? null,
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
    const commitPresentation = this.prepareCharacterPresentation?.({
      characterRiggingType: DEFAULT_CHARACTER_RIGGING_TYPE, armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
      waistLean: DEFAULT_WAIST_LEAN, grips: DEFAULT_GRIPS, arms: null,
    });
    this.replacement?.controller.abort(new DOMException('The sprite rig was disposed.', 'AbortError'));
    for (const resource of this.replacement?.staged.values() ?? []) this.releaseResource(resource);
    this.replacement?.staged.clear();
    const previousCoverage = new Map(this.coverage);
    this.detachScene();
    this.disposeLayers(this.layers.values());
    this.layers.clear();
    this.layerEntries = this.boneLayers = this.tiledLayers = [];
    this.attachmentEntries = [];
    this.skeletonMountEntries = [];
    this.materialResources = [];
    this.rotatedLayers = [];
    this.flipbooks = [];
    this.directionalPreview = null;
    this.previewDirectionPose = null;
    this.deathSkeletonPose = null;
    this.evaluatedBasePose = null;
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
    commitPresentation?.();
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
    if (type === 'avatar-3d' && this.prepareCharacterPresentation === undefined) {
      throw new SpriteError('This host has no connected avatar renderer.');
    }
  }

  private async packagedPng(source: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (this.loadContent === undefined) throw new SpriteError('This host cannot load packaged release images.');
    const bytes = await this.loadContent(source, signal);
    checkSignal(signal);
    return bytes;
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
      return { bitmap, texture, material, colour: material.color.clone(), bytes, pixels: bitmap.width * bitmap.height, disposed: false, prepared: false };
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
    return {
      characterRiggingType: this.characterRiggingType, armForwardDistance: this.armForwardDistance, waistLean: this.waistLean,
      grips: this.grips, arms: this.arms, ...this.assets,
    };
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
    validateWaistLean(options.waistLean);
    validateGrips(options.grips);
    validateArms(options.arms);
    this.assertCharacterRenderer(options.characterRiggingType);
    const nextAssets = characterAssets(options);
    const changedAssets = nextAssets.models !== this.assets.models || nextAssets.avatar !== this.assets.avatar ||
      nextAssets.hammer !== this.assets.hammer || nextAssets.pot !== this.assets.pot;
    const changedCharacter = options.characterRiggingType !== this.characterRiggingType ||
      options.armForwardDistance !== this.armForwardDistance || options.waistLean !== this.waistLean ||
      !sameGrips(options.grips, this.grips) || !sameArms(options.arms, this.arms) || changedAssets;
    // The host's pure presentation preparation runs before any skeleton or layer is allocated, so a
    // strategy refusal leaves no new visual resource to unwind. The caller's staged image cleanup
    // still runs, because buildState throws before it takes ownership of those resources.
    const commitPresentation = changedCharacter ? this.prepareCharacterPresentation?.({
      characterRiggingType: options.characterRiggingType, armForwardDistance: options.armForwardDistance,
      waistLean: options.waistLean, grips: options.grips, arms: options.arms, ...nextAssets,
    }) : undefined;
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
      return { resources, images, layers: instances, attachments, skeletonMounts, skeleton, commitPresentation,
        presentation: options.presentation,
        headTracking: compileSpriteHeadTracking(this.headTracking, layers, definition, options.presentation),
        characterRiggingType: options.characterRiggingType, armForwardDistance: options.armForwardDistance,
        waistLean: options.waistLean, grips: options.grips, arms: options.arms, mode: options.mode,
        ...nextAssets };
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
      const originWorld = { x: 0, y: 0 };
      const input = (): SkeletonInput => ({
        time: 0, origin: originWorld, direction: 'right', targets: EMPTY_TARGETS,
        clip: null, pose: EMPTY_POSE, constraints: 'disabled', rotation: null,
      });
      const runtime: SkeletonRuntime = {
        definition,
        pose,
        previewPose: null,
        previewFresh: false,
        group,
        bones,
        boneIndex,
        skeleton,
        evaluated: rest,
        originWorld,
        liveInput: input(), previewInput: input(),
        liveOutput: rest.map(bone => ({ ...bone })), previewOutput: rest.map(bone => ({ ...bone })),
        liveRotation: { pivot: 'bone-origin', angle: 0 }, previewRotation: { pivot: 'bone-origin', angle: 0 },
        livePivot: { x: 0, y: 0 }, previewPivot: { x: 0, y: 0 },
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
    const presentation = next.presentation ?? next.headTracking.presentation;
    const resetDirection = changedType || next.mode === 'replace' || !sameDirectionalPresentation(presentation, this.runtimePresentation());
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
    this.layerEntries = [...next.layers.values()];
    this.boneLayers = this.layerEntries.filter((instance): instance is BoneLayerInstance => instance.kind === 'bone');
    this.tiledLayers = this.layerEntries.filter((instance): instance is TiledLayerInstance => instance.kind !== 'skin' && instance.tile !== null);
    this.attachmentEntries = [...next.attachments.values()];
    this.skeletonMountEntries = [...next.skeletonMounts].map(([root, group]) => ({ root, group }));
    this.materialResources = [...next.resources.values()];
    this.skeleton = next.skeleton;
    this.presentation = next.presentation;
    this.headTrackingPlan = next.headTracking;
    this.deathHeadBones = compileSpriteHeadTracking(this.headTracking,
      [...next.layers.values()].map(instance => instance.data), next.skeleton?.definition ?? null, null).bones;
    this.characterRiggingType = next.characterRiggingType;
    this.armForwardDistance = next.armForwardDistance;
    this.waistLean = next.waistLean;
    this.grips = next.grips;
    this.arms = next.arms;
    this.assets = nextAssets;
    const changedNaturalArms = this.applyArmLengths(this.skeleton, false);
    if (changedType && next.mode === 'edit') this.resetBasePresentation();
    this.preview = options.preview;
    if (changedType || next.mode === 'replace' || this.preview !== null) {
      this.directionalPreview = null;
      this.previewDirectionPose = null;
    }
    if (resetDirection) {
      this.deathSkeletonPose = null;
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
    for (const resource of this.resources.values()) resource.material.color.copy(resource.colour).multiplyScalar(this.deathBrightness);
    this.attachScene();
    this.preparePreviewPose();
    this.refreshCommittedScene({ forceVisibility: true, notifyCoverage: false });
    for (const [name, covered] of this.coverage) {
      if (previousCoverage.get(name) !== covered) this.anchor(name).setCovered({ covered });
    }
    next.commitPresentation?.();
    if (changedNaturalArms) this.onNaturalArmsChange?.();
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

  private refreshScene(options: { forceVisibility?: boolean; notifyCoverage?: boolean } = EMPTY_REFRESH,
    evaluatePose = !this.dying, physicalDeath = false): void {
    if (evaluatePose) this.activePresentation();
    const direction = this.displayedPresentation.direction;
    const changedDirection = direction !== this.currentDirection;
    if (changedDirection) this.currentDirection = direction;
    if (options.forceVisibility || changedDirection) this.applyDirection(direction, options.notifyCoverage !== false);
    if (this.characterRiggingType !== 'sprite-2d') return;
    if (evaluatePose) this.updateFlipbooks();
    const presentation = this.runtimePresentation();
    if (presentation !== null && (this.presentation !== null || this.rotatedLayers.length > 0)) {
      const { pivot } = presentation;
      const anchor = this.anchor(pivot.anchor).node;
      anchor.updateWorldMatrix(true, false);
      this.presentationPivot.set(pivot.x, pivot.y, 0).applyMatrix4(anchor.matrixWorld);
    }
    if (this.skeleton !== null) {
      this.updateSkeletonRoot(this.skeleton);
      if (evaluatePose) this.evaluateSkeleton(this.skeleton);
      else if (physicalDeath) this.evaluatePhysicalSkeleton(this.skeleton);
      this.updateBoneAttachments(this.skeleton);
      this.skeleton.group.updateWorldMatrix(true, true);
      for (const { group } of this.skeletonMountEntries) group.updateWorldMatrix(true, true);
    }
    if (!this.dying) this.rotateLayers();
    for (const attachment of this.attachmentEntries) {
      // Manual local matrices must follow moving anchors before UV density is measured.
      if (attachment.legacyCount > 0) attachment.group.updateWorldMatrix(true, true, true);
    }
    for (const instance of this.tiledLayers) {
      if (!instance.visible) continue;
      instance.mesh.updateWorldMatrix(true, false);
      this.updateTileUv(instance);
    }
  }

  private activePresentation(): Readonly<DirectionalFrame> {
    const out = this.displayedPresentation;
    if (this.preview !== null) {
      const index = directionIndex(this.preview.direction);
      out.direction = this.preview.direction;
      out.aimAngle = this.presentation === null ? index * DIRECTION_STEP_DEGREES : this.presentation.directions[index].neutralAngle;
      out.targetRotation = out.displayedRotation = 0;
      return out;
    }
    let source: Readonly<DirectionalFrame>;
    if (this.directionalPreview !== null) {
      if (this.previewDirectionPose === null) throw new SpriteError('Directional preview is missing its presentation state.');
      source = this.previewDirectionPose.snapshot();
    } else source = this.directionPose.snapshot();
    out.direction = source.direction; out.aimAngle = source.aimAngle;
    out.targetRotation = source.targetRotation; out.displayedRotation = source.displayedRotation;
    return out;
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
    for (const instance of this.layerEntries) {
      const visible = this.characterRiggingType === 'sprite-2d' && (instance.directionMask & (1 << index)) !== 0;
      if (visible === instance.visible) continue;
      instance.visible = visible;
      instance.mesh.visible = visible;
    }
    for (const { name, setCovered } of this.anchorTargetEntries) {
      const covered = this.characterRiggingType === 'sprite-2d';
      if (this.coverage.get(name) === covered) continue;
      this.coverage.set(name, covered);
      if (notifyCoverage) setCovered({ covered });
    }
  }

  private updateSkeletonRoot(runtime: SkeletonRuntime): void {
    const host = this.anchor(runtime.definition.anchor).node;
    host.getWorldPosition(this.tempWorld);
    runtime.originWorld.x = this.tempWorld.x;
    runtime.originWorld.y = this.tempWorld.y;
    this.positionSkeletonMount(runtime.group, this.root, this.tempWorld);
    for (const { root, group } of this.skeletonMountEntries) this.positionSkeletonMount(group, root, this.tempWorld);
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

  private skeletonRotation(runtime: SkeletonRuntime, frame: Readonly<DirectionalFrame>, preview: boolean): SkeletonRotation | null {
    const presentation = this.runtimePresentation();
    if (presentation === null || !presentation.rotation || presentation.bones.length === 0) return null;
    const rotation = preview ? runtime.previewRotation : runtime.liveRotation;
    const pivot = preview ? runtime.previewPivot : runtime.livePivot;
    pivot.x = this.presentationPivot.x - runtime.originWorld.x; pivot.y = this.presentationPivot.y - runtime.originWorld.y;
    rotation.pivot = this.presentation === null ? 'bone-origin' : pivot;
    rotation.angle = THREE.MathUtils.degToRad(frame.displayedRotation);
    return rotation;
  }

  private preparePreviewPose(): void {
    const runtime = this.skeleton;
    if (runtime === null || runtime.previewPose !== null || this.preview === null && this.directionalPreview === null) return;
    runtime.previewPose = new SkeletonPose(runtime.definition);
    runtime.previewFresh = true;
  }

  private evaluateSkeleton(runtime: SkeletonRuntime): void {
    try {
      const live = this.directionPose.snapshot();
      const constraints: 'enabled' | 'disabled' = this.hasFrame ? 'enabled' : 'disabled';
      const input = runtime.liveInput;
      input.time = this.lastFrame.time;
      input.direction = live.direction;
      input.targets = this.hasFrame ? this.rigTargets(runtime.originWorld) : EMPTY_TARGETS;
      input.clip = this.hasFrame ? runtime.definition.animation : null;
      input.pose = EMPTY_POSE;
      input.constraints = constraints;
      input.rotation = this.skeletonRotation(runtime, live, false);
      // Keep the live braid running independently while an editor preview owns the displayed pose.
      let evaluatedPose = runtime.pose;
      let bones = evaluatedPose.evaluate(input, runtime.liveOutput);
      if (this.preview !== null || this.directionalPreview !== null) {
        if (runtime.previewPose === null) throw new SpriteError('A sprite preview has no prepared pose.');
        evaluatedPose = runtime.previewPose;
        if (runtime.previewFresh) {
          evaluatedPose.copyMotionFrom(runtime.pose);
          runtime.previewFresh = false;
        }
        const preview = runtime.previewInput;
        preview.time = this.preview === null ? this.previewTime : this.preview.time;
        preview.direction = this.displayedPresentation.direction;
        preview.targets = input.targets;
        preview.clip = this.preview === null ? input.clip : this.preview.clip;
        preview.pose = this.preview === null ? EMPTY_POSE : this.preview.pose;
        // Without a live frame, neither live nor preview poses have IK targets.
        preview.constraints = this.hasFrame && this.preview !== null ? this.preview.constraints : constraints;
        preview.rotation = this.skeletonRotation(runtime, this.displayedPresentation, true);
        bones = evaluatedPose.evaluate(preview, runtime.previewOutput);
      }
      this.evaluatedBasePose = evaluatedPose;
      runtime.evaluated = bones;
      this.applyBoneMatrices(runtime, bones);
      runtime.skeleton.update();
    } catch (error) {
      throw this.spriteFailure(error);
    }
  }

  private updateBoneAttachments(runtime: SkeletonRuntime): void {
    for (const instance of this.boneLayers) {
      const index = runtime.boneIndex.get(instance.boneId);
      if (index === undefined) throw new SpriteError(`Sprite "${instance.data.name}" references a missing bone.`);
      const bone = runtime.bones[index]!.matrixWorld;
      const scale = runtime.evaluated[index]!.scale;
      if (scale === 1 || this.segmentAnchors.get(instance.boneId) === instance.data.anchor) {
        instance.mesh.matrix.multiplyMatrices(bone, instance.localMatrix);
      } else {
        // Other art on a stretched bone, such as an elbow cap, moves with the stretch but keeps its size.
        this.tempMatrixA.makeScale(1 / scale, 1, 1);
        this.tempMatrixA.elements[12] = (scale - 1) * instance.data.offset.x / scale;
        instance.mesh.matrix.multiplyMatrices(bone, this.tempMatrixA).multiply(instance.localMatrix);
      }
      instance.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  private rigTargets(origin: RuntimePoint): ReadonlyMap<string, RuntimeTarget> {
    for (const { node, target } of this.anchorTargetEntries) {
      node.getWorldPosition(this.tempWorld);
      target.x = this.tempWorld.x - origin.x;
      target.y = this.tempWorld.y - origin.y;
      target.angle = this.worldAngle(node);
    }
    this.targetOrigin = origin;
    const frameTargets = this.dying ? this.deathFrameTargets : this.lastFrame.targets;
    frameTargets.forEach(this.translateTarget);
    for (const name of this.nonAnchorTargets) {
      const target = frameTargets.get(name);
      if (target === undefined || 'used' in target && !target.used) this.translatedTargets.delete(name);
    }
    return this.translatedTargets;
  }

  // The held pose has its own pooled target records, so live and captured targets never alias.
  private writeDeathTargets(origin: RuntimePoint): ReadonlyMap<string, RuntimeTarget> {
    for (const { node, death: out } of this.anchorTargetEntries) {
      node.getWorldPosition(this.tempWorld);
      out.x = this.tempWorld.x - origin.x; out.y = this.tempWorld.y - origin.y;
      out.angle = this.worldAngle(node);
    }
    for (const { source: target, target: out } of this.deathTargetEntries) {
      if (!target.used) continue;
      out.x = target.x - origin.x; out.y = target.y - origin.y; out.angle = target.angle;
    }
    return this.deathTargets;
  }

  private evaluatePhysicalSkeleton(runtime: SkeletonRuntime): void {
    const pose = this.deathSkeletonPose;
    if (pose === null) throw new SpriteError('A dying skeleton has no captured pose.');
    this.heldFrame.targets = this.writeDeathTargets(runtime.originWorld);
    this.heldFrame.rootAngle = this.worldAngle(this.anchor(runtime.definition.anchor).node);
    runtime.evaluated = pose.evaluateHeld(this.heldFrame);
    this.applyBoneMatrices(runtime, runtime.evaluated);
    runtime.skeleton.update();
  }

  private worldAngle(node: THREE.Object3D): number {
    const e = node.matrixWorld.elements;
    return Math.atan2(e[1]!, e[0]!);
  }

  // A stretched bone stretches its weighted artwork, and the art bound to it, along its length.
  private applyBoneMatrices(runtime: SkeletonRuntime, bones: readonly RuntimeBoneWorld[]): void {
    for (let index = 0; index < bones.length; index++) {
      const source = bones[index]!;
      const bone = runtime.bones[index]!;
      bone.matrix.makeRotationZ(source.angle);
      if (source.scale !== 1) bone.matrix.scale(this.boneStretch.setX(source.scale));
      bone.matrix.setPosition(source.x, source.y, 0);
      bone.matrixWorld.copy(bone.matrix);
    }
  }

  private applyArmLengths(runtime: SkeletonRuntime | null, notify = true): boolean {
    const lengths = new Map<string, number>();
    const segments = new Map<string, string>();
    if (runtime !== null && this.arms !== null && this.armSlots !== null) {
      for (const side of ['left', 'right'] as const) {
        const slots = this.armSlots[side];
        for (const chain of runtime.definition.ik) {
          if (chain.target !== slots.target) continue;
          lengths.set(chain.upper, this.arms[side].upper);
          lengths.set(chain.lower, this.arms[side].forearm);
          segments.set(chain.upper, slots.upper);
          segments.set(chain.lower, slots.forearm);
        }
      }
    }
    this.segmentAnchors = segments;
    runtime?.pose.setBoneLengths(lengths);
    runtime?.previewPose?.setBoneLengths(lengths);
    const definition = runtime?.definition ?? null;
    const chain = (side: ArmSide): ArmLengths | null => {
      const ik = definition?.ik.find(candidate => candidate.target === this.armSlots?.[side].target);
      if (definition === null || ik === undefined) return null;
      const length = (id: string) => definition.bones.find(bone => bone.id === id)!.length;
      return Object.freeze({ upper: length(ik.upper), forearm: length(ik.lower) });
    };
    const left = chain('left'), right = chain('right'), previous = this.naturalArms;
    const same = (a: ArmLengths | null, b: ArmLengths | null): boolean =>
      a === null || b === null ? a === b : a.upper === b.upper && a.forearm === b.forearm;
    if (same(previous.left, left) && same(previous.right, right)) return false;
    this.naturalArms = Object.freeze({ left, right });
    if (notify) this.onNaturalArmsChange?.();
    return true;
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
