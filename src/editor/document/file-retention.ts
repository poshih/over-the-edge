import { Disposal } from '../../disposal';
import type { BinarySectionName, FileHandle, FileStore, ServerFileEntry } from './files';

export interface ServerFileWrite {
  readonly section: BinarySectionName;
  // Project file paths, as ServerFileRef names them.
  readonly files: readonly {
    readonly path: string;
    readonly file: FileHandle;
  }[];
  // false: upload/overwrite listed paths; true: final whole-section listing.
  readonly replacesSection: boolean;
}

// After its request: finish when the server acknowledged it, uncertain when it may have changed the server unanswered,
// neither when the server refused it; release in every case.
export interface PreparedFileWrite {
  // After the request acknowledged this section revision; FileStore.uploaded records where an upload went.
  finish(revision: number): void;
  // Request may have changed the server but no acknowledgement was received.
  uncertain(): void;
  release(): void;
}

// Before a request of this page destroys a server project's copy of files (by leaving them out of a section's listing,
// overwriting their paths or replacing the project), the page comes to hold every one the document or history uses.
export interface ProjectFileRetention {
  // Refuses with the read's error when the page cannot get such a file, so the request must not be sent.
  prepare(
    project: string,
    write: ServerFileWrite,
    signal: AbortSignal,
  ): Promise<PreparedFileWrite>;
  dispose(): void;
}

export function createProjectFileRetention(options: { readonly files: FileStore }): ProjectFileRetention {
  const { files } = options;
  const lifecycle = new AbortController();
  // Each prepared write's release, until it runs.
  const outstanding = new Set<() => void>();
  let disposed = false;

  // Undo or Redo can still need it.
  function used(file: FileHandle): boolean {
    return files.references(file, 'document') + files.references(file, 'history') > 0;
  }

  // A used file whose bytes the page lacks: a server copy goes with the request, and a published one may go with the
  // next deployment.
  function exposed(destroyed: readonly ServerFileEntry[]): FileHandle | null {
    for (const { file } of destroyed) {
      if (used(file) && files.locations(file).page === null) return file;
    }
    return null;
  }

  return Object.freeze({
    async prepare(project: string, write: ServerFileWrite, signal: AbortSignal): Promise<PreparedFileWrite> {
      if (disposed) throw new Error('The file retention is closed.');
      const listed = new Map<string, FileHandle>();
      for (const { path, file } of write.files) {
        if (listed.has(path)) throw new Error(`A file write lists ${path} twice.`);
        listed.set(path, file);
      }
      // The paths the request leaves as they are.
      const untouched = (path: string): boolean => write.replacesSection ? listed.has(path) : !listed.has(path);
      // The known server files the request removes or overwrites with other bytes.
      const destroyed = (): readonly ServerFileEntry[] => files.serverFiles(project, write.section)
        .filter(({ file, source }) => !untouched(source.path) && listed.get(source.path) !== file);
      const reading = AbortSignal.any([signal, lifecycle.signal]);
      const leases: (() => void)[] = [];
      const releaseLeases = (): void => {
        const disposal = new Disposal();
        for (const release of leases.splice(0)) disposal.run(release);
        disposal.finish();
      };
      try {
        reading.throwIfAborted();
        // A download waits, so what the request destroys and who uses it is worked out again after each.
        for (let file = exposed(destroyed()); file !== null; file = exposed(destroyed())) {
          const staged = await files.stagePage(await files.blob(file, reading), reading);
          leases.push(staged.release);
          if (files.locations(file).page === null) throw new Error('A preserved file must be held by the page.');
        }
        reading.throwIfAborted();
        leases.push(files.retain([...new Set(destroyed().map(({ file }) => file))].filter(used), 'work'));
      } catch (error) {
        const disposal = new Disposal();
        disposal.run(() => { throw error; });
        disposal.run(releaseLeases);
        disposal.finish();
      }
      let settled = false;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        outstanding.delete(release);
        releaseLeases();
      };
      outstanding.add(release);
      // False once dispose released the write: its answer has nothing left to update.
      const settle = (): boolean => {
        if (disposed) return false;
        if (settled || released) throw new Error('A prepared file write settles once, before its release.');
        settled = true;
        return true;
      };
      return Object.freeze({
        finish(revision: number): void {
          if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`A section revision is a positive integer, not ${revision}.`);
          if (!settle()) return;
          const known = files.serverFiles(project, write.section);
          if (write.replacesSection) {
            for (const path of new Set(known.map(({ source }) => source.path).filter((path) => !untouched(path)))) {
              files.forgetServer(project, path);
            }
          } else {
            // Each listed path holds its file now: its known place there moves to this revision, any other file's goes.
            for (const [path, file] of listed) {
              const here = known.filter(({ source }) => source.path === path);
              const own = here.find((entry) => entry.file === file);
              if (own !== undefined) {
                if (own.source.revision !== revision || here.length > 1) files.uploaded(file, { ...own.source, revision });
              } else if (here.length > 0) files.forgetServer(project, path);
            }
          }
          // The server counts each change of a section once, so a file one revision behind sat this request out.
          for (const { file, source } of known) {
            if (untouched(source.path) && source.revision === revision - 1) files.uploaded(file, { ...source, revision });
          }
        },
        uncertain(): void {
          if (!settle()) return;
          // Whatever the request touches may be gone or replaced.
          const touched = files.serverFiles(project, write.section).filter(({ source }) => !untouched(source.path));
          for (const path of new Set(touched.map(({ source }) => source.path))) files.forgetServer(project, path);
        },
        release,
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const disposal = new Disposal();
      disposal.run(() => lifecycle.abort());
      for (const release of [...outstanding]) disposal.run(release);
      disposal.finish();
    },
  });
}
