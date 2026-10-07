import {
  ACESFilmicToneMapping, AmbientLight, Box3, BoxGeometry, BufferGeometry,
  CanvasTexture, CylinderGeometry, DirectionalLight, Euler,
  Fog, Group, HemisphereLight, LatheGeometry, Line, MathUtils,
  Matrix4, Mesh, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera,
  Quaternion, Scene, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry,
  Vector3, WebGLRenderer,
} from 'three';
import type { Material, Object3D } from 'three';
import { ARM_SIDES, DEFAULT_ARM_IK, HEAD_GEOMETRY, SHAFT_ARTWORK_LENGTH, SPRITE_TARGET_IDS } from './character';
import type { ArmIkSettings, ArmSide, CharacterState, VisualBinding, VisualPartId } from './character';
import { ARM_GEOMETRY, ArmPoseSolver, createArmPose, DEFAULT_ARM_CHAINS } from './arm-ik';
import { DEFAULT_ARM_FORWARD_DISTANCE, getToolDepth, PLAYER_DEPTH } from './character-depth';
import { ARM_LAYER } from './arm-layer';
import { OBSTACLE_LINE } from './obstacle-line';
import type { ArmChains, ArmPose } from './arm-ik';
import type { ArmLengths, CharacterArms } from './character-arms';
import { DEFAULT_GRIPS, GripHold, headGripMargin, NO_GRIP_ROTATION, sameGripRotation } from './grips';
import type { GripDistances, GripRotation, Grips, GripShoulder } from './grips';
import { AvatarView } from './avatar-view';
import { createArmSolutions, createFramePlan, createPose, projectGripShoulder } from './avatar-rig';
import type {
  AvatarRig, AvatarRigArmSolution, AvatarRigBinds, AvatarRigFrameContext, AvatarRigFramePlan, AvatarRigPose, AvatarRigPoseContext,
  AvatarRigRegistry, PreparedAvatarMotions,
  PreparedAvatarRig,
} from './avatar-rig';
import { sameAvatarDriver } from './avatar-driver';
import type { AvatarDriver } from './avatar-driver';
import type { AvatarMotionEntry } from './avatar-motion-data';
import type { AvatarMotionModel } from './avatar-motion';
import type { CharacterModelUsage, ResolvedAvatarJoints } from './character-model-inspect';
import type { CharacterModelLoader, LoadedCharacterModel } from './character-model-types';
import {
  characterModel, PROP_MODEL_ROLES, sameAvatarModelSettings, sameAvatarMotions, sameBoneMap,
} from './character-profile';
import type { AvatarBoneMap, AvatarHair, AvatarModelSettings, CharacterAssets, PropModelRole } from './character-profile';
import { PropModelView } from './prop-model-view';
import { HammerHandleFit } from './hammer-handle-fit';
import { SkinnedAvatarView } from './skinned-avatar-view';
import { HeadAim } from './head-aim';
import { DEFAULT_WAIST_LEAN, WaistLean } from './waist-lean';
import type { LeanPreview } from './waist-lean';
import { createHammerHeadGeometry, createPotGeometry, placeLimb, PLAYER_FIGURE } from './player-figure';
import { PHYSICS, RIG } from './config';
import type { InputMode, Point } from './config';
import type { LevelChange, LevelDefinition, LevelLabel } from './level';
import type { RigGeometry } from './rig';
import { DEFAULT_HAMMER_HEAD, hammerHeadRadius } from './hammer-head';
import type { HammerHead } from './hammer-head';
import { LevelLooks } from './object-looks';
import type { Kinds } from './plugins/kinds';
import type { RuntimePlugins } from './plugins/runtime';
import { attributed, call0, call1, call2, call3, invalidResult } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import { createCameraDirector, checkCameraAim } from './camera-director';
import type { CameraAim, CameraDirector } from './camera-director';
import { createBackdrop } from './backdrop';
import type { Backdrop } from './backdrop';
import { createAimMarks } from './aim-marks';
import type { AimMarks } from './aim-marks';
import type { HurtCause, ProjectileBlock } from './hazards';
import { createHurtEffects } from './hurt-effects';
import type { HurtEffects } from './hurt-effects';
import { createBlockEffects } from './block-effects';
import type { BlockEffects } from './block-effects';
import { createDeathAppearance, createDeathPoseWriter, DEFAULT_DEATH_POSE } from './death-pose';
import type { DeathAppearance, DeathPoseInput, DeathPoseWriter } from './death-pose';
import { copyRotation, createDeathPose } from './player-pose';
import type { DeathPose, DeathSeed, MutableLivePlayerFrame, PlayerFrameState } from './player-pose';
import { PlacementHold } from './placement-hold';
import type { DeathFrame, DeathKind } from './death-sequence';
import { createSceneLayers } from './scene-layer';
import type { SceneDeathPlayerFrame, SceneFrame, SceneLayer, ScenePlayerFrame } from './scene-layer';
import type { PartPose, PhysicsFrame } from './simulation';
import { TerrainView } from './terrain-view';
import type { DecorationView } from './decoration-view';
import { Disposal } from './disposal';
import { CharacterModelPool } from './character-model-pool';
import type { CharacterModelLease } from './character-model-pool';
import { SpriteRig } from './sprite-rig';
import type { CharacterAssetLease, SpriteAnchor, SpriteArmSlots } from './sprite-rig';
import { DEFAULT_CHARACTER_RIGGING_TYPE, SpriteError, UPPER_BODY_3D } from './sprite-data';
import type { CharacterPresentation, CharacterRiggingType, SpriteDocument } from './sprite-data';
import { VisualVisibility } from './visual-visibility';
import type { RigTarget } from './skeleton-pose';
import { DEFAULT_THEME } from './theme';
import type { GameTheme } from './theme';
import type { EnemyArtSettings } from './enemy-art-data';
import type { EnemyEvent } from './enemy-types';
import { DEFAULT_ENEMY_ART } from './enemy-art-data';
import type { ContentLoader } from './content-ref';
import type { LibraryAvatarSettings, PartRole } from './model-library';

const VISUAL = {
  // The orthographic camera's distance from the course plane (z = 0).
  depth: 20,
  // The depths either camera sees, from the course plane: in front of it and behind it.
  sceneFront: 15,
  // The deepest decoration's back, with room for its own depth.
  sceneBack: 1100,
  nearPlane: 0.1,
  touchPixelsPerReach: 100,
} as const;
// The brass sleeve near the start of each two-part hammer segment.
const SLEEVE_INSET = 0.07;
const ENGINE = Object.freeze({ plugin: null, point: null });

function solid(geometry: BoxGeometry | SphereGeometry | CylinderGeometry | LatheGeometry | TorusGeometry,
  material: MeshStandardMaterial, position: [number, number, number] = [0, 0, 0]): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(...position);
  return mesh;
}

interface Arm {
  upper: Group;
  lower: Group;
  elbow: Group;
  hand: Group;
  readonly solver: ArmPoseSolver;
}

type MutableRigTarget = { -readonly [K in keyof RigTarget]: RigTarget[K] };

export interface CameraFraming extends Point {
  worldHeight: number;
}

// A preview that moves the character's whole presentation for a while: its body, pot and tool together, by `offset` in
// the view's plane and turned about the player's root, over `duration` seconds of simulation time. Presentation only:
// the camera, physics and overlays keep the simulation's frame. It ends early on a rewind, a restart or another preview.
export interface PresentationPreview {
  readonly duration: number;
  // Writes the offset `elapsed` seconds in: metres, and radians counterclockwise. Non-finite values end the preview.
  offset(elapsed: number, out: { x: number; y: number; turn: number }): void;
}

// The imported avatar the character shows: the facts its motion kinds get, each motion's claimed joints, and a joint's
// current world frame.
export interface ImportedAvatarFacts {
  readonly model: AvatarMotionModel;
  readonly motions: readonly { readonly id: string; readonly claims: readonly number[] }[];
  jointWorld(index: number, out: Matrix4): Matrix4;
}

// A rendered avatar: the built-in skinned mesh, which builds its own frames from world arm poses,
// or an imported skinned model, which applies the prepared rig's avatar-space pose matrices.
type AvatarRenderer = AvatarView | SkinnedAvatarView;

// A slot-owned prop view plus the pool reference that keeps its model alive. Library parts are
// borrowed from their caller and therefore have no lease.
interface OwnedProp {
  readonly model: LoadedCharacterModel;
  readonly lease: CharacterModelLease;
  readonly view: PropModelView;
  readonly fit: HammerHandleFit | null;
}

// One loaded character profile. Its sprite rig, models and views are built once and kept while
// another profile is shown, so switching profiles only changes what is attached and visible.
interface CharacterSlot {
  readonly index: number;
  readonly rig: SpriteRig;
  // Sprite mounts and their parents; an inactive profile is detached, so it costs no frame work.
  readonly mounts: readonly { readonly node: Group; readonly parent: Object3D }[];
  readonly coverage: Map<string, boolean>;
  presentation: CharacterPresentation;
  // This profile's sole model cache: one shared entry per (usage, source), kept alive by the leases
  // its committed views and in-flight preparations hold.
  readonly pool: CharacterModelPool;
  avatar: OwnedPreparedAvatar | null;
  // A hammer model also fits its handle to the game's.
  readonly props: Record<PropModelRole, OwnedProp | null>;
}

// A library model shown for one part in place of every character's own model for that part.
// An avatar brings the settings its proportions need. The caller owns `model`.
export interface PartModel {
  readonly id: string;
  readonly model: LoadedCharacterModel;
  readonly avatar?: LibraryAvatarSettings;
  // A library hammer's own head outline, which the game's physics takes along with the model.
  readonly head?: HammerHead;
}

interface PartViews {
  avatar: (PreparedAvatar & { readonly id: string; readonly settings: LibraryAvatarSettings }) | null;
  hammer: { readonly id: string; readonly model: LoadedCharacterModel; readonly view: PropModelView; readonly fit: HammerHandleFit } | null;
  pot: { readonly id: string; readonly model: LoadedCharacterModel; readonly view: PropModelView } | null;
}

// A fitted imported avatar and the state its frames need. Each profile and library avatar owns one,
// so pose history and strategy state never leak from the avatar that was showing before it. Its hair
// and motions change in place, keeping the view.
interface PreparedAvatar {
  readonly model: LoadedCharacterModel;
  readonly boneMap: AvatarBoneMap;
  readonly driver: AvatarDriver;
  hair: AvatarHair;
  motion: readonly AvatarMotionEntry[];
  // The motions its view runs, and the fit they are prepared against.
  motions: PreparedAvatarMotions;
  readonly resolved: ResolvedAvatarJoints;
  readonly binds: AvatarRigBinds;
  readonly rig: AvatarRig;
  readonly plan: AvatarRigFramePlan;
  readonly pose: AvatarRigPose;
  readonly view: SkinnedAvatarView;
  readonly solvers: Readonly<Record<ArmSide, ArmPoseSolver>>;
}

// The exact inputs a commit needs to build one avatar view: the cached model, the settings it was
// fitted with, and the pure preparation, including its hair and motions, checked before any scene
// changes. Bound together, so a compiled rig can never be committed against a different model or
// bone map. A change to the hair and motions alone instead replaces the motions of the view showing,
// which the preparation names.
type PreparedAvatarView =
  | {
    readonly kind: 'view';
    readonly model: LoadedCharacterModel;
    readonly boneMap: AvatarBoneMap;
    readonly driver: AvatarDriver;
    readonly hair: AvatarHair;
    readonly motion: readonly AvatarMotionEntry[];
    readonly prepared: PreparedAvatarRig;
  }
  | {
    readonly kind: 'motions';
    readonly view: SkinnedAvatarView;
    readonly hair: AvatarHair;
    readonly motion: readonly AvatarMotionEntry[];
    readonly motions: PreparedAvatarMotions;
  };

// A slot-owned avatar view: the prepared avatar plus the pool reference that keeps its model alive.
type OwnedPreparedAvatar = PreparedAvatar & { readonly lease: CharacterModelLease };

// One operation's single-flight acquisition of a model and the lease it holds until commit/failure.
interface ModelHolding {
  readonly lease: CharacterModelLease;
  readonly model: LoadedCharacterModel;
}

export const MAX_CHARACTER_PROFILES = 2;
const PROP_PARTS: ReadonlySet<VisualPartId> = new Set(['pot', 'hammer-shaft', 'hammer-head']);
const HAMMER_PARTS: ReadonlySet<VisualPartId> = new Set(['hammer-shaft', 'hammer-head']);
const ARM_PARTS: ReadonlySet<VisualPartId> = new Set(ARM_SIDES.flatMap((side) =>
  [`${side}-upper-arm`, `${side}-forearm`, `${side}-elbow`, `${side}-hand`] as const));
// three.js's default render layer, which everything but a 3D character's arms is on.
const DEFAULT_LAYER = 0;

// Puts a mesh-part arm visual, the built-in one or an Appearance import, on the arms' render layer.
function onArmLayer(root: Object3D): void {
  root.traverse((object) => { object.layers.set(ARM_LAYER); });
}
const PROP_VIEW_NAMES: Readonly<Record<PropModelRole, string>> = { hammer: 'one-model-hammer', pot: 'profile-pot-model' };
const DEFAULT_PRESENTATION: CharacterPresentation = Object.freeze({
  characterRiggingType: DEFAULT_CHARACTER_RIGGING_TYPE, armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
  waistLean: DEFAULT_WAIST_LEAN, grips: DEFAULT_GRIPS, arms: null,
});

// Each arm's grip target and segment slots, so a character's arm lengths also stretch its 2D arms.
const ARM_SLOTS: Readonly<Record<ArmSide, SpriteArmSlots>> = Object.freeze({
  left: Object.freeze({ target: 'left-grip', upper: 'left-upper-arm', forearm: 'left-forearm' }),
  right: Object.freeze({ target: 'right-grip', upper: 'right-upper-arm', forearm: 'right-forearm' }),
});

// A character's arm lengths replace the natural chains' segment lengths; shoulders stay.
function withArmLengths(chains: ArmChains, arms: CharacterArms | null): ArmChains {
  if (arms === null) return chains;
  return Object.freeze({
    left: Object.freeze({ ...chains.left, upper: arms.left.upper, forearm: arms.left.forearm }),
    right: Object.freeze({ ...chains.right, upper: arms.right.upper, forearm: arms.right.forearm }),
  });
}

// Toward the camera: the grip frame's Z in world space.
const WORLD_FORWARD = Object.freeze(new Vector3(0, 0, 1));

// A hand's grip rotation as a quaternion in its grip frame, or null for none, so unrotated hands do no
// per-frame work. Three.js's 'ZYX' order composes Rz · Ry · Rx: X first, then Y, then Z, about fixed axes.
function gripQuaternion(rotation: GripRotation): Quaternion | null {
  if (sameGripRotation(rotation, NO_GRIP_ROTATION)) return null;
  return new Quaternion().setFromEuler(new Euler(
    MathUtils.degToRad(rotation.x), MathUtils.degToRad(rotation.y), MathUtils.degToRad(rotation.z), 'ZYX'));
}

function disposeResources(...roots: Object3D[]): void {
  const disposal = new Disposal();
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<CanvasTexture>();
  for (const root of roots) disposal.run(() => root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Line || object instanceof Sprite) {
      if ('geometry' in object) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        if ('map' in material && material.map instanceof CanvasTexture) textures.add(material.map);
      }
    }
  }));
  for (const geometry of geometries) disposal.run(() => geometry.dispose());
  for (const material of materials) disposal.run(() => material.dispose());
  for (const texture of textures) disposal.run(() => texture.dispose());
  disposal.finish();
}

export class GameView {
  readonly canvas: HTMLCanvasElement;
  readonly terrain = new TerrainView();
  readonly sprites: SpriteRig;
  // How the level's flags, updrafts, bonfires, traps, projectiles, liquid pools and enemies look.
  private readonly looks: LevelLooks;
  private readonly renderer: WebGLRenderer;
  // Passes, each drawn over the last. The course: terrain, its artwork and the scenery behind the obstacle line.
  // Then, with depth cleared, the actors: the characters, phantoms and enemies, which the course's colliders,
  // reaching half their depth toward the camera, must never hide; a 3D character's arms (ARM_LAYER) are left out.
  // Then, with depth cleared, the front: decorations on or in front of the line and the looks' fronts, such as the
  // halves of swinging axes and liquid pools in front of it. Then, with depth cleared again,
  // a 3D character's arms, so they never clip into its body, jar or head; the marks, which ignore depth and write
  // none (aim cursor and line, course labels, editor overlays); and last the foreground, the tool, which shares the
  // arms' depth so the hands hold it.
  // The first part of the course pass. A separate render, without a depth clear before the rest of the course,
  // guarantees that a backdrop draws first even when its root mixes opaque and transparent materials.
  private readonly backdropScene = new Scene();
  private readonly course = new Scene();
  private readonly actors = new Scene();
  private readonly front = new Scene();
  private readonly marks = new Scene();
  private readonly foreground = new Scene();
  // Whether the actors' arms pass runs: the active character has 3D arms, which hold the tool. 2D characters keep
  // their authored depths.
  private armsOverBody = UPPER_BODY_3D[DEFAULT_PRESENTATION.characterRiggingType];
  private readonly orthographic = new OrthographicCamera();
  private readonly perspective = new PerspectiveCamera();
  // The theme's camera. Either looks along -z at the course plane, the obstacle line (z = 0), from `distance`, and
  // shows it `worldHeight` tall, so the plane maps to the screen the same way in both.
  private camera: OrthographicCamera | PerspectiveCamera;
  private distance: number = VISUAL.depth;
  private readonly director: Attributed<CameraDirector>;
  private readonly cameraView = {
    focus: { x: 0, y: 0 }, reach: { x: 0, y: 0 }, reachRadius: 0, maxReach: 0, width: 1, height: 1, dt: 0,
    death: null as DeathKind | null,
  };
  private readonly cameraAim: CameraAim = { x: 0, y: 0, worldHeight: 0 };
  private readonly backdrop: Attributed<Backdrop>;
  private readonly aimMarks: Attributed<AimMarks>;
  private readonly hurtEffects: Attributed<HurtEffects>;
  private readonly blockEffects: Attributed<BlockEffects>;
  private readonly deathWriter: DeathPoseWriter;
  private readonly deathInput: { -readonly [K in keyof DeathPoseInput]: DeathPoseInput[K] } = {
    elapsed: 0, duration: 0, poseProgress: 0, reducedMotion: false, character: DEFAULT_CHARACTER_RIGGING_TYPE, direction: 1,
    body: 'rigid', attachment: 'gripped', physical: createDeathPose(), headFacing: { x: 0, y: 0, z: 0, w: 1 },
    layout: { waist: { x: 0, y: 0.32 }, neck: { x: 0, y: PLAYER_FIGURE.neck.y } }, grippedArms: null,
  };
  private readonly deathPose: DeathAppearance = createDeathAppearance();
  private readonly sceneDeathPlayer: { -readonly [K in keyof SceneDeathPlayerFrame]: SceneDeathPlayerFrame[K] } = {
    phase: 'dying-rigid', centre: { x: 0, y: 0, angle: 0 }, pose: createDeathPose(), presented: this.deathPose,
    layout: { waist: { x: 0, y: 0 }, neck: { x: 0, y: 0 } }, headFacing: { x: 0, y: 0, z: 0, w: 1 }, direction: 1,
  };
  private readonly heldDefault: DeathAppearance = createDeathAppearance();
  private readonly grippedPose: DeathPose = createDeathPose();
  private readonly physicalArms = { left: createArmPose('left'), right: createArmPose('right') };
  private readonly placementHold = new PlacementHold();
  private readonly deferVisualChange = (apply: () => void, cancel?: () => void): boolean => this.placementHold.defer(apply, cancel);
  private readonly headRotation = new Quaternion();
  private readonly headDelta = new Matrix4();
  private readonly headWorld = new Matrix4();
  private readonly headCentre = new Vector3();
  private readonly headCentreLocal = new Vector3();
  private readonly headRoll = new Quaternion();
  private readonly zAxis = new Vector3(0, 0, 1);
  private readonly capturedArmIk = { ...DEFAULT_ARM_IK };
  private capturedHeadAngle = 0;
  private capturedTorsoAngle = 0;
  // Whether the hurt effects update on drawn frames: from a hurt or a clear until they say nothing shows.
  private hurtShowing = false;
  private blockShowing = false;
  // Course labels.
  private readonly labels = new Group();
  // Null in a release whose level has no decorations; its shell then carries none of their code.
  readonly decorations: DecorationView | null;
  private readonly bindings = new Map<VisualPartId, VisualBinding>();
  private readonly layers = new Map<SceneLayer, Attributed<SceneLayer>>();
  private readonly updatingLayers = new Set<Attributed<SceneLayer>>();
  private readonly sceneFrame: { -readonly [K in keyof SceneFrame]: SceneFrame[K] };
  // Internal collision diagnostics read these after the player's arms are posed, outside the public layer contract.
  private readonly posedArms: ArmPose[] = [];
  private readonly playerMeshes = new Map<string, Group>();
  private readonly torso = new Group();
  private readonly meshHead = new Group();
  private readonly headAim = new HeadAim();
  // The upper body turns about the waist, at the jar's rim, toward the hammer, up to the character's waistLean.
  private readonly waistLean = new WaistLean(Math.max(...RIG.potVertices.map((point) => point.y)));
  private maxWaistLean = DEFAULT_WAIST_LEAN;
  private readonly torsoOrigin = { x: 0, y: 0 };
  private readonly spriteNeck = { x: 0, y: 0 };
  private readonly headPivot = new Vector3(...HEAD_GEOMETRY.neck);
  private readonly headOffset = new Vector3();
  private avatar: AvatarView | null = null;
  private readonly characterModels: CharacterModelLoader | null;
  private readonly content: ContentLoader | undefined;
  private readonly slots: CharacterSlot[] = [];
  private activeSlot = 0;
  private armChains: ArmChains = DEFAULT_ARM_CHAINS;
  private avatarRenderer: AvatarRenderer | null = null;
  // The prepared rig (if any) the active character shows, with its per-avatar pose history.
  private activeAvatar: PreparedAvatar | null = null;
  private readonly avatarRigs: AvatarRigRegistry;
  private readonly propModels: Record<PropModelRole, PropModelView | null> = { hammer: null, pot: null };
  // Library models chosen for each part, shown for every character.
  private readonly parts: PartViews = { avatar: null, hammer: null, pot: null };
  // Parts whose library model is on its way while characters load, so their own is never loaded.
  private readonly reserved = new Set<PartRole>();
  private readonly potFrame = new Matrix4();
  // The running presentation preview, from the simulation time of its first frame, and the frame it draws: the
  // simulation's with the player's parts and cursor moved. Reused, so a preview allocates nothing per frame.
  private presentationPreview: { readonly preview: PresentationPreview; start: number | null } | null = null;
  private readonly previewOffset = { x: 0, y: 0, turn: 0 };
  // The aim a sprite character turns its head and faces by: before a presentation preview's turn, which its anchors
  // already carry.
  private readonly spriteAim = { x: 0, y: 0 };
  private readonly shaftCenter = { x: 0, y: 0 };
  private readonly aim = { x: 0, y: 0 };
  private readonly localAim = { x: 0, y: 0 };
  private previewParts: PartPose[] = [];
  private readonly previewCursor = { x: 0, y: 0 };
  private previewFrame: PhysicsFrame | null = null;
  private readonly previewPlayer: MutableLivePlayerFrame = {
    phase: 'alive', centre: { x: 0, y: 0, angle: 0 }, shoulder: { x: 0, y: 0 },
  };
  private avatarFacts: { readonly avatar: PreparedAvatar; readonly motions: PreparedAvatarMotions; readonly facts: ImportedAvatarFacts } | null = null;
  private renders = 0;
  private readonly customShaft = new Group();
  // Two-part hammer segments, rescaled when the rig changes.
  private readonly shaftSegments: { readonly shaft: Mesh; readonly sleeve: Mesh }[] = [];
  private rig: RigGeometry;
  private toolDepth = getToolDepth(DEFAULT_ARM_FORWARD_DISTANCE);
  private grips: Grips = DEFAULT_GRIPS;
  private readonly gripDistances: GripDistances = { left: 0, right: 0 };
  // Where sliding hands have slid to, kept from frame to frame.
  private readonly gripHold = new GripHold();
  // The physical head's outline, which the built-in head mesh, the framing and the hands follow.
  private headOutline: HammerHead = DEFAULT_HAMMER_HEAD;
  private hammerRadius = hammerHeadRadius(DEFAULT_HAMMER_HEAD);
  private headMargin = headGripMargin(DEFAULT_HAMMER_HEAD);
  private headMesh!: Mesh;
  // Each hand's grip rotation in its grip frame, or null for none.
  private gripRotations: Record<ArmSide, Quaternion | null> = { left: null, right: null };
  // Scratch for turning a grip rotation into another space, and each glove's world-space turn this frame.
  private readonly gripBasis = new Matrix4();
  private readonly gripFrame = new Quaternion();
  private readonly gripAcross = new Vector3();
  private readonly gripTurn = new Quaternion();
  private readonly gloveTurns: Record<ArmSide, Quaternion | null> = { left: null, right: null };
  private readonly gloveTurnScratch: Record<ArmSide, Quaternion> = { left: new Quaternion(), right: new Quaternion() };
  // A prepared rig's frame plan as the grip rotations turn it: the view's own copy, so a strategy's plan,
  // which may carry its state between frames, is never rewritten.
  private readonly turnedPlan: AvatarRigFramePlan = createFramePlan();
  // Each shoulder against the handle, refreshed every frame for the grip placement.
  private readonly gripShoulders: Record<ArmSide, GripShoulder> = {
    left: { along: 0, aside2: 0, arm: 0 }, right: { along: 0, aside2: 0, arm: 0 },
  };
  private readonly gripShoulder = new Vector3();
  private readonly gripButt = new Vector3();
  private readonly gripAxis = new Vector3();
  private readonly spriteContact = new Vector3();
  // Whether the active character is 2D, whose arm chains that target the grips reach in the drawing plane.
  private spriteArms = false;
  private readonly arms = new Map<ArmSide, Arm>();
  // The physical tool: origin at the butt, +X along the handle, in unscaled metres.
  private readonly toolFrame = new Matrix4();
  private readonly observer: ResizeObserver;
  private width = 1;
  private height = 1;
  // Zero until the first frustum update, which always runs.
  private worldHeight = 0;
  private framing: CameraFraming | null = null;
  private labelDefinition: readonly LevelLabel[] | null = null;
  private readonly projection = new Vector3();
  private readonly inverseBody = new Matrix4();
  private readonly avatarTool = new Matrix4();
  private readonly avatarButt = new Vector3();
  private readonly avatarShaft = new Vector3();
  private readonly avatarForward = new Vector3();
  private readonly wristAvatar = new Vector3();
  private readonly handAvatar = new Vector3();
  private readonly solutions: Record<ArmSide, AvatarRigArmSolution> = createArmSolutions();
  private readonly armTargets = { shoulder: new Vector3(), hand: new Vector3(), hint: new Vector3(), shaftAxis: new Vector3() };
  private readonly frameContext: { -readonly [K in keyof AvatarRigFrameContext]: AvatarRigFrameContext[K] } = {
    body: this.torso.matrixWorld, inverseBody: this.inverseBody, tool: this.avatarTool,
    shaftAxis: this.avatarShaft, forward: this.avatarForward, shaftLength: 0, dt: 0, poseSource: 'live', attachment: 'gripped',
  };
  private readonly poseContext: { -readonly [K in keyof AvatarRigPoseContext]: AvatarRigPoseContext[K] } = {
    body: this.torso.matrixWorld, inverseBody: this.inverseBody, plan: this.turnedPlan, arms: this.solutions, dt: 0,
    poseSource: 'live', attachment: 'gripped',
  };
  private readonly spriteTargets = new Map<string, MutableRigTarget>(
    ['left-grip', 'right-grip', 'hammer-base', 'hammer-shaft', 'hammer-head', 'aim']
      .map((id): [string, MutableRigTarget] => [id, { x: 0, y: 0, angle: 0 }]));
  private readonly spriteFrame = { time: 0, dt: 0, aim: this.spriteAim, targets: this.spriteTargets };
  private theme: GameTheme;
  private readonly fog: Fog;
  // Each light exists in every lit pass: all but the marks.
  private readonly lights: {
    readonly hemisphere: HemisphereLight[]; readonly ambient: AmbientLight[];
    readonly sun: DirectionalLight[]; readonly rim: DirectionalLight[];
  } = { hemisphere: [], ambient: [], sun: [], rim: [] };
  private palette: Record<keyof GameTheme['character'], MeshStandardMaterial> | null = null;
  private themeWrites = 0;

  constructor(canvas: HTMLCanvasElement, initial: PhysicsFrame, level: LevelDefinition, options: {
    // Loads imported character GLBs; hosts without one reject profiles that reference models.
    characterModels?: CharacterModelLoader | null;
    // Loads a release's packaged sprite images.
    content?: ContentLoader;
    theme?: GameTheme;
    enemyArt?: EnemyArtSettings;
    kinds: Kinds;
    plugins: RuntimePlugins;
    // Creates the decoration view; without it the view draws no decorations.
    decorations?: (() => DecorationView) | null;
  }) {
    this.canvas = canvas;
    this.characterModels = options.characterModels ?? null;
    this.avatarRigs = options.kinds.avatarRigs;
    this.content = options.content;
    this.theme = options.theme ?? DEFAULT_THEME;
    const theme = this.theme;
    this.camera = theme.camera.perspective ? this.perspective : this.orthographic;
    // Resolve and check plugin factories before creating a WebGL renderer or attaching any view listeners.
    // A later factory failure frees every presentation object already made.
    const created: Attributed<{ dispose(): void }>[] = [];
    let layers: readonly Attributed<SceneLayer>[];
    let looks: LevelLooks | null = null;
    try {
      this.director = createCameraDirector(options.plugins);
      this.deathWriter = createDeathPoseWriter(options.plugins);
      looks = new LevelLooks(options.plugins, level.objects, options.enemyArt === undefined ? DEFAULT_ENEMY_ART : options.enemyArt);
      this.looks = looks;
      this.backdrop = createBackdrop(options.plugins, theme);
      created.push(this.backdrop);
      this.aimMarks = createAimMarks(options.plugins, theme);
      created.push(this.aimMarks);
      this.hurtEffects = createHurtEffects(options.plugins);
      created.push(this.hurtEffects);
      this.blockEffects = createBlockEffects(options.plugins);
      created.push(this.blockEffects);
      layers = createSceneLayers(options.plugins);
    } catch (error) {
      for (let index = created.length - 1; index >= 0; index--) call0(created[index]!, 'dispose');
      looks?.dispose();
      this.terrain.dispose();
      throw error;
    }
    const root = initial.player.centre;
    const head = this.part(initial, 'head');
    this.cameraView.focus.x = root.x;
    this.cameraView.focus.y = root.y;
    this.cameraView.reach.x = head.x;
    this.cameraView.reach.y = head.y;
    this.rig = initial.rig;
    this.sceneFrame = { time: initial.time, parts: initial.parts, player: this.scenePlayer(initial.player),
      cursor: initial.cursor, enemies: initial.enemies, rig: initial.rig };
    // Keep unmounted runtime layers owned too, if subsequent renderer/player construction fails.
    for (const layer of layers) this.layers.set(layer.value, layer);
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.toneMapping = ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = theme.exposure;
      this.renderer.autoClear = false;
      // Swinging axes keep the side of the obstacle line their pass draws.
      this.renderer.localClippingEnabled = true;
      this.renderer.info.autoReset = false;
      this.renderer.setClearColor(theme.sky);
      this.fog = new Fog(theme.fog.color);
      // The marks are unlit; they only take the fog.
      this.marks.fog = this.fog;
      for (const pass of [this.backdropScene, this.course, this.actors, this.front, this.foreground]) {
        pass.fog = this.fog;
        const hemisphere = new HemisphereLight(theme.hemisphere.sky, theme.hemisphere.ground, theme.hemisphere.intensity);
        const ambient = new AmbientLight(theme.ambient.color, theme.ambient.intensity);
        const sunlight = new DirectionalLight(theme.sun.color, theme.sun.intensity);
        sunlight.position.set(-5, 12, 10);
        const rimLight = new DirectionalLight(theme.rim.color, theme.rim.intensity);
        rimLight.position.set(8, 3, -4);
        // The actors' lights also light their arms, which draw in a pass of their own.
        if (pass === this.actors) for (const light of [hemisphere, ambient, sunlight, rimLight]) light.layers.enable(ARM_LAYER);
        pass.add(hemisphere, ambient, sunlight, rimLight);
        this.lights.hemisphere.push(hemisphere);
        this.lights.ambient.push(ambient);
        this.lights.sun.push(sunlight);
        this.lights.rim.push(rimLight);
      }
      this.backdropScene.add(this.backdrop.value.root);
      this.decorations = options.decorations?.() ?? null;
      this.decorations?.setObjects(level.objects);
      this.course.add(this.terrain.root);
      for (const passes of this.looks.passes()) {
        if (passes.course !== undefined) this.course.add(passes.course);
        if (passes.actors !== undefined) this.actors.add(passes.actors);
        if (passes.front !== undefined) this.front.add(passes.front);
      }
      this.marks.add(this.labels);
      if (this.decorations !== null) {
        this.course.add(this.decorations.root);
        this.front.add(this.decorations.front);
      }
      this.setLabels(level.labels);
      this.buildPlayer();
      this.sprites = this.createSlot().rig;

      this.marks.add(this.aimMarks.value.root);
      this.marks.add(this.hurtEffects.value.root);
      this.marks.add(this.blockEffects.value.root);
      for (const layer of layers) this.addLayer(layer.value, layer);

      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas);
      this.resize();
      this.recenter(initial);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get visuals(): ReadonlyMap<VisualPartId, VisualBinding> {
    return this.bindings;
  }

  // Restyles the existing lights, fog, backdrop and materials in place; nothing is rebuilt.
  setTheme(theme: GameTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.themeWrites++;
    this.renderer.setClearColor(theme.sky);
    this.renderer.toneMappingExposure = theme.exposure;
    this.fog.color.set(theme.fog.color);
    this.updateFrustum();
    this.placeFog();
    for (const light of this.lights.hemisphere) {
      light.color.set(theme.hemisphere.sky);
      light.groundColor.set(theme.hemisphere.ground);
      light.intensity = theme.hemisphere.intensity;
    }
    for (const [lights, setting] of [
      [this.lights.ambient, theme.ambient], [this.lights.sun, theme.sun], [this.lights.rim, theme.rim],
    ] as const) {
      for (const light of lights) {
        light.color.set(setting.color);
        light.intensity = setting.intensity;
      }
    }
    call1(this.backdrop, 'setTheme', theme);
    call1(this.aimMarks, 'setTheme', theme);
    if (this.palette !== null) {
      for (const key of Object.keys(this.palette) as (keyof GameTheme['character'])[]) this.palette[key].color.set(theme.character[key]);
    }
  }

  applyEnemy(event: EnemyEvent): void { this.looks.applyEnemy(event); }

  setEnemyArt(art: EnemyArtSettings): void { this.looks.setEnemyArt(art); }

  addLayer(layer: SceneLayer, source: Pick<Attributed<unknown>, 'plugin' | 'point'> = ENGINE): void {
    const target = this.layers.get(layer) ?? attributed(source.plugin, source.point, layer);
    this.layers.set(layer, target);
    if (layer.update !== undefined) this.updatingLayers.add(target);
    const pass = layer.pass === 'course' ? this.course : layer.pass === 'actors' ? this.actors : this.marks;
    pass.add(layer.root);
  }

  // Removes a layer added with addLayer() and disposes it.
  removeLayer(layer: SceneLayer): void {
    const target = this.layers.get(layer);
    if (target === undefined) return;
    this.layers.delete(layer);
    this.updatingLayers.delete(target);
    layer.root.removeFromParent();
    if (layer.dispose !== undefined) call0(target, 'dispose');
  }

  // The current rig's read-only geometry, for a layer's initial state before its first drawn frame.
  get rigGeometry(): RigGeometry { return this.rig; }

  armPoses(): readonly ArmPose[] { return this.posedArms; }

  // Adds the release's second character profile; only the active profile renders and updates.
  createAlternateCharacter(): SpriteRig {
    if (this.slots.length >= MAX_CHARACTER_PROFILES) {
      throw new Error(`A game view shows at most ${MAX_CHARACTER_PROFILES} character profiles.`);
    }
    return this.createSlot().rig;
  }

  // Swaps presentation only, including grips and arm lengths: physics and level state are untouched and nothing reloads.
  selectCharacter(index: number): void {
    const slot = this.slots[index];
    if (!Number.isInteger(index) || slot === undefined) throw new Error(`Unknown character profile ${index}.`);
    if (this.placementHold.defer(() => this.selectCharacter(index))) return;
    if (index === this.activeSlot) return;
    this.activeSlot = index;
    for (const other of this.slots) {
      for (const mount of other.mounts) this.attach(mount.node, mount.parent, other === slot);
    }
    for (const [id, binding] of this.bindings) binding.visibility.setCovered({ covered: slot.coverage.get(id) ?? false });
    slot.rig.resetPresentation();
    this.applyPresentation();
    this.resetPoseHistory();
  }

  // Each arm's lengths as the active character type draws them without its own arm lengths.
  naturalArmLengths(): CharacterArms {
    const slot = this.slots[this.activeSlot];
    const type = (slot?.presentation ?? DEFAULT_PRESENTATION).characterRiggingType;
    const chains = type === 'avatar-3d' ? (this.parts.avatar?.view ?? slot?.avatar?.view)?.chains ?? DEFAULT_ARM_CHAINS : DEFAULT_ARM_CHAINS;
    const sprite = type === 'sprite-2d' ? slot?.rig.naturalArmLengths() ?? null : null;
    const side = (arm: ArmSide): ArmLengths => sprite?.[arm] ?? { upper: chains[arm].upper, forearm: chains[arm].forearm };
    return { left: side('left'), right: side('right') };
  }

  characterSelection(): { active: number; count: number; types: CharacterRiggingType[] } {
    return { active: this.activeSlot, count: this.slots.length, types: this.slots.map(slot => slot.presentation.characterRiggingType) };
  }

  // Validation report of a model loaded for the primary profile, for authoring tools.
  characterModelReport(source: string, usage: CharacterModelUsage) {
    return this.slots[0]?.pool.value(usage, source)?.report ?? null;
  }

  // Cancels and releases every profile, for example when the game stops.
  disposeCharacters(): void {
    const disposal = new Disposal();
    for (const slot of this.slots) {
      // Disposing the rig commits the default presentation, which releases every committed view
      // lease; the pool then aborts anything still in flight and disposes anything left.
      disposal.run(() => slot.rig.dispose());
      disposal.run(() => slot.pool.dispose());
    }
    for (const role of ['avatar', 'hammer', 'pot'] as const) disposal.run(() => this.disposePart(role));
    disposal.finish();
  }

  private createSlot(): CharacterSlot {
    const index = this.slots.length;
    const root = new Group();
    root.name = `character-${index}:sprites`;
    const foreground = new Group();
    foreground.name = `character-${index}:foreground-sprites`;
    const mounts: { node: Group; parent: Object3D }[] = [{ node: root, parent: this.actors }, { node: foreground, parent: this.foreground }];
    const coverage = new Map<string, boolean>();
    const anchors = new Map<string, SpriteAnchor>();
    let slot: CharacterSlot;
    for (const [id, binding] of this.bindings) {
      // Each profile draws under its own mount, so an inactive profile is hidden, not rebuilt.
      const node = new Group();
      node.name = `character-${index}:${id}`;
      mounts.push({ node, parent: binding.anchor });
      anchors.set(id, {
        node,
        renderRoot: HAMMER_PARTS.has(id) ? foreground : root,
        setCovered: (state) => {
          coverage.set(id, state.covered);
          if (this.slots[this.activeSlot] === slot) binding.visibility.setCovered(state);
        },
      });
    }
    const rig = new SpriteRig(anchors, {
      root, targetIds: SPRITE_TARGET_IDS,
      prepareCharacterPresentation: (settings) => this.prepareCharacterPresentation(slot, settings),
      headTracking: {
        anchor: 'character-head',
        pivot: { anchor: 'torso', x: HEAD_GEOMETRY.neck[0], y: HEAD_GEOMETRY.neck[1] },
      },
      prepareTexture: (texture) => this.renderer.initTexture(texture),
      characterAssets: { prepare: (document, signal) => this.prepareModels(slot, document, signal) },
      loadContent: this.content,
      armSlots: ARM_SLOTS,
    });
    slot = {
      index, rig, mounts, coverage, presentation: DEFAULT_PRESENTATION,
      // One pool per profile, so models never leak across profiles and each profile's admission
      // budget is its own.
      pool: new CharacterModelPool({
        load: async (model, usage, signal) => {
          if (this.characterModels === null) throw new SpriteError('This host cannot load character models.');
          return this.characterModels.load(model, usage, signal);
        },
      }),
      avatar: null, props: { hammer: null, pot: null },
    };
    for (const mount of mounts) this.attach(mount.node, mount.parent, index === this.activeSlot);
    this.slots.push(slot);
    return slot;
  }

  private async prepareModels(slot: CharacterSlot, document: SpriteDocument, signal: AbortSignal): Promise<CharacterAssetLease> {
    const leases: CharacterModelLease[] = [];
    try {
      if (document.avatar !== undefined && !this.reserved.has('avatar')) {
        leases.push((await this.acquireModel(slot, document, 'avatar', document.avatar.model, signal)).lease);
      }
      for (const role of PROP_MODEL_ROLES) {
        const prop = document[role];
        if (prop !== undefined && !this.reserved.has(role)) {
          leases.push((await this.acquireModel(slot, document, role, prop.model, signal)).lease);
        }
      }
      signal.throwIfAborted();
      return { release: () => { for (const lease of leases) lease.release(); } };
    } catch (error) {
      for (const lease of leases) lease.release();
      throw error;
    }
  }

  // Before characters load: parts that will show a library model, so no character loads its own
  // until the part returns to the characters' models.
  reserveParts(roles: Iterable<PartRole>): void {
    for (const role of roles) this.reserved.add(role);
  }

  // Shows a library model for one part in place of every character's own, or returns the part to
  // the characters' own models, loading any not loaded yet. Resolves once the part is visible; a
  // failure leaves the part as it was.
  async setPartModel(role: PartRole, part: PartModel | null, signal: AbortSignal): Promise<void> {
    await this.placementHold.wait(signal);
    if (part === null) {
      // Snapshot the committed slots and the library view before awaiting. Every character model is
      // loaded and every avatar rig pure-prepared from these snapshots; nothing in the scene or the
      // reservation changes until all of it has succeeded. Each load is a transaction lease, held
      // until this operation commits or fails.
      const snapshots = this.slots.map(slot => ({ slot, presentation: slot.presentation }));
      const library = this.parts[role];
      const prepared = new Map<CharacterSlot, PreparedAvatarView>();
      const leases: CharacterModelLease[] = [];
      try {
        for (const { slot, presentation } of snapshots) {
          if (role === 'avatar') {
            const avatar = presentation.avatar;
            if (avatar === undefined) continue;
            const holding = await this.acquireModel(slot, presentation, role, avatar.model, signal);
            leases.push(holding.lease);
            const view = this.prepareAvatarFrom(slot, holding.model, avatar);
            if (view !== null) prepared.set(slot, view);
          } else {
            const profile = presentation[role];
            if (profile === undefined) continue;
            leases.push((await this.acquireModel(slot, presentation, role, profile.model, signal)).lease);
          }
        }
        signal.throwIfAborted();
        await this.placementHold.wait(signal);
        // Immediately before any live mutation, refuse a slot, a presentation or the library view that
        // moved while the loads ran. The model and its compiled rig are bound together in `prepared`, so
        // the commit below never pairs a preparation with reread mutable state. On refusal the library
        // model, selection and reservation all stay exactly as they were.
        const superseded = this.parts[role] !== library || this.slots.length !== snapshots.length ||
          snapshots.some(({ slot, presentation }) => slot.presentation !== presentation || !this.slots.includes(slot));
        if (superseded) {
          throw new SpriteError(`The ${role} changed while its character models were loading; the library model stays as it was.`);
        }
        // Commit boundary: drop the reservation, then build every character's own view from the
        // immutable preparations above before dropping the library view. Each commit retains its own
        // pool reference, so releasing these transaction leases afterwards cannot evict a shown model.
        this.reserved.delete(role);
        for (const { slot } of snapshots) this.syncModelViews(slot, prepared.get(slot) ?? null);
        this.disposePart(role);
      } finally {
        for (const lease of leases) lease.release();
      }
    } else {
      const previous = this.parts[role];
      if (previous?.model === part.model && (role !== 'avatar' || part.avatar === (previous as PartViews['avatar'])!.settings)) return;
      if (role === 'avatar') {
        if (part.avatar === undefined) throw new SpriteError(`Library avatar "${part.id}" needs its settings.`);
        // Fitted and prepared before anything changes, so a failure leaves the part as it was. The
        // old view goes first: disposing a view detaches its model's scene, and new settings keep
        // the same model.
        const prepared = this.avatarRigs.prepare(part.model.report, part.avatar);
        this.disposePart(role);
        const view = new SkinnedAvatarView(part.model, prepared.resolved, part.avatar.boneMap, prepared.binds, prepared.motions);
        this.parts.avatar = {
          id: part.id, model: part.model, settings: part.avatar, driver: part.avatar.driver, hair: part.avatar.hair,
          motion: part.avatar.motion, motions: prepared.motions, boneMap: part.avatar.boneMap, resolved: prepared.resolved, binds: prepared.binds,
          rig: prepared.rig, plan: createFramePlan(), pose: createPose(), view,
          solvers: { left: new ArmPoseSolver('left'), right: new ArmPoseSolver('right') },
        };
      } else {
        const fit = role === 'hammer' ? new HammerHandleFit(part.model, this.rig.handleLength) : null;
        const view = new PropModelView(part.model, PROP_VIEW_NAMES[role]);
        this.disposePart(role);
        if (role === 'hammer') this.parts.hammer = { id: part.id, model: part.model, view, fit: fit! };
        else this.parts.pot = { id: part.id, model: part.model, view };
      }
    }
    this.applyPresentation();
  }

  // Rocks (sway) or kicks (jolt) the upper body about the waist for a moment, so an avatar's secondary motion can be
  // judged without playing. Presentation only, like the waist lean it adds to.
  previewMotion(kind: LeanPreview): void {
    this.presentationPreview = null;
    this.waistLean.preview(kind);
  }

  // Runs `preview`, ending any other.
  previewPresentation(preview: PresentationPreview): void {
    this.waistLean.endPreview();
    this.presentationPreview = { preview, start: null };
  }

  // Ends `preview` if it still runs.
  endPresentationPreview(preview: PresentationPreview): void {
    if (this.presentationPreview?.preview === preview) this.presentationPreview = null;
  }

  // The imported avatar the character shows, the same object until it changes; null for any other avatar.
  importedAvatar(): ImportedAvatarFacts | null {
    const avatar = this.activeAvatar;
    if (avatar === null || !(this.avatarRenderer instanceof SkinnedAvatarView)) return null;
    const cached = this.avatarFacts;
    if (cached !== null && cached.avatar === avatar && cached.motions === avatar.motions) return cached.facts;
    const view = avatar.view;
    const facts: ImportedAvatarFacts = Object.freeze({
      model: avatar.motions.model,
      motions: Object.freeze(avatar.motions.motions.map(({ id, claims }) => Object.freeze({ id, claims }))),
      jointWorld: (index: number, out: Matrix4) => view.jointWorld(index, out),
    });
    this.avatarFacts = { avatar, motions: avatar.motions, facts };
    return facts;
  }

  // The library model each part shows, or null where characters show their own.
  partModels(): Record<PartRole, string | null> {
    return { avatar: this.parts.avatar?.id ?? null, hammer: this.parts.hammer?.id ?? null, pot: this.parts.pot?.id ?? null };
  }

  private disposePart(role: PartRole): void {
    const part = this.parts[role];
    if (part === null) return;
    const fit = role === 'hammer' ? this.parts.hammer!.fit : null;
    this.parts[role] = null;
    const disposal = new Disposal();
    disposal.run(() => part.view.root.removeFromParent());
    disposal.run(() => part.view.dispose());
    disposal.run(() => fit?.dispose());
    disposal.finish();
  }

  // A single-flight acquisition of one model for an operation. The lease is registered before the
  // await and held until the operation commits or fails; any other caller that needs the same source
  // shares the one load, and only the last release aborts or disposes it.
  private async acquireModel(
    slot: CharacterSlot, assets: CharacterAssets, usage: CharacterModelUsage, id: string, signal: AbortSignal,
  ): Promise<ModelHolding> {
    const model = characterModel(assets, id);
    const lease = slot.pool.acquire(model, usage, signal);
    try {
      const loaded = await lease.loaded;
      signal.throwIfAborted();
      return { lease, model: loaded };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  // Pure preparation for the presentation a change selects, run before any committed presentation or
  // scene changes. Returns the commit that installs the exact settings it prepared, so a strategy
  // refusal leaves both the committed presentation and the avatar that was showing untouched.
  private prepareCharacterPresentation(slot: CharacterSlot, settings: CharacterPresentation): () => void {
    const prepared = this.prepareProfileAvatar(slot, settings);
    return () => {
      slot.presentation = settings;
      this.syncModelViews(slot, prepared);
      if (this.slots[this.activeSlot] === slot) this.applyPresentation();
    };
  }

  // Pure preparation for the avatar a presentation selects: resolves and fits the model and runs the
  // strategy's prepare, all before any scene is touched. Returns null when the slot keeps its current
  // avatar view, has none to build, or has the part reserved for a library model.
  private prepareProfileAvatar(slot: CharacterSlot, presentation: CharacterPresentation): PreparedAvatarView | null {
    const avatar = presentation.avatar;
    if (avatar === undefined) return null;
    const loaded = this.resolvedModel(slot, presentation, 'avatar', avatar.model);
    if (loaded === null) return null;
    return this.prepareAvatarFrom(slot, loaded, avatar);
  }

  // The single cached-vs-reserved decision: the model a presentation references from the slot's
  // cache, or null when the part is reserved for a library model and its own was therefore never
  // loaded. Any other miss is a programmer error, because preparation loads every model a commit
  // needs before the commit runs.
  private resolvedModel(slot: CharacterSlot, presentation: CharacterPresentation,
    usage: CharacterModelUsage, id: string): LoadedCharacterModel | null {
    const model = characterModel(presentation, id);
    const loaded = slot.pool.value(usage, model.source);
    if (loaded !== undefined) return loaded;
    if (this.reserved.has(usage)) return null;
    throw new SpriteError(`Character model "${model.name}" was not loaded before use.`);
  }

  // The pure preparation for an avatar view from an already-resolved model, unless the slot already
  // shows that exact model and settings. The slot's view keeps showing a model fitted with the same
  // bone map and driver, taking only new hair and motions. Shared by presentation changes and part
  // restores, so a prepared rig and motions are always bound to the model and settings they were
  // prepared from.
  private prepareAvatarFrom(slot: CharacterSlot, loaded: LoadedCharacterModel,
    avatar: AvatarModelSettings): PreparedAvatarView | null {
    const current = slot.avatar;
    if (current !== null && current.model === loaded && sameBoneMap(current.boneMap, avatar.boneMap) &&
      sameAvatarDriver(current.driver, avatar.driver)) {
      if (sameAvatarMotions(current, avatar)) return null;
      return {
        kind: 'motions', view: current.view, hair: avatar.hair, motion: avatar.motion,
        motions: this.avatarRigs.prepareMotions(loaded.report, current.resolved, current.binds, avatar,
          { settings: current, motions: current.motions }),
      };
    }
    return {
      kind: 'view', model: loaded, boneMap: avatar.boneMap, driver: avatar.driver, hair: avatar.hair, motion: avatar.motion,
      prepared: this.avatarRigs.prepare(loaded.report, avatar),
    };
  }

  // Commits views for the models a slot's committed presentation references, reusing the pure
  // preparation the caller computed before any scene change. Callers pass the prepared avatar for any
  // avatar this commit builds or whose motions it replaces; null means the slot keeps its current avatar view.
  private syncModelViews(slot: CharacterSlot, preparation: PreparedAvatarView | null): void {
    if (preparation?.kind === 'motions') {
      const current = slot.avatar;
      if (current?.view !== preparation.view) throw new Error('Avatar motions were prepared for a view the character no longer shows.');
      current.view.setMotions(preparation.motions);
      current.motions = preparation.motions;
      current.hair = preparation.hair;
      current.motion = preparation.motion;
    }
    const preparedAvatar = preparation?.kind === 'view' ? preparation : null;
    const { avatar } = slot.presentation;
    const avatarModel = avatar === undefined ? null : this.resolvedModel(slot, slot.presentation, 'avatar', avatar.model);
    const current = slot.avatar;
    const replaceAvatar = current !== null && (avatar === undefined || avatarModel === null ||
      current.model !== avatarModel || !sameAvatarModelSettings(current, avatar));
    // Take the replacement reference before dropping the old one, so a model shared by both views
    // never reaches zero references in the middle of the commit.
    const avatarLease = preparedAvatar === null ? null : slot.pool.hold(preparedAvatar.model);
    if (replaceAvatar) {
      current.view.dispose();
      current.lease.release();
      slot.avatar = null;
    }
    if (preparedAvatar !== null && avatarLease !== null) {
      const { prepared } = preparedAvatar;
      const view = new SkinnedAvatarView(preparedAvatar.model, prepared.resolved, preparedAvatar.boneMap, prepared.binds, prepared.motions);
      slot.avatar = {
        model: preparedAvatar.model, boneMap: preparedAvatar.boneMap, driver: preparedAvatar.driver, hair: preparedAvatar.hair,
        motion: preparedAvatar.motion, motions: prepared.motions, resolved: prepared.resolved, binds: prepared.binds,
        rig: prepared.rig, plan: createFramePlan(), pose: createPose(), view,
        solvers: { left: new ArmPoseSolver('left'), right: new ArmPoseSolver('right') }, lease: avatarLease,
      };
    }
    for (const role of PROP_MODEL_ROLES) {
      const profile = slot.presentation[role];
      const model = profile === undefined ? null : this.resolvedModel(slot, slot.presentation, role, profile.model);
      const current = slot.props[role];
      if (current !== null && current.model === model) continue;
      if (model === null) {
        this.releaseProp(slot, role);
        continue;
      }
      const lease = slot.pool.hold(model);
      this.releaseProp(slot, role);
      slot.props[role] = this.mountProp(role, model, lease);
    }
  }

  // Builds one committed prop view, fitting a hammer's handle to the game's rig.
  private mountProp(role: PropModelRole, model: LoadedCharacterModel, lease: CharacterModelLease): OwnedProp {
    const fit = role === 'hammer' ? new HammerHandleFit(model, this.rig.handleLength) : null;
    const view = new PropModelView(model, PROP_VIEW_NAMES[role]);
    return { model, lease, view, fit };
  }

  // Drops one committed prop view, releasing its pool reference last so the model stays alive until
  // the scene no longer draws it.
  private releaseProp(slot: CharacterSlot, role: PropModelRole): void {
    const current = slot.props[role];
    if (current === null) return;
    current.view.dispose();
    current.fit?.dispose();
    current.lease.release();
    slot.props[role] = null;
  }

  private applyPresentation(): void {
    const slot = this.slots[this.activeSlot];
    const character = slot?.presentation ?? DEFAULT_PRESENTATION;
    const type = character.characterRiggingType;
    const avatarMode = type === 'avatar-3d';
    // A library avatar replaces an Avatar character's own, with the settings its proportions need.
    const partAvatar = avatarMode ? this.parts.avatar : null;
    const presentation = partAvatar === null ? character : { ...character, ...partAvatar.settings };
    const upperBody3d = UPPER_BODY_3D[type];
    this.armsOverBody = upperBody3d;
    this.toolDepth = getToolDepth(upperBody3d ? presentation.armForwardDistance : DEFAULT_ARM_FORWARD_DISTANCE);
    const maxWaistLean = upperBody3d ? presentation.waistLean : 0;
    // A new lean applies at once, also while time stands still, rather than easing in from the previous one.
    if (maxWaistLean !== this.maxWaistLean) this.waistLean.reset();
    this.maxWaistLean = maxWaistLean;
    const imported = avatarMode ? partAvatar?.view ?? slot?.avatar?.view ?? null : null;
    if (avatarMode && imported === null && this.avatar === null) this.avatar = new AvatarView();
    this.avatarRenderer = !avatarMode ? null : imported ?? this.avatar;
    // The prepared rig the frame plan and pose phases use, or null for the built-in zero-offset avatar.
    const previousAvatar = this.activeAvatar;
    this.activeAvatar = avatarMode ? partAvatar ?? slot?.avatar ?? null : null;
    const headBind = this.activeAvatar?.binds.joints.head;
    if (headBind === undefined) this.headPivot.fromArray(HEAD_GEOMETRY.neck);
    else this.headPivot.setFromMatrixPosition(headBind);
    // A newly activated avatar solves arms from its own bind, never the pose the previous avatar left.
    if (this.activeAvatar !== previousAvatar) this.resetPoseHistory();
    if (this.avatar !== null) this.attach(this.avatar.root, this.actors, this.avatarRenderer === this.avatar);
    for (const other of this.slots) {
      if (other.avatar !== null) this.attach(other.avatar.view.root, this.actors, other.avatar.view === imported);
      // Prop models show in every character type. The hammer draws in the tool's foreground pass;
      // the pot draws in the actors pass, so its walls hide a body inside it through the depth buffer.
      for (const role of PROP_MODEL_ROLES) {
        const prop = other.props[role];
        if (prop !== null) this.attach(prop.view.root, role === 'hammer' ? this.foreground : this.actors, other === slot && this.parts[role] === null);
      }
    }
    // Library models show for every character, the hammer and pot in every character type.
    if (this.parts.avatar !== null) this.attach(this.parts.avatar.view.root, this.actors, this.parts.avatar.view === imported);
    for (const role of PROP_MODEL_ROLES) {
      const part = this.parts[role];
      if (part !== null) this.attach(part.view.root, role === 'hammer' ? this.foreground : this.actors, true);
      this.propModels[role] = part?.view ?? slot?.props[role]?.view ?? null;
    }
    for (const [id, binding] of this.bindings) {
      const replaced = this.propModels.hammer !== null && HAMMER_PARTS.has(id) || this.propModels.pot !== null && id === 'pot';
      binding.visibility.setEnabled({ enabled: (!avatarMode || PROP_PARTS.has(id)) && !replaced });
    }
    this.armChains = withArmLengths(imported?.chains ?? DEFAULT_ARM_CHAINS, presentation.arms);
    // New grips put the hands back on them; a new slide point or hand turn leaves them where they hold.
    const grips = presentation.grips;
    if (grips.placement !== this.grips.placement || grips.left !== this.grips.left || grips.right !== this.grips.right) {
      this.gripHold.reset();
    }
    this.grips = grips;
    this.spriteArms = type === 'sprite-2d';
    // 2D characters keep the wrist rotation authored on their IK chains, and their art hangs from these
    // hand anchors, so only 3D hands turn on their grips.
    const rotation = this.spriteArms ? null : this.grips.rotation;
    this.gripRotations = rotation === null ? { left: null, right: null }
      : { left: gripQuaternion(rotation.left), right: gripQuaternion(rotation.right) };
    if (slot !== undefined && this.cameraView.death !== null) {
      slot.rig.setDying(true, this.deathInput.body === 'ragdoll');
      slot.rig.setDeathBrightness(this.spriteArms ? this.deathPose.spriteBrightness : 1);
    }
  }

  private attach(object: Object3D, parent: Object3D, attached: boolean): void {
    object.visible = attached;
    if (!attached) object.removeFromParent();
    else if (object.parent !== parent) parent.add(object);
  }

  render(physics: PhysicsFrame, options: CharacterState & { dt: number; death: DeathFrame | null }): void {
    this.renders++;
    this.syncRig(physics);
    this.syncHead(this.part(physics, 'head').vertices);
    // The camera follows the simulation; the character draws where a presentation preview moves it.
    const focus = physics.player.centre;
    const reach = this.part(physics, 'head');
    this.cameraView.focus.x = focus.x;
    this.cameraView.focus.y = focus.y;
    this.cameraView.reach.x = reach.x;
    this.cameraView.reach.y = reach.y;
    const frame = this.presentedFrame(physics);
    const tip = this.part(frame, 'head');
    this.updateCamera(options.dt, false);
    call1(this.backdrop, 'follow', this.cameraAim);
    this.posePlayer(frame, options, frame === physics ? 0 : this.previewOffset.turn);
    call3(this.aimMarks, 'update', tip, frame.cursor, this.cameraView.death);
    this.terrain.update(frame.time);
    this.decorations?.update();
    this.looks.update(frame.time, frame.projectiles, frame.enemies, frame.platforms);
    if (this.updatingLayers.size > 0 || this.hurtShowing || this.blockShowing) {
      const shown = this.sceneFrame;
      shown.time = physics.time;
      shown.parts = physics.parts;
      shown.player = this.scenePlayer(physics.player);
      shown.cursor = physics.cursor;
      shown.enemies = physics.enemies;
      shown.rig = physics.rig;
      for (const layer of this.updatingLayers) call1(layer, 'update', shown);
      if (this.hurtShowing) this.hurtShowing = this.updateHurt(shown);
      if (this.blockShowing) this.blockShowing = this.updateBlock(shown);
    }
    this.renderer.info.reset();
    this.renderer.clear();
    if (this.backdrop.value.root.visible) this.renderer.render(this.backdropScene, this.camera);
    this.renderer.render(this.course, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.actors, this.camera);
    if (this.drawsFront()) {
      this.renderer.clearDepth();
      this.renderer.render(this.front, this.camera);
    }
    this.renderer.clearDepth();
    if (this.armsOverBody) {
      this.camera.layers.set(ARM_LAYER);
      this.actors.matrixWorldAutoUpdate = false;
      try { this.renderer.render(this.actors, this.camera); } finally {
        this.actors.matrixWorldAutoUpdate = true;
        this.camera.layers.set(DEFAULT_LAYER);
      }
    }
    this.renderer.render(this.marks, this.camera);
    this.renderer.render(this.foreground, this.camera);
  }

  // The same terminal-frame evaluation seeds death and draws live play. It does not render,
  // move the camera or stage effects; released poses never visit live grip placement or IK.
  private posePlayer(frame: PhysicsFrame, options: CharacterState & { dt: number; death: DeathFrame | null }, turn = 0): void {
    const player = frame.player, root = player.centre, tip = this.part(frame, 'head');
    const released = player.phase === 'dying-ragdoll';
    const depth = released ? OBSTACLE_LINE : this.toolDepth;
    for (const part of frame.parts) {
      const mesh = this.playerMeshes.get(part.id);
      if (!mesh) continue;
      mesh.position.set(part.x, part.y, part.kind === 'pot' ? PLAYER_DEPTH.pot : depth);
      mesh.rotation.z = part.angle;
      if (part.kind === 'pot') {
        // The jar's frame: origin at the physical pot's bottom-centre, at the pot's own depth. The pot model and
        // hair colliders held by the jar follow it.
        const cos = Math.cos(part.angle), sin = Math.sin(part.angle);
        this.potFrame.makeRotationZ(part.angle)
          .setPosition(part.x - RIG.potBottom * sin, part.y + RIG.potBottom * cos, PLAYER_DEPTH.pot);
        this.propModels.pot?.update(this.potFrame);
      }
    }
    const shaftBase = this.part(frame, 'slider');
    const shaftLength = Math.hypot(tip.x - shaftBase.x, tip.y - shaftBase.y);
    const shaftCenter = this.shaftCenter;
    shaftCenter.x = (shaftBase.x + tip.x) / 2;
    shaftCenter.y = (shaftBase.y + tip.y) / 2;
    const shaftAngle = shaftLength <= PHYSICS.aimEpsilon ? shaftBase.angle : Math.atan2(tip.y - shaftBase.y, tip.x - shaftBase.x);
    const turnCos = Math.cos(turn), turnSin = Math.sin(turn);
    const aim = this.aim;
    const headAnchor = this.bindings.get('character-head')!.anchor;
    headAnchor.matrixAutoUpdate = false;
    this.customShaft.position.set(shaftCenter.x, shaftCenter.y, depth);
    this.customShaft.rotation.z = shaftAngle;
    this.customShaft.scale.x = shaftLength / SHAFT_ARTWORK_LENGTH;
    this.toolFrame.makeRotationZ(shaftAngle).setPosition(shaftBase.x, shaftBase.y, depth);
    let armPoses: ArmPose[];
    if (player.phase === 'alive') {
      headAnchor.matrix.identity();
      headAnchor.matrixWorldNeedsUpdate = true;
      this.waistLean.update(shaftAngle - turn, this.maxWaistLean, frame.time);
      const lean = this.waistLean.angle;
      const origin = this.waistLean.torsoOrigin(root.x, root.y, this.torsoOrigin, lean);
      if (turn !== 0) {
        const dx = origin.x - root.x, dy = origin.y - root.y;
        origin.x = root.x + dx * turnCos - dy * turnSin;
        origin.y = root.y + dx * turnSin + dy * turnCos;
      }
      this.torso.position.set(origin.x, origin.y, PLAYER_DEPTH.torso);
      this.torso.rotation.z = lean + turn;
      this.torso.updateWorldMatrix(true, false);
      aim.x = frame.cursor.x - player.shoulder.x;
      aim.y = frame.cursor.y - player.shoulder.y;
      const cos = Math.cos(lean + turn), sin = Math.sin(lean + turn);
      this.localAim.x = aim.x * cos + aim.y * sin;
      this.localAim.y = aim.y * cos - aim.x * sin;
      this.headAim.update(this.localAim, frame.time);
      this.headRotation.copy(this.headAim.rotation);
      this.headOffset.copy(this.headPivot).applyQuaternion(this.headRotation).negate().add(this.headPivot);
      this.meshHead.matrix.makeRotationFromQuaternion(this.headRotation).setPosition(this.headOffset);
      this.meshHead.matrixWorldNeedsUpdate = true;
      armPoses = this.updateArms(this.torso.matrixWorld, this.toolFrame, shaftLength, options, shaftAngle);
    } else {
      const death = options.death;
      if (death === null) throw new Error('A physical death frame needs the active death sequence.');
      const input = this.deathInput;
      input.elapsed = death.elapsed; input.duration = death.duration;
      input.poseProgress = death.poseProgress; input.reducedMotion = death.reducedMotion;
      input.character = this.slots[this.activeSlot]!.presentation.characterRiggingType;
      input.body = released ? 'ragdoll' : 'rigid'; input.attachment = released ? 'released' : 'gripped';
      input.physical = player.pose; input.headFacing = player.headFacing; input.layout = player.layout;
      input.direction = player.direction; input.grippedArms = null;
      // Hold retains the existing grip-driven 3D solutions, including depth and rig wrist tracks.
      // The pure writer gets their numeric baseline, so its default changes no held-hand behaviour.
      if (!released) {
        DEFAULT_DEATH_POSE(input, this.heldDefault);
        this.placeTorso(this.heldDefault, PLAYER_DEPTH.torso);
        const live = this.updateArms(this.torso.matrixWorld, this.toolFrame, shaftLength, options, shaftAngle, false);
        this.writeArmPoints(live, this.grippedPose);
        input.grippedArms = this.grippedPose.arms;
      }
      this.deathWriter(input, this.deathPose);
      this.slots[this.activeSlot]!.rig.setDeathBrightness(this.spriteArms ? this.deathPose.spriteBrightness : 1);
      this.placeTorso(this.deathPose, released ? OBSTACLE_LINE : PLAYER_DEPTH.torso);
      this.placeDeathHead(this.deathPose, released);
      if (released || this.spriteArms) {
        headAnchor.matrix.copy(this.headDelta);
        this.meshHead.matrix.identity();
      } else {
        headAnchor.matrix.identity();
        this.meshHead.matrix.copy(this.headDelta);
      }
      headAnchor.matrixWorldNeedsUpdate = this.meshHead.matrixWorldNeedsUpdate = true;
      aim.x = this.spriteAim.x; aim.y = this.spriteAim.y;
      armPoses = this.updateDeathArms(this.deathPose, released, options.dt);
    }
    if (this.avatarRenderer instanceof SkinnedAvatarView) {
      this.avatarRenderer.apply(this.torso.matrixWorld, this.potFrame, this.headRotation, this.activeAvatar!.pose, frame.time,
        player.phase === 'alive' ? null : this.headDelta);
    } else if (this.avatarRenderer !== null) {
      this.avatarRenderer.update(this.torso.matrixWorld, armPoses, this.headRotation,
        released ? this.gloveTurns : this.turnGloves(), player.phase === 'alive' ? null : this.headDelta);
    }
    // The one-model hammer follows the physical tool frame; its handle is fitted to the rig, not per frame.
    this.propModels.hammer?.update(this.toolFrame);
    for (const pose of armPoses) {
      if (released) this.spriteContact.copy(pose.hand);
      else this.spriteContact.set(this.gripDistances[pose.side], 0, 0).applyMatrix4(this.toolFrame);
      const target = this.spriteTargets.get(ARM_SLOTS[pose.side].target)!;
      target.x = this.spriteContact.x;
      target.y = this.spriteContact.y;
      target.angle = Math.atan2(pose.shaftAxis.y, pose.shaftAxis.x);
    }
    const baseTarget = this.spriteTargets.get('hammer-base')!;
    baseTarget.x = shaftBase.x; baseTarget.y = shaftBase.y; baseTarget.angle = shaftAngle;
    const shaftTarget = this.spriteTargets.get('hammer-shaft')!;
    shaftTarget.x = shaftCenter.x; shaftTarget.y = shaftCenter.y; shaftTarget.angle = shaftAngle;
    const headTarget = this.spriteTargets.get('hammer-head')!;
    headTarget.x = tip.x; headTarget.y = tip.y; headTarget.angle = tip.angle;
    const aimTarget = this.spriteTargets.get('aim')!;
    aimTarget.x = frame.cursor.x; aimTarget.y = frame.cursor.y; aimTarget.angle = Math.atan2(aim.y, aim.x);
    const spriteAim = this.spriteAim;
    spriteAim.x = aim.x * turnCos + aim.y * turnSin;
    spriteAim.y = aim.y * turnCos - aim.x * turnSin;
    this.spriteFrame.time = frame.time;
    this.spriteFrame.dt = options.dt;
    this.slots[this.activeSlot]!.rig.update(this.spriteFrame);
  }

  writeDeathSeed(frame: PhysicsFrame, out: DeathSeed, armIk: Readonly<ArmIkSettings>): void {
    if (frame.player.phase !== 'alive') throw new Error('A death seed must be evaluated from a live terminal frame.');
    this.syncRig(frame); this.syncHead(this.part(frame, 'head').vertices);
    this.presentationPreview = null;
    Object.assign(this.capturedArmIk, armIk);
    this.posePlayer(frame, { armIk, dt: 0, death: null });
    out.placement = frame.placement; out.time = frame.time;
    out.centre.x = frame.player.centre.x; out.centre.y = frame.player.centre.y; out.centre.angle = frame.player.centre.angle;
    out.pose.torso.x = this.torso.position.x; out.pose.torso.y = this.torso.position.y; out.pose.torso.angle = this.torso.rotation.z;
    out.layout.waist.x = 0; out.layout.waist.y = Math.max(...RIG.potVertices.map(point => point.y));
    out.layout.neck.x = this.headPivot.x; out.layout.neck.y = this.headPivot.y;
    this.headCentreLocal.copy(this.headPivot);
    this.headCentreLocal.y += PLAYER_FIGURE.helmet.y - PLAYER_FIGURE.neck.y;
    this.headCentre.copy(this.headCentreLocal).applyMatrix4(this.meshHead.matrix).applyMatrix4(this.torso.matrixWorld);
    out.pose.head.x = this.headCentre.x; out.pose.head.y = this.headCentre.y; out.pose.head.angle = this.torso.rotation.z;
    copyRotation(out.headFacing, this.headRotation);
    this.writeArmPoints(this.posedArms, out.pose);
    if (this.spriteArms) {
      const rig = this.slots[this.activeSlot]!.rig;
      for (const side of ARM_SIDES) rig.writeDeathArm(side, out.pose.arms[side]);
      if (rig.writeDeathHead(out.pose.head, this.spriteNeck)) {
        this.inverseBody.copy(this.torso.matrixWorld).invert();
        this.headCentre.set(out.pose.head.x, out.pose.head.y, PLAYER_DEPTH.torso);
        this.headCentreLocal.copy(this.headCentre).applyMatrix4(this.inverseBody);
        this.gripShoulder.set(this.spriteNeck.x, this.spriteNeck.y, PLAYER_DEPTH.torso).applyMatrix4(this.inverseBody);
        out.layout.neck.x = this.gripShoulder.x; out.layout.neck.y = this.gripShoulder.y;
        out.headFacing.x = out.headFacing.y = out.headFacing.z = 0; out.headFacing.w = 1;
      }
    }
    this.capturedHeadAngle = out.pose.head.angle; this.capturedTorsoAngle = out.pose.torso.angle;
    out.direction = this.part(frame, 'head').x < frame.player.centre.x ? -1 : 1;
  }

  private writeArmPoints(poses: readonly ArmPose[], out: DeathPose): void {
    for (const pose of poses) {
      const arm = out.arms[pose.side];
      arm.shoulder.x = pose.shoulder.x; arm.shoulder.y = pose.shoulder.y;
      arm.elbow.x = pose.elbow.x; arm.elbow.y = pose.elbow.y;
      arm.hand.x = pose.hand.x; arm.hand.y = pose.hand.y;
      arm.hand.angle = Math.atan2(pose.shaftAxis.y, pose.shaftAxis.x);
    }
  }

  private placeTorso(pose: DeathPose, depth: number): void {
    this.torso.position.set(pose.torso.x, pose.torso.y, depth);
    this.torso.rotation.z = pose.torso.angle;
    this.torso.updateWorldMatrix(true, false);
  }

  private placeDeathHead(pose: DeathAppearance, released: boolean): void {
    this.headRotation.set(pose.headFacing.x, pose.headFacing.y, pose.headFacing.z, pose.headFacing.w);
    const angle = this.spriteArms ? pose.head.angle - this.capturedHeadAngle + this.capturedTorsoAngle : pose.head.angle;
    this.headRoll.setFromAxisAngle(this.zAxis, angle).multiply(this.headRotation);
    const from = this.deathInput.headFacing, to = pose.headFacing;
    const nodDepth = 2 * (PLAYER_FIGURE.helmet.y - PLAYER_FIGURE.neck.y) *
      (to.x * to.w + to.y * to.z - from.x * from.w - from.y * from.z);
    this.headWorld.makeRotationFromQuaternion(this.headRoll).setPosition(pose.head.x, pose.head.y,
      released ? OBSTACLE_LINE : this.headCentre.z + nodDepth);
    this.inverseBody.copy(this.torso.matrixWorld).invert();
    this.headDelta.multiplyMatrices(this.inverseBody, this.headWorld);
    this.headWorld.makeTranslation(-this.headCentreLocal.x, -this.headCentreLocal.y, -this.headCentreLocal.z);
    this.headDelta.multiply(this.headWorld);
  }

  private scenePlayer(player: PlayerFrameState): ScenePlayerFrame {
    if (player.phase === 'alive') return player;
    const shown = this.sceneDeathPlayer;
    shown.phase = player.phase; shown.centre = player.centre; shown.pose = player.pose;
    shown.layout = player.layout; shown.headFacing = player.headFacing; shown.direction = player.direction;
    return shown;
  }

  // A hit took health, the killing one when `fatal`: the hurt effects take it, then update on drawn frames until done.
  hurt(cause: Readonly<HurtCause>, fatal: boolean): void {
    call2(this.hurtEffects, 'hurt', cause, fatal);
    this.hurtShowing = true;
  }

  block(hit: Readonly<ProjectileBlock>): void {
    call1(this.blockEffects, 'block', hit);
    this.blockShowing = true;
  }

  beginDeath(frame: PhysicsFrame, kind: DeathKind): void {
    this.cameraView.death = kind;
    this.presentationPreview = null;
    if (frame.player.phase === 'alive') throw new Error('Death presentation needs the simulation death phase.');
    this.deathInput.direction = frame.player.direction;
    this.deathInput.body = frame.player.phase === 'dying-ragdoll' ? 'ragdoll' : 'rigid';
    this.placementHold.begin();
    this.slots[this.activeSlot]!.rig.setDying(true, frame.player.phase === 'dying-ragdoll');
  }

  cancelDeath(): void {
    this.cameraView.death = null;
    this.deathInput.poseProgress = 0;
    this.deathPose.spriteBrightness = 1;
    for (const slot of this.slots) {
      slot.rig.setDying(false);
      slot.rig.setDeathBrightness(1);
    }
  }

  // The player was placed anew: the hurt effects following the character end.
  clearHurt(): void {
    call0(this.hurtEffects, 'clear');
    this.hurtShowing = true;
  }

  private updateHurt(frame: SceneFrame): boolean {
    const showing = call1(this.hurtEffects, 'update', frame);
    if (typeof showing !== 'boolean') {
      throw invalidResult(this.hurtEffects, 'update(frame) must return a boolean');
    }
    return showing;
  }

  private updateBlock(frame: SceneFrame): boolean {
    const showing = call1(this.blockEffects, 'update', frame);
    if (typeof showing !== 'boolean') {
      throw invalidResult(this.blockEffects, 'update(frame) must return a boolean');
    }
    return showing;
  }

  recenter(frame: PhysicsFrame): void {
    this.syncRig(frame);
    const root = frame.player.centre;
    const tip = this.part(frame, 'head');
    this.syncHead(tip.vertices);
    this.cameraView.focus.x = root.x;
    this.cameraView.focus.y = root.y;
    this.cameraView.reach.x = tip.x;
    this.cameraView.reach.y = tip.y;
    this.snapCamera();
  }

  // Settles the character's presentation, for a player placed anew: at a restart, or back at a bonfire while time goes on.
  resetPresentation(): void {
    this.presentationPreview = null;
    this.headAim.reset();
    this.waistLean.reset();
    this.gripHold.reset();
    for (const slot of this.slots) slot.rig.resetPresentation();
    this.placementHold.place();
    if (this.avatarRenderer instanceof SkinnedAvatarView) this.avatarRenderer.interrupt();
    this.resetPoseHistory();
  }

  // Clears the arm-solver history so a newly activated avatar bends from its own bind rather than
  // continuing the pose of the avatar that was showing before it.
  private resetPoseHistory(): void {
    for (const arm of this.arms.values()) arm.solver.reset();
    if (this.activeAvatar !== null) {
      this.activeAvatar.solvers.left.reset();
      this.activeAvatar.solvers.right.reset();
    }
  }

  private snapCamera(): void {
    this.updateCamera(0, true);
  }

  private updateCamera(dt: number, snap: boolean): void {
    const view = this.cameraView;
    view.reachRadius = this.hammerRadius;
    view.maxReach = this.rig.maxReach;
    view.width = this.width;
    view.height = this.height;
    view.dt = dt;
    const aim = this.cameraAim;
    aim.x = this.camera.position.x;
    aim.y = this.camera.position.y;
    aim.worldHeight = this.worldHeight;
    if (this.framing !== null) {
      aim.x = this.framing.x;
      aim.y = this.framing.y;
      aim.worldHeight = this.framing.worldHeight;
    } else {
      call2(this.director, snap ? 'snap' : 'aim', view, aim);
      checkCameraAim(aim, this.director);
    }
    this.updateFrustum();
    this.camera.position.set(aim.x, aim.y, this.distance);
    this.camera.updateMatrixWorld();
  }

  // Mouse gain follows the director's worldHeight; touch gain stays reach-based and independent of zoom.
  pointerDelta(pixels: Readonly<Point>, sensitivity: number, mode: InputMode, out: Point): void {
    const scale = (mode === 'touch' ? this.rig.maxReach / VISUAL.touchPixelsPerReach :
      this.worldHeight / this.height) * sensitivity;
    out.x = pixels.x * scale;
    out.y = -pixels.y * scale;
  }

  project(point: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    this.projection.set(point.x, point.y, OBSTACLE_LINE).project(this.camera);
    return {
      x: rect.left + (this.projection.x + 1) * this.width / 2,
      y: rect.top + (1 - this.projection.y) * this.height / 2,
    };
  }

  // Where a point at depth `z` is drawn, or null when it is at or behind the camera.
  projectDepth(point: Point, z: number): Point | null {
    const scale = this.depthScale(z);
    if (scale === null) return null;
    const { x, y } = this.camera.position;
    return this.project({ x: x + (point.x - x) * scale, y: y + (point.y - y) * scale });
  }

  // The point at depth `z` under a client position, or null when that depth is at or behind the camera.
  unprojectDepth(client: Point, z: number): Point | null {
    const scale = this.depthScale(z);
    if (scale === null) return null;
    const plane = this.unproject(client);
    const { x, y } = this.camera.position;
    return { x: x + (plane.x - x) / scale, y: y + (plane.y - y) / scale };
  }

  // How much larger than on the course plane something at depth `z` looks, measured from the view's centre.
  private depthScale(z: number): number | null {
    if (this.camera !== this.perspective) return 1;
    const distance = this.distance - z;
    return distance <= this.perspective.near ? null : this.distance / distance;
  }

  // The point on the course plane under a client position.
  unproject(client: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    const { halfWidth, halfHeight } = this.halfExtents();
    return {
      x: this.camera.position.x + ((client.x - rect.left) / rect.width * 2 - 1) * halfWidth,
      y: this.camera.position.y + (1 - (client.y - rect.top) / rect.height * 2) * halfHeight,
    };
  }

  setFraming(framing: CameraFraming | null): void {
    if (framing !== null && (![framing.x, framing.y, framing.worldHeight].every(Number.isFinite) || framing.worldHeight <= 0)) {
      throw new Error('Camera framing must have finite coordinates and a positive height.');
    }
    this.framing = framing === null ? null : { ...framing };
    this.snapCamera();
  }

  statistics() {
    return {
      frames: this.renderer.info.render.frame,
      renders: this.renders,
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      terrain: this.terrain.inspect(),
      decorations: this.decorations?.inspect() ?? null,
      looks: this.looks.inspect(),
      enemies: this.looks.inspectEnemies(),
      sprites: this.sprites.inspect(),
      headAim: { rotation: this.headAim.rotation.toArray() },
      avatar: this.avatar === null ? null : { ...this.avatar.inspect(), visible: this.avatar.root.visible },
      importedAvatar: this.activeImportedAvatar(),
      hammerModel: this.propModels.hammer === null ? null : {
        ...this.propModels.hammer.inspect(),
        fit: (this.parts.hammer?.fit ?? this.slots[this.activeSlot]?.props.hammer?.fit)?.inspect() ?? null,
      },
      parts: this.partModels(),
      potModel: this.propModels.pot === null ? null : this.propModels.pot.inspect(),
      theme: { writes: this.themeWrites, sky: this.theme.sky, fog: { ...this.theme.fog }, backdrop: this.theme.backdrop.visible },
      camera: {
        ...this.cameraState(),
        perspective: this.camera === this.perspective, fieldOfView: this.perspective.fov, distance: this.distance,
        near: this.camera.near, far: this.camera.far, fog: { near: this.fog.near, far: this.fog.far },
      },
      characters: this.characterSelection(),
      armChains: { left: { ...this.armChains.left }, right: { ...this.armChains.right } },
      rig: this.rig,
      grips: {
        placement: this.grips.placement, slideAt: this.grips.slideAt, slideRange: { ...this.grips.slideRange },
        left: this.gripDistances.left, right: this.gripDistances.right,
      },
    };
  }

  private activeImportedAvatar() {
    const view = this.avatarRenderer instanceof SkinnedAvatarView ? this.avatarRenderer : this.slots[this.activeSlot]?.avatar?.view;
    if (view === undefined) return null;
    const inspected = view.inspect();
    return { ...inspected, visible: view.root.visible && view.root.parent !== null && inspected.modelAttached };
  }

  cameraState() {
    return {
      x: this.camera.position.x, y: this.camera.position.y, width: this.width, height: this.height,
      worldHeight: this.worldHeight, director: this.director.value.inspect === undefined ? null : call0(this.director, 'inspect') ?? null,
    };
  }

  dispose(): void {
    const disposal = new Disposal();
    disposal.run(() => this.placementHold.dispose());
    disposal.run(() => this.observer?.disconnect());
    disposal.run(() => this.disposeCharacters());
    const avatar = this.avatar;
    this.avatar = null;
    disposal.run(() => avatar?.root.removeFromParent());
    disposal.run(() => avatar?.dispose());
    disposal.run(() => this.terrain.root.removeFromParent());
    disposal.run(() => this.terrain.dispose());
    disposal.run(() => this.decorations?.dispose());
    disposal.run(() => this.looks.dispose());
    disposal.run(() => this.backdrop.value.root.removeFromParent());
    disposal.run(() => call0(this.backdrop, 'dispose'));
    disposal.run(() => this.aimMarks.value.root.removeFromParent());
    disposal.run(() => call0(this.aimMarks, 'dispose'));
    disposal.run(() => this.hurtEffects.value.root.removeFromParent());
    disposal.run(() => call0(this.hurtEffects, 'dispose'));
    disposal.run(() => this.blockEffects.value.root.removeFromParent());
    disposal.run(() => call0(this.blockEffects, 'dispose'));
    for (const layer of this.layers.values()) {
      disposal.run(() => layer.value.root.removeFromParent());
      if (layer.value.dispose !== undefined) disposal.run(() => call0(layer, 'dispose'));
    }
    this.layers.clear();
    this.updatingLayers.clear();
    disposal.run(() => disposeResources(this.backdropScene, this.course, this.actors, this.front, this.marks, this.foreground));
    this.bindings.clear();
    disposal.run(() => this.renderer?.dispose());
    disposal.finish();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('The game canvas must have a visible size.');
    this.width = rect.width;
    this.height = rect.height;
    this.snapCamera();
    this.renderer.setSize(this.width, this.height, false);
  }

  private updateFrustum(): void {
    const aspect = this.width / this.height;
    const worldHeight = this.cameraAim.worldHeight;
    const halfHeight = worldHeight / 2;
    const halfWidth = halfHeight * aspect;
    const { perspective, fieldOfView } = this.theme.camera;
    const camera = perspective ? this.perspective : this.orthographic;
    if (camera === this.camera && worldHeight === this.worldHeight && (perspective
      ? this.perspective.aspect === aspect && this.perspective.fov === fieldOfView
      : this.orthographic.right === halfWidth && this.orthographic.top === halfHeight)) return;
    if (perspective) {
      // Far enough that the course plane fills the same height the orthographic camera shows.
      this.perspective.fov = fieldOfView;
      this.perspective.aspect = aspect;
      this.distance = halfHeight / Math.tan(fieldOfView * Math.PI / 360);
    } else {
      this.orthographic.left = -halfWidth;
      this.orthographic.right = halfWidth;
      this.orthographic.top = halfHeight;
      this.orthographic.bottom = -halfHeight;
      this.distance = VISUAL.depth;
    }
    camera.position.set(this.camera.position.x, this.camera.position.y, this.distance);
    camera.near = Math.max(VISUAL.nearPlane, this.distance - VISUAL.sceneFront);
    camera.far = this.distance + VISUAL.sceneBack;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.camera = camera;
    this.worldHeight = worldHeight;
    this.placeFog();
  }

  // Theme fog depths are measured behind the course plane; the fog itself from the camera.
  private placeFog(): void {
    this.fog.near = this.distance + this.theme.fog.near;
    this.fog.far = this.distance + this.theme.fog.far;
  }

  // Half the course plane's visible width and height.
  private halfExtents(): { halfWidth: number; halfHeight: number } {
    const halfHeight = this.worldHeight / 2;
    return { halfWidth: halfHeight * this.width / this.height, halfHeight };
  }

  // Whether anything draws in front of the obstacle line, over the actors.
  private drawsFront(): boolean {
    return (this.decorations !== null && this.decorations.front.children.length > 0) || this.looks.drawsFront();
  }

  // Burns the bonfires the player has reached this run, and puts the rest out.
  setLitBonfires(ids: readonly string[]): void {
    this.looks.setLit(ids);
  }

  setPressedSwitches(ids: readonly string[]): void {
    this.looks.setPressedSwitches(ids);
  }

  applyLevel(change: LevelChange): void {
    this.setLabels(change.level.labels);
    this.looks.setLevel(change.level.objects);
    this.decorations?.apply(change);
  }

  private setLabels(labels: readonly LevelLabel[]): void {
    if (this.labelDefinition === labels) return;
    this.labelDefinition = labels;
    disposeResources(this.labels);
    this.labels.clear();
    for (const label of labels) this.addLabel(label.text, label);
  }

  private buildPlayer(): void {
    const colors = this.theme.character;
    const brass = new MeshStandardMaterial({ color: colors.pot, roughness: 0.34, metalness: 0.65 });
    const trim = new MeshStandardMaterial({ color: colors.trim, roughness: 0.4, metalness: 0.5 });
    const dark = new MeshStandardMaterial({ color: colors.dark, roughness: 0.5, metalness: 0.4 });
    const suit = new MeshStandardMaterial({ color: colors.suit, roughness: 0.7 });
    const ceramic = new MeshStandardMaterial({ color: colors.ceramic, roughness: 0.5, metalness: 0.12 });
    const wood = new MeshStandardMaterial({ color: colors.wood, roughness: 0.7 });
    this.palette = { pot: brass, trim, dark, suit, ceramic, wood };

    const pot = new Group();
    pot.add(solid(createPotGeometry(), brass));
    const rim = solid(new TorusGeometry(0.433, 0.035, 10, 40), trim, [0, 0.31, 0]);
    rim.rotation.x = Math.PI / 2;
    pot.add(rim);
    pot.add(solid(new CylinderGeometry(0.425, 0.425, 0.018, 32), dark, [0, 0.285, 0]));
    const badge = solid(new SphereGeometry(0.11, 12, 8), ceramic, [0, -0.03, 0.472]);
    badge.scale.set(1, 0.9, 0.16);
    pot.add(badge);
    const potAnchor = this.visualSlot('pot', pot);
    this.playerMeshes.set('pot', potAnchor);
    this.actors.add(potAnchor);

    const { chest: chestShape, neck, helmet: helmetShape, upperArm, forearm } = PLAYER_FIGURE;
    const body = new Group();
    const chest = solid(new SphereGeometry(chestShape.radius, 16, 12), suit, [0, chestShape.y, 0]);
    chest.scale.set(...chestShape.scale);
    body.add(chest);
    body.add(solid(new CylinderGeometry(neck.top, neck.bottom, neck.height, 12), dark, [0, neck.y, 0]));
    this.torso.add(this.visualSlot('torso', body));
    const characterHead = new Group();
    const helmet = solid(new SphereGeometry(helmetShape.radius, 20, 14), ceramic, [0, helmetShape.y, 0]);
    helmet.scale.y = helmetShape.scaleY;
    characterHead.add(helmet);
    const visor = solid(new SphereGeometry(0.19, 20, 12), dark, [0, 1.10, 0.16]);
    visor.scale.set(0.92, 0.52, 0.43);
    characterHead.add(visor);
    const reflection = solid(new BoxGeometry(0.08, 0.018, 0.01), trim, [-0.05, 1.13, 0.243]);
    characterHead.add(reflection);
    this.torso.add(this.visualSlot('character-head', characterHead));
    this.actors.add(this.torso);
    for (const side of ARM_SIDES) {
      const arm: Arm = {
        upper: this.visualSlot(`${side}-upper-arm`, solid(new CylinderGeometry(upperArm.top, upperArm.bottom, 1, 10), side === 'left' ? dark : suit)),
        lower: this.visualSlot(`${side}-forearm`, solid(new CylinderGeometry(forearm.top, forearm.bottom, 1, 10), ceramic)),
        elbow: this.visualSlot(`${side}-elbow`, solid(new SphereGeometry(PLAYER_FIGURE.elbow, 12, 8), brass)),
        hand: this.visualSlot(`${side}-hand`, solid(new SphereGeometry(PLAYER_FIGURE.hand, 12, 8), dark)),
        solver: new ArmPoseSolver(side),
      };
      this.actors.add(arm.upper, arm.lower, arm.elbow, arm.hand);
      this.arms.set(side, arm);
    }
    const shaftSegments: Group[] = [];
    // Unit-length geometry, shared by the segments and scaled to the rig's segment length.
    const shaftGeometry = new CylinderGeometry(RIG.handleHalfWidth, RIG.handleHalfWidth, 1, 10);
    const sleeveGeometry = new CylinderGeometry(0.052, 0.052, 0.04, 10);
    for (let index = 0; index < RIG.handleSegments; index++) {
      const segment = new Group();
      const shaft = solid(shaftGeometry, wood);
      shaft.rotation.z = Math.PI / 2;
      segment.add(shaft);
      const sleeve = solid(sleeveGeometry, brass);
      sleeve.rotation.z = Math.PI / 2;
      segment.add(sleeve);
      this.shaftSegments.push({ shaft, sleeve });
      this.playerMeshes.set(`handle-${index}`, segment);
      this.foreground.add(segment);
      shaftSegments.push(segment);
    }
    this.layoutShaft();
    this.bindings.set('hammer-shaft', {
      anchor: this.customShaft,
      modelAnchor: this.customShaft,
      defaults: shaftSegments,
      bounds: new Box3(
        new Vector3(-SHAFT_ARTWORK_LENGTH / 2, -RIG.handleHalfWidth, -RIG.handleHalfWidth),
        new Vector3(SHAFT_ARTWORK_LENGTH / 2, RIG.handleHalfWidth, RIG.handleHalfWidth),
      ),
      visibility: this.visibility('hammer-shaft', shaftSegments),
      deferChange: this.deferVisualChange,
    });
    this.foreground.add(this.customShaft);
    const head = new Group();
    this.headMesh = new Mesh(createHammerHeadGeometry(this.headOutline), dark);
    head.add(this.headMesh);
    const bolt = solid(new SphereGeometry(0.052, 10, 8), brass, [0, 0, 0.13]);
    bolt.scale.z = 0.3;
    head.add(bolt);
    const headAnchor = this.visualSlot('hammer-head', head);
    this.playerMeshes.set('head', headAnchor);
    this.foreground.add(headAnchor);
  }

  private visualSlot(slot: VisualPartId, model: Object3D): Group {
    const anchor = new Group();
    const modelAnchor = slot === 'character-head' ? this.meshHead : anchor;
    if (modelAnchor !== anchor) {
      modelAnchor.matrixAutoUpdate = false;
      anchor.add(modelAnchor);
    }
    modelAnchor.add(model);
    if (this.bindings.has(slot)) throw new Error(`Duplicate visual slot: ${slot}`);
    const defaults = [model];
    this.bindings.set(slot, {
      anchor, modelAnchor, defaults, bounds: new Box3().setFromObject(model, true),
      visibility: this.visibility(slot, defaults),
      deferChange: this.deferVisualChange,
    });
    if (ARM_PARTS.has(slot)) onArmLayer(model);
    return anchor;
  }

  // Arm replacements from authoring tools draw over the body like the built-in arms.
  private visibility(slot: VisualPartId, defaults: readonly Object3D[]): VisualVisibility {
    if (ARM_PARTS.has(slot)) return new VisualVisibility(defaults, { onReplacement: (next) => { if (next !== null) onArmLayer(next); } });
    return new VisualVisibility(defaults);
  }

  // Follows the physical head's outline when the hammer's head changes: the built-in head mesh, the framing and how
  // near the head the hands may come.
  private syncHead(outline: HammerHead): void {
    if (outline === this.headOutline) return;
    this.headOutline = outline;
    this.headMesh.geometry.dispose();
    this.headMesh.geometry = createHammerHeadGeometry(outline);
    this.hammerRadius = hammerHeadRadius(outline);
    this.headMargin = headGripMargin(outline);
  }

  // Follows a rebuilt rig: the two-part hammer's segment lengths, hammer models' handles, touch gain and framing.
  private syncRig(frame: PhysicsFrame): void {
    if (frame.rig === this.rig) return;
    this.rig = frame.rig;
    this.layoutShaft();
    for (const slot of this.slots) slot.props.hammer?.fit?.setHandleLength(this.rig.handleLength);
    this.parts.hammer?.fit.setHandleLength(this.rig.handleLength);
  }

  private layoutShaft(): void {
    const length = this.rig.segmentLength;
    for (const { shaft, sleeve } of this.shaftSegments) {
      shaft.scale.y = length;
      sleeve.position.x = SLEEVE_INSET - length / 2;
    }
  }

  // Every character type takes its hands from the same grip placement on the physical tool frame.
  private updateArms(body: Matrix4, tool: Matrix4, shaftLength: number,
    options: { armIk: Readonly<ArmIkSettings>; dt: number; death: DeathFrame | null }, shaftAngle: number, compose = true): ArmPose[] {
    const settings = options.death === null ? options.armIk : this.capturedArmIk;
    const chains = this.armChains;
    const cos = Math.cos(shaftAngle);
    const sin = Math.sin(shaftAngle);
    const butt = this.gripButt.setFromMatrixPosition(tool);
    const shaftAxis = this.gripAxis.set(cos, sin, 0);
    const slot = this.slots[this.activeSlot]!;
    const prepared = this.activeAvatar;
    // Phase 1: the prepared rig writes each side's wrist target track before grips are placed; the arms
    // then follow that plan as the grip rotations turn it.
    const poseSource = options.death === null ? 'live' : 'captured-death';
    const plan = prepared === null ? null : this.frameAvatarRig(prepared, body, tool, cos, sin, shaftLength, options.dt, poseSource);
    // Every arm reaches from the body's shoulders with the lengths it is drawn at, measured in the course plane as
    // the camera sees it. A 2D arm chain that targets a hand's grip has its authored lengths unless the profile has
    // its own.
    const flat = this.spriteArms ? slot.rig.naturalArmLengths() : null;
    for (const side of ARM_SIDES) {
      const sprite = flat?.[side] ?? null;
      const local = chains[side].shoulder;
      const shoulder = this.gripShoulder.set(local[0], local[1], local[2]);
      // Reach is measured to the wrist, which a rig may hold off the handle's contact point.
      if (plan !== null) shoulder.sub(plan[side].offset);
      shoulder.applyMatrix4(body);
      const lengths = sprite !== null && slot.presentation.arms === null ? sprite : chains[side];
      projectGripShoulder(shoulder, butt, shaftAxis, lengths.upper + lengths.forearm, this.gripShoulders[side]);
    }
    this.gripHold.place(this.grips, this.gripShoulders, shaftLength, this.headMargin, this.gripDistances);
    const poses = this.posedArms;
    poses.length = 0;
    for (const side of ARM_SIDES) {
      const arm = this.arms.get(side);
      if (!arm) throw new Error(`Missing visual arm: ${side}`);
      // An imported avatar supplies its own shoulders and bind-pose bone lengths; grips are shared.
      const chain = chains[side];
      const grip = this.gripDistances[side];
      const targets = this.armTargets;
      const hand = targets.hand.set(grip, 0, 0).applyMatrix4(tool);
      if (plan !== null) {
        // The IK reaches the wrist, not the contact point, so the palm and its grip can differ.
        this.wristAvatar.copy(this.avatarButt).addScaledVector(this.avatarShaft, grip);
        this.handAvatar.copy(this.wristAvatar).add(plan[side].offset).applyMatrix4(body);
        hand.copy(this.handAvatar);
      }
      targets.shoulder.set(chain.shoulder[0], chain.shoulder[1], chain.shoulder[2]).applyMatrix4(body);
      if (side === 'left') targets.hint.set(settings.leftHintX, settings.leftHintY, settings.leftHintZ);
      else targets.hint.set(settings.rightHintX, settings.rightHintY, settings.rightHintZ);
      targets.hint.applyMatrix4(body);
      targets.shaftAxis.set(cos, sin, 0);
      const pose = (prepared?.solvers[side] ?? arm.solver).solve(targets, options.dt, chain);
      if (prepared !== null) this.captureAvatarSolution(side, pose);
      placeLimb(arm.upper, pose.shoulder, pose.elbow, pose.normal);
      placeLimb(arm.lower, pose.elbow, pose.hand, pose.normal);
      arm.elbow.position.copy(pose.elbow);
      arm.hand.position.copy(pose.hand);
      arm.hand.rotation.set(0, 0, shaftAngle);
      // A mesh-part hand's own frame is its grip frame, so its rotation applies there.
      const rotation = this.gripRotations[side];
      if (rotation !== null) arm.hand.quaternion.multiply(rotation);
      poses.push(pose);
    }
    // Phase 2: the prepared rig composes its mapped-joint matrices from the turned plan and these solutions.
    if (prepared !== null && plan !== null) {
      const context = this.poseContext;
      context.body = body;
      context.plan = plan;
      context.dt = options.dt;
      context.poseSource = poseSource;
      context.attachment = 'gripped';
      if (compose) prepared.rig.writePose(context, prepared.pose);
    }
    return poses;
  }

  // Phase 1 inputs for a prepared rig: the tool frame and the standard hand directions, in avatar space.
  // Returns the plan the arms follow: the rig's own, or the view's copy turned about each rotated hand's grip.
  private frameAvatarRig(prepared: PreparedAvatar, body: Matrix4, tool: Matrix4, cos: number, sin: number,
    shaftLength: number, dt: number, poseSource: 'live' | 'captured-death'): AvatarRigFramePlan {
    this.inverseBody.copy(body).invert();
    this.avatarTool.copy(this.inverseBody).multiply(tool);
    this.avatarButt.setFromMatrixPosition(this.avatarTool);
    this.avatarShaft.set(cos, sin, 0).transformDirection(this.inverseBody);
    this.avatarForward.set(0, 0, 1).transformDirection(this.inverseBody);
    const context = this.frameContext;
    context.body = body;
    context.shaftLength = shaftLength;
    context.dt = dt;
    context.poseSource = poseSource;
    prepared.rig.writeFramePlan(context, prepared.plan);
    if (this.gripRotations.left === null && this.gripRotations.right === null) return prepared.plan;
    for (const side of ARM_SIDES) {
      const track = prepared.plan[side];
      const turned = this.turnedPlan[side];
      turned.offset.copy(track.offset);
      turned.shaft.copy(track.shaft);
      turned.forward.copy(track.forward);
      const rotation = this.gripRotations[side];
      if (rotation === null) continue;
      // The wrist swings about the grip with the hand, so a rig's wrist offset turns too.
      const turn = this.turnAboutGrip(rotation, this.avatarShaft, this.avatarForward, this.gripTurn);
      turned.offset.applyQuaternion(turn);
      turned.shaft.applyQuaternion(turn);
      turned.forward.applyQuaternion(turn);
    }
    return this.turnedPlan;
  }

  private updateDeathArms(presented: DeathPose, released: boolean, dt: number): ArmPose[] {
    const body = this.torso.matrixWorld, prepared = this.activeAvatar;
    this.inverseBody.copy(body).invert();
    const poses = this.posedArms;
    for (let index = 0; index < ARM_SIDES.length; index++) {
      const side = ARM_SIDES[index]!, source = presented.arms[side], pose = this.physicalArms[side];
      const previousNormalZ = poses[index]!.normal.z;
      const held = released ? null : poses[index]!;
      pose.shoulder.set(source.shoulder.x, source.shoulder.y, held === null ? OBSTACLE_LINE : held.shoulder.z);
      pose.elbow.set(source.elbow.x, source.elbow.y, held === null ? OBSTACLE_LINE : held.elbow.z);
      pose.hand.set(source.hand.x, source.hand.y, held === null ? OBSTACLE_LINE : held.hand.z);
      if (held === null) pose.normal.set(0, 0, Math.abs(previousNormalZ) > 1e-8
        ? Math.sign(previousNormalZ) : ARM_GEOMETRY[side].normalSign);
      else pose.normal.copy(held.normal);
      pose.shaftAxis.set(Math.cos(source.hand.angle), Math.sin(source.hand.angle), 0);
      pose.axis.subVectors(pose.hand, pose.shoulder).normalize();
      pose.bendDirection.subVectors(pose.elbow, pose.shoulder).normalize();
      pose.hint.copy(pose.elbow);
      const arm = this.arms.get(side)!;
      placeLimb(arm.upper, pose.shoulder, pose.elbow, pose.normal);
      placeLimb(arm.lower, pose.elbow, pose.hand, pose.normal);
      arm.elbow.position.copy(pose.elbow); arm.hand.position.copy(pose.hand);
      arm.hand.rotation.set(0, 0, source.hand.angle);
      if (!released && this.gripRotations[side] !== null) arm.hand.quaternion.multiply(this.gripRotations[side]!);
      if (prepared !== null) {
        this.captureAvatarSolution(side, pose);
        if (released) {
          const track = this.turnedPlan[side];
          track.offset.set(0, 0, 0);
          track.shaft.copy(pose.shaftAxis).transformDirection(this.inverseBody);
          track.forward.set(0, 0, 1).transformDirection(this.inverseBody);
        }
      }
    }
    poses.length = 0;
    poses.push(this.physicalArms.left, this.physicalArms.right);
    if (released) this.gloveTurns.left = this.gloveTurns.right = null;
    if (prepared !== null) {
      const context = this.poseContext;
      context.body = body; context.dt = dt;
      if (released) context.plan = this.turnedPlan;
      context.poseSource = released ? 'physical-death' : 'captured-death';
      context.attachment = released ? 'released' : 'gripped';
      prepared.rig.writePose(context, prepared.pose);
    }
    return poses;
  }

  // Each rotated glove's turn about its grip in world space, where the grip frame follows the tool's shaft
  // axis this frame, for the built-in avatar.
  private turnGloves(): Readonly<Record<ArmSide, Quaternion | null>> {
    for (const side of ARM_SIDES) {
      const rotation = this.gripRotations[side];
      this.gloveTurns[side] = rotation === null ? null
        : this.turnAboutGrip(rotation, this.gripAxis, WORLD_FORWARD, this.gloveTurnScratch[side]);
    }
    return this.gloveTurns;
  }

  // `rotation`, given in a hand's grip frame, as a turn in the space where that frame's X (the handle,
  // toward the head) is `shaft` and its Z (toward the camera) is `forward`.
  private turnAboutGrip(rotation: Quaternion, shaft: Vector3, forward: Vector3, out: Quaternion): Quaternion {
    this.gripAcross.crossVectors(forward, shaft);
    this.gripFrame.setFromRotationMatrix(this.gripBasis.makeBasis(shaft, this.gripAcross, forward));
    return out.copy(this.gripFrame).multiply(rotation).multiply(this.gripFrame.invert());
  }

  // Phase 2 inputs: the solved arm in avatar space, with `wrist` the actual IK target.
  private captureAvatarSolution(side: ArmSide, pose: ArmPose): void {
    const solution = this.solutions[side];
    solution.shoulder.copy(pose.shoulder).applyMatrix4(this.inverseBody);
    solution.elbow.copy(pose.elbow).applyMatrix4(this.inverseBody);
    solution.wrist.copy(pose.hand).applyMatrix4(this.inverseBody);
    solution.normal.copy(pose.normal).transformDirection(this.inverseBody);
  }

  private addLabel(text: string, position: Point): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A 2D canvas context is required for course labels.');
    context.fillStyle = 'rgba(230, 231, 206, 0.85)';
    context.font = '600 24px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 256, 48);
    const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), transparent: true, depthTest: false }));
    sprite.position.set(position.x, position.y, 0.04);
    sprite.scale.set(2.25, 0.42, 1);
    this.labels.add(sprite);
  }

  // `frame`, or while a presentation preview runs, a frame whose player parts and cursor it moved: turned by the offset's
  // turn about the root, then moved by its offset. The preview ends past its duration, on a rewind or on bad values.
  private presentedFrame(frame: PhysicsFrame): PhysicsFrame {
    const running = this.presentationPreview;
    if (running === null || frame.player.phase !== 'alive') return frame;
    if (running.start === null) running.start = frame.time;
    const elapsed = frame.time - running.start;
    const offset = this.previewOffset;
    offset.x = 0;
    offset.y = 0;
    offset.turn = 0;
    if (elapsed >= 0 && elapsed <= running.preview.duration) running.preview.offset(elapsed, offset);
    // The preview may have ended or been replaced while it ran.
    if (this.presentationPreview !== running || elapsed < 0 || elapsed > running.preview.duration ||
      !Number.isFinite(offset.x) || !Number.isFinite(offset.y) || !Number.isFinite(offset.turn)) {
      if (this.presentationPreview === running) this.presentationPreview = null;
      return frame;
    }
    const root = frame.player.centre;
    const cos = Math.cos(offset.turn), sin = Math.sin(offset.turn);
    const pivotX = root.x, pivotY = root.y;
    if (this.previewParts.length !== frame.parts.length) {
      this.previewParts = frame.parts.map((part) => ({ ...part }));
    }
    for (let index = 0; index < frame.parts.length; index += 1) {
      const part = frame.parts[index]!;
      const moved = this.previewParts[index]!;
      const dx = part.x - pivotX, dy = part.y - pivotY;
      moved.id = part.id;
      moved.kind = part.kind;
      moved.vertices = part.vertices;
      moved.collides = part.collides;
      moved.x = pivotX + dx * cos - dy * sin + offset.x;
      moved.y = pivotY + dx * sin + dy * cos + offset.y;
      moved.angle = part.angle + offset.turn;
    }
    const cursorX = frame.cursor.x - pivotX, cursorY = frame.cursor.y - pivotY;
    this.previewCursor.x = pivotX + cursorX * cos - cursorY * sin + offset.x;
    this.previewCursor.y = pivotY + cursorX * sin + cursorY * cos + offset.y;
    const shown = this.previewFrame ??= {
      time: frame.time, placement: frame.placement, player: this.previewPlayer,
      parts: this.previewParts, cursor: this.previewCursor, enemies: frame.enemies,
      projectiles: frame.projectiles, platforms: frame.platforms, rig: frame.rig,
    };
    shown.time = frame.time;
    shown.placement = frame.placement;
    this.previewPlayer.centre.x = pivotX + offset.x; this.previewPlayer.centre.y = pivotY + offset.y;
    this.previewPlayer.centre.angle = root.angle + offset.turn;
    const sx = frame.player.shoulder.x - pivotX, sy = frame.player.shoulder.y - pivotY;
    this.previewPlayer.shoulder.x = pivotX + sx * cos - sy * sin + offset.x;
    this.previewPlayer.shoulder.y = pivotY + sx * sin + sy * cos + offset.y;
    shown.parts = this.previewParts;
    shown.enemies = frame.enemies;
    shown.projectiles = frame.projectiles;
    shown.platforms = frame.platforms;
    shown.rig = frame.rig;
    return shown;
  }

  private part(frame: PhysicsFrame, id: string): PartPose {
    const part = frame.parts.find((candidate) => candidate.id === id);
    if (!part) throw new Error(`Missing rendered physics part: ${id}`);
    return part;
  }
}
