// Per-profile ownership of GLBs: single-flight loads, explicit operation/view leases, bounded
// admission. Abandoned loads keep their budget until they settle, even if a decoder ignores abort.
import type { CharacterModel } from './character-profile';
import type { CharacterModelUsage } from './character-model-inspect';
import type { LoadedCharacterModel } from './character-model-types';
import { SpriteError } from './sprite-fields';

// Three current roles + three incoming profile roles + three concurrent role restores.
export const CHARACTER_MODEL_POOL_LIMIT = 9;

export interface CharacterModelLease {
  readonly loaded: Promise<LoadedCharacterModel>;
  release(): void;
}

interface PoolEntry {
  readonly model: CharacterModel;
  readonly usage: CharacterModelUsage;
  readonly controller: AbortController;
  refs: number;
  value: LoadedCharacterModel | null;
  loading: Promise<LoadedCharacterModel> | null;
}

class ModelPoolInvariantError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelPoolInvariantError'; }
}

function abandoned(): DOMException {
  return new DOMException('No character view needs this model any more.', 'AbortError');
}

export class CharacterModelPool {
  private readonly load: (model: CharacterModel, usage: CharacterModelUsage, signal: AbortSignal) => Promise<LoadedCharacterModel>;
  // Avoid concatenating a possibly large data URI into another cache key.
  private readonly entries: Record<CharacterModelUsage, Map<string, PoolEntry>> = {
    avatar: new Map(), hammer: new Map(), pot: new Map(),
  };
  private readonly admitted = new Set<PoolEntry>();
  private readonly lifecycle = new AbortController();

  constructor(options: {
    readonly load: (model: CharacterModel, usage: CharacterModelUsage, signal: AbortSignal) => Promise<LoadedCharacterModel>;
  }) { this.load = options.load; }

  acquire(model: CharacterModel, usage: CharacterModelUsage, signal: AbortSignal): CharacterModelLease {
    signal.throwIfAborted();
    this.assertOpen();
    let entry = this.entries[usage].get(model.source);
    if (entry === undefined) {
      if (this.admitted.size >= CHARACTER_MODEL_POOL_LIMIT) {
        throw new SpriteError(`This character has reached its ${CHARACTER_MODEL_POOL_LIMIT}-model loading budget. Wait for an earlier operation to finish.`);
      }
      entry = { model, usage, controller: new AbortController(), refs: 0, value: null, loading: null };
      this.entries[usage].set(model.source, entry);
      this.admitted.add(entry);
      this.start(entry);
    }
    entry.refs++;
    return this.binding(entry, signal);
  }

  // Commit retains a non-aborting lease on a model this pool loaded, for the usage it was loaded for,
  // before its preparation releases the operation lease.
  hold(model: LoadedCharacterModel): CharacterModelLease {
    this.assertOpen();
    const entry = this.entries[model.usage].get(model.source);
    if (entry === undefined || entry.value === null) {
      throw new ModelPoolInvariantError(`Character model "${model.name}" was not loaded before commit.`);
    }
    entry.refs++;
    return this.binding(entry, null);
  }

  value(usage: CharacterModelUsage, source: string): LoadedCharacterModel | undefined {
    return this.entries[usage].get(source)?.value ?? undefined;
  }

  dispose(): void {
    if (this.lifecycle.signal.aborted) return;
    // Each binding releases exactly its own ref; do not overwrite counts beneath live leases.
    this.lifecycle.abort(abandoned());
    for (const cache of Object.values(this.entries)) {
      if (cache.size !== 0) throw new ModelPoolInvariantError('Character model leases survived pool shutdown.');
    }
  }

  private assertOpen(): void {
    if (this.lifecycle.signal.aborted) throw new SpriteError('The character model pool is closed.');
  }

  private start(entry: PoolEntry): void {
    // Register the flight before calling the injected loader, including any synchronous/reentrant
    // behaviour. A cancellation before this microtask starts does not begin an unnecessary load.
    entry.loading = Promise.resolve().then(() => {
      entry.controller.signal.throwIfAborted();
      return this.load(entry.model, entry.usage, entry.controller.signal);
    }).then(value => {
      entry.loading = null;
      if (this.entries[entry.usage].get(entry.model.source) !== entry) {
        value.dispose();
        this.retire(entry);
        throw abandoned();
      }
      entry.value = value;
      return value;
    }, (error: unknown) => {
      entry.loading = null;
      this.retire(entry);
      throw error;
    });
  }

  private binding(entry: PoolEntry, signal: AbortSignal | null): CharacterModelLease {
    const loading = entry.loading;
    const cached = entry.value;
    if (loading === null && cached === null) throw new ModelPoolInvariantError('A lease has no model or load.');
    let released = false;
    let settled = false;
    let resolveLoaded!: (value: LoadedCharacterModel) => void;
    let rejectLoaded!: (reason: unknown) => void;
    const loaded = new Promise<LoadedCharacterModel>((resolve, reject) => {
      resolveLoaded = resolve;
      rejectLoaded = reject;
    });
    const onAbort = (): void => release(signal!.reason);
    const onShutdown = (): void => release(this.lifecycle.signal.reason);
    const release = (reason: unknown): void => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', onAbort);
      this.lifecycle.signal.removeEventListener('abort', onShutdown);
      if (!settled) { settled = true; rejectLoaded(reason); }
      this.drop(entry);
    };
    // Observe every shared flight, including after cancellation, without swallowing its errors.
    // A failed lease reports the original error and releases its listener/reference immediately.
    if (loading !== null) loading.then(value => {
      if (!settled) { settled = true; resolveLoaded(value); }
    }, (error: unknown) => release(error));
    if (signal?.aborted) release(signal.reason);
    else if (this.lifecycle.signal.aborted) release(this.lifecycle.signal.reason);
    else {
      if (cached !== null) { settled = true; resolveLoaded(cached); }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.lifecycle.signal.addEventListener('abort', onShutdown, { once: true });
    }
    // Abort stays observed after resolution until explicit release: preparation still owns a model
    // while decoding sprites. Only hold() creates ownership independent of that operation's signal.
    return { loaded, release: () => release(abandoned()) };
  }

  private drop(entry: PoolEntry): void {
    if (--entry.refs < 0) throw new ModelPoolInvariantError('A model reference was released more than once.');
    if (entry.refs !== 0) return;
    const value = entry.value;
    entry.value = null;
    value?.dispose();
    this.retire(entry);
    if (entry.loading !== null) entry.controller.abort(abandoned());
  }

  private retire(entry: PoolEntry): void {
    const cache = this.entries[entry.usage];
    if (cache.get(entry.model.source) === entry) cache.delete(entry.model.source);
    // Retired, still-running decoders retain admission until their success/failure handler finishes.
    if (entry.loading === null) this.admitted.delete(entry);
  }
}
