import { loadProjectDocuments, PROJECT_FILES, ProjectError, projectFileRefs, validateProjectManifest } from '../project';
import type { OpenedFile, OpenedProject, PublishedFile } from './published-project';
import { VisualStore, VisualStoreError } from './visual-store';

// The record next to the project's files; no project file has this path.
const STATE = 'workshop-state';
const VERSION = 1;

interface CopyRecord {
  readonly path: string;
  readonly value: unknown;
}

// Which page wrote the copy last, and its how-many-th write that was.
interface WriteMark {
  readonly writer: string;
  readonly sequence: number;
}

function writeMark(value: unknown): WriteMark | null {
  if (typeof value !== 'object' || value === null) return null;
  const writer: unknown = Reflect.get(value, 'writer');
  const sequence: unknown = Reflect.get(value, 'sequence');
  return typeof writer === 'string' && Number.isSafeInteger(sequence) ? { writer, sequence: sequence as number } : null;
}

function sameMark(a: WriteMark | null, b: WriteMark | null): boolean {
  return a === null || b === null ? a === b : a.writer === b.writer && a.sequence === b.sequence;
}

function copyState(value: unknown): { origin: string | null; dirty: string[]; mark: WriteMark } {
  const mark = writeMark(value);
  if (mark !== null && Reflect.get(value as object, 'schemaVersion') === VERSION) {
    const origin: unknown = Reflect.get(value as object, 'origin');
    const dirty: unknown = Reflect.get(value as object, 'dirty');
    if ((origin === null || typeof origin === 'string') && Array.isArray(dirty) && dirty.every((name) => typeof name === 'string')) {
      return { origin, dirty, mark };
    }
  }
  throw new ProjectError('This browser\'s copy of the project is from an unsupported version.');
}

export interface ProjectCopy {
  // The published version this copy started from, or null for an imported or new project.
  readonly origin: string | null;
  // Sections that had unsaved changes when the copy was written.
  readonly dirty: readonly string[];
  readonly content: OpenedProject;
}

// A stored published file: its size and SHA-256 name its bytes in any deployment that still serves them.
function publishedReference(value: unknown): { sha256: string; bytes: number } | null {
  if (typeof value !== 'object' || value === null || value instanceof Blob) return null;
  const sha256: unknown = Reflect.get(value, 'sha256');
  const bytes: unknown = Reflect.get(value, 'bytes');
  return typeof sha256 === 'string' && Number.isSafeInteger(bytes) ? { sha256, bytes: bytes as number } : null;
}

/**
 * This browser's copy of the open project, stored like a project directory: every file under its
 * path (JSON values; a Blob for each binary file the page holds, and the served file for each one
 * this Workshop serves, which stays on the site) next to one state record. A write stores only
 * the files that changed and removes the ones that are gone, in one transaction; after another
 * page (another tab) wrote the copy, it rewrites all of it, so the copy is always one page's project.
 */
export class ProjectCopyStore {
  private readonly served: readonly PublishedFile[];
  private readonly store = new VisualStore<CopyRecord>({ database: 'over-the-edge:project-copy', store: 'files', keyPath: 'path' });
  // getRandomValues, unlike randomUUID, also works on plain-HTTP addresses.
  private readonly writer = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  private sequence = 0;
  // The stored files as last read or written, or null when unknown: the next write then starts afresh.
  private stored: Map<string, unknown> | null = null;
  // The mark of the copy this page last wrote or opened, and of the copy it last read.
  private mark: WriteMark | null = null;
  private readMark: WriteMark | null = null;

  // `served`, the files this Workshop serves (its published project's and the built-in course's), resolves the copy's
  // published files: a copy started from an older deployment opens while this one still serves the files it uses.
  constructor(served: readonly PublishedFile[]) {
    this.served = served;
  }

  // Reads the copy without its files' bytes: JSON files are validated as a project's, binary files stay Blobs this page
  // reads only when it uses them, or published files.
  async read(): Promise<ProjectCopy | null> {
    this.stored = null;
    this.readMark = null;
    const entries = await this.guard(() => this.store.entries(), 'could not be read');
    if (entries.length === 0) {
      this.stored = new Map();
      this.mark = null;
      return null;
    }
    const records = new Map(entries.map((entry) => [String(entry.key),
      typeof entry.value === 'object' && entry.value !== null ? Reflect.get(entry.value, 'value') : undefined]));
    const { origin, dirty, mark } = copyState(records.get(STATE));
    this.readMark = mark;
    const manifest = validateProjectManifest(records.get(PROJECT_FILES.manifest));
    const documents = loadProjectDocuments(manifest, (ref) => records.get(ref.path));
    const files = new Map<string, OpenedFile>();
    for (const ref of projectFileRefs(manifest)) {
      if (!ref.binary) continue;
      const value = records.get(ref.path);
      const reference = publishedReference(value);
      if (value instanceof Blob && value.size > 0 && value.size <= ref.maxBytes) files.set(ref.path, value);
      else if (reference !== null) files.set(ref.path, this.publishedFile(ref.path, reference));
      else throw new ProjectError(`This browser's copy of the project is missing ${ref.path}.`, { section: ref.path });
    }
    return { origin, dirty, content: Object.freeze({ ...documents, files }) };
  }

  // After the page opened the copy it read: `files` are the page's values for what the store holds.
  adopt(files: ReadonlyMap<string, unknown>): void {
    this.stored = new Map(files);
    this.mark = this.readMark;
  }

  async write(state: { origin: string | null; dirty: readonly string[] }, files: ReadonlyMap<string, unknown>): Promise<void> {
    const previous = this.stored;
    const expected = this.mark;
    const mark: WriteMark = { writer: this.writer, sequence: ++this.sequence };
    this.stored = null;
    await this.guard(() => this.store.update((store) => {
      const current = store.get(STATE);
      current.onsuccess = () => {
        const kept = previous !== null && sameMark(writeMark(Reflect.get(current.result ?? {}, 'value')), expected) ? previous : null;
        if (kept === null) store.clear();
        store.put({ path: STATE, value: { schemaVersion: VERSION, origin: state.origin, dirty: [...state.dirty], ...mark } });
        for (const [path, value] of files) if (kept?.get(path) !== value) store.put({ path, value });
        for (const path of kept?.keys() ?? []) if (!files.has(path)) store.delete(path);
      };
    }), 'could not be saved; browser storage may be blocked or full. Export the project file to keep your changes');
    this.stored = new Map(files);
    this.mark = mark;
  }

  async clear(): Promise<void> {
    this.stored = null;
    await this.guard(() => this.store.update((store) => store.clear()), 'could not be removed');
    this.stored = new Map();
    this.mark = null;
  }

  dispose(): void {
    this.store.close();
  }

  // The file this deployment serves with a stored published file's bytes, wherever it is.
  private publishedFile(path: string, reference: { sha256: string; bytes: number }): PublishedFile {
    const file = this.served.find((candidate) => candidate.sha256 === reference.sha256 && candidate.bytes === reference.bytes);
    if (file === undefined) {
      throw new ProjectError(`This browser's copy of the project uses ${path} from a published version this site no longer serves.`, { section: path });
    }
    return file;
  }

  private async guard<T>(task: () => Promise<T>, problem: string): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof VisualStoreError)) throw error;
      throw new ProjectError(`This browser's copy of the project ${problem}.`, { cause: error });
    }
  }
}
