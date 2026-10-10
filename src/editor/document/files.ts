import { Disposal } from '../../disposal';
import { ProjectError } from '../../project';
import { sha256Hex } from '../../sha256';
import { ProjectApiError } from '../project-client';
import type { ProjectClient } from '../project-client';
import { downloadPublishedFile } from '../published-project';
import type { PublishedFile } from '../published-project';

declare const FILE_HANDLE: unique symbol;

export type BinarySectionName = 'art' | 'media' | 'models';

// One version of one binary file, the same frozen object wherever its bytes are: an upload or a download changes what
// the FileStore knows of it, never the handle, so the sections holding it stay the same.
export interface FileHandle {
  readonly [FILE_HANDLE]: true;
  readonly key: string; // Stable file/version identity, not its current URL.
  readonly bytes: number;
}

// Where a server project held a file: its project file path (as projectFileRefs names it, e.g. media/bell.wav) at a
// revision of its section, served at `url`.
export interface ServerFileRef {
  readonly project: string;
  readonly section: BinarySectionName;
  readonly revision: number;
  readonly path: string;
  readonly url: string;
}

export interface ServerFileEntry {
  readonly file: FileHandle;
  readonly source: ServerFileRef;
}

export interface FileLocations {
  readonly page: Blob | null;
  readonly servers: readonly ServerFileRef[];
  readonly published: readonly PublishedFile[];
  readonly sha256: string | null; // Store knowledge, not a mutable handle field.
}

// Who needs a file: the document's current values, the history's steps, or work under way (reads, imports, saves).
export type FileUse = 'document' | 'history' | 'work';

export interface StagedFile {
  readonly handle: FileHandle;
  release(): void;
}

export interface FileUrl {
  readonly url: string;
  release(): void;
}

// Files whose locations changed, told a microtask later.
export interface FileStoreEvent {
  readonly files: readonly FileHandle[];
}

export interface FileStore {
  // Hashes page bytes; the same bytes get the same handle.
  stagePage(blob: Blob, signal: AbortSignal): Promise<StagedFile>;
  registerPublished(file: PublishedFile): FileHandle;
  // A file the server lists, unread: its bytes are only what that revision held at that path.
  registerServer(source: ServerFileRef, bytes: number): FileHandle;

  locations(file: FileHandle): FileLocations;
  // The page keeps its bytes of a file while any use retains it.
  retain(files: readonly FileHandle[], use: FileUse): () => void;
  references(file: FileHandle, use: FileUse): number;
  pageBytes(file: FileHandle): number;

  // The file's bytes, checked to be this version's wherever they come from.
  blob(file: FileHandle, signal: AbortSignal): Promise<Blob>;
  // Where media elements stream it from; a server URL serves whatever the path holds now.
  url(file: FileHandle, type: string): FileUrl;
  hasServer(file: FileHandle, project: string, path: string): boolean;
  serverFiles(
    project: string,
    section: BinarySectionName,
  ): readonly ServerFileEntry[];

  // The server holds the file at `source` now, and nothing else at its path.
  uploaded(file: FileHandle, source: ServerFileRef): void;
  forgetServer(project: string, path: string): void;
  // Another incarnation now answers to the project ID (its revision went back, or it disappeared): no file recorded
  // there is read from it again.
  forgetProject(project: string): void;
  // What this browser's copy can store: page bytes or a published file, never a server URL.
  copySource(file: FileHandle): Blob | PublishedFile | null;

  subscribe(listener: (event: FileStoreEvent) => void): () => void;
  dispose(): void;
}

// Bytes known by their SHA-256 and size, shared by every handle known to hold them.
interface Content {
  readonly sha256: string;
  readonly bytes: number;
  page: Blob | null;
  readonly published: PublishedFile[];
  // The handle staging or publishing these bytes gives out.
  handle: WeakRef<FileHandle> | null;
  readonly handles: Set<WeakRef<FileHandle>>;
  // Those handles' uses: the page lets its bytes go once none is left.
  users: number;
  // Object URLs of the page's bytes by media type, each kept while leased.
  readonly urls: Map<string, { readonly url: string; leases: number }>;
}

// An entry's place in the server index, apart from its handle so the index can let a collected handle go.
interface Indexed {
  readonly ref: WeakRef<FileHandle>;
  readonly paths: Set<string>;
}

interface Entry {
  readonly handle: FileHandle;
  readonly indexed: Indexed;
  content: Content | null;
  // At most one per project and path, newest last.
  readonly servers: ServerFileRef[];
  readonly uses: Record<FileUse, number>;
}

const SECTIONS: readonly BinarySectionName[] = ['art', 'media', 'models'];

function pathKey(project: string, path: string): string {
  return `${project}\n${path}`;
}

async function digest(blob: Blob, signal: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  const sha256 = await sha256Hex(bytes);
  signal.throwIfAborted();
  return sha256;
}

function serverRef(source: ServerFileRef): ServerFileRef {
  if (!SECTIONS.includes(source.section) || !Number.isSafeInteger(source.revision) || source.revision < 0) {
    throw new Error(`A server file needs a binary section and a revision, not ${source.section}@${source.revision}.`);
  }
  return Object.freeze({ project: source.project, section: source.section, revision: source.revision, path: source.path, url: source.url });
}

function changed(source: ServerFileRef): ProjectError {
  return new ProjectError(`${source.path} changed in project "${source.project}" after this page listed it, so the version this `
    + 'page uses cannot be read there.', { section: source.section });
}

// A 404 means the project or the file is gone, so this version is too; any other failure stays as it was.
function gone(error: unknown, source: ServerFileRef): unknown {
  return error instanceof ProjectApiError && error.status === 404
    ? new ProjectError(`${source.path} is no longer in project "${source.project}".`, { section: source.section, cause: error }) : error;
}

/**
 * The project's binary files by handle: the bytes this page holds, the published files and the server project paths
 * holding them. Handles are interned weakly, by digest once known and by server path and revision before, so a
 * handle lives as long as a value holds it while the page keeps bytes only for retained handles.
 */
export function createFileStore(options: { readonly client: ProjectClient }): FileStore {
  const { client } = options;
  const entries = new WeakMap<FileHandle, Entry>();
  // By `${sha256}:${bytes}`.
  const contents = new Map<string, WeakRef<Content>>();
  // Indexed entries by project, then path.
  const servers = new Map<string, Map<string, Set<Indexed>>>();
  // Blobs with known bytes, the page's and verified downloads, which staging takes without hashing again.
  const verified = new WeakMap<Blob, Content>();
  // Contents with object URLs, revoked on dispose.
  const leased = new Set<Content>();
  const listeners = new Set<(event: FileStoreEvent) => void>();
  const pending = new Set<FileHandle>();
  const lifecycle = new AbortController();
  const collected = new FinalizationRegistry<Indexed>((indexed) => {
    for (const key of [...indexed.paths]) {
      const at = key.indexOf('\n');
      unindex(indexed, key.slice(0, at), key.slice(at + 1));
    }
  });
  const forgotten = new FinalizationRegistry<{ readonly key: string; readonly ref: WeakRef<Content> }>(({ key, ref }) => {
    if (contents.get(key) === ref) contents.delete(key);
  });
  let serial = 0;
  let queued = false;
  let disposed = false;

  function live(): void {
    if (disposed) throw new Error('The file store is closed.');
  }

  function entryOf(file: FileHandle): Entry {
    live();
    const entry = entries.get(file);
    if (entry === undefined) throw new Error('The file store does not know this file.');
    return entry;
  }

  // Every listener is told, a microtask later and once for a burst; the first error is rethrown afterwards.
  function tell(files: Iterable<FileHandle>): void {
    if (disposed) return;
    for (const file of files) pending.add(file);
    if (pending.size === 0 || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed || pending.size === 0) return;
      const event: FileStoreEvent = Object.freeze({ files: Object.freeze([...pending]) });
      pending.clear();
      let failure: { readonly error: unknown } | null = null;
      for (const listener of [...listeners]) {
        try { listener(event); } catch (error) { failure ??= { error }; }
      }
      if (failure !== null) throw failure.error;
    });
  }

  function holders(content: Content): FileHandle[] {
    const result: FileHandle[] = [];
    for (const ref of content.handles) {
      const handle = ref.deref();
      if (handle === undefined) content.handles.delete(ref);
      else result.push(handle);
    }
    return result;
  }

  function contentFor(sha256: string, bytes: number): Content {
    const key = `${sha256}:${bytes}`;
    const known = contents.get(key)?.deref();
    if (known !== undefined) return known;
    const content: Content = { sha256, bytes, page: null, published: [], handle: null, handles: new Set(), users: 0, urls: new Map() };
    const ref = new WeakRef(content);
    contents.set(key, ref);
    forgotten.register(content, { key, ref });
    return content;
  }

  function join(entry: Entry, content: Content): void {
    entry.content = content;
    content.handles.add(entry.indexed.ref);
    content.users += entry.uses.document + entry.uses.history + entry.uses.work;
    if (content.handle?.deref() === undefined) content.handle = entry.indexed.ref;
  }

  function index(indexed: Indexed, project: string, path: string): void {
    let paths = servers.get(project);
    if (paths === undefined) {
      paths = new Map();
      servers.set(project, paths);
    }
    let held = paths.get(path);
    if (held === undefined) {
      held = new Set();
      paths.set(path, held);
    }
    held.add(indexed);
    indexed.paths.add(pathKey(project, path));
  }

  function unindex(indexed: Indexed, project: string, path: string): void {
    indexed.paths.delete(pathKey(project, path));
    const paths = servers.get(project);
    const held = paths?.get(path);
    if (paths === undefined || held === undefined) return;
    held.delete(indexed);
    if (held.size > 0) return;
    paths.delete(path);
    if (paths.size === 0) servers.delete(project);
  }

  function located(project: string, path: string): Entry[] {
    const result: Entry[] = [];
    for (const indexed of [...servers.get(project)?.get(path) ?? []]) {
      const handle = indexed.ref.deref();
      // Collected, its finalizer still to run.
      if (handle === undefined) unindex(indexed, project, path);
      else result.push(entries.get(handle)!);
    }
    return result;
  }

  function serverAt(entry: Entry, project: string, path: string): ServerFileRef | undefined {
    return entry.servers.find((source) => source.project === project && source.path === path);
  }

  function locate(entry: Entry, source: ServerFileRef): void {
    unlocate(entry, source.project, source.path);
    entry.servers.push(source);
    index(entry.indexed, source.project, source.path);
  }

  function unlocate(entry: Entry, project: string, path: string): void {
    const at = entry.servers.findIndex((source) => source.project === project && source.path === path);
    if (at >= 0) entry.servers.splice(at, 1);
    unindex(entry.indexed, project, path);
  }

  // Drops every file's place at a project path.
  function forget(project: string, path: string, moved: FileHandle[]): void {
    for (const entry of located(project, path)) {
      unlocate(entry, project, path);
      moved.push(entry.handle);
    }
  }

  function create(key: string, bytes: number, content: Content | null, source: ServerFileRef | null): FileHandle {
    const handle = Object.freeze({ key, bytes }) as FileHandle;
    const indexed: Indexed = { ref: new WeakRef(handle), paths: new Set() };
    const entry: Entry = { handle, indexed, content: null, servers: [], uses: { document: 0, history: 0, work: 0 } };
    entries.set(handle, entry);
    collected.register(handle, indexed);
    if (content !== null) join(entry, content);
    if (source !== null) locate(entry, source);
    return handle;
  }

  function given(content: Content): FileHandle {
    return content.handle?.deref() ?? create(`sha256:${content.sha256}:${content.bytes}`, content.bytes, content, null);
  }

  function count(held: readonly Entry[], use: FileUse, delta: 1 | -1): void {
    for (const entry of held) {
      entry.uses[use] += delta;
      const content = entry.content;
      if (content === null) continue;
      content.users += delta;
      if (content.users > 0 || content.page === null) continue;
      content.page = null;
      tell(holders(content));
    }
  }

  function retain(files: readonly FileHandle[], use: FileUse): () => void {
    const held = files.map(entryOf);
    count(held, use, 1);
    let released = false;
    return () => {
      if (released || disposed) return;
      released = true;
      count(held, use, -1);
    };
  }

  // Without a digest only the section's revision vouches for the bytes: it must be the one they were known at.
  async function sameRevision(source: ServerFileRef, signal: AbortSignal): Promise<void> {
    let revision: number;
    try {
      revision = (await client.revisions(source.project, signal)).sections[source.section] ?? 0;
    } catch (error) {
      throw gone(error, source);
    }
    if (revision !== source.revision) throw changed(source);
  }

  async function serverBlob(entry: Entry, source: ServerFileRef, signal: AbortSignal): Promise<Blob> {
    const known = entry.content !== null;
    if (!known) await sameRevision(source, signal);
    let blob: Blob;
    try {
      blob = await client.blob(source.url, signal);
    } catch (error) {
      throw gone(error, source);
    }
    if (blob.size !== entry.handle.bytes) throw changed(source);
    if (!known) await sameRevision(source, signal);
    const sha256 = await digest(blob, signal);
    // Learned here, or by a read that finished meanwhile.
    let content = entry.content;
    if (content === null) {
      // Only a place the handle still records vouches for these bytes: one forgotten or moved during the read may serve
      // another project's by now. A removed or replaced ref never returns, so checking once, after the last wait, holds.
      if (serverAt(entry, source.project, source.path) !== source) throw changed(source);
      content = contentFor(sha256, blob.size);
      join(entry, content);
      tell([entry.handle]);
    }
    if (content.sha256 !== sha256) throw changed(source);
    verified.set(blob, content);
    return blob;
  }

  function unavailable(entry: Entry): ProjectError {
    const source = entry.servers.at(-1);
    const path = source?.path ?? entry.content?.published[0]?.path ?? 'A project file';
    return new ProjectError(`${path} is not available in this page.`, { section: source?.section ?? null });
  }

  const store: FileStore = {
    async stagePage(blob, signal): Promise<StagedFile> {
      live();
      const reading = AbortSignal.any([signal, lifecycle.signal]);
      reading.throwIfAborted();
      const content = verified.get(blob) ?? contentFor(await digest(blob, reading), blob.size);
      if (content.page === null) {
        content.page = blob;
        verified.set(blob, content);
        tell(holders(content));
      }
      const handle = given(content);
      return Object.freeze({ handle, release: retain([handle], 'work') });
    },
    registerPublished(file): FileHandle {
      live();
      const content = contentFor(file.sha256, file.bytes);
      if (!content.published.some((known) => known.url === file.url)) {
        content.published.push(file);
        tell(holders(content));
      }
      return given(content);
    },
    registerServer(source, bytes): FileHandle {
      live();
      const ref = serverRef(source);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${ref.path} needs its size in bytes.`);
      for (const entry of located(ref.project, ref.path)) {
        const known = serverAt(entry, ref.project, ref.path)!;
        if (known.section === ref.section && known.revision === ref.revision && entry.handle.bytes === bytes) return entry.handle;
      }
      return create(`server:${++serial}`, bytes, null, ref);
    },
    locations(file): FileLocations {
      const { content, servers: sources } = entryOf(file);
      return Object.freeze({
        page: content?.page ?? null,
        servers: Object.freeze([...sources]),
        published: Object.freeze([...content?.published ?? []]),
        sha256: content?.sha256 ?? null,
      });
    },
    retain,
    references(file, use): number {
      return entryOf(file).uses[use];
    },
    pageBytes(file): number {
      const { content } = entryOf(file);
      return content === null || content.page === null ? 0 : file.bytes;
    },
    async blob(file, signal): Promise<Blob> {
      const entry = entryOf(file);
      const reading = AbortSignal.any([signal, lifecycle.signal]);
      reading.throwIfAborted();
      // Each source gives this version's bytes or refuses; the first refusal says why none could.
      const refusals: Error[] = [];
      const content = entry.content;
      if (content !== null) {
        if (content.page !== null) return content.page;
        for (const published of [...content.published]) {
          try {
            const blob = new Blob([await downloadPublishedFile(published, reading)]);
            verified.set(blob, content);
            return blob;
          } catch (error) {
            if (!(error instanceof ProjectError)) throw error;
            refusals.push(error);
          }
        }
      }
      for (const source of [...entry.servers].reverse()) {
        try {
          return await serverBlob(entry, source, reading);
        } catch (error) {
          if (!(error instanceof ProjectError)) throw error;
          refusals.push(error);
        }
      }
      throw refusals[0] ?? unavailable(entry);
    },
    url(file, type): FileUrl {
      const entry = entryOf(file);
      const content = entry.content;
      if (content !== null) {
        let held = content.urls.get(type);
        const page = content.page;
        if (held === undefined && page !== null) {
          held = { url: URL.createObjectURL(page.type === type ? page : page.slice(0, page.size, type)), leases: 0 };
          content.urls.set(type, held);
          leased.add(content);
        }
        if (held !== undefined) {
          const lease = held;
          lease.leases++;
          let released = false;
          return Object.freeze({
            url: lease.url,
            release: () => {
              if (released || disposed) return;
              released = true;
              if (--lease.leases > 0) return;
              URL.revokeObjectURL(lease.url);
              if (content.urls.get(type) === lease) content.urls.delete(type);
              if (content.urls.size === 0) leased.delete(content);
            },
          });
        }
      }
      const url = content?.published[0]?.url ?? entry.servers.at(-1)?.url;
      if (url === undefined) throw unavailable(entry);
      return Object.freeze({ url, release: () => undefined });
    },
    hasServer(file, project, path): boolean {
      return serverAt(entryOf(file), project, path) !== undefined;
    },
    serverFiles(project, section): readonly ServerFileEntry[] {
      live();
      const result: ServerFileEntry[] = [];
      for (const path of [...servers.get(project)?.keys() ?? []]) {
        for (const entry of located(project, path)) {
          const source = serverAt(entry, project, path)!;
          if (source.section === section) result.push(Object.freeze({ file: entry.handle, source }));
        }
      }
      return Object.freeze(result);
    },
    uploaded(file, source): void {
      const entry = entryOf(file);
      const ref = serverRef(source);
      const moved = [file];
      for (const other of located(ref.project, ref.path)) {
        if (other === entry) continue;
        unlocate(other, ref.project, ref.path);
        moved.push(other.handle);
      }
      locate(entry, ref);
      tell(moved);
    },
    forgetServer(project, path): void {
      live();
      const moved: FileHandle[] = [];
      forget(project, path, moved);
      tell(moved);
    },
    forgetProject(project): void {
      live();
      const moved: FileHandle[] = [];
      for (const path of [...servers.get(project)?.keys() ?? []]) forget(project, path, moved);
      tell(moved);
    },
    copySource(file): Blob | PublishedFile | null {
      const { content } = entryOf(file);
      return content?.page ?? content?.published[0] ?? null;
    },
    subscribe(listener): () => void {
      live();
      const subscribed = (event: FileStoreEvent): void => listener(event);
      listeners.add(subscribed);
      return () => { listeners.delete(subscribed); };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const disposal = new Disposal();
      disposal.run(() => lifecycle.abort());
      for (const content of leased) {
        for (const { url } of content.urls.values()) disposal.run(() => URL.revokeObjectURL(url));
        content.urls.clear();
      }
      leased.clear();
      servers.clear();
      contents.clear();
      listeners.clear();
      pending.clear();
      disposal.finish();
    },
  };
  return Object.freeze(store);
}
