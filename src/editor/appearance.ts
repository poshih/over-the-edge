import type { AppearanceRig } from '../appearance-rig';
import type { VisualAlignment } from '../appearance-profile';
import type { VisualPartId } from '../character';
import { Disposal } from '../disposal';
import { ModelError as AppearanceError } from '../model-data';
import { ProjectError } from '../project';
import { createAppearanceCommands } from './appearance-commands';
import { createAppearanceImports } from './appearance-imports';
import type { AppearanceImports, AppearancePartInput } from './appearance-imports';
import { DEFAULT_ALIGNMENT, VISUAL_PARTS } from './appearance-types';
import type { FileHandle, FileStore } from './document/files';
import type { History } from './document/history';
import type { ImportRunner } from './document/import-runner';
import type { ProjectCommandInfo } from './document/project-commands';
import type { DocumentAppearance, DocumentAppearancePart, DocumentArmIk } from './document/project-document';
import type { EditOutcome, FileInput, ImportOptions } from './document/project-imports';
import type { AppearanceCommands, ProjectionState, VisualProjectionEvent } from './document/visual-contract';
import { ProjectApiError } from './project-client';
import { loadVisualModel } from './visual-model';
import type { LoadedVisual } from './visual-model';
import type { VisualSaves } from './visual-saves';

export interface AppearanceOptions {
  readonly history: History;
  readonly files: FileStore;
  readonly rig: AppearanceRig;
  readonly runner: ImportRunner;
  readonly saves: VisualSaves;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
  readonly onFault: (error: unknown) => void;
}

type PartValue = DocumentAppearancePart | null;

type PartSaveState =
  | { readonly kind: 'saving'; readonly value: PartValue }
  | { readonly kind: 'failed'; readonly value: PartValue; readonly error: AppearanceError };

interface PartProjection {
  desired: PartValue;
  token: object;
  file: FileHandle | null;
  alignment: Readonly<VisualAlignment> | null;
  rendering: ProjectionState<PartValue, AppearanceError>;
}

interface PartWork {
  readonly part: VisualPartId;
  readonly file: FileHandle;
  readonly token: object;
  readonly controller: AbortController;
}

const STATUS: VisualProjectionEvent = Object.freeze({ cause: null, step: null });

function refusal(error: unknown): AppearanceError {
  if (error instanceof AppearanceError) return error;
  if (!(error instanceof ProjectError || error instanceof ProjectApiError || error instanceof DOMException)) throw error;
  return new AppearanceError(error.message, { cause: error });
}

// Part models follow the document. The only backlog is its latest entry for each part.
export class Appearance {
  readonly commands: AppearanceCommands;
  readonly imports: AppearanceImports;
  private readonly options: AppearanceOptions;
  private readonly projections = new Map<VisualPartId, PartProjection>();
  private readonly partSaves = new Map<VisualPartId, PartSaveState>();
  private readonly listeners = new Set<(event: VisualProjectionEvent) => void>();
  private readonly lifecycle = new AbortController();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeFiles: () => void;
  private loading: PartWork | null = null;
  private active = false;
  private disposed = false;

  constructor(options: AppearanceOptions) {
    this.options = options;
    options.rig.assertComplete();
    this.commands = createAppearanceCommands({ document: options.history.document, files: options.files });
    this.imports = createAppearanceImports({
      history: options.history, commands: this.commands, runner: options.runner,
      onPartAccepted: (part, value) => this.saveAccepted([{ part, value }]),
      onPartsAccepted: (value) => {
        const parts = new Map(value.map((entry) => [entry.part, entry]));
        this.saveAccepted(VISUAL_PARTS.map(({ id }) => ({ part: id, value: parts.get(id) ?? null })));
      },
    });
    const entries = new Map(this.definition().map((entry) => [entry.part, entry]));
    for (const { id } of VISUAL_PARTS) {
      const desired = entries.get(id) ?? null;
      this.projections.set(id, {
        desired, token: {}, file: null, alignment: null,
        rendering: desired === null ? Object.freeze({ kind: 'ready', value: null })
          : Object.freeze({ kind: 'loading', value: desired }),
      });
    }
    this.unsubscribe = options.history.document.subscribeAll((changes, cause, step) => {
      const appearance = changes.find((change) => change.section === 'appearance');
      if (appearance !== undefined && appearance.section === 'appearance') this.follow(appearance.after, { cause, step });
      else if (changes.some((change) => change.section === 'arm-ik')) this.changed({ cause, step });
    });
    this.unsubscribeFiles = options.files.subscribe((event) => this.filesChanged(event.files));
  }

  get browserAppearance(): boolean {
    return this.options.saves.browserAppearance;
  }

  definition(): DocumentAppearance {
    return this.options.history.document.get('appearance');
  }

  armIkSettings(): DocumentArmIk {
    return this.options.history.document.get('arm-ik');
  }

  renderingState(part: VisualPartId): ProjectionState<PartValue, AppearanceError> {
    return this.projection(part).rendering;
  }

  importPart(part: VisualPartId, input: FileInput, options: ImportOptions): Promise<EditOutcome<DocumentAppearancePart>> {
    return this.imports.part(part, input, options);
  }

  useDefault(part: VisualPartId, info: ProjectCommandInfo): AppearanceError | null {
    if (this.disposed) return new AppearanceError('The appearance editor is closed.');
    const expected = this.definition().find((entry) => entry.part === part) ?? null;
    const error = this.options.history.apply(this.commands.replacePart(part, expected, null, info));
    if (error !== null) {
      if (!(error instanceof AppearanceError)) throw error;
      return error;
    }
    if (expected !== null) this.saveAccepted([{ part, value: null }]);
    return null;
  }

  replaceParts(value: readonly AppearancePartInput[], options: ImportOptions): Promise<EditOutcome<DocumentAppearance>> {
    return this.imports.parts(value, options);
  }

  activate(): void {
    if (this.disposed || this.active) return;
    this.active = true;
    this.follow(this.definition(), STATUS);
  }

  snapshot() {
    const appearance = new Map(this.definition().map((entry) => [entry.part, entry]));
    const settings = this.armIkSettings();
    return Object.freeze({
      armIk: Object.freeze({ settings, dirty: settings !== this.options.saves.armIkFingerprint() }),
      parts: Object.freeze(VISUAL_PARTS.map((part) => {
        const value = appearance.get(part.id) ?? null;
        const saved = this.options.saves.partFingerprint(part.id);
        const saving = this.partSaves.get(part.id);
        return Object.freeze({
          ...part, value, name: value?.name ?? null, alignment: value?.alignment ?? DEFAULT_ALIGNMENT,
          custom: value !== null, dirty: value !== saved, saving: saving?.kind === 'saving',
          saveError: saving?.kind === 'failed' && saving.value === value && value !== saved ? saving.error : null,
          rendering: this.projection(part.id).rendering,
          rig: this.options.rig.inspect(part.id),
        });
      })),
    });
  }

  subscribe(listener: (event: VisualProjectionEvent) => void): () => void {
    if (this.disposed) throw new Error('The appearance projection is closed.');
    this.listeners.add(listener);
    listener(STATUS);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    disposal.run(this.unsubscribe);
    disposal.run(this.unsubscribeFiles);
    disposal.run(() => this.lifecycle.abort());
    disposal.run(() => this.imports.dispose());
    disposal.run(() => this.loading?.controller.abort());
    this.listeners.clear();
    for (const [part, projection] of this.projections) {
      if (projection.file !== null) disposal.run(() => this.options.rig.reset(part));
    }
    this.projections.clear();
    this.partSaves.clear();
    disposal.finish();
  }

  private projection(part: VisualPartId): PartProjection {
    const projection = this.projections.get(part);
    if (projection === undefined) throw new Error(`Missing appearance projection for ${part}.`);
    return projection;
  }

  private saveAccepted(values: readonly { readonly part: VisualPartId; readonly value: PartValue }[]): void {
    if (this.disposed || !this.browserAppearance) return;
    for (const { part, value } of values) {
      const saving: PartSaveState = Object.freeze({ kind: 'saving', value });
      this.partSaves.set(part, saving);
      // An accepted edit outlives its caller; only the appearance's disposal cancels its automatic save.
      void this.options.saves.savePart(part, value, this.lifecycle.signal).then((result) => {
        if (this.disposed) return;
        if (result.kind === 'refused') {
          const error = new AppearanceError(`The ${part} edit was accepted, but its browser save failed: ${result.error.message}`, { cause: result.error });
          if (this.partSaves.get(part) === saving) this.partSaves.set(part, Object.freeze({ kind: 'failed', value, error }));
          this.options.onNotice(error.message, 'error');
        } else if (this.partSaves.get(part) === saving) {
          this.partSaves.delete(part);
        }
        this.changed(STATUS);
      }).catch((error: unknown) => {
        const disposal = new Disposal();
        disposal.run(() => this.options.onFault(error));
        if (!this.disposed && this.partSaves.get(part) === saving) {
          this.partSaves.delete(part);
          disposal.run(() => this.changed(STATUS));
        }
        disposal.finish();
      });
    }
    this.changed(STATUS);
  }

  private follow(value: DocumentAppearance, event: VisualProjectionEvent): void {
    const entries = new Map(value.map((entry) => [entry.part, entry]));
    for (const { id } of VISUAL_PARTS) {
      const projection = this.projection(id);
      const desired = entries.get(id) ?? null;
      if (projection.desired === desired) continue;
      const changedFile = projection.desired?.file !== desired?.file;
      if (changedFile) {
        projection.token = {};
        if (this.loading?.part === id) this.loading.controller.abort();
      }
      projection.desired = desired;
      if (desired === null) {
        if (this.active) this.options.rig.reset(id);
        projection.file = null;
        projection.alignment = null;
        projection.rendering = Object.freeze({ kind: 'ready', value: null });
      } else if (this.active && projection.file === desired.file) {
        try {
          if (projection.alignment !== desired.alignment) this.options.rig.align(id, desired.alignment);
          projection.alignment = desired.alignment;
          projection.rendering = Object.freeze({ kind: 'ready', value: desired });
        } catch (error) {
          const failure = refusal(error);
          projection.rendering = Object.freeze({ kind: 'failed', value: desired, error: failure });
          this.options.onNotice(failure.message, 'error');
        }
      } else if (!changedFile && projection.rendering.kind === 'failed') {
        projection.rendering = Object.freeze({ ...projection.rendering, value: desired });
      } else {
        projection.rendering = Object.freeze({ kind: 'loading', value: desired });
      }
    }
    this.pump();
    this.changed(event);
  }

  private wanted(work: PartWork): boolean {
    if (this.disposed || !this.active || work.controller.signal.aborted) return false;
    const projection = this.projection(work.part);
    return projection.token === work.token && projection.desired?.file === work.file &&
      this.definition().find((entry) => entry.part === work.part)?.file === work.file;
  }

  private filesChanged(files: readonly FileHandle[]): void {
    if (this.disposed || !this.active) return;
    const moved = new Set(files);
    let changed = false;
    for (const projection of this.projections.values()) {
      const desired = projection.desired;
      if (projection.rendering.kind !== 'failed' || desired === null || projection.file === desired.file || !moved.has(desired.file)) continue;
      const locations = this.options.files.locations(desired.file);
      if (locations.page === null && locations.servers.length === 0 && locations.published.length === 0) continue;
      projection.token = {};
      projection.rendering = Object.freeze({ kind: 'loading', value: desired });
      changed = true;
    }
    if (!changed) return;
    this.pump();
    this.changed(STATUS);
  }

  private pump(): void {
    if (this.disposed || !this.active || this.loading !== null) return;
    for (const { id } of VISUAL_PARTS) {
      const projection = this.projection(id);
      if (projection.rendering.kind !== 'loading' || projection.desired === null) continue;
      const work: PartWork = {
        part: id, file: projection.desired.file, token: projection.token, controller: new AbortController(),
      };
      this.loading = work;
      void this.load(work).catch((error: unknown) => this.options.onFault(error));
      return;
    }
  }

  private async load(work: PartWork): Promise<void> {
    let model: LoadedVisual | null = null;
    let release: (() => void) | null = null;
    let failure: { readonly error: unknown } | null = null;
    let changed = false;
    try {
      release = this.options.files.retain([work.file], 'work');
      const blob = await this.options.files.blob(work.file, work.controller.signal);
      if (!this.wanted(work)) return;
      // Native parsing cannot abort. Keep the single slot until it settles, then discard obsolete results.
      model = await loadVisualModel(blob);
      if (!this.wanted(work)) return;
      const desired = this.definition().find((entry) => entry.part === work.part)!;
      this.options.rig.setModel(work.part, model, desired.alignment);
      model = null;
      const projection = this.projection(work.part);
      projection.file = desired.file;
      projection.alignment = desired.alignment;
      projection.rendering = Object.freeze({ kind: 'ready', value: desired });
      changed = true;
    } catch (error) {
      try {
        const refused = refusal(error);
        if (this.wanted(work)) {
          const projection = this.projection(work.part);
          projection.rendering = Object.freeze({ kind: 'failed', value: projection.desired, error: refused });
          changed = true;
          this.options.onNotice(refused.message, 'error');
        }
      } catch (error) {
        failure = { error };
      }
    } finally {
      const disposal = new Disposal();
      const failed = failure;
      if (failed !== null) disposal.run(() => { throw failed.error; });
      if (model !== null) {
        const obsolete = model;
        disposal.run(() => obsolete.dispose());
      }
      if (release !== null) disposal.run(release);
      this.loading = null;
      if (changed) disposal.run(() => this.changed(STATUS));
      if (failure === null) disposal.run(() => this.pump());
      disposal.finish();
    }
  }

  private changed(event: VisualProjectionEvent): void {
    if (this.disposed) return;
    const disposal = new Disposal();
    const change = Object.freeze(event);
    for (const listener of this.listeners) disposal.run(() => listener(change));
    disposal.finish();
  }
}
