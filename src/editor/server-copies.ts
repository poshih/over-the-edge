import { ProjectError } from '../project';
import { validateSharedName } from '../shared-copies';
import type { SharedKind } from '../shared-copies';
import type { ProjectClient, ServerHealth } from './project-client';

// Whether this page can list and save shared copies: still looking for the project server, without one (a static
// Workshop), waiting for its token, or signed in.
export type ServerCopiesState = 'checking' | 'offline' | 'signed-out' | 'connected';

/**
 * The copies this Workshop shares with everyone who opens it (see src/shared-copies.ts), kept on the project server
 * and listed once signed in to it.
 */
export class ServerCopies {
  private readonly client: ProjectClient;
  private readonly health: () => ServerHealth | null;
  private readonly listeners = new Set<() => void>();
  private readonly unwatch: () => void;
  private current: ServerCopiesState;

  constructor(options: {
    readonly client: ProjectClient;
    // The project server as the open project last found it, and every change of the open project.
    readonly health: () => ServerHealth | null;
    readonly watch: (listener: () => void) => () => void;
  }) {
    this.client = options.client;
    this.health = options.health;
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

  // The names of the server's copies of a kind; none until signed in.
  async list(kind: SharedKind): Promise<readonly string[]> {
    if (this.current !== 'connected') return [];
    return (await this.client.sharedCopies(kind)).map((copy) => copy.name);
  }

  // A copy's value as stored; the editor validates it.
  async read(kind: SharedKind, name: string): Promise<unknown> {
    try {
      return await this.client.sharedCopy(kind, name);
    } catch (error) {
      // A copy edited by hand or by a merge may no longer be JSON.
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${kind}/${name}.json on the server is not valid JSON.`);
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
