// The release's side of content delivery. It asks the game's content access for grants, fetches
// granted files with bounded concurrency, and verifies every byte against the build's pins before
// anything parses it. The engine never sees identities or credentials: a grant is only URLs.
import { GAME_GROUP, refPath, validateContentManifest } from './content';
import type { ContentManifest, ContentPins } from './content';
import { pathGroup, pathHash } from './content-ref';
import type { MediaStream } from './media-host';
import type { ModelSelection, ModelSelectionRequest } from './model-library';
import { sha256Hex } from './sha256';

// superseded: a newer swap of the same part replaced one not yet sent. unknown-model: a swap or a
// backend's answer names a library model this release does not list for that part.
export const CONTENT_ERROR_CODES = ['unauthenticated', 'denied', 'unavailable', 'integrity', 'superseded', 'unknown-model'] as const;
export type ContentErrorCode = (typeof CONTENT_ERROR_CODES)[number];

// Typed content failures; games branch on `code`. Messages name content by path, never by URL.
export class ContentError extends Error {
  readonly code: ContentErrorCode;
  readonly group: string | null;
  readonly path: string | null;

  constructor(code: ContentErrorCode, message: string, options: { group?: string | null; path?: string | null } = {}) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
    this.group = options.group ?? (options.path == null ? null : pathGroup(options.path));
    this.path = options.path ?? null;
  }
}

export interface ContentGrantRequest {
  readonly group: string;
  readonly paths: readonly string[];
  // True when this release held a grant for the group that expired or that the CDN refused.
  readonly refresh: boolean;
}

// URLs for the requested paths: signed, covered by a cookie, or blob: URLs made from a platform's
// bytes. `credentials` says whether requests send cookies; `expires` is epoch milliseconds.
export interface ContentGrant {
  readonly urls: ReadonlyMap<string, string>;
  readonly credentials: 'omit' | 'include';
  readonly expires: number | null;
}

// Where a game's identity plugs in: it signs the player in, asks its backend for access to a group
// and returns the answer, or refuses with a ContentError coded unauthenticated, denied or unavailable.
export interface ContentAccess {
  grant(request: ContentGrantRequest, signal: AbortSignal): Promise<ContentGrant>;
  // The game's backend decides which library model each part uses. select() returns its stored
  // selection, after asking it to change one part when `request` is not null; without it, parts use
  // the profile's own models.
  select?(request: ModelSelectionRequest | null, signal: AbortSignal): Promise<ModelSelection>;
}

// For a game that needs no authentication: every file is public under the content URL.
export function publicAccess(contentUrl: string): ContentAccess {
  const root = new URL(contentUrl, document.baseURI);
  return {
    async grant(request) {
      return { urls: new Map(request.paths.map(path => [path, new URL(path, root).href])), credentials: 'omit', expires: null };
    },
  };
}

export interface ContentProgress {
  readonly loaded: number;
  readonly total: number;
}

export interface ContentStatistics {
  readonly payloadBytesRead: number;
  readonly verifiedBytes: number;
  readonly requests: number;
  readonly retries: number;
}

interface HeldGrant {
  readonly grant: ContentGrant;
  // Whether the grant arrived with time to spare. One that did not (a short lifetime, or a clock
  // ahead of the backend's) is renewed only when the CDN refuses it.
  readonly renewable: boolean;
}

const CONCURRENCY = 6;
// A grant this close to expiry is renewed before a request uses it.
const EXPIRY_MARGIN_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The content request was cancelled.', 'AbortError');
}

// Settles with `promise`, or rejects as soon as `signal` aborts, without cancelling shared work.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The shared work may still fail after this caller stops waiting.
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(aborted(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Ends a request that makes no progress for IDLE_TIMEOUT_MS, whether it waits for headers or data.
class Watchdog {
  readonly signal: AbortSignal;
  readonly caller: AbortSignal;
  expired = false;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(caller: AbortSignal) {
    this.caller = caller;
    this.signal = AbortSignal.any([caller, this.controller.signal]);
    this.arm();
  }

  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.expired = true; this.controller.abort(); }, IDLE_TIMEOUT_MS);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

function checkGrant(value: unknown, request: ContentGrantRequest): ContentGrant {
  const invalid = (reason: string): ContentError =>
    new ContentError('unavailable', `The game's content access returned an invalid grant for ${request.group}: ${reason}.`, { group: request.group });
  if (typeof value !== 'object' || value === null) throw invalid('it is not an object');
  const { urls, credentials, expires } = value as Partial<ContentGrant>;
  if (!(urls instanceof Map)) throw invalid('urls must be a Map from content paths to URLs');
  if (credentials !== 'omit' && credentials !== 'include') throw invalid('credentials must be omit or include');
  if (expires !== null && (typeof expires !== 'number' || !Number.isFinite(expires))) throw invalid('expires must be a time or null');
  const checked = new Map<string, string>();
  for (const path of request.paths) {
    const url: unknown = urls.get(path);
    let parsed: URL | null = null;
    try { parsed = typeof url === 'string' ? new URL(url) : null; } catch { parsed = null; }
    if (parsed === null || !['https:', 'http:', 'blob:'].includes(parsed.protocol)) throw invalid(`it has no HTTP(S) or blob: URL for ${path}`);
    checked.set(path, parsed.href);
  }
  return Object.freeze({ urls: checked, credentials, expires });
}

/**
 * One release's content. Grants are requested once per group and shared by every download in it;
 * a grant that expires, or that the CDN answers with 401 or 403, is renewed once. Downloads stream
 * into buffers of the manifest's exact size and are checked against the SHA-256 in their path.
 * Content and grant URLs live only in memory.
 */
export class ContentSession {
  private readonly access: ContentAccess;
  private readonly pins: ContentPins;
  private readonly onProgress: ((progress: ContentProgress) => void) | null;
  private readonly lifecycle = new AbortController();
  private readonly sizes = new Map<string, number>();
  private readonly groups = new Map<string, readonly string[]>();
  private readonly grants = new Map<string, HeldGrant>();
  private readonly granting = new Map<string, Promise<HeldGrant>>();
  // Groups this session has held a grant for, so later requests for them ask for a refresh.
  private readonly granted = new Set<string>();
  // Orders downloads and refusals: a refusal answers every download that started before it.
  private sequence = 0;
  private readonly refusals = new Map<string, { readonly error: ContentError; readonly sequence: number }>();
  private readonly cached = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private readonly waiting: { readonly start: () => void; readonly signal: AbortSignal; readonly cancel: () => void }[] = [];
  private active = 0;
  private loaded = 0;
  private total = 0;
  private payloadBytesRead = 0;
  private verifiedBytes = 0;
  private requests = 0;
  private retries = 0;

  constructor(options: { access: ContentAccess; pins: ContentPins; onProgress?: (progress: ContentProgress) => void }) {
    this.access = options.access;
    this.pins = options.pins;
    this.onProgress = options.onProgress ?? null;
    this.sizes.set(options.pins.manifest, options.pins.manifestBytes);
    this.groups.set(GAME_GROUP, [...options.pins.game]);
  }

  // Grants the game group, then downloads, verifies and validates the manifest.
  async manifest(signal: AbortSignal): Promise<ContentManifest> {
    this.total += this.pins.manifestBytes;
    this.report();
    const bytes = await this.fetchVerified(this.pins.manifest, this.within(signal), true);
    let manifest: ContentManifest;
    try {
      manifest = validateContentManifest(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      throw new ContentError('integrity', `The content manifest ${this.pins.manifest} is invalid: ${
        error instanceof Error ? error.message : String(error)}`, { path: this.pins.manifest });
    }
    const game = new Set(this.pins.game);
    const listed = Object.keys(manifest.files).filter(path => pathGroup(path) === GAME_GROUP);
    if (listed.length + 1 !== game.size || !game.has(this.pins.manifest) || listed.some(path => !game.has(path))) {
      throw new ContentError('integrity', 'The content manifest does not match the files this release was built with.', { group: GAME_GROUP });
    }
    for (const [path, bytes] of Object.entries(manifest.files)) {
      this.sizes.set(path, bytes);
      // Other groups, such as each library model's, are granted on their own.
      const group = pathGroup(path);
      if (group !== GAME_GROUP) this.groups.set(group, [...(this.groups.get(group) ?? []), path]);
    }
    return manifest;
  }

  // Starts downloading files ahead of use; bytes() then takes the same downloads.
  prefetch(sources: readonly string[]): void {
    for (const source of sources) {
      const path = this.known(source);
      if (this.cached.has(path)) continue;
      this.total += this.sizes.get(path)!;
      const download = this.fetchVerified(path, this.lifecycle.signal, true);
      // A failure surfaces to whoever takes the file.
      download.catch(() => undefined);
      this.cached.set(path, download);
    }
    this.report();
  }

  // Verified bytes of a packaged source. Callers must not detach or transfer the buffer.
  bytes(source: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const path = this.known(source);
    const cached = this.cached.get(path);
    const request = this.within(signal);
    return cached === undefined ? this.fetchVerified(path, request, false) : abortable(cached, request);
  }

  // A granted URL for a media element; music and video stream without integrity checks.
  async stream(source: string, signal: AbortSignal): Promise<MediaStream> {
    const path = this.known(source);
    const held = await this.grantFor(pathGroup(path), null, this.within(signal), this.sequence++);
    return { url: held.grant.urls.get(path)!, crossOrigin: held.grant.credentials === 'include' ? 'use-credentials' : 'anonymous' };
  }

  // Drops downloads kept for boot; grants stay for later requests.
  forgetDownloads(): void {
    this.cached.clear();
  }

  statistics(): ContentStatistics {
    return {
      payloadBytesRead: this.payloadBytesRead, verifiedBytes: this.verifiedBytes,
      requests: this.requests, retries: this.retries,
    };
  }

  dispose(): void {
    this.lifecycle.abort(new DOMException('The release closed.', 'AbortError'));
    this.cached.clear();
    this.grants.clear();
  }

  // A caller's signal that also ends when the session closes.
  private within(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifecycle.signal]);
  }

  private known(source: string): string {
    const path = refPath(source);
    if (!this.sizes.has(path)) throw new ContentError('integrity', `Content ${path} is not part of this release.`, { path });
    return path;
  }

  private report(): void {
    this.onProgress?.({ loaded: this.loaded, total: this.total });
  }

  private expired(held: HeldGrant): boolean {
    return held.renewable && held.grant.expires! - EXPIRY_MARGIN_MS <= Date.now();
  }

  // The group's current grant. It is renewed when it expired, or once when `failed`, the grant a
  // download presented, was refused by the CDN: every download that met the same grant shares the
  // renewal. A refusal fails every download that `started` before it; later ones ask anew.
  private grantFor(group: string, failed: HeldGrant | null, signal: AbortSignal, started: number): Promise<HeldGrant> {
    if (signal.aborted) return Promise.reject(aborted(signal));
    const refusal = this.refusals.get(group);
    if (refusal !== undefined && refusal.sequence > started) return Promise.reject(refusal.error);
    const current = this.grants.get(group);
    if (current !== undefined && current !== failed && !this.expired(current)) return Promise.resolve(current);
    let pending = this.granting.get(group);
    if (pending === undefined) {
      const paths = this.groups.get(group);
      if (paths === undefined) return Promise.reject(new ContentError('integrity', `Content group ${group} is not part of this release.`, { group }));
      const request: ContentGrantRequest = Object.freeze({ group, paths: Object.freeze([...paths]), refresh: this.granted.has(group) });
      pending = this.requestGrant(request).then((grant) => {
        const held = { grant, renewable: grant.expires !== null && grant.expires - EXPIRY_MARGIN_MS > Date.now() };
        if (!this.lifecycle.signal.aborted) {
          this.grants.set(group, held);
          this.granted.add(group);
          this.refusals.delete(group);
        }
        return held;
      }, (error: unknown) => {
        if (error instanceof ContentError) {
          this.refusals.set(group, { error, sequence: this.sequence++ });
          if (current !== undefined && this.grants.get(group) === current) this.grants.delete(group);
        }
        throw error;
      }).finally(() => this.granting.delete(group));
      this.granting.set(group, pending);
    }
    return abortable(pending, signal);
  }

  private async requestGrant(request: ContentGrantRequest): Promise<ContentGrant> {
    let value: unknown;
    try {
      value = await this.access.grant(request, this.lifecycle.signal);
    } catch (error) {
      // Only the session's own closing is a cancellation; an adapter's own abort is a failure.
      if (this.lifecycle.signal.aborted) throw aborted(this.lifecycle.signal);
      // A refusal reaches the release facets' FAILED point, naming its group (docs/release-plugins.md).
      if (error instanceof ContentError) throw error.group === null ? new ContentError(error.code, error.message, { group: request.group }) : error;
      throw new ContentError('unavailable', `The game's content access failed for ${request.group}: ${
        error instanceof Error ? error.message : String(error)}`, { group: request.group });
    }
    return checkGrant(value, request);
  }

  private async slot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw aborted(signal);
    if (this.active < CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        start: () => { signal.removeEventListener('abort', entry.cancel); resolve(); },
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(aborted(signal));
        },
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.waiting.push(entry);
    });
  }

  private free(): void {
    const next = this.waiting.shift();
    // The freed slot passes straight to the next download.
    if (next === undefined) this.active--;
    else next.start();
  }

  private async fetchVerified(path: string, signal: AbortSignal, counted: boolean): Promise<Uint8Array<ArrayBuffer>> {
    const expected = this.sizes.get(path)!;
    const group = pathGroup(path);
    const started = this.sequence++;
    await this.slot(signal);
    try {
      let held = await this.grantFor(group, null, signal, started);
      for (let attempt = 0; ; attempt++) {
        const watchdog = new Watchdog(signal);
        try {
          if (attempt > 0) this.retries++;
          const response = await this.request(held.grant, path, watchdog);
          if ((response.status === 401 || response.status === 403) && attempt === 0) {
            await response.body?.cancel().catch(() => undefined);
            held = await this.grantFor(group, held, signal, started);
            continue;
          }
          if (response.status === 401) throw new ContentError('unauthenticated', `Content ${path} needs the player to sign in (HTTP 401).`, { path });
          if (response.status === 403) throw new ContentError('denied', `Content ${path} was refused for this player (HTTP 403).`, { path });
          if (!response.ok) throw new ContentError('unavailable', `Content ${path} could not be loaded (HTTP ${response.status}).`, { path });
          const bytes = await this.read(response, path, expected, watchdog, counted);
          if (await sha256Hex(bytes) !== pathHash(path)) {
            throw new ContentError('integrity', `Content ${path} does not match its SHA-256; it changed after the build.`, { path });
          }
          this.verifiedBytes += bytes.byteLength;
          return bytes;
        } finally {
          watchdog.stop();
        }
      }
    } finally {
      this.free();
    }
  }

  private async request(grant: ContentGrant, path: string, watchdog: Watchdog): Promise<Response> {
    try {
      this.requests++;
      return await fetch(grant.urls.get(path)!, { credentials: grant.credentials, signal: watchdog.signal });
    } catch {
      if (watchdog.caller.aborted) throw aborted(watchdog.caller);
      if (watchdog.expired) throw new ContentError('unavailable', `Content ${path} did not answer.`, { path });
      // The browser's message carries no URL; neither does this one.
      throw new ContentError('unavailable', `Content ${path} could not be downloaded. Check the network and the CDN's CORS headers.`, { path });
    }
  }

  // Streams a response into a buffer of the manifest's exact size.
  private async read(response: Response, path: string, expected: number, watchdog: Watchdog, counted: boolean): Promise<Uint8Array<ArrayBuffer>> {
    if (response.body === null) throw new ContentError('unavailable', `Content ${path} arrived without a body.`, { path });
    const reader = response.body.getReader();
    const bytes = new Uint8Array(expected);
    let offset = 0;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (watchdog.caller.aborted) throw aborted(watchdog.caller);
          if (watchdog.expired) throw new ContentError('unavailable', `Content ${path} stopped downloading.`, { path });
          throw new ContentError('unavailable', `Content ${path} could not be downloaded completely.`, { path });
        }
        if (chunk.done) break;
        this.payloadBytesRead += chunk.value.byteLength;
        watchdog.arm();
        if (offset + chunk.value.byteLength > expected) {
          reader.cancel().catch(() => undefined);
          throw new ContentError('integrity', `Content ${path} is larger than the build wrote. Check that the content URL serves this build's content.`, { path });
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
        if (counted) {
          this.loaded += chunk.value.byteLength;
          this.report();
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== expected) {
      throw new ContentError('integrity', `Content ${path} is smaller than the build wrote. Check that the content URL serves this build's content.`, { path });
    }
    return bytes;
  }
}
