// A release's model library. The game's backend decides and stores which library model each part
// uses; this relays the player's swaps to it one at a time and shows only its answers. Nothing here
// decides a selection or keeps one: the backend's latest answer lives in memory, as views.
import type { ContentLibrary, ContentLibraryAvatar, ContentLibraryEntry, ContentLibraryHammer } from './content';
import { ContentError } from './content-session';
import type { ContentAccess } from './content-session';
import type { CharacterModelLoader, LoadedCharacterModel } from './character-model-types';
import { EMPTY_SELECTION, isPartRole, libraryAvatarSettings, PART_ROLES } from './model-library';
import type { LibraryAvatarSettings, ModelSelection, ModelSelectionRequest, PartRole } from './model-library';
import type { PartModel } from './view';

// What shows each part's model: the game, which also gives its physics a library hammer's head.
export interface PartModelHost {
  setPartModel(role: PartRole, part: PartModel | null, signal: AbortSignal): Promise<void>;
  partModels(): Record<PartRole, string | null>;
}

// What the game's module uses: the library's ids and the parts in use, and requests to its backend.
export interface ModelLibraryApi {
  available(role: PartRole): readonly string[];
  active(role: PartRole): string | null;
  // Asks the backend to use `id`, or the profile's own model for null, for one part; resolves with
  // the selection in use once the backend's answer shows.
  swap(role: PartRole, id: string | null): Promise<ModelSelection>;
  // Reads the backend's selection again, for example after it changed there.
  refresh(): Promise<ModelSelection>;
}

interface Pending {
  readonly request: ModelSelectionRequest | null;
  readonly resolve: (selection: ModelSelection) => void;
  readonly reject: (error: unknown) => void;
}

// Models kept for each part besides the one in use, so swapping back fetches nothing.
const CACHED_PER_PART = 1;

function typed(error: unknown, fallback: string): unknown {
  if (error instanceof ContentError || error instanceof DOMException && error.name === 'AbortError') return error;
  // Model checks raise their own typed errors; anything else is the backend or adapter failing.
  if (error instanceof Error && 'code' in error) return error;
  return new ContentError('unavailable', `${fallback}: ${error instanceof Error ? error.message : String(error)}`);
}

// A backend's answer, checked as far as its shape; unknown ids fail only their own part.
export function checkSelection(value: unknown): ModelSelection {
  const fail = (): never => { throw new ContentError('unavailable', 'The game\'s content access returned an invalid model selection.'); };
  if (typeof value !== 'object' || value === null) return fail();
  const keys = Object.keys(value);
  if (keys.length !== PART_ROLES.length || !PART_ROLES.every(role => keys.includes(role))) return fail();
  for (const role of PART_ROLES) {
    const id: unknown = Reflect.get(value, role);
    if (id !== null && typeof id !== 'string') return fail();
  }
  return Object.freeze({ avatar: Reflect.get(value, 'avatar'), hammer: Reflect.get(value, 'hammer'), pot: Reflect.get(value, 'pot') }) as ModelSelection;
}

// The backend's stored selection, read at boot alongside the game group's grant.
export async function readSelection(access: ContentAccess, signal: AbortSignal): Promise<ModelSelection> {
  if (access.select === undefined) return EMPTY_SELECTION;
  try {
    return checkSelection(await access.select(null, signal));
  } catch (error) {
    throw typed(error, 'The game\'s model selection failed');
  }
}

export class ReleaseModelLibrary {
  readonly api: ModelLibraryApi;
  private readonly library: ContentLibrary;
  private readonly select: ContentAccess['select'] | null;
  private readonly loader: CharacterModelLoader | null;
  private readonly parts: PartModelHost;
  private readonly signal: AbortSignal;
  private readonly onFailure: (error: unknown) => void;
  // Loaded library models by part, most recent last; the view shows at most one of each.
  private readonly cache: Record<PartRole, Map<string, LoadedCharacterModel>> = { avatar: new Map(), hammer: new Map(), pot: new Map() };
  private readonly settings = new Map<ContentLibraryAvatar, LibraryAvatarSettings>();
  private readonly queue: Pending[] = [];
  private running = false;

  constructor(options: {
    library: ContentLibrary;
    access: ContentAccess;
    loader: CharacterModelLoader | null;
    parts: PartModelHost;
    signal: AbortSignal;
    // A part that could not follow an answer other than the one a swap waits for.
    onFailure: (error: unknown) => void;
  }) {
    this.library = options.library;
    this.select = options.access.select === undefined ? null : options.access.select.bind(options.access);
    this.loader = options.loader;
    this.parts = options.parts;
    this.signal = options.signal;
    this.onFailure = options.onFailure;
    this.api = Object.freeze({
      available: (role: PartRole) => this.library[role].map(entry => entry.id),
      active: (role: PartRole) => this.parts.partModels()[role],
      swap: (role: PartRole, id: string | null) => this.swap(role, id),
      refresh: () => this.enqueue(null),
    });
  }

  // The parts a selection gives a library model this release lists.
  replaced(selection: ModelSelection): Set<PartRole> {
    return new Set(PART_ROLES.filter(role => selection[role] !== null && this.listed(role, selection[role]!)));
  }

  // Loads the models a selection names, without showing them; failures are per part.
  async load(selection: ModelSelection): Promise<Map<PartRole, PartModel | null | Error>> {
    const results = new Map<PartRole, PartModel | null | Error>();
    await Promise.all(PART_ROLES.map(async (role) => {
      const id = selection[role];
      try {
        if (id !== null && !this.listed(role, id)) {
          throw new ContentError('unknown-model', `The game's backend selected ${role} "${id}", which this release does not list.`);
        }
        results.set(role, id === null ? null : await this.model(role, id));
      } catch (error) {
        results.set(role, typed(error, `The library ${role} "${id}" could not load`) as Error);
      }
    }));
    return results;
  }

  // Shows loaded models; a part that failed returns to the profile's own model. Returns the failures.
  async show(loaded: Map<PartRole, PartModel | null | Error>): Promise<Error[]> {
    const failures: Error[] = [];
    for (const role of PART_ROLES) {
      const part = loaded.get(role) ?? null;
      if (part instanceof Error) failures.push(part);
      await this.parts.setPartModel(role, part instanceof Error ? null : part, this.signal);
    }
    this.evict();
    return failures;
  }

  private swap(role: PartRole, id: string | null): Promise<ModelSelection> {
    if (!isPartRole(role)) return Promise.reject(new ContentError('unknown-model', `There is no part "${String(role)}"; use avatar, hammer or pot.`));
    if (id !== null && !this.listed(role, id)) {
      return Promise.reject(new ContentError('unknown-model', `This release lists no ${role} "${String(id)}".`));
    }
    // A newer swap of the same part supersedes one not yet sent.
    for (const pending of [...this.queue]) {
      if (pending.request?.role !== role) continue;
      this.queue.splice(this.queue.indexOf(pending), 1);
      pending.reject(new ContentError('superseded', `A newer ${role} swap replaced this one before it was sent.`));
    }
    return this.enqueue({ role, id });
  }

  private enqueue(request: ModelSelectionRequest | null): Promise<ModelSelection> {
    if (this.select === null) return Promise.reject(new ContentError('unavailable', 'This release has no backend that selects models.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      void this.pump();
    });
  }

  // One request at a time, each answer shown before the next request is sent.
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.signal.aborted) {
        const next = this.queue.shift()!;
        try {
          let answer: ModelSelection;
          try {
            answer = checkSelection(await this.select!(next.request, this.signal));
          } catch (error) {
            throw typed(error, 'The game\'s model selection failed');
          }
          const failures = await this.apply(answer);
          const own = next.request === null ? undefined : failures.get(next.request.role);
          for (const [role, error] of failures) if (role !== next.request?.role) this.onFailure(error);
          if (own !== undefined) next.reject(own);
          else next.resolve(this.selection());
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // Shows an answer: each part whose selection changed loads and shows, or keeps its model and fails.
  private async apply(answer: ModelSelection): Promise<Map<PartRole, unknown>> {
    const failures = new Map<PartRole, unknown>();
    const current = this.parts.partModels();
    await Promise.all(PART_ROLES.map(async (role) => {
      const id = answer[role];
      if (id === current[role]) return;
      try {
        if (id !== null && !this.listed(role, id)) {
          throw new ContentError('unknown-model', `The game's backend selected ${role} "${id}", which this release does not list.`);
        }
        await this.parts.setPartModel(role, id === null ? null : await this.model(role, id), this.signal);
      } catch (error) {
        failures.set(role, typed(error, `The ${role} could not change`));
      }
    }));
    this.evict();
    return failures;
  }

  private selection(): ModelSelection {
    return Object.freeze({ ...this.parts.partModels() });
  }

  private listed(role: PartRole, id: string): boolean {
    return this.library[role].some(entry => entry.id === id);
  }

  // A library model, from memory or through the game's content access.
  private async model(role: PartRole, id: string): Promise<PartModel> {
    const entry: ContentLibraryEntry = this.library[role].find(candidate => candidate.id === id)!;
    const cache = this.cache[role];
    let model = cache.get(id);
    if (model === undefined) {
      if (this.loader === null) throw new ContentError('unavailable', 'This release cannot load models.');
      model = await this.loader.load({ id: entry.id, name: entry.name, source: entry.source }, role, this.signal);
      cache.set(id, model);
    } else {
      // Most recently used last.
      cache.delete(id);
      cache.set(id, model);
    }
    if (role === 'hammer') return { id, model, head: (entry as ContentLibraryHammer).head };
    if (role !== 'avatar') return { id, model };
    const avatar = entry as ContentLibraryAvatar;
    let settings = this.settings.get(avatar);
    if (settings === undefined) {
      settings = libraryAvatarSettings(avatar);
      this.settings.set(avatar, settings);
    }
    return { id, model, avatar: settings };
  }

  // Keeps the model each part shows and the most recent others; disposes the rest.
  private evict(): void {
    const shown = this.parts.partModels();
    for (const role of PART_ROLES) {
      const cache = this.cache[role];
      const spare = [...cache.keys()].filter(id => id !== shown[role]);
      for (const id of spare.slice(0, Math.max(0, spare.length - CACHED_PER_PART))) {
        cache.get(id)!.dispose();
        cache.delete(id);
      }
    }
  }

  dispose(): void {
    this.queue.splice(0).forEach(pending => pending.reject(new DOMException('The release closed.', 'AbortError')));
    for (const role of PART_ROLES) {
      for (const model of this.cache[role].values()) model.dispose();
      this.cache[role].clear();
    }
  }
}
