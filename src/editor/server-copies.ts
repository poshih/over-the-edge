import { ProjectError } from '../project';
import { validateSharedName } from '../shared-copies';
import type { SharedKind } from '../shared-copies';
import type { ProjectClient, ServerHealth } from './project-client';
import { downloadServerLevel } from './server-levels';
import type { ServerLevel } from './server-levels';

// A copy a server list offers: one on the project server, or a level file served with this Workshop, which has a name
// unless it is the published project's level.
export type ServerCopy =
  | { readonly source: 'server'; readonly name: string; readonly label: string }
  | { readonly source: 'file'; readonly name: string | null; readonly label: string; readonly file: ServerLevel };

// Whether this page can list and save shared copies: still looking for the project server, without one (a static
// Workshop), waiting for its token, or signed in.
export type ServerCopiesState = 'checking' | 'offline' | 'signed-out' | 'connected';

/**
 * The copies this Workshop shares with everyone who opens it (see src/shared-copies.ts): live on the project server
 * once signed in to it, and otherwise the levels a Workshop build serves. A published project's level comes first.
 */
export class ServerCopies {
  private readonly client: ProjectClient;
  private readonly health: () => ServerHealth | null;
  private readonly published: ServerLevel | null;
  private readonly folder: readonly ServerLevel[];
  private readonly listeners = new Set<() => void>();
  private readonly unwatch: () => void;
  private current: ServerCopiesState;

  constructor(options: {
    readonly client: ProjectClient;
    // The project server as the open project last found it, and every change of the open project.
    readonly health: () => ServerHealth | null;
    readonly watch: (listener: () => void) => () => void;
    // The published project's level, and the levels folder's levels this Workshop was built with.
    readonly levels: { readonly published: ServerLevel | null; readonly folder: readonly ServerLevel[] };
  }) {
    this.client = options.client;
    this.health = options.health;
    this.published = options.levels.published;
    this.folder = options.levels.folder;
    this.current = this.derive();
    this.unwatch = options.watch(() => {
      const next = this.derive();
      if (next === this.current) return;
      this.current = next;
      for (const listener of this.listeners) listener();
    });
  }

  state(): ServerCopiesState {
    return this.current;
  }

  // Called whenever state() changes.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(kind: SharedKind): Promise<readonly ServerCopy[]> {
    const published: ServerCopy[] = kind === 'levels' && this.published !== null
      ? [{ source: 'file', name: null, label: this.published.name, file: this.published }] : [];
    if (this.current === 'connected') {
      const copies = await this.client.sharedCopies(kind);
      return [...published, ...copies.map((copy): ServerCopy => ({ source: 'server', name: copy.name, label: copy.name }))];
    }
    if (kind !== 'levels') return published;
    return [...published, ...this.folder.map((level): ServerCopy => ({ source: 'file', name: level.name, label: level.name, file: level }))];
  }

  // A copy's value as stored; the editor validates it.
  async read(kind: SharedKind, copy: ServerCopy, signal: AbortSignal): Promise<unknown> {
    if (copy.source === 'file') return downloadServerLevel(copy.file, signal);
    try {
      return await this.client.sharedCopy(kind, copy.name);
    } catch (error) {
      // A copy edited by hand or by a merge may no longer be JSON.
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${kind}/${copy.name}.json on the server is not valid JSON.`);
    }
  }

  async save(kind: SharedKind, name: string, value: unknown): Promise<void> {
    await this.client.putSharedCopy(kind, validateSharedName(name), value);
  }

  dispose(): void {
    this.unwatch();
    this.listeners.clear();
  }

  private derive(): ServerCopiesState {
    const server = this.health();
    return server === null ? 'checking' : !server.available ? 'offline' : !server.authenticated ? 'signed-out' : 'connected';
  }
}
