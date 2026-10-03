import { libraryAvatarSettings } from '../model-library';
import type { LibraryAvatarEntry, LibraryEntry, PartRole } from '../model-library';
import type { ProjectBundle, ProjectManifest } from '../project';
import type { SharedCopySummary, SharedKind } from '../shared-copies';

export class ProjectApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly section: string | null;

  constructor(status: number, code: string, message: string, section: string | null = null) {
    super(message);
    this.name = 'ProjectApiError';
    this.status = status;
    this.code = code;
    this.section = section;
  }
}

export interface ServerRevisions {
  readonly revision: number;
  readonly sections: Readonly<Record<string, number>>;
  // The level version the stored level and game settings are, with the phantom course of its recordings; null while
  // the stored level is invalid.
  readonly level: LevelVersionRef | null;
}

export interface LevelVersionRef {
  readonly version: number;
  readonly course: string;
}

// A level version as the project lists it, with how many phantom recordings were made on it.
export interface LevelVersionSummary extends LevelVersionRef {
  readonly savedAt: string;
  readonly recordings: number;
}

// A phantom recording as the project lists it: v<version>-<session>-<clip>.phantom.
export interface PhantomSummary {
  readonly name: string;
  readonly bytes: number;
  readonly savedAt: string;
}

export interface ServerProjectSummary {
  readonly id: string;
  readonly title: string | null;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

export interface ServerProject extends ServerRevisions {
  readonly id: string;
  readonly manifest: ProjectManifest;
  readonly files: readonly { readonly path: string; readonly kind: string; readonly bytes: number }[];
}

export interface PublishRecord {
  readonly id: string;
  readonly revision: number;
  readonly publishedAt: string;
  readonly durationMs: number;
  readonly files: number;
  readonly bytes: number;
  readonly url: string;
  readonly directory: string;
}

// The project server as this page sees it: absent, present but waiting for its token, or signed in, with the project
// this Workshop was started with when the server holds it (null otherwise).
export type ServerHealth =
  | { readonly available: false }
  | { readonly available: true; readonly authenticated: false; readonly auth: 'loopback' | 'token' }
  | { readonly available: true; readonly authenticated: true; readonly auth: 'loopback' | 'token'; readonly project: string | null };

const NO_SERVER: ServerHealth = Object.freeze({ available: false });

const JSON_TYPE = 'application/json';

/** Talks to the self-hosted project server that `npm run dev` and `npm run studio` provide. */
export class ProjectClient {
  private readonly base: string;

  constructor(base = '/api') {
    this.base = base;
  }

  // A static Workshop deployment answers /api/health with its app page, not JSON.
  async health(): Promise<ServerHealth> {
    try {
      const response = await fetch(`${this.base}/health`, { headers: { Accept: JSON_TYPE }, credentials: 'same-origin' });
      if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith(JSON_TYPE)) return NO_SERVER;
      const value: unknown = await response.json();
      if (typeof value !== 'object' || value === null || Reflect.get(value, 'api') !== 1) return NO_SERVER;
      const auth = Reflect.get(value, 'auth') === 'token' ? 'token' : 'loopback';
      if (Reflect.get(value, 'authenticated') !== true) return { available: true, authenticated: false, auth };
      const project = Reflect.get(value, 'project');
      return { available: true, authenticated: true, auth, project: typeof project === 'string' ? project : null };
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return NO_SERVER;
      throw error;
    }
  }

  async signIn(token: string): Promise<void> {
    await this.request('POST', '/session', { headers: { Authorization: `Bearer ${token}` } });
  }

  async list(): Promise<readonly ServerProjectSummary[]> {
    return (await this.json<{ projects: ServerProjectSummary[] }>('GET', '/projects')).projects;
  }

  project(id: string): Promise<ServerProject> {
    return this.json('GET', `/projects/${encodeURIComponent(id)}`);
  }

  revisions(id: string): Promise<ServerRevisions> {
    return this.json('GET', `/projects/${encodeURIComponent(id)}/revision`);
  }

  // A section's value and revision; the revision is null when its ETag is missing, as some proxies drop it, and a
  // weak ETag, as compressing proxies make it, still counts.
  async section(id: string, name: string): Promise<{ value: unknown; revision: number | null }> {
    const response = await this.request('GET', `/projects/${encodeURIComponent(id)}/${name}`);
    const tag = /^(?:W\/)?"([0-9]{1,15})"$/.exec(response.headers.get('etag') ?? '');
    return { value: await response.json(), revision: tag === null ? null : Number(tag[1]) };
  }

  // Every level version of the project, oldest first.
  async levelVersions(id: string): Promise<readonly LevelVersionSummary[]> {
    return (await this.json<{ versions: LevelVersionSummary[] }>('GET', `/projects/${encodeURIComponent(id)}/level/versions`)).versions;
  }

  async phantoms(id: string, version: number): Promise<readonly PhantomSummary[]> {
    return (await this.json<{ phantoms: PhantomSummary[] }>('GET', `/projects/${encodeURIComponent(id)}/level/versions/${version}/phantoms`)).phantoms;
  }

  // One phantom recording's bytes, still to be decoded.
  async phantom(id: string, version: number, name: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request('GET', `/projects/${encodeURIComponent(id)}/level/versions/${version}/phantoms/${encodeURIComponent(name)}`, { signal });
    return new Uint8Array(await response.arrayBuffer());
  }

  // Stores one clip of a play session as a phantom recording of the level's `version`; sending a clip again replaces it.
  async postPhantom(id: string, version: number, clip: { session: string; clip: number }, recording: Uint8Array<ArrayBuffer>): Promise<void> {
    const query = new URLSearchParams({ session: clip.session, clip: String(clip.clip) });
    await this.request('POST', `/projects/${encodeURIComponent(id)}/level/versions/${version}/phantoms?${query}`,
      { body: recording, type: 'application/octet-stream' });
  }

  putSection(id: string, name: string, value: unknown, revision?: number): Promise<ServerRevisions> {
    return this.json('PUT', `/projects/${encodeURIComponent(id)}/${name}`, { body: JSON.stringify(value), type: JSON_TYPE, revision });
  }

  async blob(url: string): Promise<Blob> {
    return (await this.request('GET', url.slice(this.base.length))).blob();
  }

  modelUrl(id: string, part: string): string {
    return `${this.base}/projects/${encodeURIComponent(id)}/appearance/${part}/model`;
  }

  putModel(id: string, part: string, blob: Blob, name: string, revision?: number): Promise<ServerRevisions> {
    return this.json('PUT', `/projects/${encodeURIComponent(id)}/appearance/${part}/model?name=${encodeURIComponent(name)}`,
      { body: blob, type: 'model/gltf-binary', revision });
  }

  libraryModelUrl(id: string, role: PartRole, modelId: string): string {
    return `${this.base}/projects/${encodeURIComponent(id)}/models/${role}/${modelId}/model`;
  }

  // Stores a library GLB with its entry; an avatar's settings travel with it, so its bone map is checked against it.
  putLibraryModel(id: string, role: PartRole, entry: LibraryEntry | LibraryAvatarEntry, blob: Blob, revision?: number): Promise<ServerRevisions> {
    const query = new URLSearchParams({ name: entry.name });
    if (role === 'avatar') query.set('settings', JSON.stringify(libraryAvatarSettings(entry as LibraryAvatarEntry)));
    return this.json('PUT', `/projects/${encodeURIComponent(id)}/models/${role}/${entry.id}/model?${query}`,
      { body: blob, type: 'model/gltf-binary', revision });
  }

  mediaUrl(id: string, path: string): string {
    return `${this.base}/projects/${encodeURIComponent(id)}/media/${encodeURIComponent(path.slice('/media/'.length))}`;
  }

  putMedia(id: string, path: string, blob: Blob, revision?: number): Promise<ServerRevisions> {
    return this.json('PUT', `/projects/${encodeURIComponent(id)}/media/${encodeURIComponent(path.slice('/media/'.length))}`,
      { body: blob, type: 'application/octet-stream', revision });
  }

  artUrl(id: string, assetId: string): string {
    return `${this.base}/projects/${encodeURIComponent(id)}/art/assets/${assetId}`;
  }

  async postArt(id: string, blob: Blob, name: string, revision?: number): Promise<ServerRevisions> {
    return this.json('POST', `/projects/${encodeURIComponent(id)}/art/assets?name=${encodeURIComponent(name)}`,
      { body: blob, type: 'model/gltf-binary', revision });
  }

  putBundle(id: string, bundle: ProjectBundle): Promise<ServerRevisions & { id: string }> {
    return this.json('PUT', `/projects/${encodeURIComponent(id)}/bundle`, { body: JSON.stringify(bundle), type: JSON_TYPE });
  }

  publish(id: string): Promise<PublishRecord> {
    return this.json('POST', `/projects/${encodeURIComponent(id)}/publish`);
  }

  async publishStatus(id: string): Promise<{ running: boolean; release: PublishRecord | null }> {
    return this.json('GET', `/projects/${encodeURIComponent(id)}/publish`);
  }

  async sharedCopies(kind: SharedKind): Promise<readonly SharedCopySummary[]> {
    return (await this.json<{ copies: SharedCopySummary[] }>('GET', `/shared/${kind}`)).copies;
  }

  sharedCopy(kind: SharedKind, name: string): Promise<unknown> {
    return this.json('GET', `/shared/${kind}/${encodeURIComponent(name)}`);
  }

  // Stores a copy every Workshop page can load, replacing any copy with that name.
  putSharedCopy(kind: SharedKind, name: string, value: unknown): Promise<SharedCopySummary> {
    return this.json('PUT', `/shared/${kind}/${encodeURIComponent(name)}`, { body: JSON.stringify(value), type: JSON_TYPE });
  }

  private async json<T>(method: string, path: string, options: { body?: BodyInit; type?: string; revision?: number } = {}): Promise<T> {
    return (await this.request(method, path, options)).json() as Promise<T>;
  }

  private async request(method: string, path: string, options: {
    body?: BodyInit; type?: string; revision?: number; headers?: Record<string, string>; signal?: AbortSignal;
  } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: JSON_TYPE, ...options.headers };
    if (method !== 'GET') headers['X-Studio-Request'] = '1';
    if (options.type !== undefined) headers['Content-Type'] = options.type;
    if (options.revision !== undefined) headers['If-Match'] = `"${options.revision}"`;
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, { method, headers, body: options.body, credentials: 'same-origin', signal: options.signal });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ProjectApiError(0, 'offline', 'The project server did not answer. Check that npm run dev or npm run studio is running.');
    }
    if (response.ok) return response;
    let message = `The project server answered ${response.status}.`;
    let code = 'http';
    let section: string | null = null;
    try {
      const body: unknown = await response.json();
      const error = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : null;
      if (typeof error === 'object' && error !== null) {
        message = String(Reflect.get(error, 'message') ?? message);
        code = String(Reflect.get(error, 'code') ?? code);
        const value = Reflect.get(error, 'section');
        section = typeof value === 'string' ? value : null;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new ProjectApiError(response.status, code, message, section);
  }
}
