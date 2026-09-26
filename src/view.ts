import {
  ACESFilmicToneMapping, AmbientLight, Box3, BoxGeometry, BufferAttribute, BufferGeometry,
  CanvasTexture, CircleGeometry, CylinderGeometry, DirectionalLight, ExtrudeGeometry,
  Fog, Group, HemisphereLight, LatheGeometry, Line, LineDashedMaterial,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera,
  RingGeometry, Scene, Shape, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry,
  Vector2, Vector3, WebGLRenderer,
} from 'three';
import type { Material, Object3D, Quaternion } from 'three';
import { ARM_SIDES, HEAD_GEOMETRY, SPRITE_TARGET_IDS } from './character';
import type { ArmIkSettings, ArmSide, CharacterState, VisualBinding, VisualPartId } from './character';
import { ARM_GEOMETRY, DEFAULT_ARM_CHAINS, solveArmPose } from './arm-ik';
import { DEFAULT_ARM_FORWARD_DISTANCE, getToolDepth, PLAYER_DEPTH } from './character-depth';
import type { ArmChains, ArmPose } from './arm-ik';
import { AvatarView } from './avatar-view';
import { resolveAvatarJoints } from './character-model-inspect';
import type { CharacterModelUsage } from './character-model-inspect';
import type { CharacterModelLoader, LoadedCharacterModel } from './character-model-types';
import { characterModel, DEFAULT_CHARACTER_SHADING, PROP_MODEL_ROLES, sameBoneMap } from './character-profile';
import type { AvatarBoneMap, PropModelRole } from './character-profile';
import { CharacterShadingView } from './character-shading';
import { PropModelView } from './prop-model-view';
import { SkinnedAvatarView } from './skinned-avatar-view';
import { HeadAim } from './head-aim';
import { PHYSICS, RIG } from './config';
import type { InputMode, Point } from './config';
import type { LevelChange, LevelDefinition, LevelLabel } from './level';
import { FlagView } from './flag-view';
import { UpdraftView } from './updraft-view';
import { EnemyView } from './enemy-view';
import { clamp } from './math';
import type { PartPose, PhysicsFrame } from './simulation';
import { TerrainView } from './terrain-view';
import { SpriteRig } from './sprite-rig';
import type { SpriteAnchor } from './sprite-rig';
import { DEFAULT_CHARACTER_RIGGING_TYPE, SpriteError } from './sprite-data';
import type { CharacterPresentation, CharacterRiggingType, SpriteDocument } from './sprite-data';
import { VisualVisibility } from './visual-visibility';
import type { RigTarget } from './skeleton-pose';
import { DEFAULT_THEME } from './theme';
import type { GameTheme } from './theme';
import type { EnemyArtSettings } from './enemy-art-data';

const VISUAL = {
  viewHeight: 8.5,
  cameraLead: 0.9,
  cameraLift: 1.15,
  cameraMinimumY: 2.9,
  cameraResponse: 3.5,
  depth: 20,
  compactWidth: 680,
  compactHeight: 580,
  reachMargin: 0.5,
  framingMargin: 0.2,
  visibleGroundDepth: 1.3,
  characterTop: 1.35,
  touchPixelsPerReach: 100,
} as const;
const POT_HALF_WIDTH = Math.max(...RIG.potVertices.map((point) => Math.abs(point.x)));
const HAMMER_RADIUS = Math.max(...RIG.headVertices.map((point) => Math.hypot(point.x, point.y)));

function polygonShape(vertices: readonly Point[]): Shape {
  const shape = new Shape();
  shape.moveTo(vertices[0].x, vertices[0].y);
  for (const vertex of vertices.slice(1)) shape.lineTo(vertex.x, vertex.y);
  shape.closePath();
  return shape;
}

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
  pose: ArmPose | null;
}

export interface CameraFraming extends Point {
  worldHeight: number;
}

export interface ViewLayer {
  readonly root: Object3D;
  update: (frame: PhysicsFrame, arms: readonly ArmPose[]) => void;
  dispose: () => void;
}

interface AvatarRenderer {
  readonly root: Object3D;
  update: (body: Matrix4, poses: readonly ArmPose[], headRotation: Quaternion) => void;
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
  readonly models: Map<CharacterModelUsage, Map<string, LoadedCharacterModel>>;
  avatar: { readonly model: LoadedCharacterModel; readonly boneMap: AvatarBoneMap; readonly view: SkinnedAvatarView } | null;
  readonly props: Record<PropModelRole, { readonly model: LoadedCharacterModel; readonly view: PropModelView } | null>;
}

export const MAX_CHARACTER_PROFILES = 2;
const PROP_PARTS: ReadonlySet<VisualPartId> = new Set(['pot', 'hammer-shaft', 'hammer-head']);
const HAMMER_PARTS: ReadonlySet<VisualPartId> = new Set(['hammer-shaft', 'hammer-head']);
const PROP_VIEW_NAMES: Readonly<Record<PropModelRole, string>> = { hammer: 'one-model-hammer', pot: 'profile-pot-model' };
const DEFAULT_PRESENTATION: CharacterPresentation = Object.freeze({
  characterRiggingType: DEFAULT_CHARACTER_RIGGING_TYPE, armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
});

function disposeResources(...roots: Object3D[]): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<CanvasTexture>();
  for (const root of roots) root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Line || object instanceof Sprite) {
      if ('geometry' in object) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        if ('map' in material && material.map instanceof CanvasTexture) textures.add(material.map);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export class GameView {
  readonly canvas: HTMLCanvasElement;
  readonly terrain = new TerrainView();
  readonly enemies: EnemyView;
  readonly sprites: SpriteRig;
  private readonly flags = new FlagView();
  private readonly updrafts = new UpdraftView();
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly foreground = new Scene();
  private readonly camera = new OrthographicCamera();
  private readonly scenery = new Group();
  private readonly decorations = new Group();
  private readonly bindings = new Map<VisualPartId, VisualBinding>();
  private readonly layers = new Set<ViewLayer>();
  private readonly playerMeshes = new Map<string, Group>();
  private readonly torso = new Group();
  private readonly meshHead = new Group();
  private readonly headAim = new HeadAim();
  private readonly headPivot = new Vector3(...HEAD_GEOMETRY.neck);
  private readonly headOffset = new Vector3();
  private avatar: AvatarView | null = null;
  private readonly characterModels: CharacterModelLoader | null;
  private readonly slots: CharacterSlot[] = [];
  private activeSlot = 0;
  private readonly shading = new CharacterShadingView();
  private armChains: ArmChains = DEFAULT_ARM_CHAINS;
  private avatarRenderer: AvatarRenderer | null = null;
  private readonly propModels: Record<PropModelRole, PropModelView | null> = { hammer: null, pot: null };
  private readonly potFrame = new Matrix4();
  private renders = 0;
  private readonly customShaft = new Group();
  private toolDepth = getToolDepth(DEFAULT_ARM_FORWARD_DISTANCE);
  private readonly arms = new Map<ArmSide, Arm>();
  private readonly limbDirection = new Vector3();
  private readonly limbSide = new Vector3();
  private readonly limbNormal = new Vector3();
  private readonly limbRotation = new Matrix4();
  private readonly gripFrame = new Matrix4();
  private readonly cursor = new Group();
  private readonly targetLine: Line;
  private readonly targetPositions = new Float32Array(6);
  private readonly observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private worldHeight: number = VISUAL.viewHeight;
  private compact = false;
  private framing: CameraFraming | null = null;
  private labelDefinition: readonly LevelLabel[] | null = null;
  private focus: Point;
  private hammer: Point;
  private readonly projection = new Vector3();
  private readonly spriteTargets = new Map<string, RigTarget>();
  private theme: GameTheme;
  private readonly fog: Fog;
  // Each light exists in both the scene and foreground passes.
  private readonly lights: {
    readonly hemisphere: HemisphereLight[]; readonly ambient: AmbientLight[];
    readonly sun: DirectionalLight[]; readonly rim: DirectionalLight[];
  } = { hemisphere: [], ambient: [], sun: [], rim: [] };
  private readonly mountains: Mesh<ExtrudeGeometry, MeshBasicMaterial>[] = [];
  private readonly sunDisc: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly cursorMaterial: MeshBasicMaterial;
  private readonly targetMaterial: LineDashedMaterial;
  private palette: Record<keyof GameTheme['character'], MeshStandardMaterial> | null = null;
  private themeWrites = 0;

  constructor(canvas: HTMLCanvasElement, initial: PhysicsFrame, level: LevelDefinition, options: {
    // Loads imported character GLBs; hosts without one reject profiles that reference models.
    characterModels?: CharacterModelLoader | null;
    theme?: GameTheme;
    enemyArt?: EnemyArtSettings;
  } = {}) {
    this.canvas = canvas;
    this.characterModels = options.characterModels ?? null;
    this.theme = options.theme ?? DEFAULT_THEME;
    const theme = this.theme;
    this.enemies = new EnemyView(options.enemyArt);
    const root = this.part(initial, 'root');
    const head = this.part(initial, 'head');
    this.focus = { x: root.x, y: root.y };
    this.hammer = { x: head.x, y: head.y };
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = theme.exposure;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(theme.sky);
    this.fog = new Fog(theme.fog.color, theme.fog.near, theme.fog.far);
    this.scene.fog = this.fog;
    this.foreground.fog = this.fog;
    for (const pass of [this.scene, this.foreground]) {
      const hemisphere = new HemisphereLight(theme.hemisphere.sky, theme.hemisphere.ground, theme.hemisphere.intensity);
      const ambient = new AmbientLight(theme.ambient.color, theme.ambient.intensity);
      const sunlight = new DirectionalLight(theme.sun.color, theme.sun.intensity);
      sunlight.position.set(-5, 12, 10);
      const rimLight = new DirectionalLight(theme.rim.color, theme.rim.intensity);
      rimLight.position.set(8, 3, -4);
      pass.add(hemisphere, ambient, sunlight, rimLight);
      this.lights.hemisphere.push(hemisphere);
      this.lights.ambient.push(ambient);
      this.lights.sun.push(sunlight);
      this.lights.rim.push(rimLight);
    }
    this.camera.position.z = VISUAL.depth;
    this.camera.near = 0.1;
    this.camera.far = 100;
    this.sunDisc = new Mesh(new CircleGeometry(1.8, 48), new MeshBasicMaterial({ color: theme.sunDisc.color, fog: false }));
    this.buildScenery();
    this.scene.add(this.terrain.root, this.flags.root, this.updrafts.root, this.enemies.root, this.decorations);
    this.setLabels(level.labels);
    this.flags.setObjects(level.objects);
    this.updrafts.setObjects(level.objects);
    this.buildPlayer();
    this.sprites = this.createSlot().rig;

    const cursorMaterial = new MeshBasicMaterial({ color: theme.aim.cursor, transparent: true, opacity: 0.9, depthTest: false });
    this.cursorMaterial = cursorMaterial;
    this.cursor.add(new Mesh(new RingGeometry(0.075, 0.09, 24), cursorMaterial));
    this.cursor.add(new Mesh(new CircleGeometry(0.018, 12), cursorMaterial));
    this.cursor.renderOrder = 20;
    this.scene.add(this.cursor);
    const targetGeometry = new BufferGeometry();
    targetGeometry.setAttribute('position', new BufferAttribute(this.targetPositions, 3));
    this.targetMaterial = new LineDashedMaterial({
      color: theme.aim.line, transparent: true, opacity: 0.45, dashSize: 0.07, gapSize: 0.05, depthTest: false,
    });
    this.targetLine = new Line(targetGeometry, this.targetMaterial);
    this.targetLine.frustumCulled = false;
    this.scene.add(this.targetLine);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.recenter(initial);
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
    this.fog.near = theme.fog.near;
    this.fog.far = theme.fog.far;
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
    this.sunDisc.visible = theme.sunDisc.visible;
    this.sunDisc.material.color.set(theme.sunDisc.color);
    const backdrop = [theme.backdrop.far, theme.backdrop.middle, theme.backdrop.near];
    for (const [index, mountains] of this.mountains.entries()) {
      mountains.visible = theme.backdrop.visible;
      mountains.material.color.set(backdrop[index]!);
    }
    this.cursorMaterial.color.set(theme.aim.cursor);
    this.targetMaterial.color.set(theme.aim.line);
    if (this.palette !== null) {
      for (const key of Object.keys(this.palette) as (keyof GameTheme['character'])[]) this.palette[key].color.set(theme.character[key]);
      this.shading.refresh();
    }
  }

  addLayer(layer: ViewLayer): void {
    this.layers.add(layer);
    this.scene.add(layer.root);
  }

  // Adds the release's second character profile; only the active profile renders and updates.
  createAlternateCharacter(): SpriteRig {
    if (this.slots.length >= MAX_CHARACTER_PROFILES) {
      throw new Error(`A game view shows at most ${MAX_CHARACTER_PROFILES} character profiles.`);
    }
    return this.createSlot().rig;
  }

  // Swaps presentation only: physics, grips and level state are untouched and nothing reloads.
  selectCharacter(index: number): void {
    const slot = this.slots[index];
    if (!Number.isInteger(index) || slot === undefined) throw new Error(`Unknown character profile ${index}.`);
    if (index === this.activeSlot) return;
    this.activeSlot = index;
    for (const other of this.slots) {
      for (const mount of other.mounts) this.attach(mount.node, mount.parent, other === slot);
    }
    for (const [id, binding] of this.bindings) binding.visibility.setCovered({ covered: slot.coverage.get(id) ?? false });
    this.applyPresentation();
    slot.rig.resetPresentation();
  }

  characterSelection(): { active: number; count: number; types: CharacterRiggingType[] } {
    return { active: this.activeSlot, count: this.slots.length, types: this.slots.map(slot => slot.presentation.characterRiggingType) };
  }

  // Validation report of a model loaded for the primary profile, for authoring tools.
  characterModelReport(source: string, usage: CharacterModelUsage) {
    return this.slots[0]?.models.get(usage)?.get(source)?.report ?? null;
  }

  // Cancels and releases every profile, for example when the game stops.
  disposeCharacters(): void {
    for (const slot of this.slots) slot.rig.dispose();
  }

  private createSlot(): CharacterSlot {
    const index = this.slots.length;
    const root = new Group();
    root.name = `character-${index}:sprites`;
    const foreground = new Group();
    foreground.name = `character-${index}:foreground-sprites`;
    const mounts: { node: Group; parent: Object3D }[] = [{ node: root, parent: this.scene }, { node: foreground, parent: this.foreground }];
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
      onCharacterPresentationChange: (settings) => this.presentationChanged(slot, settings),
      headTracking: {
        anchor: 'character-head',
        pivot: { anchor: 'torso', x: HEAD_GEOMETRY.neck[0], y: HEAD_GEOMETRY.neck[1] },
      },
      prepareTexture: (texture) => this.renderer.initTexture(texture),
      characterAssets: { prepare: (document, signal) => this.prepareModels(slot, document, signal) },
    });
    slot = {
      index, rig, mounts, coverage, presentation: DEFAULT_PRESENTATION,
      models: new Map([['avatar', new Map()], ['hammer', new Map()], ['pot', new Map()]]),
      avatar: null, props: { hammer: null, pot: null },
    };
    for (const mount of mounts) this.attach(mount.node, mount.parent, index === this.activeSlot);
    this.slots.push(slot);
    return slot;
  }

  private async prepareModels(slot: CharacterSlot, document: SpriteDocument, signal: AbortSignal): Promise<void> {
    if (document.avatar !== undefined) {
      const loaded = await this.loadModel(slot, document, 'avatar', document.avatar.model, signal);
      resolveAvatarJoints(loaded.report, document.avatar.boneMap);
    }
    for (const role of PROP_MODEL_ROLES) {
      const prop = document[role];
      if (prop !== undefined) await this.loadModel(slot, document, role, prop.model, signal);
    }
  }

  private async loadModel(
    slot: CharacterSlot, document: SpriteDocument, usage: CharacterModelUsage, id: string, signal: AbortSignal,
  ): Promise<LoadedCharacterModel> {
    const model = characterModel(document, id);
    const cache = slot.models.get(usage)!;
    const cached = cache.get(model.source);
    if (cached !== undefined) return cached;
    if (this.characterModels === null) throw new SpriteError('This host cannot load character models.');
    const loaded = await this.characterModels.load(model, usage, signal);
    cache.set(model.source, loaded);
    return loaded;
  }

  private presentationChanged(slot: CharacterSlot, settings: CharacterPresentation): void {
    slot.presentation = settings;
    this.syncModelViews(slot);
    if (this.slots[this.activeSlot] === slot) this.applyPresentation();
  }

  // Builds views for newly referenced models once, then releases models the profile dropped.
  private syncModelViews(slot: CharacterSlot): void {
    const { avatar } = slot.presentation;
    const loaded = (usage: CharacterModelUsage, id: string): LoadedCharacterModel => {
      const model = characterModel(slot.presentation, id);
      const result = slot.models.get(usage)!.get(model.source);
      if (result === undefined) throw new SpriteError(`Character model "${model.name}" was not loaded before use.`);
      return result;
    };
    const avatarModel = avatar === undefined ? null : loaded('avatar', avatar.model);
    if (slot.avatar !== null && (avatar === undefined || slot.avatar.model !== avatarModel ||
      !sameBoneMap(slot.avatar.boneMap, avatar.boneMap))) {
      this.shading.unregister(slot.avatar.view.root);
      slot.avatar.view.dispose();
      slot.avatar = null;
    }
    if (avatar !== undefined && slot.avatar === null) {
      const view = new SkinnedAvatarView(avatarModel!, resolveAvatarJoints(avatarModel!.report, avatar.boneMap), avatar.boneMap);
      this.shading.register(view.root);
      slot.avatar = { model: avatarModel!, boneMap: avatar.boneMap, view };
    }
    for (const role of PROP_MODEL_ROLES) {
      const profile = slot.presentation[role];
      const model = profile === undefined ? null : loaded(role, profile.model);
      const current = slot.props[role];
      if (current !== null && current.model !== model) {
        this.shading.unregister(current.view.root);
        current.view.dispose();
        slot.props[role] = null;
      }
      if (model !== null && slot.props[role] === null) {
        const view = new PropModelView(model, PROP_VIEW_NAMES[role]);
        this.shading.register(view.root);
        slot.props[role] = { model, view };
      }
    }
    const inUse: Readonly<Record<CharacterModelUsage, LoadedCharacterModel | undefined>> = {
      avatar: slot.avatar?.model, hammer: slot.props.hammer?.model, pot: slot.props.pot?.model,
    };
    for (const [usage, cache] of slot.models) {
      for (const [source, model] of cache) {
        if (model === inUse[usage]) continue;
        model.dispose();
        cache.delete(source);
      }
    }
  }

  private applyPresentation(): void {
    const slot = this.slots[this.activeSlot];
    const presentation = slot?.presentation ?? DEFAULT_PRESENTATION;
    const type = presentation.characterRiggingType;
    this.toolDepth = getToolDepth(type === 'sprite-2d' ? DEFAULT_ARM_FORWARD_DISTANCE : presentation.armForwardDistance);
    const avatarMode = type === 'avatar-3d';
    const imported = avatarMode ? slot?.avatar?.view ?? null : null;
    if (avatarMode && imported === null && this.avatar === null) {
      this.avatar = new AvatarView();
      this.shading.register(this.avatar.root);
    }
    this.avatarRenderer = !avatarMode ? null : imported ?? this.avatar;
    if (this.avatar !== null) this.attach(this.avatar.root, this.scene, this.avatarRenderer === this.avatar);
    for (const other of this.slots) {
      if (other.avatar !== null) this.attach(other.avatar.view.root, this.scene, other.avatar.view === imported);
      // Prop models show in every character type. The hammer draws in the tool's foreground pass;
      // the pot draws in the main pass, so its walls hide a body inside it through the depth buffer.
      for (const role of PROP_MODEL_ROLES) {
        const prop = other.props[role];
        if (prop !== null) this.attach(prop.view.root, role === 'hammer' ? this.foreground : this.scene, other === slot);
      }
    }
    for (const role of PROP_MODEL_ROLES) this.propModels[role] = slot?.props[role]?.view ?? null;
    for (const [id, binding] of this.bindings) {
      const replaced = this.propModels.hammer !== null && HAMMER_PARTS.has(id) || this.propModels.pot !== null && id === 'pot';
      binding.visibility.setEnabled({ enabled: (!avatarMode || PROP_PARTS.has(id)) && !replaced });
    }
    this.armChains = imported?.chains ?? DEFAULT_ARM_CHAINS;
    // Shading styles Avatar mode: the connected character and its separate pot and hammer.
    this.shading.apply(presentation.shading ?? DEFAULT_CHARACTER_SHADING, avatarMode);
  }

  private attach(object: Object3D, parent: Object3D, attached: boolean): void {
    object.visible = attached;
    if (!attached) object.removeFromParent();
    else if (object.parent !== parent) parent.add(object);
  }

  private propReplacementChanged(next: Object3D | null, previous: Object3D | null): void {
    if (previous !== null) this.shading.unregister(previous);
    if (next !== null) this.shading.register(next);
  }

  render(frame: PhysicsFrame, options: CharacterState & { dt: number }): void {
    this.renders++;
    const root = this.part(frame, 'root');
    const tip = this.part(frame, 'head');
    this.focus = { x: root.x, y: root.y };
    this.hammer = { x: tip.x, y: tip.y };
    this.updateFrustum();
    const target = this.cameraTarget();
    const blend = this.framing === null ? 1 - Math.exp(-VISUAL.cameraResponse * options.dt) : 1;
    this.camera.position.x += (target.x - this.camera.position.x) * blend;
    this.camera.position.y += (target.y - this.camera.position.y) * blend;
    this.keepRigVisible();
    this.camera.updateMatrixWorld();
    this.scenery.position.x = this.camera.position.x * 0.6;
    this.scenery.position.y = this.camera.position.y * 0.25;
    for (const part of frame.parts) {
      const mesh = this.playerMeshes.get(part.id);
      if (!mesh) continue;
      mesh.position.set(part.x, part.y, part.kind === 'pot' ? PLAYER_DEPTH.pot : this.toolDepth);
      mesh.rotation.z = part.angle;
      if (part.kind === 'pot' && this.propModels.pot !== null) {
        // The pot model's origin is the physical pot's bottom-centre, at the pot's own depth.
        const cos = Math.cos(part.angle), sin = Math.sin(part.angle);
        this.potFrame.makeRotationZ(part.angle)
          .setPosition(part.x - RIG.potBottom * sin, part.y + RIG.potBottom * cos, PLAYER_DEPTH.pot);
        this.propModels.pot.update(this.potFrame);
      }
    }
    this.torso.position.set(root.x, root.y, PLAYER_DEPTH.torso);
    this.torso.updateWorldMatrix(true, false);
    const shaftBase = this.part(frame, 'slider');
    const aimOrigin = this.part(frame, 'carrier');
    const aim = { x: frame.cursor.x - aimOrigin.x, y: frame.cursor.y - aimOrigin.y };
    this.headAim.update(aim, frame.time);
    this.headOffset.copy(this.headPivot).applyQuaternion(this.headAim.rotation).negate().add(this.headPivot);
    this.meshHead.matrix.makeRotationFromQuaternion(this.headAim.rotation).setPosition(this.headOffset);
    this.meshHead.matrixWorldNeedsUpdate = true;
    const shaftLength = Math.hypot(tip.x - shaftBase.x, tip.y - shaftBase.y);
    const shaftCenter = { x: (shaftBase.x + tip.x) / 2, y: (shaftBase.y + tip.y) / 2 };
    const shaftAngle = shaftLength <= PHYSICS.aimEpsilon ? shaftBase.angle : Math.atan2(tip.y - shaftBase.y, tip.x - shaftBase.x);
    this.cursor.position.set(frame.cursor.x, frame.cursor.y, 1);
    this.customShaft.position.set(shaftCenter.x, shaftCenter.y, this.toolDepth);
    this.customShaft.rotation.z = shaftAngle;
    this.customShaft.scale.x = shaftLength / RIG.handleLength;
    // Unscaled physical coordinates keep grip offsets independent of artwork and tiling.
    this.gripFrame.makeRotationZ(shaftAngle).setPosition(shaftBase.x, shaftBase.y, this.toolDepth);
    const armPoses = this.updateArms(this.torso.matrixWorld, this.gripFrame, shaftLength, { ...options, shaftAngle });
    this.avatarRenderer?.update(this.torso.matrixWorld, armPoses, this.headAim.rotation);
    // The one-model hammer follows the same unscaled physical frame as the grips, without stretching.
    this.propModels.hammer?.update(this.gripFrame);
    for (const pose of armPoses) this.spriteTargets.set(`${pose.side}-grip`, {
      x: pose.hand.x, y: pose.hand.y, angle: Math.atan2(pose.shaftAxis.y, pose.shaftAxis.x),
    });
    this.spriteTargets.set('hammer-base', { x: shaftBase.x, y: shaftBase.y, angle: shaftAngle });
    this.spriteTargets.set('hammer-shaft', { ...shaftCenter, angle: shaftAngle });
    this.spriteTargets.set('hammer-head', { x: tip.x, y: tip.y, angle: tip.angle });
    this.spriteTargets.set('aim', { ...frame.cursor, angle: Math.atan2(aim.y, aim.x) });
    this.slots[this.activeSlot]!.rig.update({ time: frame.time, dt: options.dt, aim, targets: this.spriteTargets });
    this.targetPositions.set([tip.x, tip.y, 0.8, frame.cursor.x, frame.cursor.y, 0.8]);
    this.targetLine.geometry.attributes.position.needsUpdate = true;
    this.targetLine.computeLineDistances();
    this.terrain.update(frame.time);
    this.flags.update();
    this.updrafts.update(frame.time);
    this.enemies.update(frame.enemies, frame.time);
    for (const layer of this.layers) layer.update(frame, armPoses);
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // Isolate tool depth from character artwork, including transparent GLBs and skinned sprites.
    this.renderer.clearDepth();
    this.renderer.render(this.foreground, this.camera);
  }

  recenter(frame: PhysicsFrame): void {
    const root = this.part(frame, 'root');
    const tip = this.part(frame, 'head');
    this.focus = { x: root.x, y: root.y };
    this.hammer = { x: tip.x, y: tip.y };
    this.updateFrustum();
    this.snapCamera();
  }

  resetPresentation(): void {
    this.headAim.reset();
    for (const slot of this.slots) slot.rig.resetPresentation();
  }

  private snapCamera(): void {
    const target = this.cameraTarget();
    this.camera.position.set(target.x, target.y, VISUAL.depth);
    this.keepRigVisible();
    this.camera.updateMatrixWorld();
  }

  pointerDelta(pixels: Point, sensitivity: number, mode: InputMode): Point {
    const scale = (mode === 'touch' ? RIG.maxReach / VISUAL.touchPixelsPerReach :
      this.worldHeight / this.height) * sensitivity;
    return { x: pixels.x * scale, y: -pixels.y * scale };
  }

  project(point: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    this.projection.set(point.x, point.y, 0).project(this.camera);
    return {
      x: rect.left + (this.projection.x + 1) * this.width / 2,
      y: rect.top + (1 - this.projection.y) * this.height / 2,
    };
  }

  unproject(client: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    this.projection.set((client.x - rect.left) / rect.width * 2 - 1,
      1 - (client.y - rect.top) / rect.height * 2, 0).unproject(this.camera);
    return { x: this.projection.x, y: this.projection.y };
  }

  setFraming(framing: CameraFraming | null): void {
    if (framing !== null && (![framing.x, framing.y, framing.worldHeight].every(Number.isFinite) || framing.worldHeight <= 0)) {
      throw new Error('Camera framing must have finite coordinates and a positive height.');
    }
    this.framing = framing === null ? null : { ...framing };
    this.updateFrustum();
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
      flags: this.flags.inspect(),
      updrafts: this.updrafts.inspect(),
      enemies: this.enemies.inspect(),
      sprites: this.sprites.inspect(),
      headAim: { rotation: this.headAim.rotation.toArray() },
      avatar: this.avatar === null ? null : { ...this.avatar.inspect(), visible: this.avatar.root.visible },
      importedAvatar: this.activeImportedAvatar(),
      hammerModel: this.propModels.hammer === null ? null : this.propModels.hammer.inspect(),
      potModel: this.propModels.pot === null ? null : this.propModels.pot.inspect(),
      shading: this.shading.inspect(),
      theme: { writes: this.themeWrites, sky: this.theme.sky, fog: { ...this.theme.fog }, backdrop: this.theme.backdrop.visible },
      characters: this.characterSelection(),
      armChains: { left: { ...this.armChains.left }, right: { ...this.armChains.right } },
    };
  }

  private activeImportedAvatar() {
    const view = this.slots[this.activeSlot]?.avatar?.view;
    if (view === undefined) return null;
    return { ...view.inspect(), visible: view.root.visible && view.root.parent !== null };
  }

  cameraState() {
    return {
      x: this.camera.position.x, y: this.camera.position.y, width: this.width, height: this.height,
      worldHeight: this.worldHeight, compact: this.compact,
    };
  }

  dispose(): void {
    this.observer.disconnect();
    this.disposeCharacters();
    this.avatar?.root.removeFromParent();
    this.avatar?.dispose();
    this.avatar = null;
    this.shading.dispose();
    this.terrain.root.removeFromParent();
    this.terrain.dispose();
    this.flags.dispose();
    this.updrafts.dispose();
    this.enemies.dispose();
    for (const layer of this.layers) { layer.root.removeFromParent(); layer.dispose(); }
    this.layers.clear();
    disposeResources(this.scene, this.foreground);
    this.bindings.clear();
    this.renderer.dispose();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('The game canvas must have a visible size.');
    this.width = rect.width;
    this.height = rect.height;
    this.updateFrustum();
    this.snapCamera();
    this.renderer.setSize(this.width, this.height, false);
  }

  private framingBounds() {
    return {
      minX: Math.min(this.focus.x - POT_HALF_WIDTH, this.hammer.x - HAMMER_RADIUS),
      maxX: Math.max(this.focus.x + POT_HALF_WIDTH, this.hammer.x + HAMMER_RADIUS),
      minY: Math.min(this.focus.y + RIG.potBottom, this.hammer.y - HAMMER_RADIUS),
      maxY: Math.max(this.focus.y + VISUAL.characterTop, this.hammer.y + HAMMER_RADIUS),
    };
  }

  private updateFrustum(): void {
    const aspect = this.width / this.height;
    this.compact = this.width < VISUAL.compactWidth || this.height < VISUAL.compactHeight || aspect < 1;
    const bounds = this.framingBounds();
    const span = 2 * (RIG.maxReach + VISUAL.reachMargin);
    const padding = 2 * VISUAL.framingMargin;
    const worldHeight = this.framing !== null ? this.framing.worldHeight : this.compact ? Math.max(
      span, span / aspect, bounds.maxY - bounds.minY + padding,
      (bounds.maxX - bounds.minX + padding) / aspect,
    ) : VISUAL.viewHeight;
    const halfHeight = worldHeight / 2;
    const halfWidth = halfHeight * aspect;
    if (this.worldHeight === worldHeight && this.camera.right === halfWidth && this.camera.top === halfHeight) return;
    this.worldHeight = worldHeight;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  private cameraTarget(): Point {
    if (this.framing !== null) return this.framing;
    return this.compact ? {
      x: this.focus.x + RIG.shoulder.x,
      y: Math.max(this.focus.y + RIG.shoulder.y, this.worldHeight / 2 - VISUAL.visibleGroundDepth),
    } : {
      x: this.focus.x + VISUAL.cameraLead,
      y: Math.max(VISUAL.cameraMinimumY, this.focus.y + VISUAL.cameraLift),
    };
  }

  private keepRigVisible(): void {
    if (!this.compact || this.framing !== null) return;
    const bounds = this.framingBounds();
    const halfWidth = this.camera.right;
    const halfHeight = this.camera.top;
    this.camera.position.x = clamp(this.camera.position.x,
      bounds.maxX + VISUAL.framingMargin - halfWidth, bounds.minX - VISUAL.framingMargin + halfWidth);
    this.camera.position.y = clamp(this.camera.position.y,
      bounds.maxY + VISUAL.framingMargin - halfHeight, bounds.minY - VISUAL.framingMargin + halfHeight);
  }

  applyLevel(change: LevelChange): void {
    this.setLabels(change.level.labels);
    this.flags.apply(change);
    this.updrafts.apply(change);
  }

  private setLabels(labels: readonly LevelLabel[]): void {
    if (this.labelDefinition === labels) return;
    this.labelDefinition = labels;
    disposeResources(this.decorations);
    this.decorations.clear();
    for (const label of labels) this.addLabel(label.text, label);
  }

  private buildScenery(): void {
    const { backdrop } = this.theme;
    const layers = [
      { color: backdrop.far, z: -24, base: -5, height: 14 },
      { color: backdrop.middle, z: -16, base: -6, height: 11 },
      { color: backdrop.near, z: -10, base: -8, height: 9 },
    ];
    for (const [layerIndex, layer] of layers.entries()) {
      const vertices: Point[] = [{ x: -70, y: layer.base }, { x: 70, y: layer.base }];
      for (let index = 20; index >= 0; index--) {
        vertices.push({
          x: -70 + index * 7,
          y: layer.base + layer.height * (0.55 + 0.23 * Math.sin(index * 1.7 + layerIndex) + 0.22 * Math.cos(index * 0.71)),
        });
      }
      const mountains = new Mesh(new ExtrudeGeometry(polygonShape(vertices), { depth: 0.1, bevelEnabled: false }),
        new MeshBasicMaterial({ color: layer.color }));
      mountains.position.z = layer.z;
      mountains.visible = backdrop.visible;
      this.mountains.push(mountains);
      this.scenery.add(mountains);
    }
    this.sunDisc.position.set(-4.2, 8, -35);
    this.sunDisc.visible = this.theme.sunDisc.visible;
    this.scenery.add(this.sunDisc);
    this.scene.add(this.scenery);
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
    const profile = [
      new Vector2(0.19, -0.47), new Vector2(0.33, -0.41), new Vector2(0.44, -0.28),
      new Vector2(0.49, 0.05), new Vector2(0.46, 0.23), new Vector2(0.43, 0.32),
    ];
    pot.add(solid(new LatheGeometry(profile, 40), brass));
    const rim = solid(new TorusGeometry(0.433, 0.035, 10, 40), trim, [0, 0.31, 0]);
    rim.rotation.x = Math.PI / 2;
    pot.add(rim);
    pot.add(solid(new CylinderGeometry(0.425, 0.425, 0.018, 32), dark, [0, 0.285, 0]));
    const badge = solid(new SphereGeometry(0.11, 12, 8), ceramic, [0, -0.03, 0.472]);
    badge.scale.set(1, 0.9, 0.16);
    pot.add(badge);
    const potAnchor = this.visualSlot('pot', pot);
    this.playerMeshes.set('pot', potAnchor);
    this.scene.add(potAnchor);

    const body = new Group();
    const chest = solid(new SphereGeometry(0.28, 16, 12), suit, [0, 0.56, 0]);
    chest.scale.set(0.82, 1.25, 0.77);
    body.add(chest);
    body.add(solid(new CylinderGeometry(0.07, 0.09, 0.16, 12), dark, [0, 0.89, 0]));
    this.torso.add(this.visualSlot('torso', body));
    const characterHead = new Group();
    const helmet = solid(new SphereGeometry(0.225, 20, 14), ceramic, [0, 1.095, 0]);
    helmet.scale.y = 1.06;
    characterHead.add(helmet);
    const visor = solid(new SphereGeometry(0.19, 20, 12), dark, [0, 1.10, 0.16]);
    visor.scale.set(0.92, 0.52, 0.43);
    characterHead.add(visor);
    const reflection = solid(new BoxGeometry(0.08, 0.018, 0.01), trim, [-0.05, 1.13, 0.243]);
    characterHead.add(reflection);
    this.torso.add(this.visualSlot('character-head', characterHead));
    this.scene.add(this.torso);
    for (const side of ARM_SIDES) {
      const arm: Arm = {
        upper: this.visualSlot(`${side}-upper-arm`, solid(new CylinderGeometry(0.065, 0.073, 1, 10), side === 'left' ? dark : suit)),
        lower: this.visualSlot(`${side}-forearm`, solid(new CylinderGeometry(0.055, 0.07, 1, 10), ceramic)),
        elbow: this.visualSlot(`${side}-elbow`, solid(new SphereGeometry(0.077, 12, 8), brass)),
        hand: this.visualSlot(`${side}-hand`, solid(new SphereGeometry(0.083, 12, 8), dark)),
        pose: null,
      };
      this.scene.add(arm.upper, arm.lower, arm.elbow, arm.hand);
      this.arms.set(side, arm);
    }
    const shaftSegments: Group[] = [];
    for (let index = 0; index < RIG.handleSegments; index++) {
      const segment = new Group();
      const shaft = solid(new CylinderGeometry(RIG.handleHalfWidth, RIG.handleHalfWidth, RIG.segmentLength, 10), wood);
      shaft.rotation.z = Math.PI / 2;
      segment.add(shaft);
      const sleeve = solid(new CylinderGeometry(0.052, 0.052, 0.04, 10), brass, [-0.18, 0, 0]);
      sleeve.rotation.z = Math.PI / 2;
      segment.add(sleeve);
      this.playerMeshes.set(`handle-${index}`, segment);
      this.foreground.add(segment);
      shaftSegments.push(segment);
    }
    this.bindings.set('hammer-shaft', {
      anchor: this.customShaft,
      modelAnchor: this.customShaft,
      defaults: shaftSegments,
      bounds: new Box3(
        new Vector3(-RIG.handleLength / 2, -RIG.handleHalfWidth, -RIG.handleHalfWidth),
        new Vector3(RIG.handleLength / 2, RIG.handleHalfWidth, RIG.handleHalfWidth),
      ),
      visibility: this.visibility('hammer-shaft', shaftSegments),
    });
    for (const segment of shaftSegments) this.shading.register(segment);
    this.foreground.add(this.customShaft);
    const head = new Group();
    const headMesh = new Mesh(new ExtrudeGeometry(polygonShape(RIG.headVertices), {
      depth: 0.22, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1,
    }), dark);
    headMesh.position.z = -0.11;
    head.add(headMesh);
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
    });
    if (PROP_PARTS.has(slot)) this.shading.register(model);
    return anchor;
  }

  // Pot and hammer replacements from authoring tools follow the Avatar-mode shading too.
  private visibility(slot: VisualPartId, defaults: readonly Object3D[]): VisualVisibility {
    return new VisualVisibility(defaults, PROP_PARTS.has(slot)
      ? { onReplacement: (next, previous) => this.propReplacementChanged(next, previous) } : {});
  }

  private updateArms(body: Matrix4, shaft: Matrix4, shaftLength: number,
    options: { armIk: Readonly<ArmIkSettings>; dt: number; shaftAngle: number }): ArmPose[] {
    const settings = options.armIk;
    const poses: ArmPose[] = [];
    for (const side of ARM_SIDES) {
      const arm = this.arms.get(side);
      if (!arm) throw new Error(`Missing visual arm: ${side}`);
      const geometry = ARM_GEOMETRY[side];
      // An imported avatar supplies its own shoulders and bind-pose bone lengths; grips are shared.
      const chain = this.armChains[side];
      const pose = solveArmPose(side, {
        shoulder: new Vector3(...chain.shoulder).applyMatrix4(body),
        hand: new Vector3(Math.min(geometry.gripX, shaftLength), 0, 0).applyMatrix4(shaft),
        hint: new Vector3(settings[`${side}HintX`], settings[`${side}HintY`], settings[`${side}HintZ`]).applyMatrix4(body),
        shaftAxis: new Vector3(Math.cos(options.shaftAngle), Math.sin(options.shaftAngle), 0),
      }, { previous: arm.pose, dt: options.dt, lengths: chain });
      this.positionLimb(arm.upper, pose.shoulder, pose.elbow, pose.normal);
      this.positionLimb(arm.lower, pose.elbow, pose.hand, pose.normal);
      arm.elbow.position.copy(pose.elbow);
      arm.hand.position.copy(pose.hand);
      arm.hand.rotation.set(0, 0, options.shaftAngle);
      arm.pose = pose;
      poses.push(pose);
    }
    return poses;
  }

  private positionLimb(mesh: Object3D, start: Vector3, end: Vector3, normal: Vector3): void {
    mesh.position.addVectors(start, end).multiplyScalar(0.5);
    this.limbDirection.subVectors(end, start);
    mesh.scale.y = this.limbDirection.length();
    this.limbDirection.normalize();
    this.limbSide.crossVectors(this.limbDirection, normal).normalize();
    this.limbNormal.crossVectors(this.limbSide, this.limbDirection);
    this.limbRotation.makeBasis(this.limbSide, this.limbDirection, this.limbNormal);
    mesh.quaternion.setFromRotationMatrix(this.limbRotation);
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
    this.decorations.add(sprite);
  }

  private part(frame: PhysicsFrame, id: string): PartPose {
    const part = frame.parts.find((candidate) => candidate.id === id);
    if (!part) throw new Error(`Missing rendered physics part: ${id}`);
    return part;
  }
}
