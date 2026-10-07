import { Group } from 'three';
import type { Object3D, Texture } from 'three';
import { HEAD_GEOMETRY, SPRITE_TARGET_IDS } from './character';
import type { VisualPartId } from './character';
import type { AvatarRigRegistry, PreparedAvatarMotions, PreparedAvatarRig } from './avatar-rig';
import { sameAvatarDriver } from './avatar-driver';
import type { AvatarDriver } from './avatar-driver';
import type { AvatarMotionEntry } from './avatar-motion-data';
import type { CharacterModelUsage, ResolvedAvatarJoints } from './character-model-inspect';
import { CharacterModelPool } from './character-model-pool';
import type { CharacterModelLease } from './character-model-pool';
import type { CharacterModelLoader, LoadedCharacterModel } from './character-model-types';
import { attachCharacterRoot } from './character-presenter';
import type { CharacterPresenter, CharacterStance } from './character-presenter';
import { characterModel, PROP_MODEL_ROLES, sameAvatarModelSettings, sameAvatarMotions, sameBoneMap } from './character-profile';
import type { AvatarBoneMap, AvatarHair, AvatarModelSettings, CharacterAssets, PropModelRole } from './character-profile';
import { DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth';
import type { PartModel } from './character-view';
import type { ContentLoader } from './content-ref';
import { Disposal } from './disposal';
import type { FigureRig } from './figure-rig';
import { DEFAULT_GRIPS } from './grips';
import { HammerHandleFit } from './hammer-handle-fit';
import { ImportedAvatarPresenter } from './imported-avatar-presenter';
import type { LibraryAvatarSettings, PartRole } from './model-library';
import { PropModelView } from './prop-model-view';
import type { RigGeometry } from './rig';
import { SkinnedAvatarView } from './skinned-avatar-view';
import { SpriteRig } from './sprite-rig';
import type { CharacterAssetLease, SpriteAnchor } from './sprite-rig';
import { DEFAULT_CHARACTER_RIGGING_TYPE, SpriteError } from './sprite-data';
import type { CharacterPresentation, SpriteDocument } from './sprite-data';
import { SPRITE_ARM_SLOTS, SpritePresenter } from './sprite-presenter';
import { DEFAULT_WAIST_LEAN } from './waist-lean';

export const MAX_CHARACTER_PROFILES = 2;
export const HAMMER_PARTS: ReadonlySet<VisualPartId> = new Set(['hammer-shaft', 'hammer-head']);
export const PROP_PARTS: ReadonlySet<VisualPartId> = new Set(['pot', 'hammer-shaft', 'hammer-head']);
export const DEFAULT_PRESENTATION: CharacterPresentation = Object.freeze({
  characterRiggingType: DEFAULT_CHARACTER_RIGGING_TYPE, armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
  waistLean: DEFAULT_WAIST_LEAN, grips: DEFAULT_GRIPS, arms: null,
});
const PROP_VIEW_NAMES: Readonly<Record<PropModelRole, string>> = { hammer: 'one-model-hammer', pot: 'profile-pot-model' };

// A slot-owned prop view plus the pool reference that keeps its model alive. Library parts are
// borrowed from their caller and therefore have no lease.
interface OwnedProp {
  readonly model: LoadedCharacterModel;
  readonly lease: CharacterModelLease;
  readonly view: PropModelView;
  readonly fit: HammerHandleFit | null;
}

// A fitted imported avatar and the state its frames need. Each profile and library avatar owns one,
// so pose history and strategy state never leak from the avatar that was showing before it. Its hair
// and motions change in place, keeping the view.
export interface PreparedAvatar {
  readonly model: LoadedCharacterModel;
  readonly boneMap: AvatarBoneMap;
  readonly driver: AvatarDriver;
  hair: AvatarHair;
  motion: readonly AvatarMotionEntry[];
  // The motions its view runs, and the fit they are prepared against.
  motions: PreparedAvatarMotions;
  readonly resolved: ResolvedAvatarJoints;
  readonly binds: PreparedAvatarRig['binds'];
  readonly view: SkinnedAvatarView;
  readonly presenter: ImportedAvatarPresenter;
}

// A slot-owned avatar view: the prepared avatar plus the pool reference that keeps its model alive.
type OwnedPreparedAvatar = PreparedAvatar & { readonly lease: CharacterModelLease };

// One loaded character profile. Its sprite rig, models and views are built once and kept while
// another profile is shown, so switching profiles only changes what is attached and visible.
export interface CharacterSlot {
  readonly index: number;
  readonly rig: SpriteRig;
  readonly presenter: SpritePresenter;
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

interface PartViews {
  avatar: (PreparedAvatar & { readonly id: string; readonly settings: LibraryAvatarSettings }) | null;
  hammer: { readonly id: string; readonly model: LoadedCharacterModel; readonly view: PropModelView; readonly fit: HammerHandleFit } | null;
  pot: { readonly id: string; readonly model: LoadedCharacterModel; readonly view: PropModelView } | null;
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

// One operation's single-flight acquisition of a model and the lease it holds until commit/failure.
interface ModelHolding {
  readonly lease: CharacterModelLease;
  readonly model: LoadedCharacterModel;
}

interface ProfileHost {
  readonly figure: FigureRig;
  readonly actors: Object3D;
  readonly foreground: Object3D;
  readonly stance: () => CharacterStance;
  readonly changed: () => void;
  readonly naturalArmsChanged: () => void;
  readonly prepareTexture: (texture: Texture) => void;
}

// The asset owner: profiles, their caches and views, library overrides, and prepare-then-commit transactions.
export class CharacterProfiles {
  readonly slots: CharacterSlot[] = [];
  // Library models chosen for each part, shown for every character.
  readonly parts: PartViews = { avatar: null, hammer: null, pot: null };
  readonly propModels: Record<PropModelRole, PropModelView | null> = { hammer: null, pot: null };
  // Parts whose library model is on its way while characters load, so their own is never loaded.
  private readonly reserved = new Set<PartRole>();
  private readonly host: ProfileHost;
  private readonly characterModels: CharacterModelLoader | null;
  private readonly content: ContentLoader | undefined;
  private readonly avatarRigs: AvatarRigRegistry;
  private rig: RigGeometry;
  private selected = 0;
  private disposed = false;

  constructor(rig: RigGeometry, host: ProfileHost, options: {
    characterModels?: CharacterModelLoader | null;
    content?: ContentLoader;
    avatarRigs: AvatarRigRegistry;
  }) {
    this.rig = rig; this.host = host;
    this.characterModels = options.characterModels ?? null;
    this.content = options.content;
    this.avatarRigs = options.avatarRigs;
  }

  get active(): CharacterSlot | undefined { return this.slots[this.selected]; }
  get activeIndex(): number { return this.selected; }

  createSlot(): CharacterSlot {
    if (this.slots.length >= MAX_CHARACTER_PROFILES) {
      throw new Error(`A game view shows at most ${MAX_CHARACTER_PROFILES} character profiles.`);
    }
    const index = this.slots.length;
    const root = new Group();
    root.name = `character-${index}:sprites`;
    const foreground = new Group();
    foreground.name = `character-${index}:foreground-sprites`;
    const mounts: { node: Group; parent: Object3D }[] = [{ node: root, parent: this.host.actors }, { node: foreground, parent: this.host.foreground }];
    const coverage = new Map<string, boolean>();
    const anchors = new Map<string, SpriteAnchor>();
    let slot: CharacterSlot;
    for (const [id, binding] of this.host.figure.visuals) {
      // Each profile draws under its own mount, so an inactive profile is hidden, not rebuilt.
      const node = new Group();
      node.name = `character-${index}:${id}`;
      mounts.push({ node, parent: binding.anchor });
      anchors.set(id, {
        node,
        renderRoot: HAMMER_PARTS.has(id) ? foreground : root,
        setCovered: (state) => {
          coverage.set(id, state.covered);
          if (this.active === slot) binding.visibility.setCovered(state);
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
      prepareTexture: this.host.prepareTexture,
      characterAssets: { prepare: (document, signal) => this.prepareModels(slot, document, signal) },
      loadContent: this.content,
      armSlots: SPRITE_ARM_SLOTS,
      onNaturalArmsChange: () => { if (!this.disposed && this.active === slot) this.host.naturalArmsChanged(); },
    });
    slot = {
      index, rig, presenter: new SpritePresenter(rig, this.host.figure), mounts, coverage, presentation: DEFAULT_PRESENTATION,
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
    // Mounts follow profile selection, not renderer selection, so commits see the active profile's world anchors.
    for (const mount of mounts) attachCharacterRoot(mount.node, mount.parent, index === this.selected);
    this.slots.push(slot);
    return slot;
  }

  select(index: number): boolean {
    const slot = this.slots[index];
    if (!Number.isInteger(index) || slot === undefined) throw new Error(`Unknown character profile ${index}.`);
    if (index === this.selected) return false;
    this.selected = index;
    for (const other of this.slots) {
      for (const mount of other.mounts) attachCharacterRoot(mount.node, mount.parent, other === slot);
    }
    for (const [id, binding] of this.host.figure.visuals) binding.visibility.setCovered({ covered: slot.coverage.get(id) ?? false });
    slot.rig.resetPresentation();
    return true;
  }

  resetSlotRigs(active: CharacterPresenter): void {
    // Hidden avatars can still carry a pre-placement motion clock when they are selected again.
    for (const slot of this.slots) {
      if (slot.presenter !== active) slot.rig.resetPresentation();
      if (slot.avatar !== null && slot.avatar.presenter !== active) slot.avatar.presenter.reset('placement');
    }
    if (this.parts.avatar !== null && this.parts.avatar.presenter !== active) this.parts.avatar.presenter.reset('placement');
  }

  cancelDeath(): void {
    for (const slot of this.slots) slot.presenter.setDying(false);
  }

  mountProps(): void {
    const slot = this.active;
    for (const other of this.slots) {
      // Prop models show in every character type. The hammer draws in the tool's foreground pass;
      // the pot draws in the actors pass, so its walls hide a body inside it through the depth buffer.
      for (const role of PROP_MODEL_ROLES) {
        const prop = other.props[role];
        if (prop !== null) attachCharacterRoot(prop.view.root, role === 'hammer' ? this.host.foreground : this.host.actors,
          other === slot && this.parts[role] === null);
      }
    }
    // Library models show for every character, the hammer and pot in every character type.
    for (const role of PROP_MODEL_ROLES) {
      const part = this.parts[role];
      if (part !== null) attachCharacterRoot(part.view.root, role === 'hammer' ? this.host.foreground : this.host.actors, true);
      this.propModels[role] = part?.view ?? slot?.props[role]?.view ?? null;
    }
  }

  syncRig(rig: RigGeometry): void {
    if (rig === this.rig) return;
    this.rig = rig;
    for (const slot of this.slots) slot.props.hammer?.fit?.setHandleLength(rig.handleLength);
    this.parts.hammer?.fit.setHandleLength(rig.handleLength);
  }

  characterModelReport(source: string, usage: CharacterModelUsage) {
    return this.slots[0]?.pool.value(usage, source)?.report ?? null;
  }

  reserveParts(roles: Iterable<PartRole>): void {
    for (const role of roles) this.reserved.add(role);
  }

  async setPartModel(role: PartRole, part: PartModel | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
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
          view, presenter: new ImportedAvatarPresenter(view, prepared.binds, prepared.rig, this.host.actors, this.host.stance),
        };
      } else {
        const fit = role === 'hammer' ? new HammerHandleFit(part.model, this.rig.handleLength) : null;
        const view = new PropModelView(part.model, PROP_VIEW_NAMES[role]);
        this.disposePart(role);
        if (role === 'hammer') this.parts.hammer = { id: part.id, model: part.model, view, fit: fit! };
        else this.parts.pot = { id: part.id, model: part.model, view };
      }
    }
    this.host.changed();
  }

  partModels(): Record<PartRole, string | null> {
    return { avatar: this.parts.avatar?.id ?? null, hammer: this.parts.hammer?.id ?? null, pot: this.parts.pot?.id ?? null };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    for (const slot of this.slots) {
      // Disposing the rig commits the default presentation, which releases every committed view
      // lease; the pool then aborts anything still in flight and disposes anything left.
      disposal.run(() => slot.presenter.dispose());
      for (const mount of slot.mounts) disposal.run(() => mount.node.removeFromParent());
      // A failed rig cleanup cannot strand another owner or skip releasing its lease.
      disposal.run(() => this.releaseAvatar(slot));
      for (const role of PROP_MODEL_ROLES) disposal.run(() => this.releaseProp(slot, role));
      disposal.run(() => slot.pool.dispose());
    }
    for (const role of ['avatar', 'hammer', 'pot'] as const) disposal.run(() => this.disposePart(role));
    this.propModels.hammer = this.propModels.pot = null;
    disposal.finish();
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

  private disposePart(role: PartRole): void {
    const part = this.parts[role];
    if (part === null) return;
    const fit = role === 'hammer' ? this.parts.hammer!.fit : null;
    this.parts[role] = null;
    const disposal = new Disposal();
    disposal.run(() => part.view.root.removeFromParent());
    disposal.run(() => role === 'avatar' ? (part as NonNullable<PartViews['avatar']>).presenter.dispose() : part.view.dispose());
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
      if (!this.disposed && this.active === slot) this.host.changed();
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
    if (replaceAvatar) this.releaseAvatar(slot);
    if (preparedAvatar !== null && avatarLease !== null) {
      const { prepared } = preparedAvatar;
      const view = new SkinnedAvatarView(preparedAvatar.model, prepared.resolved, preparedAvatar.boneMap, prepared.binds, prepared.motions);
      slot.avatar = {
        model: preparedAvatar.model, boneMap: preparedAvatar.boneMap, driver: preparedAvatar.driver, hair: preparedAvatar.hair,
        motion: preparedAvatar.motion, motions: prepared.motions, resolved: prepared.resolved, binds: prepared.binds,
        view, presenter: new ImportedAvatarPresenter(view, prepared.binds, prepared.rig, this.host.actors, this.host.stance), lease: avatarLease,
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
    slot.props[role] = null;
    const disposal = new Disposal();
    disposal.run(() => current.view.dispose());
    disposal.run(() => current.fit?.dispose());
    disposal.run(() => current.lease.release());
    disposal.finish();
  }

  private releaseAvatar(slot: CharacterSlot): void {
    const current = slot.avatar;
    if (current === null) return;
    slot.avatar = null;
    const disposal = new Disposal();
    disposal.run(() => current.presenter.dispose());
    disposal.run(() => current.lease.release());
    disposal.finish();
  }
}
