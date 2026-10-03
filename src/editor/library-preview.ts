import { createCharacterModelLoader } from '../character-model-loader';
import type { LoadedCharacterModel } from '../character-model-types';
import type { HammerHead } from '../hammer-head';
import { PART_ROLES } from '../model-library';
import type { PartRole } from '../model-library';
import type { PartModel } from '../view';
import type { LibraryModel } from './project-session';

// The game: it shows part models, a library hammer's with its head in the physics.
export interface PartModelHost {
  setPartModel(role: PartRole, part: PartModel | null, signal: AbortSignal): Promise<void>;
  // A new outline for the shown library hammer's head.
  setHammerHead(head: HammerHead | null): void;
}

export interface LibraryPreviewOptions {
  readonly host: PartModelHost;
  readonly blob: (role: PartRole, id: string) => Promise<Blob>;
  readonly onChange: () => void;
  readonly onError: (message: string) => void;
}

interface Shown {
  readonly entry: LibraryModel;
  readonly model: LoadedCharacterModel;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Shows library models in the Workshop's game, each part on its own, as a release shows them once
 * its backend selects them. It owns the loaded models; the view only draws them.
 */
export class LibraryPreview {
  private readonly loader = createCharacterModelLoader();
  private readonly lifetime = new AbortController();
  private readonly shown: Record<PartRole, Shown | null> = { avatar: null, hammer: null, pot: null };
  private readonly wanted: Record<PartRole, { readonly entry: LibraryModel | null; readonly task: AbortController } | null> = {
    avatar: null, hammer: null, pot: null,
  };
  private readonly queues: Record<PartRole, Promise<void>> = { avatar: Promise.resolve(), hammer: Promise.resolve(), pot: Promise.resolve() };

  private readonly options: LibraryPreviewOptions;

  constructor(options: LibraryPreviewOptions) {
    this.options = options;
  }

  // The library model each part shows, or is loading, by ID; null shows the characters' own.
  state(): Record<PartRole, { readonly id: string | null; readonly loading: boolean }> {
    const part = (role: PartRole) => {
      const wanted = this.wanted[role];
      return wanted !== null ? { id: wanted.entry?.id ?? null, loading: true } : { id: this.shown[role]?.entry.id ?? null, loading: false };
    };
    return { avatar: part('avatar'), hammer: part('hammer'), pot: part('pot') };
  }

  // Shows `entry` for its part, or the characters' own models for `role` with null. A later call
  // for the same part supersedes an unfinished one; each part's changes run one at a time.
  show(role: PartRole, entry: LibraryModel | null): Promise<void> {
    this.wanted[role]?.task.abort();
    const wanted = { entry, task: new AbortController() };
    this.wanted[role] = wanted;
    this.options.onChange();
    const run = this.queues[role].then(() => this.apply(role, wanted));
    this.queues[role] = run;
    return run;
  }

  // Follows library changes: a removed or replaced model returns its part to the characters' own,
  // and changed avatar settings and hammer heads apply at once.
  refresh(library: readonly LibraryModel[]): void {
    for (const role of PART_ROLES) {
      const wanted = this.wanted[role];
      const shown = this.shown[role];
      const target = wanted !== null ? wanted.entry : shown?.entry ?? null;
      if (target === null) continue;
      const next = library.find((entry) => entry.role === role && entry.key === target.key) ?? null;
      if (next === null || next.avatar !== target.avatar) void this.show(role, next);
      else if (next.head !== target.head) {
        // Only the shown hammer's head changed: its model stays.
        if (wanted !== null) void this.show(role, next);
        else {
          this.shown[role] = { entry: next, model: shown!.model };
          this.options.host.setHammerHead(next.head);
        }
      }
    }
  }

  dispose(): void {
    this.lifetime.abort();
    for (const role of PART_ROLES) {
      this.shown[role]?.model.dispose();
      this.shown[role] = null;
    }
  }

  private async apply(role: PartRole, wanted: { readonly entry: LibraryModel | null; readonly task: AbortController }): Promise<void> {
    const { entry } = wanted;
    const signal = AbortSignal.any([wanted.task.signal, this.lifetime.signal]);
    const current = this.shown[role];
    let loaded: LoadedCharacterModel | null = null;
    try {
      signal.throwIfAborted();
      if (entry === null) {
        if (current !== null) await this.options.host.setPartModel(role, null, signal);
      } else {
        loaded = current !== null && current.entry.key === entry.key ? current.model : await this.load(role, entry, signal);
        signal.throwIfAborted();
        await this.options.host.setPartModel(role, {
          id: entry.id, model: loaded, avatar: entry.avatar ?? undefined, head: entry.head ?? undefined,
        }, signal);
      }
      if (current !== null && current.model !== loaded) current.model.dispose();
      this.shown[role] = entry === null ? null : { entry, model: loaded! };
    } catch (error) {
      if (loaded !== null && loaded !== current?.model) loaded.dispose();
      if (!isAbort(error) && !this.lifetime.signal.aborted) {
        this.options.onError(`Could not preview ${entry === null ? `the character's own ${role}` : `library ${role} "${entry.name}"`}: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (this.wanted[role] === wanted) this.wanted[role] = null;
      this.options.onChange();
    }
  }

  private async load(role: PartRole, entry: LibraryModel, signal: AbortSignal): Promise<LoadedCharacterModel> {
    const blob = await this.options.blob(role, entry.id);
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    try {
      return await this.loader.load({ id: entry.id, name: entry.name, source: url }, role, signal);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
