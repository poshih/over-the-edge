// The contract between a release and the game's own module (GAME_MODULE). A module exports
// `start(host)`; the release calls it once, before it fetches anything, and awaits it.
import type { ContentAccess, ContentError, ContentProgress } from './content-session';
import type { PhantomService } from './phantom-service';
import type { ModelLibraryApi } from './release-library';

// Modules refuse access with ContentError, coded unauthenticated, denied or unavailable.
export { ContentError } from './content-session';
export type { ContentAccess, ContentErrorCode, ContentGrant, ContentGrantRequest, ContentProgress } from './content-session';
export type { ModelSelection, ModelSelectionRequest, PartRole } from './model-library';
export type { ModelLibraryApi } from './release-library';
// A module that talks to its phantom backend its own way may start from the reference client.
export { httpPhantoms, PhantomServiceError } from './phantom-service';
export type { PhantomQuery, PhantomService } from './phantom-service';

// What the release offers before any content loads, so the module can sign the player in first.
export interface ReleaseHost {
  // The element the release mounts its interface in; the module may add its own UI to it.
  readonly mount: HTMLElement;
  // Where this build's content is served, as an absolute URL.
  readonly contentUrl: string;
  // Where this build's phantoms go and come from (GAME_PHANTOMS_URL), as an absolute URL; null when the
  // build has no phantom backend.
  readonly phantomsUrl: string | null;
  notice(message: string, kind?: 'info' | 'error'): void;
}

// The running game, for the module's own UI. Pause and input blocking use the module's own reason,
// so they never undo the game's.
export interface ReleaseApi {
  setPause(paused: boolean): void;
  setInputBlock(blocked: boolean): void;
  readonly halted: boolean;
  // Swaps a part's model as the game's backend answers; see ContentAccess.select.
  readonly modelLibrary: ModelLibraryApi;
}

// What start() returns; every member is optional. Without `access`, content is public under the
// content URL. `failed` receives each content failure: resolve to load again (for example after
// the player signs in or buys the game), or reject to stop with that error shown. `modelFailed`
// receives a part that could not follow the backend's selection outside a swap, at boot or after
// another part's swap; that part keeps its model, or starts with the profile's own. Without
// `phantoms`, a build with a phantom URL speaks the reference protocol to it; a module may supply
// phantoms only to a build with phantoms, from a phantom URL or bundled recordings.
export interface ReleaseModule {
  readonly access?: ContentAccess;
  readonly phantoms?: PhantomService;
  progress?(progress: ContentProgress): void;
  failed?(error: ContentError): Promise<void>;
  modelFailed?(error: Error): void;
  ready?(api: ReleaseApi): void;
  dispose?(): void;
}

export type StartRelease = (host: ReleaseHost) => ReleaseModule | void | Promise<ReleaseModule | void>;
