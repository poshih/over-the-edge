import type { SpriteRig } from '../sprite-rig';
import {
  EMPTY_SPRITES, parseSpriteDocument, SPRITE_LIMITS, SpriteError, validateSpriteAnchors, validateSpriteDocument,
  validateSpriteLayer, encodePng, inspectPng, DEFAULT_SPRITE_RIGGING, validateSpriteRigging, validateSpriteBudget,
  DEFAULT_CHARACTER_RIGGING_TYPE, validateCharacterRiggingType,
} from '../sprite-data';
import type { SpriteDocument, SpriteLayer, SpriteOffset } from '../sprite-data';
import { DirectionalError, validateDirectionalPresentation } from '../directional-data';
import type { DirectionalPresentation } from '../directional-data';
import { SKELETON_LIMITS, SkeletonError, validateSkeleton, validateSkeletonPreview } from '../skeleton-data';
import type { FacingDirection, SkeletonDefinition, SkeletonPreview, SpriteSkin } from '../skeleton-data';
import { autoWeights, restPose } from '../skeleton-pose';
import { VisualStore, VisualStoreError } from './visual-store';

export interface SpriteAnchorInput {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly offset: SpriteOffset;
}

export interface SpriteLayerEdit {
  readonly name?: string;
  readonly anchor?: string;
  readonly underlay?: 'replace' | 'overlay';
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly rotation?: number;
  readonly bone?: string | null;
  readonly directions?: readonly FacingDirection[];
  readonly skin?: SpriteSkin | null;
  readonly tileLength?: number | null;
}

export interface SpriteEditorSnapshot {
  readonly restoring: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly dirty: boolean;
  readonly hasContent: boolean;
  readonly anchors: readonly SpriteAnchorInput[];
  readonly document: SpriteDocument;
  readonly saved: SpriteDocument | null;
  readonly selectedLayerId: string | null;
  readonly externalSources: boolean;
  readonly preview: SkeletonPreview | null;
  readonly directionalPreview: boolean;
}

interface StoredSprites {
  readonly id: 'active';
  readonly document: SpriteDocument;
}

function isEmbedded(source: string): boolean {
  return source.startsWith('data:');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isDocumentError(error: unknown): error is SpriteError | SkeletonError | DirectionalError {
  return error instanceof SpriteError || error instanceof SkeletonError || error instanceof DirectionalError;
}

function nextId(prefix: string, taken: ReadonlySet<string>): string {
  let index = taken.size + 1;
  let candidate = `${prefix}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}

function sameLayer(left: SpriteLayer, right: SpriteLayer): boolean {
  return left === right || left.id === right.id && left.name === right.name &&
    left.anchor === right.anchor && left.image === right.image &&
    left.width === right.width && left.height === right.height &&
    left.rotation === right.rotation && left.underlay === right.underlay &&
    left.offset.x === right.offset.x && left.offset.y === right.offset.y && left.offset.z === right.offset.z &&
    left.bone === right.bone && left.tileLength === right.tileLength &&
    left.directions.length === right.directions.length && left.directions.every((value, index) => value === right.directions[index]) &&
    (left.skin === right.skin || JSON.stringify(left.skin) === JSON.stringify(right.skin));
}

function sameDocument(left: SpriteDocument, right: SpriteDocument): boolean {
  if (left === right) return true;
  if (left.characterRiggingType !== right.characterRiggingType) return false;
  if (left.layers.length !== right.layers.length || left.images.length !== right.images.length) return false;
  return (left.skeleton === right.skeleton || JSON.stringify(left.skeleton) === JSON.stringify(right.skeleton)) &&
    samePresentation(left.presentation, right.presentation) &&
    left.layers.every((layer, index) => sameLayer(layer, right.layers[index])) &&
    (left.images === right.images || left.images.every((image, index) => {
      const other = right.images[index];
      return image === other || image.id === other.id && image.name === other.name && image.source === other.source;
    }));
}

function samePresentation(left: DirectionalPresentation | null, right: DirectionalPresentation | null): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function fitWithinAnchor(anchor: SpriteAnchorInput, size: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(anchor.width / size.width, anchor.height / size.height);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new SpriteError(`Anchor "${anchor.id}" has no usable size to fit this image.`);
  }
  return { width: size.width * scale, height: size.height * scale };
}

/**
 * Non-DOM controller for the authored sprite document: owns the draft/saved split, the
 * IndexedDB round-trip and the SpriteRig calls. `sprite-editor.ts` renders this state.
 */
export class SpriteEditorState {
  private readonly rig: SpriteRig;
  private readonly anchors: readonly SpriteAnchorInput[];
  private readonly anchorMap: ReadonlyMap<string, SpriteAnchorInput>;
  private readonly anchorIds: ReadonlySet<string>;
  private readonly targetIds: ReadonlySet<string>;
  private readonly notice: (message: string, kind: 'info' | 'error') => void;
  private readonly store = new VisualStore<StoredSprites>({
    database: 'over-the-edge:sprites', store: 'documents', keyPath: 'id',
  });
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle = new AbortController();
  private draft: SpriteDocument = EMPTY_SPRITES;
  private saved: SpriteDocument | null = null;
  private selectedLayerId: string | null = null;
  private preview: SkeletonPreview | null = null;
  private directionalPreview = false;
  private restoring = true;
  private busy = false;
  private error: string | null = null;
  private disposed = false;

  constructor(options: {
    rig: SpriteRig;
    anchors: readonly SpriteAnchorInput[];
    targetIds: readonly string[];
    onNotice: (message: string, kind: 'info' | 'error') => void;
  }) {
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
    this.rig = options.rig;
    this.anchors = Object.freeze(options.anchors.map((anchor) =>
      Object.freeze({ ...anchor, offset: Object.freeze({ ...anchor.offset }) })));
    this.anchorMap = new Map(this.anchors.map((anchor) => [anchor.id, anchor]));
    this.anchorIds = new Set(this.anchors.map((anchor) => anchor.id));
    this.targetIds = new Set(options.targetIds);
    this.notice = options.onNotice;
  }

  async restore(): Promise<void> {
    try {
      const entries = await this.store.entries();
      if (this.disposed) return;
      if (entries.some((entry) => entry.key !== 'active')) {
        throw new SpriteError('Saved sprites contain unknown records. Existing records were left untouched.');
      }
      const record = entries.find((entry) => entry.key === 'active');
      if (record === undefined) {
        this.saved = EMPTY_SPRITES;
        return;
      }
      let document: SpriteDocument;
      try {
        document = this.validateRecord(record.value);
        validateSpriteAnchors(document, this.anchorIds, this.targetIds);
      } catch (error) {
        if (!isDocumentError(error)) throw error;
        this.reportError(`Saved sprites were invalid and were left untouched in storage: ${error.message}`);
        return;
      }
      await this.replaceRig(document);
      if (this.disposed) return;
      this.draft = document;
      this.saved = document;
      this.selectedLayerId = document.layers[0]?.id ?? null;
      this.warnExternalSources(document);
    } catch (error) {
      if (this.disposed && isAbort(error)) return;
      if (!(isDocumentError(error) || error instanceof VisualStoreError)) throw error;
      if (!this.disposed) this.reportError(error.message);
    } finally {
      this.restoring = false;
      this.changed();
    }
  }

  snapshot(): SpriteEditorSnapshot {
    return {
      restoring: this.restoring,
      busy: this.busy,
      error: this.error,
      dirty: this.saved === null || !sameDocument(this.draft, this.saved),
      hasContent: this.draft.characterRiggingType !== DEFAULT_CHARACTER_RIGGING_TYPE ||
        this.draft.layers.length > 0 || this.draft.images.length > 0 ||
        this.draft.skeleton !== null || this.draft.presentation !== null,
      anchors: this.anchors,
      document: this.draft,
      saved: this.saved,
      selectedLayerId: this.selectedLayerId,
      externalSources: this.draft.images.some((image) => !isEmbedded(image.source)),
      preview: this.preview,
      directionalPreview: this.directionalPreview,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  selectLayer(id: string | null): void {
    if (id !== null && !this.draft.layers.some((layer) => layer.id === id)) {
      throw new Error(`Unknown sprite layer "${id}".`);
    }
    if (this.selectedLayerId === id) return;
    this.selectedLayerId = id;
    this.changed();
  }

  async addImageLayer(file: File, anchorId: string): Promise<void> {
    if (!this.canEdit()) return;
    const anchor = this.anchorMap.get(anchorId);
    if (anchor === undefined) throw new Error(`Unknown sprite anchor "${anchorId}".`);
    await this.run(async () => {
      if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) {
        throw new SpriteError('Choose one PNG (.png) image file.');
      }
      if (file.size === 0 || file.size > SPRITE_LIMITS.imageBytes) {
        throw new SpriteError(`Choose a PNG image no larger than ${Math.floor(SPRITE_LIMITS.imageBytes / 1024 ** 2)} MiB.`);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (this.disposed) return;
      const size = inspectPng(bytes);
      const source = encodePng(bytes);
      const existing = this.draft.images.find((image) => image.source === source);
      let images = this.draft.images;
      let image = existing;
      if (image === undefined) {
        if (images.length >= SPRITE_LIMITS.images) {
          throw new SpriteError(`A sprite document supports at most ${SPRITE_LIMITS.images} images.`);
        }
        image = { id: nextId('image', new Set(images.map((candidate) => candidate.id))), name: file.name.replace(/\.png$/i, ''), source };
        images = [...images, image];
      }
      if (this.draft.layers.length >= SPRITE_LIMITS.layers) {
        throw new SpriteError(`A sprite document supports at most ${SPRITE_LIMITS.layers} layers.`);
      }
      const fit = fitWithinAnchor(anchor, size);
      const layer = validateSpriteLayer({
        ...DEFAULT_SPRITE_RIGGING,
        id: nextId('layer', new Set(this.draft.layers.map((candidate) => candidate.id))),
        name: image.name, anchor: anchor.id, image: image.id,
        width: fit.width, height: fit.height, offset: { ...anchor.offset }, rotation: 0, underlay: 'replace',
      });
      const document = validateSpriteDocument({ ...this.draft, images, layers: [...this.draft.layers, layer] });
      await this.replaceRig(document);
      if (this.disposed) return;
      this.draft = document;
      this.selectedLayerId = layer.id;
    });
  }

  updateLayer(id: string, edit: SpriteLayerEdit): void {
    if (!this.canEdit()) return;
    const current = this.draft.layers.find((layer) => layer.id === id);
    if (current === undefined) throw new Error(`Unknown sprite layer "${id}".`);
    try {
      const layer = validateSpriteLayer({
        id: current.id, image: current.image,
        name: edit.name ?? current.name,
        anchor: edit.anchor ?? current.anchor,
        width: edit.width ?? current.width,
        height: edit.height ?? current.height,
        offset: { x: edit.x ?? current.offset.x, y: edit.y ?? current.offset.y, z: edit.z ?? current.offset.z },
        rotation: edit.rotation ?? current.rotation,
        underlay: edit.underlay ?? current.underlay,
        bone: edit.bone === undefined ? current.bone : edit.bone,
        directions: edit.directions === undefined ? current.directions : edit.directions,
        skin: edit.skin === undefined ? current.skin : edit.skin,
        tileLength: edit.tileLength === undefined ? current.tileLength : edit.tileLength,
      });
      if (sameLayer(current, layer)) {
        this.error = null;
        this.changed();
        return;
      }
      const document = Object.freeze({
        ...this.draft, layers: Object.freeze(this.draft.layers.map(candidate => candidate.id === id ? layer : candidate)),
      });
      this.validateDraft(document);
      this.rig.upsert(layer);
      this.draft = document;
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
      return;
    }
    this.error = null;
    this.changed();
  }

  deleteLayer(id: string): void {
    if (!this.canEdit()) return;
    if (!this.draft.layers.some((layer) => layer.id === id)) throw new Error(`Unknown sprite layer "${id}".`);
    const layers = this.draft.layers.filter((layer) => layer.id !== id);
    const used = new Set(layers.map((layer) => layer.image));
    const images = this.draft.images.filter((image) => used.has(image.id));
    const document = Object.freeze({ ...this.draft, images: Object.freeze(images), layers: Object.freeze(layers) });
    try {
      this.validateDraft(document);
      this.rig.remove(id);
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
      return;
    }
    this.error = null;
    this.draft = document;
    if (this.selectedLayerId === id) this.selectedLayerId = layers[0]?.id ?? null;
    this.changed();
  }

  async save(): Promise<void> {
    if (!this.canEdit()) return;
    await this.run(async () => {
      const document = validateSpriteDocument(this.draft);
      this.validateDraft(document);
      await this.store.write({ id: 'active', document });
      if (this.disposed) return;
      this.saved = document;
      this.draft = document;
    });
  }

  setCharacterRiggingType(value: unknown): boolean {
    if (!this.canEdit()) return false;
    try {
      const characterRiggingType = validateCharacterRiggingType(value, this.draft.layers.length);
      if (characterRiggingType === this.draft.characterRiggingType) {
        if (this.error !== null) {
          this.error = null;
          this.changed();
        }
        return true;
      }
      const document = Object.freeze({ ...this.draft, characterRiggingType });
      this.validateDraft(document);
      this.rig.setCharacterRiggingType(characterRiggingType);
      this.draft = document;
      this.preview = null;
      this.directionalPreview = false;
      this.error = null;
      this.changed();
      return true;
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
      return false;
    }
  }

  setSkeleton(value: SkeletonDefinition | null, options: { preview?: SkeletonPreview | null } = {}): void {
    if (!this.canEdit()) return;
    try {
      const skeleton = value === null ? null : validateSkeleton(value);
      const document = Object.freeze({ ...this.draft, skeleton });
      this.validateDraft(document);
      let preview = options.preview === undefined ? this.preview : options.preview;
      if (skeleton === null) {
        if (options.preview !== undefined && preview !== null) throw new SpriteError('A preview requires a skeleton.');
        preview = null;
      } else if (preview !== null) {
        const current = preview;
        const missingClip = current.clip !== null && !skeleton.clips.some(clip => clip.id === current.clip);
        const missingBone = current.pose.some(pose => !skeleton.bones.some(bone => bone.id === pose.bone));
        preview = options.preview === undefined && (missingClip || missingBone) ? null : validateSkeletonPreview(current, skeleton);
      }
      this.rig.configureSkeleton(skeleton, { preview });
      this.rig.setDirectionalPreview(null);
      this.preview = preview;
      this.directionalPreview = false;
      this.draft = document;
      this.error = null;
      this.changed();
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
    }
  }

  setPreview(value: SkeletonPreview | null): void {
    if (value === null) {
      this.leavePreview();
      return;
    }
    if (!this.canEdit()) return;
    try {
      const skeleton = this.draft.skeleton;
      if (skeleton === null) throw new SpriteError('Create a skeleton before previewing a pose.');
      const preview = validateSkeletonPreview(value, skeleton);
      this.rig.setPreview(preview);
      this.preview = preview;
      this.directionalPreview = false;
      this.error = null;
      this.changed();
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
    }
  }

  setPresentation(value: DirectionalPresentation | null): boolean {
    if (!this.canEdit()) return false;
    try {
      const presentation = value === null ? null : validateDirectionalPresentation(value);
      const document = Object.freeze({ ...this.draft, presentation });
      this.validateDraft(document);
      if (samePresentation(this.draft.presentation, presentation)) {
        if (this.error !== null) {
          this.error = null;
          this.changed();
        }
        return true;
      }
      this.rig.configurePresentation(presentation);
      this.draft = document;
      this.error = null;
      this.changed();
      return true;
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
      return false;
    }
  }

  setDirectionalPreview(value: { readonly aim: { readonly x: number; readonly y: number } } | null): boolean {
    if (this.disposed) return false;
    if (value === null) {
      this.rig.setDirectionalPreview(null);
      if (this.directionalPreview) {
        this.directionalPreview = false;
        this.changed();
      }
      return true;
    }
    if (!this.canEdit()) return false;
    try {
      if (![value.aim.x, value.aim.y].every(Number.isFinite) || value.aim.x === 0 && value.aim.y === 0) {
        throw new DirectionalError('Preview aim must be a finite, nonzero vector.');
      }
      const notify = !this.directionalPreview || this.preview !== null || this.error !== null;
      this.rig.setDirectionalPreview(value);
      this.preview = null;
      this.directionalPreview = true;
      this.error = null;
      // Aim movement is transient; subscribers only need preview-mode transitions.
      if (notify) this.changed();
      return true;
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
      return false;
    }
  }

  leavePreview(): void {
    if (this.disposed) return;
    const changed = this.preview !== null || this.directionalPreview;
    this.rig.setDirectionalPreview(null);
    if (this.preview !== null) this.rig.setPreview(null);
    this.preview = null;
    this.directionalPreview = false;
    if (changed) this.changed();
  }

  bindMesh(id: string, options: { columns: number; rows: number; bones: readonly string[] }): void {
    if (!this.canEdit()) return;
    try {
      const layer = this.draft.layers.find(candidate => candidate.id === id);
      if (!layer || !this.draft.skeleton) throw new SpriteError('Select a layer and create a skeleton before binding a mesh.');
      const { columns, rows } = options;
      if (![columns, rows].every(value => Number.isInteger(value) && value >= 1 && value <= SKELETON_LIMITS.grid)) {
        throw new SpriteError(`Mesh columns and rows must be whole numbers from 1 to ${SKELETON_LIMITS.grid}.`);
      }
      let xOffset = layer.offset.x, yOffset = layer.offset.y, rotation = layer.rotation;
      if (layer.bone !== null) {
        const bone = restPose(this.draft.skeleton).find(candidate => candidate.id === layer.bone);
        if (bone === undefined) throw new SpriteError('The attached bone is missing.');
        xOffset = bone.x + layer.offset.x * Math.cos(bone.angle) - layer.offset.y * Math.sin(bone.angle);
        yOffset = bone.y + layer.offset.x * Math.sin(bone.angle) + layer.offset.y * Math.cos(bone.angle);
        rotation = ((rotation + bone.angle * 180 / Math.PI) % 360 + 540) % 360 - 180;
      }
      const angle = rotation * Math.PI / 180;
      const positions = [];
      for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
        const x = (column / columns - 0.5) * layer.width;
        const y = (0.5 - row / rows) * layer.height;
        positions.push({
          x: xOffset + x * Math.cos(angle) - y * Math.sin(angle),
          y: yOffset + x * Math.sin(angle) + y * Math.cos(angle),
        });
      }
      const skin = { columns, rows, weights: autoWeights(this.draft.skeleton, positions, options.bones) };
      this.updateLayer(id, { skin, bone: null, tileLength: null, x: xOffset, y: yOffset, rotation });
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
    }
  }

  async revert(): Promise<void> {
    if (!this.canEdit()) return;
    const saved = this.saved;
    if (saved === null) {
      this.reportError('No saved sprite layout was successfully loaded. Save a valid layout before reverting.');
      return;
    }
    await this.run(async () => {
      await this.replaceRig(saved);
      if (this.disposed) return;
      this.draft = saved;
      if (this.selectedLayerId === null || !saved.layers.some((layer) => layer.id === this.selectedLayerId)) {
        this.selectedLayerId = saved.layers[0]?.id ?? null;
      }
    });
  }

  async newDocument(): Promise<void> {
    if (!this.canEdit()) return;
    await this.run(async () => {
      await this.replaceRig(EMPTY_SPRITES);
      if (this.disposed) return;
      this.draft = EMPTY_SPRITES;
      this.selectedLayerId = null;
    });
  }

  async importDocument(file: File): Promise<void> {
    if (!this.canEdit()) return;
    await this.run(async () => {
      if (file.size > SPRITE_LIMITS.documentBytes) {
        throw new SpriteError(`Sprite JSON must be at most ${Math.floor(SPRITE_LIMITS.documentBytes / 1024 ** 2)} MiB.`);
      }
      const text = await file.text();
      if (this.disposed) return;
      const document = parseSpriteDocument(text);
      validateSpriteAnchors(document, this.anchorIds, this.targetIds);
      await this.replaceRig(document);
      if (this.disposed) return;
      this.draft = document;
      this.selectedLayerId = document.layers[0]?.id ?? null;
      this.warnExternalSources(document);
    });
  }

  exportDocument(): string | null {
    if (!this.canEdit()) return null;
    try {
      const document = validateSpriteDocument(this.draft);
      this.validateDraft(document);
      return JSON.stringify(document);
    } catch (error) {
      if (!isDocumentError(error)) throw error;
      this.reportError(error.message);
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.leavePreview();
    this.disposed = true;
    this.lifecycle.abort(new DOMException('The sprite editor was disposed.', 'AbortError'));
    this.listeners.clear();
    this.store.close();
  }

  private validateRecord(value: unknown): SpriteDocument {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 2 || Reflect.get(value, 'id') !== 'active') {
      throw new SpriteError('The saved sprite record is malformed.');
    }
    return validateSpriteDocument(Reflect.get(value, 'document'));
  }

  private warnExternalSources(document: SpriteDocument): void {
    if (document.images.some((image) => !isEmbedded(image.source))) {
      this.notice(
        'This sprite document references external image URL(s). Export preserves those public references. ' +
        'Never use links containing credentials or private/internal addresses.', 'info',
      );
    }
  }

  private async replaceRig(document: SpriteDocument): Promise<void> {
    this.validateDraft(document);
    this.leavePreview();
    await this.rig.replace(document, { signal: this.lifecycle.signal });
    this.preview = null;
    this.directionalPreview = false;
  }

  private validateDraft(document: SpriteDocument): void {
    validateSpriteRigging(document.layers, document.skeleton);
    validateSpriteAnchors(document, this.anchorIds, this.targetIds);
    validateSpriteBudget(document);
  }

  private canEdit(): boolean {
    if (this.disposed) return false;
    if (this.restoring || this.busy) {
      this.notice('Wait for the current sprite operation to finish before editing.', 'error');
      return false;
    }
    return true;
  }

  private reportError(message: string): void {
    const repeated = this.error === message;
    this.error = message;
    if (!this.disposed) {
      if (!repeated) this.notice(message, 'error');
      this.changed();
    }
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      await operation();
    } catch (error) {
      if (this.disposed && isAbort(error)) return;
      if (!(isDocumentError(error) || error instanceof VisualStoreError)) throw error;
      if (!this.disposed) this.reportError(error.message);
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private changed(): void {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
}
