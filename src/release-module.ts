// The contract between a release and the game's own module (GAME_MODULE). A module exports
// `start(host)`; the release calls it once, before it fetches anything, and awaits it.
import type { ContentAccess, ContentError, ContentProgress } from './content-session';

// Modules refuse access with ContentError, coded unauthenticated, denied or unavailable.
export { ContentError } from './content-session';
export type { ContentAccess, ContentErrorCode, ContentGrant, ContentGrantRequest, ContentProgress } from './content-session';

// What the release offers before any content loads, so the module can sign the player in first.
export interface ReleaseHost {
  // The element the release mounts its interface in; the module may add its own UI to it.
  readonly mount: HTMLElement;
  // Where this build's content is served, as an absolute URL.
  readonly contentUrl: string;
  notice(message: string, kind?: 'info' | 'error'): void;
}

// The running game, for the module's own UI. Pause and input blocking use the module's own reason,
// so they never undo the game's.
export interface ReleaseApi {
  setPause(paused: boolean): void;
  setInputBlock(blocked: boolean): void;
  readonly halted: boolean;
}

// What start() returns; every member is optional. Without `access`, content is public under the
// content URL. `failed` receives each content failure: resolve to load again (for example after
// the player signs in or buys the game), or reject to stop with that error shown.
export interface ReleaseModule {
  readonly access?: ContentAccess;
  progress?(progress: ContentProgress): void;
  failed?(error: ContentError): Promise<void>;
  ready?(api: ReleaseApi): void;
  dispose?(): void;
}

export type StartRelease = (host: ReleaseHost) => ReleaseModule | void | Promise<ReleaseModule | void>;
