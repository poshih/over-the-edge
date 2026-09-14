import { AppearanceRig } from './appearance-rig';
import { AppearanceStore } from './appearance-store';
import {
  ALIGNMENT_FIELDS, AppearanceError, DEFAULT_ALIGNMENT, isVisualPart, MODEL_LIMITS,
  validateAlignment, validateStoredVisual, VISUAL_PARTS,
} from './appearance-types';
import type { StoredVisual, VisualAlignment, VisualPartId } from './appearance-types';
import { loadVisualModel } from './visual-model';

export class Appearance {
  private readonly rig: AppearanceRig;
  private readonly store = new AppearanceStore();
  private readonly notice: (message: string, kind: 'info' | 'error') => void;
  private readonly records = new Map<VisualPartId, StoredVisual>();
  private readonly drafts = new Map<VisualPartId, VisualAlignment>();
  private readonly errors = new Map<VisualPartId, string>();
  private readonly busy = new Set<VisualPartId>();
  private readonly listeners = new Set<() => void>();
  private restoring = true;
  private storageIssue: string | null = null;
  private disposed = false;

  constructor(rig: AppearanceRig, notice: (message: string, kind: 'info' | 'error') => void) {
    this.rig = rig;
    this.notice = notice;
    rig.assertComplete();
  }

  async restore(): Promise<void> {
    try {
      const entries = await this.store.entries();
      for (const entry of entries) {
        if (this.disposed) return;
        if (!isVisualPart(entry.key)) {
          this.storageIssue = 'Saved visuals contain an unknown part. That record has been preserved.';
          this.notice(this.storageIssue, 'error');
          continue;
        }
        const slot = entry.key;
        await this.run(slot, async () => {
          const record = validateStoredVisual(entry.value, slot);
          const model = await loadVisualModel(record.data);
          if (this.disposed) { model.dispose(); return; }
          this.rig.setModel(slot, model, record.alignment);
          this.records.set(slot, record);
          this.drafts.set(slot, { ...record.alignment });
        });
      }
    } catch (error) {
      if (!(error instanceof AppearanceError)) throw error;
      if (!this.disposed) {
        this.storageIssue = error.message;
        this.notice(error.message, 'error');
      }
    } finally {
      this.restoring = false;
      this.changed();
    }
  }

  async importFile(slot: VisualPartId, file: File): Promise<void> {
    if (!this.canEdit(slot)) return;
    await this.run(slot, async () => {
      if (!file.name.toLowerCase().endsWith('.glb') || file.name.length > 255) {
        throw new AppearanceError('Choose one binary glTF (.glb) file for this part.');
      }
      if (file.size === 0 || file.size > MODEL_LIMITS.bytes) {
        throw new AppearanceError('Choose a GLB file no larger than 20 MiB.');
      }
      const model = await loadVisualModel(file);
      let adopted = false;
      try {
        if (this.disposed) return;
        const record: StoredVisual = {
          schemaVersion: 1, slot, name: file.name, data: file, alignment: { ...DEFAULT_ALIGNMENT },
        };
        await this.store.write(record);
        if (this.disposed) return;
        this.rig.setModel(slot, model, record.alignment);
        adopted = true;
        this.records.set(slot, record);
        this.drafts.set(slot, { ...record.alignment });
      } finally {
        if (!adopted) model.dispose();
      }
    });
  }

  preview(slot: VisualPartId, value: unknown): void {
    if (!this.canEdit(slot)) return;
    if (!this.records.has(slot)) throw new Error(`Cannot preview alignment without a model for ${slot}.`);
    const alignment = validateAlignment(value);
    this.rig.align(slot, alignment);
    this.drafts.set(slot, alignment);
    this.errors.delete(slot);
    this.changed();
  }

  resetAlignment(slot: VisualPartId): void {
    this.preview(slot, DEFAULT_ALIGNMENT);
  }

  async saveAlignment(slot: VisualPartId): Promise<void> {
    if (!this.canEdit(slot)) return;
    const record = this.records.get(slot);
    const draft = this.drafts.get(slot);
    if (!record || !draft) throw new Error(`Cannot save alignment without a model for ${slot}.`);
    await this.run(slot, async () => {
      const next = { ...record, alignment: { ...draft } };
      await this.store.write(next);
      if (this.disposed) return;
      this.records.set(slot, next);
    });
  }

  async useDefault(slot: VisualPartId): Promise<void> {
    if (!this.canEdit(slot)) return;
    await this.run(slot, async () => {
      await this.store.remove(slot);
      if (this.disposed) return;
      this.rig.reset(slot);
      this.records.delete(slot);
      this.drafts.delete(slot);
    });
  }

  snapshot() {
    return {
      restoring: this.restoring,
      error: this.storageIssue,
      parts: VISUAL_PARTS.map((part) => {
        const record = this.records.get(part.id);
        const draft = this.drafts.get(part.id);
        const alignment = draft ? { ...draft } : { ...DEFAULT_ALIGNMENT };
        return {
          ...part,
          ...this.rig.inspect(part.id),
          name: record ? record.name : null,
          alignment,
          busy: this.restoring || this.busy.has(part.id),
          error: this.errors.get(part.id) ?? null,
          dirty: record !== undefined && ALIGNMENT_FIELDS.some((field) =>
            alignment[field.key] !== record.alignment[field.key]),
        };
      }),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.store.close();
    this.records.clear();
    this.drafts.clear();
  }

  private canEdit(slot: VisualPartId): boolean {
    if (this.disposed) return false;
    if (this.restoring || this.busy.has(slot)) {
      this.notice('Wait for this model operation to finish before editing the part.', 'error');
      return false;
    }
    return true;
  }

  private async run(slot: VisualPartId, operation: () => Promise<void>): Promise<void> {
    this.busy.add(slot);
    this.errors.delete(slot);
    this.changed();
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof AppearanceError)) throw error;
      if (!this.disposed) {
        this.errors.set(slot, error.message);
        this.notice(error.message, 'error');
      }
    } finally {
      this.busy.delete(slot);
      this.changed();
    }
  }

  private changed(): void {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }

}
