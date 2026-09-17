import type { SpriteRig } from '../sprite-rig';
import {
  EMPTY_SPRITES, parseSpriteDocument, SPRITE_LIMITS, SpriteError, validateSpriteAnchors, validateSpriteDocument,
  validateSpriteLayer, encodePng, inspectPng,
} from '../sprite-data';
import type { SpriteDocument, SpriteLayer, SpriteOffset } from '../sprite-data';
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
}

export interface SpriteEditorSnapshot {
  readonly restoring: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly dirty: boolean;
  readonly anchors: readonly SpriteAnchorInput[];
  readonly document: SpriteDocument;
  readonly saved: SpriteDocument | null;
  readonly selectedLayerId: string | null;
  readonly externalSources: boolean;
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
    left.offset.x === right.offset.x && left.offset.y === right.offset.y && left.offset.z === right.offset.z;
}

function sameDocument(left: SpriteDocument, right: SpriteDocument): boolean {
  if (left === right) return true;
  if (left.layers.length !== right.layers.length || left.images.length !== right.images.length) return false;
  return left.layers.every((layer, index) => sameLayer(layer, right.layers[index])) &&
    (left.images === right.images || left.images.every((image, index) => {
      const other = right.images[index];
      return image === other || image.id === other.id && image.name === other.name && image.source === other.source;
    }));
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
  private readonly notice: (message: string, kind: 'info' | 'error') => void;
  private readonly store = new VisualStore<StoredSprites>({
    database: 'over-the-edge:sprites', store: 'documents', keyPath: 'id',
  });
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle = new AbortController();
  private draft: SpriteDocument = EMPTY_SPRITES;
  private saved: SpriteDocument | null = null;
  private selectedLayerId: string | null = null;
  private restoring = true;
  private busy = false;
  private error: string | null = null;
  private disposed = false;

  constructor(options: {
    rig: SpriteRig;
    anchors: readonly SpriteAnchorInput[];
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
        validateSpriteAnchors(document, this.anchorIds);
      } catch (error) {
        if (!(error instanceof SpriteError)) throw error;
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
      if (!(error instanceof SpriteError || error instanceof VisualStoreError)) throw error;
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
      anchors: this.anchors,
      document: this.draft,
      saved: this.saved,
      selectedLayerId: this.selectedLayerId,
      externalSources: this.draft.images.some((image) => !isEmbedded(image.source)),
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
        id: nextId('layer', new Set(this.draft.layers.map((candidate) => candidate.id))),
        name: image.name, anchor: anchor.id, image: image.id,
        width: fit.width, height: fit.height, offset: { ...anchor.offset }, rotation: 0, underlay: 'replace',
      });
      const document = validateSpriteDocument({ schemaVersion: 1, images, layers: [...this.draft.layers, layer] });
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
    let layer: SpriteLayer;
    try {
      layer = validateSpriteLayer({
        id: current.id, image: current.image,
        name: edit.name ?? current.name,
        anchor: edit.anchor ?? current.anchor,
        width: edit.width ?? current.width,
        height: edit.height ?? current.height,
        offset: { x: edit.x ?? current.offset.x, y: edit.y ?? current.offset.y, z: edit.z ?? current.offset.z },
        rotation: edit.rotation ?? current.rotation,
        underlay: edit.underlay ?? current.underlay,
      });
      if (sameLayer(current, layer)) {
        this.error = null;
        this.changed();
        return;
      }
      this.rig.upsert(layer);
    } catch (error) {
      if (!(error instanceof SpriteError)) throw error;
      this.reportError(error.message);
      return;
    }
    this.error = null;
    const layers = Object.freeze(this.draft.layers.map((candidate) => candidate.id === id ? layer : candidate));
    this.draft = Object.freeze({ ...this.draft, layers });
    this.changed();
  }

  deleteLayer(id: string): void {
    if (!this.canEdit()) return;
    if (!this.draft.layers.some((layer) => layer.id === id)) throw new Error(`Unknown sprite layer "${id}".`);
    try {
      this.rig.remove(id);
    } catch (error) {
      if (!(error instanceof SpriteError)) throw error;
      this.reportError(error.message);
      return;
    }
    const layers = this.draft.layers.filter((layer) => layer.id !== id);
    const used = new Set(layers.map((layer) => layer.image));
    const images = this.draft.images.filter((image) => used.has(image.id));
    this.error = null;
    this.draft = Object.freeze({ schemaVersion: 1, images: Object.freeze(images), layers: Object.freeze(layers) });
    if (this.selectedLayerId === id) this.selectedLayerId = layers[0]?.id ?? null;
    this.changed();
  }

  async save(): Promise<void> {
    if (!this.canEdit()) return;
    await this.run(async () => {
      const document = validateSpriteDocument(this.draft);
      await this.store.write({ id: 'active', document });
      if (this.disposed) return;
      this.saved = document;
      this.draft = document;
    });
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
      validateSpriteAnchors(document, this.anchorIds);
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
      return JSON.stringify(validateSpriteDocument(this.draft));
    } catch (error) {
      if (!(error instanceof SpriteError)) throw error;
      this.reportError(error.message);
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
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
    await this.rig.replace(document, { signal: this.lifecycle.signal });
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
    this.error = message;
    if (!this.disposed) {
      this.notice(message, 'error');
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
      if (!(error instanceof SpriteError || error instanceof VisualStoreError)) throw error;
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
