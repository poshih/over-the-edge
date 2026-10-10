import { Disposal } from '../../disposal';
import { PluginError } from '../../plugins/kernel';
import type { FileHandle, FileStore } from './files';
import type { Command, History, PendingEdit } from './history';
import { isProjectRefusal } from './project-commands';
import type { ProjectRefusal } from './project-commands';
import type { SectionName } from './project-document';
import type { EditOutcome, ImportOptions } from './project-imports';

// One import's work, from before its first read to its step. What it stages, retains or owns lives as long as it does.
export interface PendingContext {
  // Aborts once the import stops.
  readonly signal: AbortSignal;
  // Throws once the import cannot finish: cancelled, superseded, its target changed or its project gone.
  check(): void;
  // Claims `key`, stopping the import that held it. A guard stops this one once a change of `sections` fails `unchanged`.
  target(key: string): void;
  target(key: string, sections: readonly SectionName[], unchanged: () => boolean): void;
  // A guard without a claim.
  watch(sections: readonly SectionName[], unchanged: () => boolean): void;
  // Stops every import whose target key starts with `prefix`.
  stopTargets(prefix: string): void;
  // Waits for `run`, abandoned once the import stops; a late result never resumes it.
  wait<T>(run: () => Promise<T>): Promise<T>;
  // The handle of `blob`'s bytes, which the page keeps.
  stage(blob: Blob): Promise<FileHandle>;
  // The page keeps these files' bytes.
  retain(files: readonly FileHandle[]): void;
  // Runs `release` once the import ends.
  own(release: () => void): void;
}

export interface PreparedImport<T> {
  // Built as the step finishes, after an open transaction commits, and run at once.
  command(): Command;
  value(): T;
}

/**
 * Imports as pending edits: each is the newest action from before its first read until its data is ready, then one
 * step, or nothing when it was cancelled (Undo, its owner's signal, another import of its target, a guarded change of
 * its target, or the project's invalidation) or refused. Every import of the project runs here.
 */
export interface ImportRunner {
  // `start` runs before the pending edit, for cheap refusals and target claims; `build` reads, checks and stages.
  // `refuse` types what either throws, rethrowing anything that is not a refusal.
  edit<T, P>(
    options: ImportOptions,
    refuse: (error: unknown) => ProjectRefusal,
    start: (work: PendingContext) => P,
    build: (work: PendingContext, prepared: P) => Promise<PreparedImport<T>>,
  ): Promise<EditOutcome<T>>;
  // Another project opens: every import stops.
  invalidateProject(): void;
  dispose(): void;
}

interface TargetGuard {
  readonly job: ImportJob;
  readonly sections: readonly SectionName[];
  readonly unchanged: () => boolean;
}

interface ImportJob {
  readonly controller: AbortController;
  readonly generation: number;
  readonly releases: Set<() => void>;
  readonly keys: Set<string>;
  readonly guards: Set<TargetGuard>;
  pending: PendingEdit | null;
  finishing: boolean;
  ended: boolean;
  cancellationQueued: boolean;
}

class CancelledImport extends Error {}

const CANCELLED = Object.freeze({ kind: 'cancelled' } as const);

export function createImportRunner(options: { readonly history: History; readonly files: FileStore }): ImportRunner {
  const { history, files } = options;
  const document = history.document;
  const jobs = new Set<ImportJob>();
  const targets = new Map<string, ImportJob>();
  const watched = new Map<SectionName, Set<TargetGuard>>();
  const leases = new Set<() => void>();
  let generation = 0;
  let disposed = false;

  function owned(release: () => void): () => void {
    let released = false;
    const done = (): void => {
      if (released) return;
      released = true;
      leases.delete(done);
      release();
    };
    leases.add(done);
    return done;
  }

  function own(job: ImportJob, release: () => void): void {
    if (job.ended || disposed) {
      release();
      throw new CancelledImport();
    }
    job.releases.add(owned(release));
  }

  function cancelPending(job: ImportJob): void {
    if (!job.finishing && job.pending !== null && !job.pending.done) job.pending.cancel();
  }

  function stop(job: ImportJob): void {
    if (!job.controller.signal.aborted) job.controller.abort();
  }

  function live(job: ImportJob): void {
    if (disposed || job.ended || job.generation !== generation || job.controller.signal.aborted ||
      (job.pending !== null && job.pending.done && !job.finishing)) throw new CancelledImport();
    for (const guard of job.guards) {
      if (guard.unchanged()) continue;
      stop(job);
      throw new CancelledImport();
    }
  }

  function watch(job: ImportJob, sections: readonly SectionName[], unchanged: () => boolean): void {
    const guard: TargetGuard = { job, sections, unchanged };
    job.guards.add(guard);
    for (const section of sections) {
      let guards = watched.get(section);
      if (guards === undefined) { guards = new Set(); watched.set(section, guards); }
      guards.add(guard);
    }
  }

  function target(job: ImportJob, key: string, sections: readonly SectionName[] = [], unchanged?: () => boolean): void {
    const previous = targets.get(key);
    if (previous !== undefined && previous !== job) stop(previous);
    targets.set(key, job);
    job.keys.add(key);
    if (unchanged !== undefined) watch(job, sections, unchanged);
  }

  function stopTargets(prefix: string): void {
    const previous = new Set<ImportJob>();
    for (const [key, job] of targets) if (key.startsWith(prefix)) previous.add(job);
    for (const job of previous) stop(job);
  }

  // Native blob reads and shared bakes can settle late; cancellation never resumes their edit.
  function wait<T>(job: ImportJob, run: () => Promise<T>): Promise<T> {
    live(job);
    const task = run();
    const signal = job.controller.signal;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        run();
      };
      const aborted = (): void => finish(() => reject(new CancelledImport()));
      signal.addEventListener('abort', aborted, { once: true });
      task.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
      if (signal.aborted) aborted();
    });
  }

  function stage(job: ImportJob, blob: Blob): Promise<FileHandle> {
    live(job);
    return wait(job, () => files.stagePage(blob, job.controller.signal).then((staged) => {
      if (job.ended || job.controller.signal.aborted || disposed) {
        staged.release();
        throw new CancelledImport();
      }
      job.releases.add(owned(() => staged.release()));
      return staged.handle;
    }));
  }

  function context(job: ImportJob): PendingContext {
    return Object.freeze({
      signal: job.controller.signal,
      check: () => live(job),
      target: (key: string, sections?: readonly SectionName[], unchanged?: () => boolean) => target(job, key, sections, unchanged),
      watch: (sections: readonly SectionName[], unchanged: () => boolean) => watch(job, sections, unchanged),
      stopTargets,
      wait: <T>(run: () => Promise<T>) => wait(job, run),
      stage: (blob: Blob) => stage(job, blob),
      retain: (handles: readonly FileHandle[]) => own(job, files.retain(handles, 'work')),
      own: (release: () => void) => own(job, release),
    });
  }

  function close(job: ImportJob, owner: AbortSignal, ownerAborted: () => void, aborted: () => void): void {
    job.ended = true;
    jobs.delete(job);
    for (const key of job.keys) if (targets.get(key) === job) targets.delete(key);
    for (const guard of job.guards) {
      for (const section of guard.sections) {
        const guards = watched.get(section);
        guards?.delete(guard);
        if (guards?.size === 0) watched.delete(section);
      }
    }
    const disposal = new Disposal();
    disposal.run(() => cancelPending(job));
    disposal.run(() => owner.removeEventListener('abort', ownerAborted));
    disposal.run(() => job.controller.signal.removeEventListener('abort', aborted));
    for (const release of job.releases) disposal.run(release);
    job.releases.clear();
    disposal.finish();
  }

  async function edit<T, P>(
    input: ImportOptions,
    refuse: (error: unknown) => ProjectRefusal,
    start: (work: PendingContext) => P,
    build: (work: PendingContext, prepared: P) => Promise<PreparedImport<T>>,
  ): Promise<EditOutcome<T>> {
    if (disposed || input.signal.aborted) return CANCELLED;
    const job: ImportJob = {
      controller: new AbortController(), generation, releases: new Set(), keys: new Set(), guards: new Set(),
      pending: null, finishing: false, ended: false, cancellationQueued: false,
    };
    const work = context(job);
    const ownerAborted = (): void => stop(job);
    // An abort can come while the document is telling its listeners, so the pending edit is cancelled a microtask later.
    const aborted = (): void => {
      if (job.ended || job.cancellationQueued) return;
      job.cancellationQueued = true;
      queueMicrotask(() => {
        job.cancellationQueued = false;
        if (!job.ended) cancelPending(job);
      });
    };
    jobs.add(job);
    input.signal.addEventListener('abort', ownerAborted, { once: true });
    job.controller.signal.addEventListener('abort', aborted, { once: true });
    let outcome: EditOutcome<T> | null = null;
    let failure: { readonly error: unknown } | null = null;
    try {
      const prepared = start(work);
      live(job);
      job.pending = history.prepare({
        ...input.info,
        cancelled: () => { if (!job.finishing) stop(job); },
      });
      live(job);
      const ready = await build(work, prepared);
      live(job);
      let changed = false;
      let command: Command | null = null;
      const preparedCommand = (): Command => {
        live(job);
        if (command === null) command = ready.command();
        return command;
      };
      job.finishing = true;
      let error: Error | null;
      try {
        error = job.pending.finish({
          // The factory reads after finish commits any transaction, with no async gap before run.
          get label() { return preparedCommand().label; },
          get place() { return preparedCommand().place; },
          get coalesce() { return preparedCommand().coalesce; },
          run(current) {
            live(job);
            const changes = preparedCommand().run(current);
            live(job);
            changed = changes.some((change) => change.before !== change.after);
            return changes;
          },
        });
      } finally {
        job.finishing = false;
      }
      if (error !== null && !isProjectRefusal(error)) throw error;
      outcome = error === null
        ? Object.freeze({ kind: changed ? 'applied' : 'unchanged', value: ready.value() })
        : Object.freeze({ kind: 'refused', error });
      return outcome;
    } catch (error) {
      if (error instanceof CancelledImport || (!(error instanceof PluginError) &&
        (job.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')))) {
        outcome = CANCELLED;
      } else {
        try {
          outcome = Object.freeze({ kind: 'refused', error: refuse(error) });
        } catch (unexpected) {
          failure = { error: unexpected };
          throw unexpected;
        }
      }
      return outcome;
    } finally {
      const disposal = new Disposal();
      const failed = failure;
      if (failed !== null) disposal.run(() => { throw failed.error; });
      if (outcome === null || outcome.kind === 'cancelled' || outcome.kind === 'refused') disposal.run(() => stop(job));
      disposal.run(() => close(job, input.signal, ownerAborted, aborted));
      disposal.finish();
    }
  }

  const unsubscribe = document.subscribeAll((changes) => {
    const guards = new Set<TargetGuard>();
    for (const change of changes) for (const guard of watched.get(change.section) ?? []) guards.add(guard);
    for (const guard of guards) {
      if (guard.job.ended || guard.job.finishing || guard.job.pending?.done) continue;
      if (!guard.unchanged()) stop(guard.job);
    }
  });

  function invalidate(): void {
    generation++;
    const disposal = new Disposal();
    for (const job of jobs) {
      disposal.run(() => stop(job));
      disposal.run(() => cancelPending(job));
    }
    disposal.finish();
  }

  return Object.freeze({
    edit,
    invalidateProject(): void {
      if (!disposed) invalidate();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const disposal = new Disposal();
      disposal.run(unsubscribe);
      disposal.run(invalidate);
      for (const release of leases) disposal.run(release);
      disposal.finish();
    },
  });
}
