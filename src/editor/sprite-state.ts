import { AvatarMotionError } from '../avatar-motion';
import type { AvatarRigRegistry } from '../avatar-rig';
import { DEFAULT_ARM_FORWARD_DISTANCE } from '../character-depth';
import { resolveAvatarJoints } from '../character-model-inspect';
import type { CharacterModelReport, CharacterModelUsage } from '../character-model-inspect';
import { CharacterModelError, characterModel, hasCharacterAssets } from '../character-profile';
import type { AvatarJointId, PartialAvatarBoneMap } from '../character-profile';
import { DirectionalError } from '../directional-data';
import { DEFAULT_GRIPS, sameGrips } from '../grips';
import { SkeletonError, validateSkeletonPreview } from '../skeleton-data';
import type { SkeletonDefinition, SkeletonPreview } from '../skeleton-data';
import { DEFAULT_CHARACTER_RIGGING_TYPE, EMPTY_SPRITES, SpriteError } from '../sprite-data';
import type { SpriteDocument, SpriteLayer, SpriteOffset } from '../sprite-data';
import type { PreparedSpriteReplacement, SpriteRig } from '../sprite-rig';
import { DEFAULT_WAIST_LEAN } from '../waist-lean';
import { createCharacterCommands, selectionIds } from './character-commands';
import type { PrimaryCommands } from './character-commands';
import { createCharacterImports } from './character-imports';
import type { AvatarMapping, CharacterImports } from './character-imports';
import type { Command, History } from './document/history';
import type { ImportRunner } from './document/import-runner';
import { applyProjectCommand } from './document/project-commands';
import type { ChangeCause, SectionChange, StepInfo } from './document/project-document';
import type { EditOutcome } from './document/project-imports';
import type { ProjectionState, VisualProjectionEvent } from './document/visual-contract';
import type { VisualSaves } from './visual-saves';

export interface SpriteAnchorInput {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly offset: SpriteOffset;
}

// A typed model or avatar-motion failure: a CharacterModelError code with the joints it concerns, or an
// AvatarMotionError code with the motion kind it concerns.
export interface CharacterModelIssue {
  readonly code: string;
  readonly message: string;
  readonly joints: readonly string[];
  readonly motion: string | null;
}

// The imported avatar shown in Character: the profile's, or an import waiting for a complete bone map.
export interface AvatarModelState {
  readonly name: string;
  readonly pending: boolean;
  // GLB skin joint names to choose from; null while the model's report is unavailable.
  readonly joints: readonly string[] | null;
  readonly boneMap: PartialAvatarBoneMap;
  readonly issue: CharacterModelIssue | null;
  readonly unmapped: readonly { readonly name: string; readonly follows: AvatarJointId | null }[];
}

export interface SpriteEditorSnapshot {
  // The document's primary character, the exact root.
  readonly document: SpriteDocument;
  // What the character rig shows of it.
  readonly rendering: ProjectionState<SpriteDocument, SpriteError>;
  // This browser's save of the profile, which Revert restores; null when there is none.
  readonly saved: SpriteDocument | null;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly hasContent: boolean;
  // The last refused edit, until the profile changes.
  readonly error: string | null;
  readonly anchors: readonly SpriteAnchorInput[];
  readonly selectedLayerId: string | null;
  readonly externalSources: boolean;
  readonly preview: SkeletonPreview | null;
  readonly directionalPreview: boolean;
  // The typed failure behind `error`, or behind a failed rendering, when a character model or bone map caused it.
  readonly modelIssue: CharacterModelIssue | null;
  readonly avatarModel: AvatarModelState | null;
  readonly hammerModel: { readonly name: string } | null;
  readonly potModel: { readonly name: string } | null;
}

export interface SpriteStateOptions {
  readonly history: History;
  readonly rig: SpriteRig;
  readonly anchors: readonly SpriteAnchorInput[];
  readonly targetIds: readonly string[];
  readonly avatarRigs: AvatarRigRegistry;
  readonly runner: ImportRunner;
  readonly saves: VisualSaves;
  // Reports of the models the character rig has loaded, which list an avatar's joints.
  readonly describeModel: (source: string, usage: CharacterModelUsage) => CharacterModelReport | null;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
  // An unexpected failure while the rig follows the document.
  readonly onFault: (error: unknown) => void;
}

const STATUS: VisualProjectionEvent = Object.freeze({ cause: null, step: null });
const EXTERNAL_IMAGES = 'This sprite document references external image URL(s). Export preserves those public references. ' +
  'Never use links containing credentials or private/internal addresses.';

function isExternal(source: string): boolean {
  return !source.startsWith('data:');
}

function loading(value: SpriteDocument): ProjectionState<SpriteDocument, SpriteError> {
  return Object.freeze({ kind: 'loading', value });
}

function ready(value: SpriteDocument): ProjectionState<SpriteDocument, SpriteError> {
  return Object.freeze({ kind: 'ready', value });
}

function failed(value: SpriteDocument, error: SpriteError): ProjectionState<SpriteDocument, SpriteError> {
  return Object.freeze({ kind: 'failed', value, error });
}

// The rig's refusal; anything else is a bug.
function failure(error: unknown): SpriteError {
  if (error instanceof SpriteError) return error;
  if (error instanceof SkeletonError || error instanceof DirectionalError) return new SpriteError(error.message, { cause: error });
  throw error;
}

function issueOf(error: Error | null): CharacterModelIssue | null {
  if (error instanceof CharacterModelError) {
    return Object.freeze({ code: error.code, message: error.message, joints: error.joints, motion: null });
  }
  if (error instanceof AvatarMotionError) {
    return Object.freeze({ code: error.code, message: error.message, joints: Object.freeze([]), motion: error.motion });
  }
  return null;
}

export function isDefaultCharacter(profile: SpriteDocument): boolean {
  return profile === EMPTY_SPRITES || profile.characterRiggingType === DEFAULT_CHARACTER_RIGGING_TYPE &&
    profile.armForwardDistance === DEFAULT_ARM_FORWARD_DISTANCE && profile.waistLean === DEFAULT_WAIST_LEAN &&
    sameGrips(profile.grips, DEFAULT_GRIPS) && profile.arms === null && !hasCharacterAssets(profile) &&
    profile.layers.length === 0 && profile.images.length === 0 && profile.skeleton === null && profile.presentation === null;
}

// A pose preview the new skeleton still accepts. One it refuses, such as one of a deleted clip, ends with the step.
function keptPreview(preview: SkeletonPreview | null, skeleton: SkeletonDefinition | null): SkeletonPreview | null {
  if (preview === null || skeleton === null) return null;
  try {
    return validateSkeletonPreview(preview, skeleton);
  } catch (error) {
    if (error instanceof SkeletonError) return null;
    throw error;
  }
}

// The rig calls that take its layers from `applied` to `desired`: any changed in place, or one added last or removed, the
// others the same objects in the same order; null otherwise.
function layerSteps(rig: SpriteRig, applied: readonly SpriteLayer[], desired: readonly SpriteLayer[]): (() => void)[] | null {
  if (desired.length === applied.length) {
    const changed: { readonly layer: SpriteLayer; readonly growth: number }[] = [];
    for (let index = 0; index < desired.length; index++) {
      const layer = desired[index];
      if (layer === applied[index]) continue;
      if (layer.id !== applied[index].id) return null;
      changed.push({ layer, growth: (layer.skin?.weights.length ?? 0) - (applied[index].skin?.weights.length ?? 0) });
    }
    // Shrinking meshes go first, so no rig in between exceeds the weighted-vertex budget both ends keep within.
    return changed.sort((left, right) => left.growth - right.growth).map(({ layer }) => () => rig.upsert(layer));
  }
  if (desired.length === applied.length + 1) {
    const layer = desired[applied.length];
    return applied.every((entry, index) => entry === desired[index]) ? [() => rig.upsert(layer)] : null;
  }
  if (desired.length === applied.length - 1) {
    const index = applied.findIndex((entry, at) => entry !== desired[at]);
    const removed = applied[index];
    return desired.every((entry, at) => entry === applied[at < index ? at : at + 1]) ? [() => rig.remove(removed.id)] : null;
  }
  return null;
}

/**
 * The primary character as Character and Sprites edit it: the document's profile, changed only through `commands` and
 * `imports`, which the history applies. The character rig follows the document asynchronously, the newest profile
 * winning: ordinary edits update it in place, and a change of images or models, or of more than one of the type,
 * layers, skeleton and presentation, loads the profile whole. A whole load goes on while newer profiles need what it
 * loads, and then shows the newest. Outside the document the state keeps only the selected layer, previews, the rig's
 * progress and the last refusal.
 */
export class SpriteEditorState {
  readonly history: History;
  readonly commands: PrimaryCommands;
  readonly imports: CharacterImports;
  readonly anchors: readonly SpriteAnchorInput[];
  readonly targetIds: readonly string[];
  private readonly rig: SpriteRig;
  private readonly saves: VisualSaves;
  private readonly notice: (message: string, kind: 'info' | 'error') => void;
  private readonly fault: (error: unknown) => void;
  private readonly listeners = new Set<(event: VisualProjectionEvent) => void>();
  private readonly lifecycle = new AbortController();
  private readonly unsubscribe: () => void;
  // The profile the rig shows; null until it shows one, and after an in-place change failed until it loads one whole.
  private applied: SpriteDocument | null = null;
  private rendering: ProjectionState<SpriteDocument, SpriteError>;
  // The whole preparation the rig runs, and the profile it prepares.
  private operation: { readonly root: SpriteDocument; readonly controller: AbortController } | null = null;
  private draining = false;
  private active = false;
  private selectedLayerId: string | null;
  private preview: SkeletonPreview | null = null;
  private directionalPreview = false;
  private refusal: Error | null = null;
  private saving = false;
  private avatarKey: readonly unknown[] = [];
  private avatarState: AvatarModelState | null = null;
  private disposed = false;

  constructor(options: SpriteStateOptions) {
    if (options.anchors.length === 0) throw new Error('The sprite editor requires at least one anchor.');
    const seen = new Set<string>();
    for (const anchor of options.anchors) {
      if (typeof anchor.id !== 'string' || anchor.id.length === 0 || seen.has(anchor.id)) {
        throw new Error(`Invalid or duplicate sprite anchor ID: "${anchor.id}".`);
      }
      seen.add(anchor.id);
      if (!Number.isFinite(anchor.width) || anchor.width <= 0 || !Number.isFinite(anchor.height) || anchor.height <= 0) {
        throw new Error(`Sprite anchor "${anchor.id}" needs a positive finite width and height.`);
      }
      if (![anchor.offset.x, anchor.offset.y, anchor.offset.z].every(Number.isFinite)) {
        throw new Error(`Sprite anchor "${anchor.id}" needs a finite offset.`);
      }
    }
    this.history = options.history;
    this.rig = options.rig;
    this.saves = options.saves;
    this.notice = options.onNotice;
    this.fault = options.onFault;
    this.anchors = Object.freeze(options.anchors.map((anchor) =>
      Object.freeze({ ...anchor, offset: Object.freeze({ ...anchor.offset }) })));
    this.targetIds = Object.freeze([...options.targetIds]);
    const project = options.history.document;
    this.commands = createCharacterCommands({
      document: project, anchors: this.anchors, targetIds: this.targetIds, avatarRigs: options.avatarRigs,
      describeModel: options.describeModel,
    });
    this.imports = createCharacterImports({
      document: project, runner: options.runner, commands: this.commands, onMapping: () => this.emit(STATUS),
    });
    const profile = this.definition();
    this.rendering = loading(profile);
    this.selectedLayerId = profile.layers[0]?.id ?? null;
    this.unsubscribe = project.subscribe('characters/primary', (change, cause, step) => this.follow(change, cause, step));
  }

  // The document's primary character, the exact root.
  definition(): SpriteDocument {
    return this.history.document.get('characters/primary');
  }

  renderingState(): ProjectionState<SpriteDocument, SpriteError> {
    return this.rendering;
  }

  // Starts the rig following the document, once the page has opened its first project or save.
  activate(): void {
    if (this.active || this.disposed) return;
    this.active = true;
    try {
      this.reconcile();
    } catch (error) {
      this.fault(error);
    }
    this.emit(STATUS);
  }

  // Loads the profile whole again after the rig could not show it.
  retry(): void {
    if (this.disposed || !this.active || this.draining || this.rendering.kind !== 'failed') return;
    this.rendering = loading(this.definition());
    void this.drain(true);
    this.emit(STATUS);
  }

  snapshot(): SpriteEditorSnapshot {
    const document = this.definition();
    const saved = this.saves.characterFingerprint();
    const unshown = this.rendering.kind === 'failed' ? this.rendering.error : null;
    return {
      document,
      rendering: this.rendering,
      saved,
      saving: this.saving,
      // Saved values are exact roots, so undoing back to one is clean again.
      dirty: document !== (saved ?? EMPTY_SPRITES),
      hasContent: !isDefaultCharacter(document),
      error: this.refusal?.message ?? null,
      anchors: this.anchors,
      selectedLayerId: this.selectedLayerId,
      externalSources: document.images.some((image) => isExternal(image.source)),
      preview: this.preview,
      directionalPreview: this.directionalPreview,
      modelIssue: issueOf(this.refusal ?? unshown),
      avatarModel: this.avatarModel(document),
      hammerModel: document.hammer === undefined ? null : { name: characterModel(document, document.hammer.model).name },
      potModel: document.pot === undefined ? null : { name: characterModel(document, document.pot.model).name },
    };
  }

  // Tells `listener` now, and after each change of the profile, of the rig's progress and of the editor's own state.
  subscribe(listener: (event: VisualProjectionEvent) => void): () => void {
    this.listeners.add(listener);
    listener(STATUS);
    return () => { this.listeners.delete(listener); };
  }

  // Applies `command` through the history; a refusal shows in the status and as a notice. False when refused.
  apply(command: Command): boolean {
    const refusal = applyProjectCommand(this.history, command);
    if (refusal !== null) {
      this.refuse(refusal);
      return false;
    }
    this.clearRefusal();
    return true;
  }

  // Reports an import's outcome as apply does; true once its value is the profile's.
  settle(outcome: EditOutcome<unknown>): boolean {
    if (this.disposed || outcome.kind === 'cancelled') return false;
    if (outcome.kind === 'refused') {
      this.refuse(outcome.error);
      return false;
    }
    this.clearRefusal();
    return true;
  }

  // Reports a whole profile's load as settle does, warning when its images are links.
  settleProfile(outcome: EditOutcome<SpriteDocument>): boolean {
    if (!this.settle(outcome)) return false;
    if (outcome.kind === 'applied' && outcome.value.images.some((image) => isExternal(image.source))) {
      this.notice(EXTERNAL_IMAGES, 'info');
    }
    return true;
  }

  selectLayer(id: string | null): void {
    if (id !== null && !this.definition().layers.some((layer) => layer.id === id)) {
      throw new Error(`Unknown sprite layer "${id}".`);
    }
    if (this.selectedLayerId === id) return;
    this.selectedLayerId = id;
    this.emit(STATUS);
  }

  setPreview(value: SkeletonPreview | null): void {
    if (value === null) {
      this.leavePreview();
      return;
    }
    const refused = this.previewRefusal();
    if (refused !== null) {
      this.refuse(refused);
      return;
    }
    try {
      const skeleton = this.definition().skeleton;
      if (skeleton === null) throw new SpriteError('Create a skeleton before previewing a pose.');
      const preview = validateSkeletonPreview(value, skeleton);
      this.rig.setPreview(preview);
      this.preview = preview;
      this.directionalPreview = false;
    } catch (error) {
      this.refuse(failure(error));
      return;
    }
    this.refusal = null;
    this.emit(STATUS);
  }

  setDirectionalPreview(value: { readonly aim: { readonly x: number; readonly y: number } } | null): boolean {
    if (this.disposed) return false;
    if (value === null) {
      this.rig.setDirectionalPreview(null);
      if (this.directionalPreview) {
        this.directionalPreview = false;
        this.emit(STATUS);
      }
      return true;
    }
    const refused = this.previewRefusal();
    if (refused !== null) {
      this.refuse(refused);
      return false;
    }
    try {
      if (![value.aim.x, value.aim.y].every(Number.isFinite) || value.aim.x === 0 && value.aim.y === 0) {
        throw new SpriteError('Preview aim must be a finite, nonzero vector.');
      }
      const notify = !this.directionalPreview || this.preview !== null || this.refusal !== null;
      this.rig.setDirectionalPreview(value);
      this.preview = null;
      this.directionalPreview = true;
      this.refusal = null;
      // Aim movement is transient; subscribers only need preview-mode transitions.
      if (notify) this.emit(STATUS);
      return true;
    } catch (error) {
      this.refuse(failure(error));
      return false;
    }
  }

  leavePreview(): void {
    if (this.disposed) return;
    const changed = this.preview !== null || this.directionalPreview;
    this.endPreviews();
    if (changed) this.emit(STATUS);
  }

  // Stores the profile as this browser's save; the document and its history stay as they are.
  async save(): Promise<void> {
    if (this.disposed || this.saving) return;
    const value = this.definition();
    this.saving = true;
    this.emit(STATUS);
    try {
      const result = await this.saves.saveCharacter(value, this.lifecycle.signal);
      if (result.kind === 'refused') this.refuse(result.error);
    } catch (error) {
      if (!this.lifecycle.signal.aborted) this.fault(error);
    } finally {
      this.saving = false;
      this.emit(STATUS);
    }
  }

  exportDocument(): string {
    return JSON.stringify(this.definition());
  }

  // The rig's directional readouts, of what it shows.
  presentationState(): ReturnType<SpriteRig['presentationState']> {
    return this.rig.presentationState();
  }

  flipbookState(id: string): ReturnType<SpriteRig['flipbookState']> {
    return this.rig.flipbookState(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.endPreviews();
    this.disposed = true;
    this.unsubscribe();
    this.lifecycle.abort(new DOMException('The sprite editor was disposed.', 'AbortError'));
    this.imports.dispose();
    this.listeners.clear();
  }

  // Heard as each step sets the profile: the history is never held for the rig.
  private follow(change: SectionChange<'characters/primary'>, cause: ChangeCause, step: StepInfo | null): void {
    this.refusal = null;
    this.select(change.after, cause, step);
    try {
      this.reconcile();
    } catch (error) {
      this.fault(error);
    }
    this.emit({ cause, step });
  }

  // Undo selects the layer a Sprites step had selected before it, Redo and edits the one after it.
  private select(profile: SpriteDocument, cause: ChangeCause, step: StepInfo | null): void {
    const select = step?.place.tab === 'sprites' ? step.place.select : null;
    const wanted = select === null ? [] : selectionIds(cause === 'undo' ? select.before : select.after, 'layer');
    const listed = wanted.find((id) => profile.layers.some((layer) => layer.id === id));
    if (listed !== undefined) this.selectedLayerId = listed;
    else if (!profile.layers.some((layer) => layer.id === this.selectedLayerId)) this.selectedLayerId = profile.layers[0]?.id ?? null;
  }

  // Takes the rig toward the document's profile: in place when it can, else through the one whole preparation. That
  // preparation goes on while the newest profile needs something only it loads and nothing it does not, so it never
  // restarts a load the newest still needs; otherwise it is cancelled, and the drain takes the newest without it.
  private reconcile(): void {
    if (this.disposed) return;
    const root = this.definition();
    if (!this.active || this.draining) {
      const operation = this.operation;
      if (operation !== null && operation.root !== root && this.rig.replacementNeeds(root, operation.root) !== 'prepared') {
        operation.controller.abort();
      }
      this.rendering = loading(root);
      return;
    }
    if (this.applied === root) {
      this.rendering = ready(root);
      return;
    }
    const steps = this.applied === null ? null : this.incremental(this.applied, root);
    if (steps !== null) {
      this.showSteps(root, steps);
      return;
    }
    this.rendering = loading(root);
    void this.drain(false);
  }

  // One whole preparation at a time, of the newest profile. It commits the profile the document holds by then, its own
  // or a newer one it loaded all the new images and models for, built at once from those and what the rig shows; any
  // other is cancelled. The rig drains its native work before it changes again, so nothing obsolete shows or is
  // reported ready.
  private async drain(whole: boolean): Promise<void> {
    this.draining = true;
    this.endPreviews();
    try {
      for (;;) {
        await this.rig.whenIdle(this.lifecycle.signal);
        const root = this.definition();
        if (this.applied === root) {
          this.rendering = ready(root);
          return;
        }
        const steps = whole || this.applied === null ? null : this.incremental(this.applied, root);
        whole = false;
        if (steps !== null) {
          this.showSteps(root, steps);
          return;
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, this.lifecycle.signal]);
        this.operation = { root, controller };
        let prepared: PreparedSpriteReplacement;
        try {
          prepared = await this.rig.prepareReplacement(root, { signal });
        } catch (error) {
          // A cancelled preparation is silent and a refused one shows only while the document holds its profile;
          // failure() throws anything else on to onFault.
          if (signal.aborted && error instanceof DOMException && error.name === 'AbortError') continue;
          const refusal = failure(error);
          if (root !== this.definition()) continue;
          this.rendering = failed(root, refusal);
          return;
        } finally {
          this.operation = null;
        }
        if (signal.aborted) {
          prepared.cancel();
          continue;
        }
        const desired = this.definition();
        try {
          prepared.commit(desired === root ? undefined : desired);
        } catch (error) {
          this.rendering = failed(desired, failure(error));
          return;
        }
        this.applied = desired;
        this.rendering = ready(desired);
        return;
      }
    } catch (error) {
      if (!this.lifecycle.signal.aborted) this.fault(error);
    } finally {
      this.draining = false;
      this.emit(STATUS);
    }
  }

  // Shows `root` through `steps`, in place. A refusal may leave some of them done, so the rig's state is known again
  // only once it loads a profile whole.
  private showSteps(root: SpriteDocument, steps: readonly (() => void)[]): void {
    try {
      for (const step of steps) step();
    } catch (error) {
      this.applied = null;
      this.rendering = failed(root, failure(error));
      return;
    }
    this.applied = root;
    this.rendering = ready(root);
  }

  // The rig calls that take it from showing `applied` to showing `desired` in place, or null when only a whole
  // replacement can: images added, models or the avatar's model, bone map, driver or hair changed, or more than one of
  // the type, layers, skeleton and presentation. The arm, grip and lean settings and the avatar's motions check nothing
  // else, so any of them change alongside.
  private incremental(applied: SpriteDocument, desired: SpriteDocument): (() => void)[] | null {
    const keys = new Set([...Object.keys(applied), ...Object.keys(desired)]) as Set<keyof SpriteDocument>;
    const changed = [...keys].filter((key) => applied[key] !== desired[key]);
    const rig = this.rig;
    const settings: (() => void)[] = [];
    let structure: (() => void)[] | null = null;
    for (const key of changed) {
      let steps: (() => void)[] | null;
      switch (key) {
        case 'images': {
          const shown = new Set(applied.images);
          if (!changed.includes('layers') || !desired.images.every((image) => shown.has(image))) return null;
          continue;
        }
        case 'armForwardDistance': settings.push(() => rig.setArmForwardDistance(desired.armForwardDistance)); continue;
        case 'waistLean': settings.push(() => rig.setWaistLean(desired.waistLean)); continue;
        case 'grips': settings.push(() => rig.setGrips(desired.grips)); continue;
        case 'arms': settings.push(() => rig.setArms(desired.arms)); continue;
        case 'avatar': {
          const before = applied.avatar;
          const after = desired.avatar;
          if (before === undefined || after === undefined || before.model !== after.model || before.boneMap !== after.boneMap ||
            before.driver !== after.driver || before.hair !== after.hair) return null;
          settings.push(() => rig.setAvatarMotion(after.motion));
          continue;
        }
        case 'layers': steps = layerSteps(rig, applied.layers, desired.layers); break;
        case 'characterRiggingType':
          steps = [() => {
            rig.setCharacterRiggingType(desired.characterRiggingType);
            this.preview = null;
            this.directionalPreview = false;
          }];
          break;
        case 'skeleton':
          steps = [() => {
            const preview = keptPreview(this.preview, desired.skeleton);
            rig.configureSkeleton(desired.skeleton, { preview });
            rig.setDirectionalPreview(null);
            this.preview = preview;
            this.directionalPreview = false;
          }];
          break;
        case 'presentation': steps = [() => rig.configurePresentation(desired.presentation)]; break;
        default: return null;
      }
      // These check one another, so only one of them changes in place.
      if (steps === null || structure !== null) return null;
      structure = steps;
    }
    return structure === null ? settings : [...structure, ...settings];
  }

  // Previews pose the rig as it shows the document, so they wait until it does.
  private previewRefusal(): SpriteError | null {
    if (this.disposed) return new SpriteError('The character editor is closed.');
    return this.active && !this.draining && this.applied === this.definition() ? null
      : new SpriteError('Wait for the character to load before previewing it.');
  }

  private endPreviews(): void {
    if (this.preview === null && !this.directionalPreview) return;
    this.rig.setDirectionalPreview(null);
    if (this.preview !== null) this.rig.setPreview(null);
    this.preview = null;
    this.directionalPreview = false;
  }

  // The avatar Character shows: one waiting for its bone map, or the profile's, whose joints wait for its model's
  // report. Kept while what it shows stays the same.
  private avatarModel(document: SpriteDocument): AvatarModelState | null {
    const mapping: AvatarMapping | null = this.imports.mapping();
    const avatar = document.avatar;
    const model = avatar === undefined ? null : characterModel(document, avatar.model);
    const report = model === null ? null : this.commands.report(model, 'avatar');
    const key = [mapping, avatar, model, report];
    if (key.length === this.avatarKey.length && key.every((value, index) => value === this.avatarKey[index])) return this.avatarState;
    let value: AvatarModelState | null = null;
    if (mapping !== null) {
      value = {
        name: mapping.name, pending: true, joints: mapping.report.joints.map((joint) => joint.name),
        boneMap: mapping.boneMap, issue: issueOf(mapping.issue), unmapped: [],
      };
    } else if (avatar !== undefined && model !== null) {
      let unmapped: AvatarModelState['unmapped'] = [];
      let issue: CharacterModelIssue | null = null;
      if (report !== null) {
        try {
          unmapped = resolveAvatarJoints(report, avatar.boneMap).unmapped.map((joint) => ({ name: joint.name, follows: joint.follows }));
        } catch (error) {
          if (!(error instanceof CharacterModelError)) throw error;
          issue = issueOf(error);
        }
      }
      value = {
        name: model.name, pending: false, joints: report?.joints.map((joint) => joint.name) ?? null,
        boneMap: avatar.boneMap, issue, unmapped,
      };
    }
    this.avatarKey = key;
    this.avatarState = value;
    return value;
  }

  private refuse(error: Error): void {
    if (this.disposed) return;
    const repeated = this.refusal?.message === error.message;
    this.refusal = error;
    if (!repeated) this.notice(error.message, 'error');
    this.emit(STATUS);
  }

  private clearRefusal(): void {
    if (this.refusal === null) return;
    this.refusal = null;
    this.emit(STATUS);
  }

  private emit(event: VisualProjectionEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener(event);
  }
}
