// The engine's enemy-model look: it draws each enemy species whose art is a skinned GLB of the course artwork, playing the
// clip the simulation plays at the time it plays it. A release includes this module, and with it three.js's GLTF loader
// and skeleton utilities, only when it draws enemy models.
import { AnimationMixer, Box3, Color, Group, Matrix3, Matrix4, Mesh, SkinnedMesh, Vector3 } from 'three';
import type { AnimationAction, AnimationClip, Material, Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { enemyArtAssets } from './enemy-art-data';
import type { EnemyArtSettings, ModelArt } from './enemy-art-data';
import { loopingRole, modelHeight } from './enemy-motion-data';
import type { EnemyClipRole } from './enemy-motion-data';
import { ENEMY_SPECIES, ENEMY_SPECS } from './enemy-types';
import type { EnemyPose, EnemySpecies } from './enemy-types';
import { ENEMY_TINT, hurtTint, warningTint } from './enemy-tint';
import { ModelError } from './model-data';
import { OBSTACLE_LINE } from './obstacle-line';
import type { EnemyModelLook } from './object-looks';
import { loadVisualModel } from './visual-model';
import type { LoadedVisual } from './visual-model';

// A change of clip cross-fades over this many seconds.
const CROSSFADE = 0.15;
const WARNING = new Color(ENEMY_TINT.warningColor);
const WHITE = new Color(1, 1, 1);
const ALL_SPECIES: ReadonlySet<EnemySpecies> = new Set(ENEMY_SPECIES);

export interface EnemyModelOptions {
  readonly art: EnemyArtSettings;
  // A GLB of the course artwork, by its asset ID.
  readonly fetch: (assetId: string, signal: AbortSignal) => Promise<Blob>;
  // The species a model that cannot be drawn was for, which show their built-in pixel art instead, and why.
  readonly onFailure: (species: readonly EnemySpecies[], error: unknown) => void;
}

/**
 * How a game draws enemy models: the renderer, which a release includes only when it draws them, and where their GLBs
 * come from, the course artwork's source.
 */
export interface EnemyModelSource {
  readonly create: (options: EnemyModelOptions) => EnemyModelLook;
  readonly fetch: (assetId: string, signal: AbortSignal) => Promise<Blob>;
}

export function createEnemyModels(options: EnemyModelOptions): EnemyModelLook {
  return new EnemyModels(options);
}

// A loaded GLB: its scene, which each awake enemy clones, its clips by name, playing in place, and the bounds of its
// bind pose in its own units, which fit it to a species.
interface Template {
  readonly model: LoadedVisual;
  readonly clips: ReadonlyMap<string, AnimationClip>;
  readonly bounds: Box3;
}

interface Asset {
  template: Template | null;
  loading: Promise<void> | null;
  // Why it could not load; it is not tried again while the art uses it.
  failure: { readonly reason: unknown } | null;
}

// A material an awake enemy owns, tinted by moving its emissive colour, or else its colour, from where the GLB left it.
interface Tinted {
  readonly material: Material;
  readonly target: Color | null;
  readonly base: Color;
}

interface Awake {
  readonly id: string;
  readonly species: EnemySpecies;
  entry: ModelArt;
  // At the enemy, turned to its facing; it holds the model fitted to the species.
  readonly holder: Group;
  readonly clone: Object3D;
  readonly mixer: AnimationMixer;
  readonly actions: Map<EnemyClipRole, AnimationAction>;
  readonly materials: readonly Tinted[];
  role: EnemyClipRole | null;
  tinted: boolean;
  seen: number;
}

class EnemyModels implements EnemyModelLook {
  readonly root = new Group();
  private art: EnemyArtSettings;
  private readonly fetch: EnemyModelOptions['fetch'];
  private readonly failure: EnemyModelOptions['onFailure'];
  private readonly assets = new Map<string, Asset>();
  private readonly awake = new Map<string, Awake>();
  // The species drawn now, and the model entries whose clips the GLB lacks, reported once.
  private readonly drawn = new Set<EnemySpecies>();
  private readonly unplayable = new WeakSet<ModelArt>();
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle = new AbortController();
  private frame = 0;
  private time: number | null = null;
  private delta = 0;
  private wakes = 0;
  private disposed = false;

  constructor(options: EnemyModelOptions) {
    this.root.name = 'enemy-models';
    this.art = options.art;
    this.fetch = options.fetch;
    this.failure = options.onFailure;
    this.fetchUsed();
    this.refresh();
  }

  draws(species: EnemySpecies): boolean {
    return this.drawn.has(species);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setArt(art: EnemyArtSettings): void {
    if (this.disposed || art === this.art) return;
    this.art = art;
    // An enemy whose model or clips changed wakes again with them.
    this.awake.forEach(this.sleepChanged);
    const used = enemyArtAssets(art, ALL_SPECIES);
    for (const [id, asset] of this.assets) {
      if (used.has(id)) continue;
      asset.template?.model.dispose();
      this.assets.delete(id);
    }
    this.fetchUsed();
    this.refresh();
  }

  async load(signal: AbortSignal): Promise<void> {
    if (this.disposed) return;
    const combined = AbortSignal.any([signal, this.lifecycle.signal]);
    await Promise.all([...enemyArtAssets(this.art, ALL_SPECIES)].map((id) => this.request(id, combined)));
  }

  update(poses: readonly EnemyPose[], time: number): void {
    this.delta = this.time === null ? 0 : Math.max(0, time - this.time);
    this.time = time;
    this.frame++;
    for (const pose of poses) {
      if (!this.drawn.has(pose.species)) continue;
      let awake = this.awake.get(pose.id);
      if (awake !== undefined && awake.species !== pose.species) {
        this.sleep(awake);
        awake = undefined;
      }
      awake ??= this.wake(pose);
      if (awake === undefined) continue;
      awake.seen = this.frame;
      this.place(awake, pose, time);
    }
    // An enemy no pose names sleeps, or has gone.
    if (this.awake.size > 0) this.awake.forEach(this.sleepUnseen);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.awake.forEach(this.sleepAny);
    for (const asset of this.assets.values()) asset.template?.model.dispose();
    this.assets.clear();
    this.listeners.clear();
    this.root.removeFromParent();
  }

  inspect() {
    return {
      awake: this.awake.size, wakes: this.wakes, drawn: [...this.drawn],
      assets: [...this.assets].map(([id, asset]) => ({
        id, loaded: asset.template !== null, loading: asset.loading !== null, failed: asset.failure !== null,
      })),
    };
  }

  private readonly sleepUnseen = (awake: Awake): void => {
    if (awake.seen !== this.frame) this.sleep(awake);
  };

  private readonly sleepAny = (awake: Awake): void => {
    this.sleep(awake);
  };

  private readonly sleepChanged = (awake: Awake): void => {
    const entry = this.art[awake.species];
    if (entry?.type === 'model' && entry.asset === awake.entry.asset &&
      JSON.stringify(entry.clips) === JSON.stringify(awake.entry.clips)) awake.entry = entry;
    else this.sleep(awake);
  };

  // Which species draw now, telling the listeners; a model whose GLB lacks one of its clips is reported, once.
  private refresh(): void {
    this.drawn.clear();
    for (const species of ENEMY_SPECIES) {
      const entry = this.art[species];
      if (entry?.type !== 'model') continue;
      const template = this.assets.get(entry.asset)?.template ?? null;
      if (template === null) continue;
      const missing = Object.values(entry.clips).find((name) => name !== undefined && !template.clips.has(name));
      if (missing !== undefined) {
        if (!this.unplayable.has(entry)) {
          this.unplayable.add(entry);
          this.failure([species], new ModelError(`Its GLB has no animation clip "${missing}".`));
        }
        continue;
      }
      this.drawn.add(species);
    }
    for (const listener of [...this.listeners]) listener();
  }

  private fetchUsed(): void {
    for (const id of enemyArtAssets(this.art, ALL_SPECIES)) {
      this.request(id, this.lifecycle.signal).catch(() => undefined);
    }
  }

  // Loads a GLB once, however many ask for it; one that could not load rejects until the art stops using it.
  private request(id: string, signal: AbortSignal): Promise<void> {
    let asset = this.assets.get(id);
    if (asset === undefined) {
      asset = { template: null, loading: null, failure: null };
      this.assets.set(id, asset);
    }
    if (asset.template !== null) return Promise.resolve();
    if (asset.failure !== null) return Promise.reject(asset.failure.reason);
    if (asset.loading !== null) return asset.loading;
    const state = asset;
    const loading = this.loadTemplate(id, signal).then((template) => {
      state.loading = null;
      if (this.disposed || this.assets.get(id) !== state) {
        template.model.dispose();
        return;
      }
      state.template = template;
      this.refresh();
    }, (error: unknown) => {
      state.loading = null;
      // A load stopped on purpose, or for art no longer used, is no failure; the next request tries again.
      if (signal.aborted || this.disposed || this.assets.get(id) !== state) throw error;
      state.failure = { reason: error };
      this.failure(ENEMY_SPECIES.filter((species) => {
        const entry = this.art[species];
        return entry?.type === 'model' && entry.asset === id;
      }), error);
      this.refresh();
      throw error;
    });
    state.loading = loading;
    return loading;
  }

  private async loadTemplate(id: string, signal: AbortSignal): Promise<Template> {
    const blob = await this.fetch(id, signal);
    signal.throwIfAborted();
    const model = await loadVisualModel(blob);
    try {
      signal.throwIfAborted();
      return prepareTemplate(model);
    } catch (error) {
      model.dispose();
      throw error;
    }
  }

  // A clone of the species' model for an enemy that has woken, sharing the GLB's geometry and textures, with materials of
  // its own to tint and a mixer of its own.
  private wake(pose: EnemyPose): Awake | undefined {
    const entry = this.art[pose.species];
    if (entry?.type !== 'model') return undefined;
    const template = this.assets.get(entry.asset)?.template ?? null;
    if (template === null) return undefined;
    const clone = cloneSkinned(template.model.scene);
    const copies = new Map<Material, Material>();
    const materials: Tinted[] = [];
    const own = (material: Material): Material => {
      let copy = copies.get(material);
      if (copy === undefined) {
        copy = material.clone();
        copies.set(material, copy);
        materials.push(tinted(copy));
      }
      return copy;
    };
    clone.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      // Limbs in motion leave the bind pose's bounds.
      node.frustumCulled = false;
      node.material = Array.isArray(node.material) ? node.material.map(own) : own(node.material);
    });
    const bounds = template.bounds;
    const scale = modelHeight(pose.species) / (bounds.max.y - bounds.min.y);
    const centre = bounds.getCenter(new Vector3());
    // A ground enemy stands on its collider's bottom; a bird is centred on its body.
    const ground = ENEMY_SPECS[pose.species].collider.type === 'box';
    const fitted = new Group();
    fitted.scale.setScalar(scale);
    fitted.position.set(-centre.x * scale, -(ground ? bounds.min.y : centre.y) * scale, -centre.z * scale);
    fitted.add(clone);
    const holder = new Group();
    holder.name = `enemy-model:${pose.id}`;
    holder.add(fitted);
    this.root.add(holder);
    const awake: Awake = {
      id: pose.id, species: pose.species, entry, holder, clone, mixer: new AnimationMixer(clone), actions: new Map(), materials,
      role: null, tinted: false, seen: this.frame,
    };
    this.awake.set(pose.id, awake);
    this.wakes++;
    return awake;
  }

  private sleep(awake: Awake): void {
    awake.mixer.stopAllAction();
    awake.mixer.uncacheRoot(awake.clone);
    awake.holder.removeFromParent();
    awake.clone.traverse((node) => { if (node instanceof SkinnedMesh) node.skeleton.dispose(); });
    for (const { material } of awake.materials) material.dispose();
    this.awake.delete(awake.id);
  }

  private place(awake: Awake, pose: EnemyPose, time: number): void {
    const collider = ENEMY_SPECS[pose.species].collider;
    awake.holder.position.set(pose.x, collider.type === 'box' ? pose.y - collider.halfHeight : pose.y, OBSTACLE_LINE);
    // A model faces +Z: a quarter turn faces it the way the enemy walks.
    awake.holder.rotation.y = pose.facing === 'right' ? Math.PI / 2 : -Math.PI / 2;
    this.play(awake, pose);
    awake.mixer.update(this.delta);
    this.tint(awake, pose, time);
  }

  // Plays the pose's clip at the pose's time, cross-fading from the clip before it.
  private play(awake: Awake, pose: EnemyPose): void {
    const name = awake.entry.clips[pose.clip];
    const clip = name === undefined ? undefined : this.assets.get(awake.entry.asset)?.template?.clips.get(name);
    if (clip === undefined) return;
    let action = awake.actions.get(pose.clip);
    if (action === undefined) {
      action = awake.mixer.clipAction(clip);
      // Its time is always the pose's.
      action.timeScale = 0;
      awake.actions.set(pose.clip, action);
    }
    if (awake.role !== pose.clip) {
      const previous = awake.role === null ? undefined : awake.actions.get(awake.role);
      action.reset().play();
      // Roles playing one clip share its action, which carries straight on.
      if (previous !== undefined && previous !== action) action.crossFadeFrom(previous, CROSSFADE, false);
      awake.role = pose.clip;
    }
    // A loop repeats as play's travel does, over the clip's baked length.
    const cycle = awake.entry.motion[pose.clip]?.duration ?? clip.duration;
    action.time = Math.min(loopingRole(pose.clip) ? pose.clipTime % cycle : pose.clipTime, clip.duration);
  }

  private tint(awake: Awake, pose: EnemyPose, time: number): void {
    const age = Math.max(0, time - pose.changedAt);
    const warning = pose.phase === 'windup' ? warningTint(age) : 0;
    const hurt = pose.phase === 'hurt' ? hurtTint(age) : 0;
    if (warning === 0 && hurt === 0 && !awake.tinted) return;
    for (const { target, base } of awake.materials) target?.copy(base).lerp(WARNING, warning).lerp(WHITE, hurt);
    awake.tinted = warning > 0 || hurt > 0;
  }
}

function tinted(material: Material): Tinted {
  const emissive: unknown = Reflect.get(material, 'emissive');
  const color: unknown = Reflect.get(material, 'color');
  const target = emissive instanceof Color ? emissive : color instanceof Color ? color : null;
  return { material, target, base: target?.clone() ?? new Color() };
}

function prepareTemplate(model: LoadedVisual): Template {
  const scene = model.scene;
  scene.updateMatrixWorld(true);
  const skinned: SkinnedMesh[] = [];
  scene.traverse((node) => { if (node instanceof SkinnedMesh) skinned.push(node); });
  if (skinned.length === 0) throw new ModelError('An enemy model needs a skinned mesh.');
  // The bind pose's bounds, measured as its motion's height was: each skinned mesh's own positions, without morph
  // targets, where its node places them.
  const bounds = new Box3();
  const part = new Box3();
  const point = new Vector3();
  for (const mesh of skinned) {
    const positions = mesh.geometry.getAttribute('position');
    part.makeEmpty();
    for (let index = 0; index < positions.count; index++) part.expandByPoint(point.fromBufferAttribute(positions, index));
    bounds.union(part.applyMatrix4(mesh.matrixWorld));
  }
  if (!(bounds.max.y - bounds.min.y > 0)) throw new ModelError('An enemy model needs a bind pose with height.');
  const top = topJoint(skinned);
  const clips = new Map<string, AnimationClip>();
  for (const clip of model.animations) {
    playInPlace(clip, top);
    clips.set(clip.name, clip);
  }
  return { model, clips, bounds };
}

// The joint no other joint is above, which every skin shares: the one whose travel along the facing is root motion.
function topJoint(skinned: readonly SkinnedMesh[]): Object3D {
  const joints = new Set<Object3D>();
  for (const mesh of skinned) for (const bone of mesh.skeleton.bones) joints.add(bone);
  let top: Object3D | null = null;
  for (const joint of joints) {
    let above = joint.parent;
    while (above !== null && !joints.has(above)) above = above.parent;
    if (above !== null) continue;
    if (top !== null) throw new ModelError('An enemy model needs one top joint that every skin shares.');
    top = joint;
  }
  if (top === null) throw new ModelError('An enemy model needs a skeleton.');
  return top;
}

// Takes the top joint's travel along the facing, +Z, out of a clip, keeping its sway and bob: play moves the enemy as far
// as the clip travels, so the model steps in place where its body goes.
function playInPlace(clip: AnimationClip, top: Object3D): void {
  const name = `${top.name || top.uuid}.position`;
  const track = clip.tracks.find((candidate) => candidate.name === name);
  if (track === undefined || top.parent === null) return;
  const toModel = top.parent.matrixWorld;
  const fromModel = new Matrix4().copy(toModel).invert();
  const linear = new Matrix3().setFromMatrix4(toModel);
  const fromLinear = new Matrix3().copy(linear).invert();
  const values = track.values;
  const keys = track.times.length;
  const stride = values.length / keys;
  // A cubic spline keeps each key's in-tangent, value and out-tangent.
  const cubic = stride === 9;
  const offset = cubic ? 3 : 0;
  const point = new Vector3();
  const start = point.fromArray(values, offset).applyMatrix4(toModel).z;
  const flattenTangent = (at: number): void => {
    point.fromArray(values, at).applyMatrix3(linear);
    point.z = 0;
    point.applyMatrix3(fromLinear).toArray(values, at);
  };
  for (let key = 0; key < keys; key++) {
    const at = key * stride;
    point.fromArray(values, at + offset).applyMatrix4(toModel);
    point.z = start;
    point.applyMatrix4(fromModel).toArray(values, at + offset);
    if (cubic) {
      flattenTangent(at);
      flattenTangent(at + 6);
    }
  }
}
