import {
  ACESFilmicToneMapping, AmbientLight, CanvasTexture, DirectionalLight, Fog, Group, HemisphereLight,
  OrthographicCamera, PerspectiveCamera, Scene, Sprite, SpriteMaterial, Vector3, WebGLRenderer,
} from 'three';
import { ARM_LAYER } from './arm-layer';
import { CASTER_LAYER, CharacterLight, CharacterShadowParts, TOOL_LAYER } from './character-light';
import { OBSTACLE_LINE } from './obstacle-line';
import type { CharacterModelLoader } from './character-model-types';
import type { CharacterFigure } from './character-figure';
import { CharacterView } from './character-view';
import type { InputMode, Point } from './config';
import type { LevelChange, LevelDefinition, LevelLabel } from './level';
import type { RigGeometry } from './rig';
import { DEFAULT_HAMMER_HEAD, hammerHeadRadius } from './hammer-head';
import type { HammerHead } from './hammer-head';
import { LevelLooks } from './object-looks';
import type { Kinds } from './plugins/kinds';
import type { RuntimePlugins } from './plugins/runtime';
import { call0, call1, call2, call3, checkInstance } from './plugins/kernel';
import type { Attributed, CheckedInstance } from './plugins/kernel';
import { createCameraDirector, checkCameraAim } from './camera-director';
import type { CameraAim, CameraDirector } from './camera-director';
import { createBackdrop } from './backdrop';
import type { Backdrop } from './backdrop';
import { createAimMarks } from './aim-marks';
import type { AimMarks } from './aim-marks';
import { SceneEffects } from './effects';
import type { DeathFrame, DeathKind } from './death-sequence';
import { createSceneFrame } from './scene-frame';
import type { MutableSceneFrame } from './scene-frame';
import { createSceneLayers, SCENE_LAYER_CONTRACT } from './scene-layer';
import type { SceneLayer, ScenePass } from './scene-layer';
import { disposeResources } from './scene-resources';
import { physicsPart } from './simulation';
import type { PhysicsFrame } from './simulation';
import { TerrainView } from './terrain-view';
import type { DecorationView } from './decoration-view';
import { Disposal } from './disposal';
import { DEFAULT_THEME } from './theme';
import type { GameTheme } from './theme';
import type { EnemyArtSettings } from './enemy-art-data';
import type { EnemyEvent } from './enemy-types';
import { DEFAULT_ENEMY_ART } from './enemy-art-data';
import type { ContentLoader } from './content-ref';
import { ViewMeasurements } from './view-measurements';
import { BackgroundDefocus } from './background-defocus';

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
const ENGINE = Object.freeze({ plugin: null, point: null });
// three.js's default render layer, which everything but a 3D character's arms and the player's tool is on.
const DEFAULT_LAYER = 0;

export interface CameraFraming extends Point {
  worldHeight: number;
}

export class GameView {
  readonly canvas: HTMLCanvasElement;
  readonly terrain = new TerrainView();
  readonly measurements = new ViewMeasurements();
  readonly character: CharacterView;
  // How the level's flags, updrafts, bonfires, traps, projectiles, liquid pools and enemies look.
  private readonly looks: LevelLooks;
  private readonly renderer: WebGLRenderer;
  // Passes, each drawn over the last. The course: terrain, its artwork and the scenery behind the obstacle line.
  // Then, with depth cleared, the actors: the characters, phantoms and enemies, which the course's colliders,
  // reaching half their depth toward the camera, must never hide; a 3D character's arms (ARM_LAYER) and the player's
  // tool (TOOL_LAYER) are left out, except while the character casts its shadows (CASTER_LAYER).
  // Then, with depth cleared, the front: decorations on or in front of the line and the looks' fronts, such as the
  // halves of swinging axes and liquid pools in front of it. Then, with depth cleared again,
  // a 3D character's arms, so they never clip into its body, jar or head; the marks, which ignore depth and write
  // none (aim cursor and line, course labels, editor overlays); and last the actors' tool layer, the hammer, which
  // shares the arms' depth so the hands hold it.
  // The first part of the course pass. A separate render, without a depth clear before the rest of the course,
  // guarantees that a backdrop draws first even when its root mixes opaque and transparent materials.
  private readonly backdropScene = new Scene();
  private readonly defocus = new BackgroundDefocus();
  // The backdrop, then the course, without clearing depth between them.
  private readonly drawCourse = (): void => {
    if (this.backdrop.value.root.visible) this.renderer.render(this.backdropScene, this.camera);
    this.renderer.render(this.course, this.camera);
  };
  private readonly course = new Scene();
  private readonly actors = new Scene();
  private readonly front = new Scene();
  private readonly marks = new Scene();
  // Over everything, the tool included; drawn only while something there shows.
  private readonly top = new Scene();
  private readonly orthographic = new OrthographicCamera();
  private readonly perspective = new PerspectiveCamera();
  // The theme's camera. Either looks along -z at the course plane, the obstacle line (z = 0), from `distance`, and
  // shows it `worldHeight` tall, so the plane maps to the screen the same way in both.
  private camera: OrthographicCamera | PerspectiveCamera;
  private distance: number = VISUAL.depth;
  private readonly director: Attributed<CameraDirector>;
  private readonly cameraView = {
    focus: { x: 0, y: 0 }, reach: { x: 0, y: 0 }, reachRadius: 0, maxReach: 0, jarHalfWidth: 0, jarBottom: 0,
    width: 1, height: 1, dt: 0, death: null as DeathKind | null,
  };
  private readonly cameraAim: CameraAim = { x: 0, y: 0, worldHeight: 0 };
  private readonly backdrop: Attributed<Backdrop>;
  private readonly aimMarks: Attributed<AimMarks>;
  readonly effects: SceneEffects;
  // Course labels.
  private readonly labels = new Group();
  // Null in a release whose level has no decorations; its shell then carries none of their code.
  readonly decorations: DecorationView | null;
  private readonly layers = new Map<SceneLayer, CheckedInstance<SceneLayer>>();
  private updatingLayers: readonly Attributed<SceneLayer>[] = [];
  private readonly sceneFrame: MutableSceneFrame;
  private renders = 0;
  private rig: RigGeometry;
  private headOutline: HammerHead = DEFAULT_HAMMER_HEAD;
  private hammerRadius = hammerHeadRadius(DEFAULT_HAMMER_HEAD);
  private readonly observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private pendingSize: DOMRect | null = null;
  // Zero until the first frustum update, which always runs.
  private worldHeight = 0;
  private framing: CameraFraming | null = null;
  private labelDefinition: readonly LevelLabel[] | null = null;
  private readonly projection = new Vector3();
  private theme: GameTheme;
  private readonly fog: Fog;
  // The actors' sunlight, from the theme's character light, and the player's parts that its shadows take in.
  private readonly characterLight: CharacterLight;
  private readonly characterParts: CharacterShadowParts;
  // Each light exists in every lit pass: all but the marks.
  private readonly lights: {
    readonly hemisphere: HemisphereLight[]; readonly ambient: AmbientLight[];
    readonly sun: DirectionalLight[]; readonly rim: DirectionalLight[];
  } = { hemisphere: [], ambient: [], sun: [], rim: [] };
  private themeWrites = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, initial: PhysicsFrame, level: LevelDefinition, options: {
    // Loads imported character GLBs; hosts without one reject profiles that reference models.
    characterModels?: CharacterModelLoader | null;
    // Loads a release's packaged sprite images.
    content?: ContentLoader;
    theme?: GameTheme;
    enemyArt?: EnemyArtSettings;
    kinds: Kinds;
    plugins: RuntimePlugins;
    onCharacterFigure: (figure: CharacterFigure) => void;
    // Creates the decoration view; without it the view draws no decorations.
    decorations?: (() => DecorationView) | null;
  }) {
    this.canvas = canvas;
    this.theme = options.theme ?? DEFAULT_THEME;
    const theme = this.theme;
    this.camera = theme.camera.perspective ? this.perspective : this.orthographic;
    // Resolve and check plugin factories before creating a WebGL renderer or attaching any view listeners.
    // A later factory failure frees every presentation object already made.
    const created: Attributed<{ dispose(): void }>[] = [];
    let layers: readonly CheckedInstance<SceneLayer>[];
    let looks: LevelLooks | null = null;
    let effects: SceneEffects | null = null;
    try {
      this.director = createCameraDirector(options.plugins);
      this.character = new CharacterView(initial, {
        characterModels: options.characterModels, content: options.content, theme, kinds: options.kinds, plugins: options.plugins,
        onCharacterFigure: options.onCharacterFigure, prepareTexture: (texture) => this.renderer.initTexture(texture),
      });
      looks = new LevelLooks(options.plugins, level.objects, options.enemyArt === undefined ? DEFAULT_ENEMY_ART : options.enemyArt);
      this.looks = looks;
      this.backdrop = createBackdrop(options.plugins, theme);
      created.push(this.backdrop);
      this.aimMarks = createAimMarks(options.plugins, theme);
      created.push(this.aimMarks);
      this.effects = effects = new SceneEffects(options.plugins, initial.placement);
      layers = createSceneLayers(options.plugins);
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      disposal.run(() => effects?.dispose());
      for (let index = created.length - 1; index >= 0; index--) {
        const target = created[index]!;
        disposal.run(() => call0(target, 'dispose'));
      }
      disposal.run(() => looks?.dispose());
      disposal.run(() => this.character?.dispose());
      disposal.run(() => this.terrain.dispose());
      disposal.finish();
      throw error;
    }
    const root = initial.player.centre, head = physicsPart(initial, 'head');
    this.cameraView.focus.x = root.x;
    this.cameraView.focus.y = root.y;
    this.cameraView.reach.x = head.x;
    this.cameraView.reach.y = head.y;
    this.rig = initial.rig;
    this.sceneFrame = createSceneFrame(head.vertices);
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
      // Only the player's 3D character casts shadows, from the actors' sunlight.
      this.renderer.shadowMap.enabled = true;
      this.renderer.setClearColor(theme.sky);
      this.fog = new Fog(theme.fog.color);
      // The marks and top are unlit; they only take the fog.
      this.marks.fog = this.fog;
      this.top.fog = this.fog;
      let characterSun: DirectionalLight | null = null;
      for (const pass of [this.backdropScene, this.course, this.actors, this.front]) {
        pass.fog = this.fog;
        const hemisphere = new HemisphereLight(theme.hemisphere.sky, theme.hemisphere.ground, theme.hemisphere.intensity);
        const ambient = new AmbientLight(theme.ambient.color, theme.ambient.intensity);
        const sunlight = new DirectionalLight(theme.sun.color, theme.sun.intensity);
        sunlight.position.set(-5, 12, 10);
        const rimLight = new DirectionalLight(theme.rim.color, theme.rim.intensity);
        rimLight.position.set(8, 3, -4);
        // The actors' lights also light the arms and the tool, which draw in passes of their own.
        if (pass === this.actors) {
          for (const light of [hemisphere, ambient, sunlight, rimLight]) {
            light.layers.enable(ARM_LAYER);
            light.layers.enable(TOOL_LAYER);
          }
          characterSun = sunlight;
        }
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
      this.actors.add(this.character.actors, this.character.foreground);
      this.characterLight = new CharacterLight(characterSun!, this.actors, theme);
      this.characterParts = new CharacterShadowParts(this.character.actors, this.character.foreground);
      this.marks.add(this.aimMarks.value.root);
      for (const effect of this.effects.all) this.passScene(effect.captured.pass).add(effect.value.root);
      for (const layer of layers) this.addLayer(layer.value, layer);
      this.observer = new ResizeObserver(() => {
        const size = this.readSize();
        this.pendingSize = size.width === this.width && size.height === this.height ? null : size;
      });
      this.observer.observe(canvas);
      this.resize(this.readSize());
      this.recenter(initial);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  // Restyles the existing lights, fog, backdrop and materials in place; nothing is rebuilt.
  setTheme(theme: GameTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.themeWrites++;
    this.renderer.setClearColor(theme.sky);
    this.renderer.toneMappingExposure = theme.exposure;
    if (theme.camera.blur === 0) this.defocus.release();
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
    this.characterLight.setTheme(theme);
    call1(this.backdrop, 'setTheme', theme);
    call1(this.aimMarks, 'setTheme', theme);
    this.character.setTheme(theme);
  }

  applyEnemy(event: EnemyEvent): void { this.looks.applyEnemy(event); }
  setEnemyArt(art: EnemyArtSettings): void { this.looks.setEnemyArt(art); }

  addLayer(layer: SceneLayer, source: Pick<Attributed<unknown>, 'plugin' | 'point'> = ENGINE): void {
    const target = this.layers.get(layer) ?? checkInstance<SceneLayer>(SCENE_LAYER_CONTRACT, layer, source);
    this.layers.set(layer, target);
    if (layer.update !== undefined && !this.updatingLayers.includes(target)) {
      this.updatingLayers = [...this.updatingLayers, target];
    }
    this.passScene(target.captured.pass).add(layer.root);
  }

  // Removes a layer added with addLayer() and disposes it.
  removeLayer(layer: SceneLayer): void {
    const target = this.layers.get(layer);
    if (target === undefined) return;
    this.layers.delete(layer);
    if (this.updatingLayers.includes(target)) {
      this.updatingLayers = this.updatingLayers.filter(registered => registered !== target);
    }
    layer.root.removeFromParent();
    if (layer.dispose !== undefined) call0(target, 'dispose');
  }

  // Internal rig settings for phantom playback, including before its first drawn frame.
  get rigGeometry(): RigGeometry { return this.rig; }

  render(physics: PhysicsFrame, options: { dt: number; death: DeathFrame | null }): void {
    // ResizeObserver runs after drawing; resize the buffer only when this call can draw it again.
    const size = this.pendingSize;
    if (size !== null) {
      this.resize(size);
      this.pendingSize = null;
    }
    if (this.measurements.capturing) {
      const startedAt = performance.now();
      this.renderFrame(physics, options);
      this.measurements.record(performance.now() - startedAt);
      return;
    }
    this.renderFrame(physics, options);
  }

  private renderFrame(physics: PhysicsFrame, options: { dt: number; death: DeathFrame | null }): void {
    this.renders++;
    this.syncRig(physics);
    this.syncHead(physicsPart(physics, 'head').vertices);
    // The camera follows the simulation; the character draws where a presentation preview moves it.
    const focus = physics.player.centre, reach = physicsPart(physics, 'head');
    this.cameraView.focus.x = focus.x;
    this.cameraView.focus.y = focus.y;
    this.cameraView.reach.x = reach.x;
    this.cameraView.reach.y = reach.y;
    this.updateCamera(options.dt, false);
    call1(this.backdrop, 'follow', this.cameraAim);
    const frame = this.character.pose(physics, options), tip = physicsPart(frame, 'head');
    this.characterParts.flush();
    const casting = this.characterLight.place(frame.player.centre, this.character.stance.upperBody3d);
    call3(this.aimMarks, 'update', tip, frame.cursor, this.cameraView.death);
    this.terrain.update(frame.time);
    this.decorations?.update();
    this.looks.update(frame.time, frame.projectiles, frame.enemies, frame.platforms);
    const layers = this.updatingLayers;
    if (layers.length > 0 || this.effects.active) {
      const shown = this.sceneFrame;
      shown.time = frame.time;
      shown.cursor.x = frame.cursor.x; shown.cursor.y = frame.cursor.y;
      shown.enemies = frame.enemies;
      this.writeView(shown.view);
      this.character.writeScene(shown);
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index]!;
        // An earlier update may have removed and disposed a layer still in this frame's captured list.
        if (this.layers.get(layer.value) === layer) call1(layer, 'update', shown);
      }
      this.effects.update(shown);
    }
    this.renderer.info.reset();
    this.renderer.clear();
    if (this.theme.camera.blur > 0) {
      this.defocus.render(this.renderer, this.camera, this.fog, this.distance, this.theme.camera, this.drawCourse);
    } else this.drawCourse();
    this.renderer.clearDepth();
    // While the character casts its shadows, its arms and tool draw here too, so the shadow map, drawn first, has them.
    if (casting) this.camera.layers.enable(CASTER_LAYER);
    try { this.renderer.render(this.actors, this.camera); } finally { this.camera.layers.set(DEFAULT_LAYER); }
    if (this.drawsFront()) {
      this.renderer.clearDepth();
      this.renderer.render(this.front, this.camera);
    }
    this.renderer.clearDepth();
    // Whether the actors' arms pass runs: the active character has 3D arms, which hold the tool. 2D characters keep
    // their authored depths.
    if (this.character.stance.upperBody3d) this.drawActorsLayer(ARM_LAYER);
    this.renderer.render(this.marks, this.camera);
    this.drawActorsLayer(TOOL_LAYER);
    // Like the marks, the top ignores depth.
    if (this.drawsTop()) this.renderer.render(this.top, this.camera);
  }

  // Draws only the actors on `layer`, as the actors pass placed them.
  private drawActorsLayer(layer: number): void {
    this.camera.layers.set(layer);
    this.actors.matrixWorldAutoUpdate = false;
    try { this.renderer.render(this.actors, this.camera); } finally {
      this.actors.matrixWorldAutoUpdate = true;
      this.camera.layers.set(DEFAULT_LAYER);
    }
  }

  recenter(frame: PhysicsFrame): void {
    this.syncRig(frame);
    const root = frame.player.centre, tip = physicsPart(frame, 'head');
    this.syncHead(tip.vertices);
    this.cameraView.focus.x = root.x;
    this.cameraView.focus.y = root.y;
    this.cameraView.reach.x = tip.x;
    this.cameraView.reach.y = tip.y;
    this.snapCamera();
  }

  private snapCamera(): void { this.updateCamera(0, true); }

  private updateCamera(dt: number, snap: boolean): void {
    const view = this.cameraView;
    view.death = this.character.deathKind;
    view.reachRadius = this.hammerRadius;
    view.maxReach = this.rig.maxReach;
    view.jarHalfWidth = this.rig.jar.halfWidth;
    view.jarBottom = this.rig.jar.bottom;
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
    const plane = this.unproject(client), { x, y } = this.camera.position;
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
    const rect = this.canvas.getBoundingClientRect(), { halfWidth, halfHeight } = this.halfExtents();
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
    const character = this.character.statistics();
    return {
      frames: this.renderer.info.render.frame,
      renders: this.renders,
      // Totals of the last completed game render, including every pass.
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      lines: this.renderer.info.render.lines,
      points: this.renderer.info.render.points,
      renderTime: this.measurements.read(),
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      terrain: this.terrain.inspect(),
      decorations: this.decorations?.inspect() ?? null,
      looks: this.looks.inspect(),
      enemies: this.looks.inspectEnemies(),
      sprites: character.sprites,
      headAim: character.headAim,
      avatar: character.avatar,
      importedAvatar: character.importedAvatar,
      hammerModel: character.hammerModel,
      parts: character.parts,
      potModel: character.potModel,
      theme: { writes: this.themeWrites, sky: this.theme.sky, fog: { ...this.theme.fog }, backdrop: this.theme.backdrop.visible },
      camera: {
        ...this.cameraState(),
        perspective: this.camera === this.perspective, fieldOfView: this.perspective.fov, distance: this.distance,
        near: this.camera.near, far: this.camera.far, fog: { near: this.fog.near, far: this.fog.far },
      },
      characters: character.characters,
      armChains: character.armChains,
      rig: this.rig,
      grips: character.grips,
    };
  }

  // On-request camera readings without invoking a plugin's diagnostics.
  cameraReadings() {
    return {
      x: this.camera.position.x, y: this.camera.position.y, width: this.width, height: this.height,
      worldHeight: this.worldHeight,
    };
  }

  cameraState() {
    return {
      ...this.cameraReadings(),
      director: this.director.value.inspect === undefined ? null : call0(this.director, 'inspect') ?? null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    disposal.run(() => this.observer?.disconnect());
    disposal.run(() => this.characterParts?.dispose());
    disposal.run(() => this.characterLight?.dispose());
    disposal.run(() => this.character.dispose());
    disposal.run(() => this.terrain.root.removeFromParent());
    disposal.run(() => this.terrain.dispose());
    disposal.run(() => this.decorations?.dispose());
    disposal.run(() => this.looks.dispose());
    disposal.run(() => this.backdrop.value.root.removeFromParent());
    disposal.run(() => call0(this.backdrop, 'dispose'));
    disposal.run(() => this.aimMarks.value.root.removeFromParent());
    disposal.run(() => call0(this.aimMarks, 'dispose'));
    disposal.run(() => this.effects.dispose());
    for (const layer of this.layers.values()) {
      disposal.run(() => layer.value.root.removeFromParent());
      if (layer.value.dispose !== undefined) disposal.run(() => call0(layer, 'dispose'));
    }
    this.layers.clear();
    this.updatingLayers = [];
    disposal.run(() => disposeResources(this.backdropScene, this.course, this.actors, this.front, this.marks, this.top));
    disposal.run(() => this.defocus.dispose());
    disposal.run(() => this.renderer?.dispose());
    disposal.finish();
  }

  private readSize(): DOMRect {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('The game canvas must have a visible size.');
    return rect;
  }

  private resize(size: DOMRect): void {
    this.width = size.width;
    this.height = size.height;
    this.snapCamera();
    this.renderer.setSize(this.width, this.height, false);
  }

  private updateFrustum(): void {
    const aspect = this.width / this.height, worldHeight = this.cameraAim.worldHeight;
    const halfHeight = worldHeight / 2, halfWidth = halfHeight * aspect;
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

  // The course plane's rectangle the camera shows, as halfExtents() sizes it, without allocating.
  private writeView(out: MutableSceneFrame['view']): void {
    const { x, y } = this.camera.position, halfHeight = this.worldHeight / 2, halfWidth = halfHeight * this.width / this.height;
    out.left = x - halfWidth;
    out.right = x + halfWidth;
    out.bottom = y - halfHeight;
    out.top = y + halfHeight;
  }

  // The scene drawing a validated pass.
  private passScene(pass: ScenePass | undefined): Scene {
    return pass === 'course' ? this.course : pass === 'actors' ? this.actors : pass === 'top' ? this.top : this.marks;
  }

  // Whether anything draws in front of the obstacle line, over the actors.
  private drawsFront(): boolean {
    return (this.decorations !== null && this.decorations.front.children.length > 0) || this.looks.drawsFront();
  }

  // Whether anything shows over the tool.
  private drawsTop(): boolean {
    const children = this.top.children;
    for (let index = 0; index < children.length; index++) if (children[index]!.visible) return true;
    return false;
  }

  // Burns the bonfires the player has reached this run, and puts the rest out.
  setLitBonfires(ids: readonly string[]): void { this.looks.setLit(ids); }
  setPressedSwitches(ids: readonly string[]): void { this.looks.setPressedSwitches(ids); }

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

  // Follows the physical head's outline when the hammer's head changes: the built-in head mesh, the framing and how
  // near the head the hands may come.
  private syncHead(outline: HammerHead): void {
    if (outline === this.headOutline) return;
    this.headOutline = outline;
    this.hammerRadius = hammerHeadRadius(outline);
    this.character.syncHead(outline);
  }

  // Follows a rebuilt rig: the two-part hammer's segment lengths, hammer models' handles, touch gain and framing.
  private syncRig(frame: PhysicsFrame): void {
    if (frame.rig === this.rig) return;
    this.rig = frame.rig;
    this.character.syncRig(frame);
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
}
