import { ARM_IK_FIELDS, isVisualPartId } from '../appearance-profile';
import { VISUAL_PART_IDS } from '../character';
import type { VisualPartId } from '../character';
import { Disposal } from '../disposal';
import { ModelError as AppearanceError } from '../model-data';
import { checkFileBudget, isProjectDataError, validateProjectCharacter } from '../project';
import type { SpriteDocument } from '../sprite-data';
import { SpriteError } from '../sprite-fields';
import { validateSavedAppearancePart } from './appearance-types';
import type { SavedAppearancePart } from './appearance-types';
import { armIkProfiles, readActiveArmIk, readArmIkProfile, selectArmIkProfile } from './arm-ik-store';
import type { ArmIkProfile } from './arm-ik-store';
import type { FileStore } from './document/files';
import type {
  DocumentAppearancePart, DocumentArmIk, VisualSectionValues,
} from './document/project-document';
import { appearanceValue, armIkValue, NO_APPEARANCE } from './document/visual-values';
import { SnapshotError } from './named-snapshots';
import type { SnapshotEntry } from './named-snapshots';
import { ProjectApiError } from './project-client';
import { VisualStore, VisualStoreError } from './visual-store';

export type VisualSaveRefusal = SpriteError | AppearanceError;

export type SaveResult<T> =
  | { readonly kind: 'stored'; readonly value: T }
  | { readonly kind: 'refused'; readonly error: VisualSaveRefusal };

export type SaveRead<T> =
  | { readonly kind: 'read'; readonly value: T; release(): void }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly error: VisualSaveRefusal };

export type ArmIkSaveResult =
  | { readonly kind: 'stored'; readonly entry: SnapshotEntry; readonly selection: 'selected' }
  | {
      readonly kind: 'stored';
      readonly entry: SnapshotEntry;
      readonly selection: 'not-selected';
      readonly error: AppearanceError;
    }
  | { readonly kind: 'refused'; readonly error: AppearanceError };

export interface VisualSaves {
  readonly browserAppearance: boolean;
  characterFingerprint(): SpriteDocument | null;
  partFingerprint(part: VisualPartId): DocumentAppearancePart | null | undefined;
  armIkFingerprint(): DocumentArmIk | null;
  readStartup(signal: AbortSignal): Promise<SaveRead<Partial<VisualSectionValues>>>;
  saveCharacter(value: SpriteDocument, signal: AbortSignal): Promise<SaveResult<SpriteDocument>>;
  savePart(part: VisualPartId, value: DocumentAppearancePart | null,
    signal: AbortSignal): Promise<SaveResult<DocumentAppearancePart | null>>;
  saveArmIk(name: string, value: DocumentArmIk): ArmIkSaveResult;
  readArmIk(key: string): SaveRead<ArmIkProfile>;
  selectArmIk(key: string): AppearanceError | null;
  loadedArmIk(profile: ArmIkProfile, value: DocumentArmIk): void;
  dispose(): void;
}

interface SavedCharacter {
  readonly id: 'active';
  readonly document: SpriteDocument;
}

function known(error: unknown): error is Error {
  return error instanceof VisualStoreError || error instanceof SnapshotError || error instanceof DOMException ||
    error instanceof ProjectApiError || isProjectDataError(error);
}

function characterRefusal(error: unknown): SpriteError {
  if (error instanceof SpriteError) return error;
  if (!known(error)) throw error;
  return new SpriteError(error.message, { cause: error });
}

function appearanceRefusal(error: unknown): AppearanceError {
  if (error instanceof AppearanceError) return error;
  if (!known(error)) throw error;
  return new AppearanceError(error.message, { cause: error });
}

function stored<T>(value: T): SaveResult<T> {
  return Object.freeze({ kind: 'stored', value });
}

const ABSENT = Object.freeze({ kind: 'absent' } as const);

export function createVisualSaves(options: {
  readonly files: FileStore;
  // Projects keep appearance in their own copy; only standalone startup reads these independent saves.
  readonly browserAppearance: boolean;
}): VisualSaves {
  const { files, browserAppearance } = options;
  const characterStore = new VisualStore<SavedCharacter>({
    database: 'over-the-edge:sprites', store: 'documents', keyPath: 'id',
  });
  const partStore = new VisualStore<SavedAppearancePart>({
    database: 'over-the-edge:appearance:document:v1', store: 'parts', keyPath: 'part',
  });
  const lifecycle = new AbortController();
  const work = new Set<() => void>();
  const writes = new Map<string, Promise<unknown>>();
  const epochs = new Map<string, number>();
  const parts = new Map<VisualPartId, DocumentAppearancePart | null>();
  let character: SpriteDocument | null = null;
  let armIk: DocumentArmIk | null = null;
  let disposed = false;

  function live(): void {
    if (disposed) throw new DOMException('Visual saves have been closed.', 'AbortError');
  }

  function signal(owner: AbortSignal): AbortSignal {
    live();
    const reading = AbortSignal.any([owner, lifecycle.signal]);
    reading.throwIfAborted();
    return reading;
  }

  function own(release: () => void): () => void {
    let released = false;
    const done = (): void => {
      if (released) return;
      released = true;
      work.delete(done);
      release();
    };
    if (disposed) done();
    else work.add(done);
    return done;
  }

  function advance(key: string): void {
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
  }

  // Each caller still receives its own failure; a failed write also frees the next write's place.
  function write<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = writes.get(key);
    const task = previous === undefined ? run() : previous.then(run, run);
    writes.set(key, task);
    const finished = (): void => { if (writes.get(key) === task) writes.delete(key); };
    void task.then(finished, finished);
    return task;
  }

  async function readCharacter(reading: AbortSignal, epoch: number): Promise<SpriteDocument | null> {
    try {
      const entries = await characterStore.entries();
      reading.throwIfAborted();
      if (entries.length > 1 || entries.some(({ key }) => key !== 'active')) {
        throw new SpriteError('Saved character storage contains unknown records.');
      }
      const record = entries[0]?.value;
      let value: SpriteDocument | null = null;
      if (entries.length !== 0) {
        if (typeof record !== 'object' || record === null || Array.isArray(record) || Object.keys(record).length !== 2 ||
          Reflect.get(record, 'id') !== 'active' || !Object.hasOwn(record, 'document')) {
          throw new SpriteError('The saved character record is malformed.');
        }
        value = validateProjectCharacter(Reflect.get(record, 'document'));
      }
      if ((epochs.get('character') ?? 0) === epoch) character = value;
      return value;
    } catch (error) {
      throw characterRefusal(error);
    }
  }

  const saves: VisualSaves = {
    browserAppearance,
    characterFingerprint: () => character,
    partFingerprint: (part) => parts.get(part),
    armIkFingerprint: () => armIk,
    async readStartup(owner) {
      const releases: (() => void)[] = [];
      const release = (): void => {
        const disposal = new Disposal();
        for (const done of releases.splice(0)) disposal.run(done);
        disposal.finish();
      };
      try {
        const reading = signal(owner);
        const before = new Map(epochs);
        const [characterRead, partRead] = await Promise.allSettled([
          readCharacter(reading, before.get('character') ?? 0),
          browserAppearance ? partStore.entries().catch((error: unknown) => { throw appearanceRefusal(error); }) : Promise.resolve([]),
        ]);
        if (characterRead.status === 'rejected') throw characterRead.reason;
        if (partRead.status === 'rejected') throw partRead.reason;
        reading.throwIfAborted();
        const savedCharacter = characterRead.value;
        const records = partRead.value;
        const values: Partial<VisualSectionValues> = savedCharacter === null ? {} : { 'characters/primary': savedCharacter };
        if (browserAppearance) {
          const savedParts = records.map(({ key, value }) => {
            if (!isVisualPartId(key)) throw new AppearanceError('Saved appearance contains an unknown part.');
            return validateSavedAppearancePart(value, key);
          });
          checkFileBudget('appearance', savedParts.reduce((sum, entry) => sum + entry.file.bytes, 0));
          const entries: DocumentAppearancePart[] = [];
          for (const { part, name, alignment, file } of savedParts) {
            const staged = await files.stagePage(file.blob, reading);
            releases.push(own(staged.release));
            reading.throwIfAborted();
            if (staged.handle.bytes !== file.bytes || files.locations(staged.handle).sha256 !== file.sha256) {
              throw new AppearanceError(`The saved ${part} model does not match its recorded bytes and digest.`);
            }
            entries.push(Object.freeze({ part, name, alignment, file: staged.handle }));
          }
          const appearance = appearanceValue(Object.freeze(entries), NO_APPEARANCE, files);
          const profile = readActiveArmIk(localStorage);
          reading.throwIfAborted();
          for (const part of VISUAL_PART_IDS) {
            if ((epochs.get(part) ?? 0) === (before.get(part) ?? 0)) {
              parts.set(part, appearance.find((entry) => entry.part === part) ?? null);
            }
          }
          if ((epochs.get('arm-ik') ?? 0) === (before.get('arm-ik') ?? 0)) armIk = profile?.settings ?? null;
          Object.assign(values, { appearance }, profile === null ? {} : { 'arm-ik': profile.settings });
          if (savedCharacter === null && savedParts.length === 0 && profile === null) {
            release();
            return ABSENT;
          }
        } else if (savedCharacter === null) {
          return ABSENT;
        }
        return Object.freeze({ kind: 'read', value: Object.freeze(values), release });
      } catch (error) {
        const disposal = new Disposal();
        disposal.run(release);
        disposal.finish();
        return Object.freeze({
          kind: 'refused', error: error instanceof SpriteError ? error : appearanceRefusal(error),
        });
      }
    },
    saveCharacter(value, owner) {
      return write('character', async () => {
        try {
          const writing = signal(owner);
          validateProjectCharacter(value);
          writing.throwIfAborted();
          await characterStore.write({ id: 'active', document: value });
          if (!disposed) { character = value; advance('character'); }
          return stored(value);
        } catch (error) {
          return Object.freeze({ kind: 'refused', error: characterRefusal(error) });
        }
      });
    },
    savePart(part, value, owner) {
      let release: () => void;
      try {
        live();
        owner.throwIfAborted();
        if (!browserAppearance) throw new AppearanceError('The project keeps appearance models and alignment; save them in Project.');
        if (!isVisualPartId(part) || (value !== null && value.part !== part)) {
          throw new AppearanceError('The appearance save must name its document part.');
        }
        if (!writes.has(part) && value === saves.partFingerprint(part)) return Promise.resolve(stored(value));
        if (value !== null) appearanceValue([value], NO_APPEARANCE, files);
        release = own(files.retain(value === null ? [] : [value.file], 'work'));
      } catch (error) {
        return Promise.resolve(Object.freeze({ kind: 'refused', error: appearanceRefusal(error) }));
      }
      return write(part, async () => {
        try {
          const writing = signal(owner);
          // An earlier queued write may replace today's fingerprint before this save's turn.
          if (value === saves.partFingerprint(part)) return stored(value);
          if (value === null) {
            await partStore.remove(part);
          } else {
            const blob = await files.blob(value.file, writing);
            writing.throwIfAborted();
            const sha256 = files.locations(value.file).sha256;
            if (sha256 === null) throw new Error('Verified appearance bytes must have a digest.');
            const record: SavedAppearancePart = {
              schemaVersion: 1, part, name: value.name, alignment: value.alignment,
              file: { sha256, bytes: value.file.bytes, blob },
            };
            await partStore.write(record);
          }
          // Storage can commit after its owner aborts; a successful write still stored the captured value.
          if (!disposed) { parts.set(part, value); advance(part); }
          return stored(value);
        } catch (error) {
          return Object.freeze({ kind: 'refused', error: appearanceRefusal(error) });
        } finally {
          release();
        }
      });
    },
    saveArmIk(name, value) {
      let entry: SnapshotEntry;
      try {
        live();
        armIkValue(value, value);
        entry = armIkProfiles.save(localStorage, name, value);
      } catch (error) {
        return Object.freeze({ kind: 'refused', error: appearanceRefusal(error) });
      }
      armIk = value;
      advance('arm-ik');
      const error = saves.selectArmIk(entry.key);
      return error === null ? Object.freeze({ kind: 'stored', entry, selection: 'selected' })
        : Object.freeze({
          kind: 'stored', entry, selection: 'not-selected',
          error: new AppearanceError(`IK profile "${entry.name}" was saved, but its selection for reload was not. ${error.message}`, { cause: error }),
        });
    },
    readArmIk(key) {
      try {
        live();
        return Object.freeze({ kind: 'read', value: readArmIkProfile(localStorage, key), release: () => {} });
      } catch (error) {
        return Object.freeze({ kind: 'refused', error: appearanceRefusal(error) });
      }
    },
    selectArmIk(key) {
      try {
        live();
        selectArmIkProfile(localStorage, key);
        return null;
      } catch (error) {
        return appearanceRefusal(error);
      }
    },
    loadedArmIk(profile, value) {
      live();
      if (!ARM_IK_FIELDS.every(({ key }) => profile.settings[key] === value[key])) {
        throw new Error('A loaded IK fingerprint must be the installed profile value.');
      }
      armIk = value;
      advance('arm-ik');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const disposal = new Disposal();
      disposal.run(() => lifecycle.abort());
      disposal.run(() => characterStore.close());
      disposal.run(() => partStore.close());
      for (const release of work) disposal.run(release);
      work.clear();
      writes.clear();
      epochs.clear();
      parts.clear();
      character = null;
      armIk = null;
      disposal.finish();
    },
  };
  return Object.freeze(saves);
}
