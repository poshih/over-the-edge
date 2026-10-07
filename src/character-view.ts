import { Group } from 'three';
import type { Matrix4, Texture } from 'three';
import { DEFAULT_ARM_IK } from './character';
import type { ArmIkSettings, ArmSide, VisualBinding, VisualPartId } from './character';
import type { ArmPose } from './arm-ik';
import type { CharacterArms, ArmLengths } from './character-arms';
import { DEFAULT_CHARACTER_FIGURE, resolveCharacterFigure, sameCharacterFigure } from './character-figure';
import type { CharacterFigure, CharacterFigureSource } from './character-figure';
import { characterStance, MeshPartsPresenter } from './character-presenter';
import type { CharacterPresenter, CharacterStance, DeathPresented, LivePresented, PresentedFrame } from './character-presenter';
import { CharacterProfiles, DEFAULT_PRESENTATION, HAMMER_PARTS, PROP_PARTS } from './character-profiles';
import type { PreparedAvatar } from './character-profiles';
import type { CharacterModelUsage } from './character-model-inspect';
import type { CharacterModelLoader, LoadedCharacterModel } from './character-model-types';
import type { PreparedAvatarMotions } from './avatar-rig';
import type { AvatarMotionModel } from './avatar-motion';
import { BuiltInAvatarPresenter } from './avatar-presenter';
import type { ContentLoader } from './content-ref';
import { createDeathAppearance, createDeathPoseWriter } from './death-pose';
import type { DeathAppearance, DeathPoseInput, DeathPoseWriter } from './death-pose';
import type { DeathFrame, DeathKind } from './death-sequence';
import { Disposal } from './disposal';
import { FigureRig } from './figure-rig';
import { GripArms } from './grip-arms';
import type { HammerHead } from './hammer-head';
import type { LibraryAvatarSettings, PartRole } from './model-library';
import { OBSTACLE_LINE } from './obstacle-line';
import { DEFAULT_ARM_CHAINS } from './player-figure-data';
import { copyDeathPose, createDeathPose } from './player-pose';
import type { DeathPose, MutableLivePlayerFrame } from './player-pose';
import type { Kinds } from './plugins/kinds';
import type { RuntimePlugins } from './plugins/runtime';
import type { PartPose, PhysicsFrame } from './simulation';
import { DEFAULT_CHARACTER_RIGGING_TYPE } from './sprite-data';
import type { CharacterRiggingType } from './sprite-data';
import type { SpriteRig } from './sprite-rig';
import type { GameTheme } from './theme';
import type { LeanPreview } from './waist-lean';

// A preview that moves the character's whole presentation for a while: its body, pot and tool together, by `offset` in
// the view's plane and turned about the player's root, over `duration` seconds of simulation time. Presentation only:
// the camera, physics and overlays keep the simulation's frame. It ends early on a placement, a restart or another preview.
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

// A library model shown for one part in place of every character's own model for that part.
// An avatar brings the settings its proportions need. The caller owns `model`.
export interface PartModel {
  readonly id: string;
  readonly model: LoadedCharacterModel;
  readonly avatar?: LibraryAvatarSettings;
  // A library hammer's own head outline, which the game's physics takes along with the model.
  readonly head?: HammerHead;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class CharacterView {
  readonly actors = new Group();
  readonly foreground = new Group();
  readonly sprites: SpriteRig;
  readonly appearance: DeathAppearance = createDeathAppearance();
  private readonly figure: FigureRig;
  private readonly arms: GripArms;
  private readonly profiles: CharacterProfiles;
  private readonly meshParts: MeshPartsPresenter;
  private readonly builtInAvatar: BuiltInAvatarPresenter;
  private presenter: CharacterPresenter;
  private currentStance = characterStance(DEFAULT_PRESENTATION, 'figure');
  // The prepared rig (if any) the active character shows, with its per-avatar pose history.
  private activeAvatar: PreparedAvatar | null = null;
  private armIk: Readonly<ArmIkSettings> = DEFAULT_ARM_IK;
  private characterFigure: CharacterFigure = DEFAULT_CHARACTER_FIGURE;
  private figureSource: CharacterFigureSource | null = null;
  private readonly onCharacterFigure: (figure: CharacterFigure) => void;
  private readonly deathWriter: DeathPoseWriter;
  private readonly captured: DeathPose = createDeathPose();
  private readonly capturedFacing = { x: 0, y: 0, z: 0, w: 1 };
  private livePlacement = -1;
  private death: DeathKind | null = null;
  private readonly deathInput: Mutable<DeathPoseInput> = {
    elapsed: 0, duration: 0, poseProgress: 0, reducedMotion: false, character: DEFAULT_CHARACTER_RIGGING_TYPE,
    captured: this.captured, physical: createDeathPose(), headFacing: this.capturedFacing,
  };
  private readonly liveFrame: Mutable<LivePresented>;
  private readonly deathFrame: Mutable<DeathPresented>;
  private readonly presentedCursor = { x: 0, y: 0 };
  private lastPresented: PresentedFrame | null = null;
  // The running presentation preview, from the simulation time of its first frame, and the frame it draws: the
  // simulation's with the player's parts and cursor moved. Reused, so a preview allocates nothing per frame.
  private presentationPreview: { readonly preview: PresentationPreview; start: number | null } | null = null;
  private readonly previewOffset = { x: 0, y: 0, turn: 0 };
  private previewParts: PartPose[] = [];
  private readonly previewCursor = { x: 0, y: 0 };
  private previewFrame: PhysicsFrame | null = null;
  private readonly previewPlayer: MutableLivePlayerFrame = {
    phase: 'alive', centre: { x: 0, y: 0, angle: 0 }, shoulder: { x: 0, y: 0 },
  };
  private avatarFacts: { readonly avatar: PreparedAvatar; readonly motions: PreparedAvatarMotions; readonly facts: ImportedAvatarFacts } | null = null;
  private charactersDisposed = false;
  private disposed = false;

  constructor(initial: PhysicsFrame, options: {
    characterModels?: CharacterModelLoader | null;
    content?: ContentLoader;
    theme: GameTheme;
    kinds: Kinds;
    plugins: RuntimePlugins;
    onCharacterFigure: (figure: CharacterFigure) => void;
    prepareTexture: (texture: Texture) => void;
  }) {
    // Resolve the writer before allocating scene resources or constructing the renderer.
    this.deathWriter = createDeathPoseWriter(options.plugins);
    this.onCharacterFigure = options.onCharacterFigure;
    this.figure = new FigureRig(initial.rig, options.theme);
    this.actors.add(this.figure.actors);
    this.foreground.add(this.figure.foreground);
    this.arms = new GripArms(this.figure);
    const stance = (): CharacterStance => this.currentStance;
    this.meshParts = new MeshPartsPresenter(this.figure);
    this.builtInAvatar = new BuiltInAvatarPresenter(this.figure, this.actors, stance);
    this.presenter = this.meshParts;
    this.profiles = new CharacterProfiles(initial.rig, {
      figure: this.figure, actors: this.actors, foreground: this.foreground, stance,
      changed: () => this.applyPresentation(), naturalArmsChanged: () => this.applyPresentation(),
      prepareTexture: options.prepareTexture,
    }, { characterModels: options.characterModels, content: options.content, avatarRigs: options.kinds.avatarRigs });
    this.liveFrame = {
      phase: 'alive', time: initial.time, dt: 0, body: this.figure.torso.matrixWorld, pot: this.figure.potFrame,
      tool: this.figure.toolFrame, shaft: this.figure.shaft, headRotation: this.figure.headRotation,
      arms: this.figure.posedArms, cursor: this.presentedCursor, aim: this.figure.aim, turn: 0, grips: this.arms.distances,
    };
    this.deathFrame = {
      phase: 'dying', time: initial.time, dt: 0, body: this.figure.torso.matrixWorld, pot: this.figure.potFrame,
      tool: this.figure.toolFrame, shaft: this.figure.shaft, headRotation: this.figure.headRotation,
      arms: this.figure.posedArms, cursor: this.presentedCursor, aim: this.figure.aim, turn: 0,
      headDelta: this.figure.headDelta, appearance: this.appearance,
    };
    try {
      this.sprites = this.profiles.createSlot().rig;
      this.applyPresentation();
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      disposal.run(() => this.dispose());
      disposal.finish();
      throw error;
    }
  }

  get visuals(): ReadonlyMap<VisualPartId, VisualBinding> { return this.figure.visuals; }
  get stance(): CharacterStance { return this.currentStance; }
  get deathKind(): DeathKind | null { return this.death; }

  setTheme(theme: GameTheme): void { this.figure.setTheme(theme); }

  setArmIk(armIk: Readonly<ArmIkSettings>): void {
    const previous = this.armIk;
    if (previous.leftHintX === armIk.leftHintX && previous.leftHintY === armIk.leftHintY && previous.leftHintZ === armIk.leftHintZ &&
      previous.rightHintX === armIk.rightHintX && previous.rightHintY === armIk.rightHintY && previous.rightHintZ === armIk.rightHintZ) return;
    this.armIk = Object.freeze({ ...armIk });
    this.updateFigure();
  }

  syncRig(frame: PhysicsFrame): void {
    this.figure.syncRig(frame.rig);
    this.profiles.syncRig(frame.rig);
  }

  syncHead(outline: HammerHead): void { this.figure.syncHead(outline); this.arms.syncHead(outline); }

  // Adds the release's second character profile; only the active profile renders and updates.
  createAlternateCharacter(): SpriteRig { return this.profiles.createSlot().rig; }

  // Swaps presentation at once and stores its figure for the next death; the live rig and level state stay untouched.
  selectCharacter(index: number): void {
    if (!this.profiles.select(index)) return;
    this.applyPresentation();
    this.resetPoseHistory();
  }

  characterSelection(): { active: number; count: number; types: CharacterRiggingType[] } {
    return { active: this.profiles.activeIndex, count: this.profiles.slots.length,
      types: this.profiles.slots.map(slot => slot.presentation.characterRiggingType) };
  }

  // Each arm's lengths as the active character type draws them without its own arm lengths.
  naturalArmLengths(): CharacterArms {
    const slot = this.profiles.active;
    const type = (slot?.presentation ?? DEFAULT_PRESENTATION).characterRiggingType;
    const chains = type === 'avatar-3d' ? (this.profiles.parts.avatar?.view ?? slot?.avatar?.view)?.chains ?? DEFAULT_ARM_CHAINS : DEFAULT_ARM_CHAINS;
    const sprite = type === 'sprite-2d' ? slot?.rig.naturalArmLengths() ?? null : null;
    const side = (arm: ArmSide): ArmLengths => sprite?.[arm] ?? { upper: chains[arm].upper, forearm: chains[arm].forearm };
    return { left: side('left'), right: side('right') };
  }

  // Validation report of a model loaded for the primary profile, for authoring tools.
  characterModelReport(source: string, usage: CharacterModelUsage) { return this.profiles.characterModelReport(source, usage); }
  // Before characters load: parts that will show a library model, so no character loads its own
  // until the part returns to the characters' models.
  reserveParts(roles: Iterable<PartRole>): void { this.profiles.reserveParts(roles); }
  // Shows a library model for one part in place of every character's own, or returns the part to
  // the characters' own models, loading any not loaded yet. Resolves once the part is visible; a
  // failure leaves the part as it was.
  setPartModel(role: PartRole, part: PartModel | null, signal: AbortSignal): Promise<void> {
    return this.profiles.setPartModel(role, part, signal);
  }
  // The library model each part shows, or null where characters show their own.
  partModels(): Record<PartRole, string | null> { return this.profiles.partModels(); }

  // Rocks (sway) or kicks (jolt) the upper body about the waist for a moment, so an avatar's secondary motion can be
  // judged without playing. Presentation only, like the waist lean it adds to.
  previewMotion(kind: LeanPreview): void {
    this.presentationPreview = null;
    this.figure.waistLean.preview(kind);
  }

  // Runs `preview`, ending any other.
  previewPresentation(preview: PresentationPreview): void {
    this.figure.waistLean.endPreview();
    this.presentationPreview = { preview, start: null };
  }

  // Ends `preview` if it still runs.
  endPresentationPreview(preview: PresentationPreview): void {
    if (this.presentationPreview?.preview === preview) this.presentationPreview = null;
  }

  // The imported avatar the character shows, the same object until it changes; null for any other avatar.
  importedAvatar(): ImportedAvatarFacts | null {
    const avatar = this.activeAvatar;
    if (avatar === null) return null;
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

  pose(physics: PhysicsFrame, options: { dt: number; death: DeathFrame | null }): PhysicsFrame {
    const frame = this.presentedFrame(physics), figure = this.figure, stance = this.currentStance;
    const player = frame.player, dt = Math.max(0, options.dt);
    figure.placeParts(frame, player.phase === 'dying' ? OBSTACLE_LINE : stance.toolDepth, this.profiles.propModels.pot);
    this.presentedCursor.x = frame.cursor.x; this.presentedCursor.y = frame.cursor.y;
    if (player.phase === 'alive') {
      const turn = frame === physics ? 0 : this.previewOffset.turn;
      figure.poseLiveTorso(player, frame.cursor, frame.time, stance, turn);
      this.arms.solve(stance, this.armIk, this.presenter, dt);
      const presented = this.liveFrame;
      presented.time = frame.time; presented.dt = dt; presented.turn = turn;
      this.livePlacement = frame.placement;
      this.lastPresented = presented;
      this.presenter.present(presented);
    } else {
      const death = options.death;
      if (death === null) throw new Error('A physical death frame needs the active death sequence.');
      const input = this.deathInput;
      input.elapsed = death.elapsed; input.duration = death.duration;
      input.poseProgress = death.poseProgress; input.reducedMotion = death.reducedMotion;
      input.character = this.profiles.active!.presentation.characterRiggingType;
      input.physical = player.pose;
      this.deathWriter(input, this.appearance);
      figure.poseDeath(this.appearance, stance);
      this.arms.placePhysical(this.appearance);
      const presented = this.deathFrame;
      presented.time = frame.time; presented.dt = dt;
      this.lastPresented = presented;
      this.presenter.present(presented);
    }
    // The one-model hammer follows the physical tool frame; its handle is fitted to the rig, not per frame.
    this.profiles.propModels.hammer?.update(figure.toolFrame);
    return frame;
  }

  beginDeath(frame: PhysicsFrame, kind: DeathKind): void {
    if (frame.player.phase === 'alive') throw new Error('Death presentation needs the simulation death phase.');
    this.death = kind;
    this.presentationPreview = null;
    const captured = this.captured, facing = this.capturedFacing;
    if (this.livePlacement === frame.placement) this.figure.writeShownPose(captured, facing, this.currentStance);
    else {
      copyDeathPose(captured, frame.player.pose);
      facing.x = facing.y = facing.z = 0; facing.w = 1;
    }
    this.deathFrame.turn = this.liveFrame.turn;
    this.presenter.setDying(true);
  }

  cancelDeath(): void {
    this.death = null;
    this.deathInput.poseProgress = 0;
    this.appearance.spriteBrightness = 1;
    this.presenter.setDying(false);
    this.profiles.cancelDeath();
  }

  // Settles the character's presentation, for a player placed anew: at a restart, or back at a bonfire while time goes on.
  resetPresentation(): void {
    this.presentationPreview = null;
    this.figure.resetFilters();
    this.arms.reset();
    this.profiles.resetSlotRigs(this.presenter);
    this.presenter.reset('placement');
    this.figure.resetPoseHistory();
  }

  armPoses(): readonly ArmPose[] { return this.figure.posedArms; }

  statistics() {
    const stance = this.currentStance, props = this.profiles.propModels, parts = this.profiles.parts, slot = this.profiles.active;
    const imported = this.activeAvatar ?? slot?.avatar;
    return {
      sprites: this.sprites.inspect(),
      headAim: { rotation: this.figure.headAim.rotation.toArray() },
      avatar: this.builtInAvatar.inspect(),
      importedAvatar: imported?.presenter.inspect() ?? null,
      hammerModel: props.hammer === null ? null : {
        ...props.hammer.inspect(), fit: (parts.hammer?.fit ?? slot?.props.hammer?.fit)?.inspect() ?? null,
      },
      parts: this.partModels(),
      potModel: props.pot === null ? null : props.pot.inspect(),
      characters: this.characterSelection(),
      armChains: { left: { ...stance.chains.left }, right: { ...stance.chains.right } },
      grips: {
        placement: stance.grips.placement, slideAt: stance.grips.slideAt, slideRange: { ...stance.grips.slideRange },
        left: this.arms.distances.left, right: this.arms.distances.right,
      },
    };
  }

  // Cancels and releases every profile, for example when the game stops.
  disposeCharacters(): void {
    if (this.charactersDisposed) return;
    this.charactersDisposed = true;
    const disposal = new Disposal();
    disposal.run(() => this.cancelDeath());
    disposal.run(() => this.presenter.show(false));
    disposal.run(() => this.builtInAvatar.show(false));
    this.presenter = this.meshParts;
    this.activeAvatar = this.avatarFacts = null;
    disposal.run(() => this.profiles.dispose());
    disposal.run(() => this.applyPresentation());
    disposal.finish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    disposal.run(() => this.disposeCharacters());
    disposal.run(() => this.builtInAvatar.dispose());
    disposal.run(() => this.meshParts.dispose());
    disposal.run(() => this.figure.dispose());
    disposal.run(() => this.actors.removeFromParent());
    disposal.run(() => this.foreground.removeFromParent());
    disposal.run(() => this.actors.clear());
    disposal.run(() => this.foreground.clear());
    disposal.finish();
  }

  private applyPresentation(): void {
    const slot = this.profiles.active, character = slot?.presentation ?? DEFAULT_PRESENTATION;
    // A library avatar replaces an Avatar character's own, with the settings its proportions need.
    const partAvatar = character.characterRiggingType === 'avatar-3d' ? this.profiles.parts.avatar : null;
    const presentation = partAvatar === null ? character : { ...character, ...partAvatar.settings };
    // The prepared rig the frame plan and pose phases use, or null for the built-in zero-offset avatar.
    const avatar = character.characterRiggingType === 'avatar-3d' ? partAvatar ?? slot?.avatar ?? null : null;
    const next = character.characterRiggingType === 'sprite-2d' ? slot!.presenter
      : character.characterRiggingType === 'model-3d' ? this.meshParts : avatar?.presenter ?? this.builtInAvatar;
    const stance = next.stanceFor(presentation);
    // A new lean applies at once, also while time stands still, rather than easing in from the previous one.
    if (stance.waistLean !== this.currentStance.waistLean) this.figure.waistLean.reset();
    this.currentStance = stance;
    this.activeAvatar = avatar;
    this.figure.setStance(stance);
    this.arms.setStance(stance);
    if (next !== this.presenter) {
      this.presenter.setDying(false);
      this.presenter.show(false);
      this.presenter = next;
      // A newly activated avatar solves arms from its own bind, never the pose the previous avatar left.
      this.resetPoseHistory();
    }
    next.show(true);
    this.profiles.mountProps();
    for (const [id, binding] of this.figure.visuals) {
      const replaced = this.profiles.propModels.hammer !== null && HAMMER_PARTS.has(id) || this.profiles.propModels.pot !== null && id === 'pot';
      binding.visibility.setEnabled({ enabled: (stance.bodyVisuals === 'figure' || PROP_PARTS.has(id)) && !replaced });
    }
    this.updateFigure();
    if (this.death !== null) {
      // Seed inactive slots with the view's frozen death aim before they hold.
      if (next.kind === 'sprite') next.present(this.lastPresented ?? this.liveFrame);
      next.setDying(true);
    }
  }

  // Clears the arm-solver history so a newly activated avatar bends from its own bind rather than
  // continuing the pose of the avatar that was showing before it.
  private resetPoseHistory(): void {
    this.figure.resetPoseHistory();
    this.presenter.reset('history');
  }

  private updateFigure(): void {
    const stance = this.currentStance, previous = this.figureSource;
    // A commit can change both presentation and natural sprite lengths; its final notification shares this resolution.
    if (previous !== null && previous.waistLean === stance.waistLean && previous.chains === stance.chains &&
      previous.reach === stance.reach && previous.armIk === this.armIk && previous.neck.x === stance.headPivot.x && previous.neck.y === stance.headPivot.y &&
      previous.grips.left === stance.grips.left && previous.grips.right === stance.grips.right) return;
    const source: CharacterFigureSource = {
      waistLean: stance.waistLean, grips: stance.grips, chains: stance.chains, reach: stance.reach,
      neck: { x: stance.headPivot.x, y: stance.headPivot.y }, armIk: this.armIk,
    };
    const figure = resolveCharacterFigure(source);
    this.figureSource = source;
    if (sameCharacterFigure(this.characterFigure, figure)) return;
    this.characterFigure = figure;
    this.onCharacterFigure(figure);
  }

  // `frame`, or while a presentation preview runs, a frame whose player parts and cursor it moved: turned by the offset's
  // turn about the root, then moved by its offset. The preview ends past its duration or on bad values.
  private presentedFrame(frame: PhysicsFrame): PhysicsFrame {
    const running = this.presentationPreview;
    if (running === null || frame.player.phase !== 'alive') return frame;
    if (running.start === null) running.start = frame.time;
    const elapsed = Math.max(0, frame.time - running.start);
    const offset = this.previewOffset;
    offset.x = 0;
    offset.y = 0;
    offset.turn = 0;
    if (elapsed <= running.preview.duration) running.preview.offset(elapsed, offset);
    // The preview may have ended or been replaced while it ran.
    if (this.presentationPreview !== running || elapsed > running.preview.duration ||
      !Number.isFinite(offset.x) || !Number.isFinite(offset.y) || !Number.isFinite(offset.turn)) {
      if (this.presentationPreview === running) this.presentationPreview = null;
      return frame;
    }
    const root = frame.player.centre;
    const cos = Math.cos(offset.turn), sin = Math.sin(offset.turn);
    const pivotX = root.x, pivotY = root.y;
    if (this.previewParts.length !== frame.parts.length) this.previewParts = frame.parts.map((part) => ({ ...part }));
    for (let index = 0; index < frame.parts.length; index += 1) {
      const part = frame.parts[index]!, moved = this.previewParts[index]!;
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
}
