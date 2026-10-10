import { Disposal } from '../../disposal';
import { PLUGIN_DATA_LIMITS, pluginOfSection } from '../../plugin-data';
import type { FileHandle, FileStore } from './files';
import type {
  BuiltinDocumentSectionName, ChangeCause, ProjectDocument, SectionChange, SectionName, SectionValue, SectionValues, Selection,
  SomeSectionChange, StepInfo, StepPlace,
} from './project-document';
import { adapterFor, SECTION_ADAPTERS } from './sections';

export const HISTORY_LIMITS = Object.freeze({ steps: 200, bytes: 64 * 1024 * 1024, label: 80, coalesceMs: 1000 });

export interface Command extends StepInfo {
  readonly coalesce: string | null;
  // Changes from the current document, at most one per section; throws a typed refusal without changes.
  run(document: ProjectDocument): readonly SomeSectionChange[];
}

// One step built over time: a live drag or a plugin's group.
export interface Transaction {
  apply(run: Command['run']): Error | null;          // Shown at once; returns a typed refusal without changes.
  commit(select?: Selection): void;                 // Everything applied becomes one step, unless nothing remains.
  cancel(): void;                                   // Restores its changes and records nothing.
}

// An edit waiting for a bake or a file, or an outline being drawn.
export interface PendingEdit<T = never> {
  readonly done: boolean;
  step(label: string, before: T, after: T): void;    // A step of its own; makes this the newest action.
  undoStep(): void;                                 // Takes back its newest stroke without cancelling.
  finish(command: Command): Error | null;           // One step on top of the history.
  cancel(): void;
}

export interface HistoryAction {
  readonly label: string;
  readonly place: StepPlace;
  // 'step' undoes/redoes a step; 'stroke' a pending stroke; 'cancel' ends a pending edit (Undo only).
  readonly kind: 'step' | 'stroke' | 'cancel';
}

export interface HistoryState {
  readonly steps: number;                           // Steps Undo can take back.
  readonly redoSteps: number;                       // Steps Redo can put back.
  readonly bytes: number;                           // Estimated bytes held by all undo and redo steps.
  readonly undo: HistoryAction | null;              // What Undo would do now, described even while held.
  readonly redo: HistoryAction | null;              // What Redo would do now, described even while held.
  readonly pending: readonly string[];              // Pending edits' labels, oldest first.
  readonly transaction: string | null;              // The open transaction's label.
  readonly held: boolean;                           // Undo and Redo wait while a project opens, imports or updates.
}

export interface History {
  readonly document: ProjectDocument;
  apply(command: Command): Error | null;
  // Commands applied inside take the key and label.
  coalescing<R>(key: string, label: string, run: () => R): R;
  seal(key: string): void;
  begin(info: StepInfo): Transaction;
  prepare<T = never>(info: StepInfo & { restore?(value: T): void; cancelled(): void }): PendingEdit<T>;
  undo(): void;
  redo(): void;
  load(values: SectionValues): void;                // Another project: clears steps and pending edits.
  external(changes: readonly SomeSectionChange[], cause?: 'server' | 'edit'): void;
  cut(sections: readonly SectionName[]): void;      // Drops the newest touching step, every older one and all redo.
  hold(): () => void;                               // Undo and Redo wait until every returned release has run.
  state(): HistoryState;
  subscribe(listener: () => void): () => void;      // Hears every change of state().
  dispose(): void;
}

export interface HistoryOptions {
  readonly files: FileStore;
}

type SectionListener<S extends SectionName> =
  (change: SectionChange<S>, cause: ChangeCause, step: StepInfo | null) => void;

type BatchListener = (changes: readonly SomeSectionChange[], cause: ChangeCause, step: StepInfo | null) => void;
type ChangeListener = (change: SomeSectionChange, cause: ChangeCause, step: StepInfo | null) => void;

interface Link<T> {
  readonly value: T;
  previous: Link<T> | null;
  next: Link<T> | null;
}

class Chain<T> {
  first: Link<T> | null = null;
  last: Link<T> | null = null;
  size = 0;

  append(value: T): Link<T> {
    const link: Link<T> = { value, previous: this.last, next: null };
    if (this.last !== null) this.last.next = link;
    else this.first = link;
    this.last = link;
    this.size++;
    return link;
  }

  remove(link: Link<T>): void {
    if (link.previous !== null) link.previous.next = link.next;
    else this.first = link.next;
    if (link.next !== null) link.next.previous = link.previous;
    else this.last = link.previous;
    link.previous = null;
    link.next = null;
    this.size--;
  }

  clear(): void {
    this.first = null;
    this.last = null;
    this.size = 0;
  }
}

interface StoredStep {
  info: StepInfo;
  changes: readonly SomeSectionChange[];
  bytes: number;
  readonly order: number;
  readonly key: string | null;
  readonly epoch: number;
  sealedAt: number | null;
  readonly sections: Map<SectionName, Link<StoredStep>>;
  release: () => void;
}

interface StepResources {
  readonly bytes: number;
  readonly release: () => void;
}

interface LiveTransaction {
  readonly info: StepInfo;
  changes: readonly SomeSectionChange[];
  release: () => void;
  done: boolean;
}

interface Stroke {
  readonly label: string;
  readonly before: () => void;
  readonly after: () => void;
}

interface LivePending {
  readonly info: StepInfo;
  order: number;
  readonly strokes: Stroke[];
  readonly undone: Stroke[];
  readonly cancelled: () => void;
  entry: Link<LivePending> | null;
  done: boolean;
}

function label(value: string): string {
  if (value.length === 0) throw new Error('A history step needs a label.');
  return value.length <= HISTORY_LIMITS.label ? value : value.slice(0, HISTORY_LIMITS.label - 1) + '…';
}

function selection(value: Selection): Selection {
  return Object.freeze({ before: Object.freeze([...value.before]), after: Object.freeze([...value.after]) });
}

function stepInfo(info: StepInfo, name = info.label): StepInfo {
  return Object.freeze({
    label: label(name),
    place: Object.freeze({ ...info.place, select: info.place.select === null ? null : selection(info.place.select) }),
  });
}

function withSelection(info: StepInfo, select: Selection): StepInfo {
  return Object.freeze({ ...info, place: Object.freeze({ ...info.place, select }) });
}

function mergedInfo(first: StepInfo, next: StepInfo): StepInfo {
  const before = first.place.select;
  const after = next.place.select;
  return before !== null && after !== null
    ? withSelection(first, Object.freeze({ before: before.before, after: after.after })) : first;
}

function action(info: StepInfo, kind: HistoryAction['kind'], name = info.label): HistoryAction {
  return Object.freeze({ label: name, place: info.place, kind });
}

function frozen(value: unknown): void {
  if (!Object.isFrozen(value)) throw new Error('A project section must be frozen.');
}

export function createHistory(initial: SectionValues, options: HistoryOptions): History {
  const builtin = Object.keys(SECTION_ADAPTERS.builtin) as BuiltinDocumentSectionName[];
  const values = new Map<SectionName, SectionValue<SectionName>>();
  const documentFiles = new Map<SectionName, () => void>();
  const sectionListeners = new Map<SectionName, Set<ChangeListener>>();
  const batchListeners = new Set<BatchListener>();
  const refusals = new Set([
    ...Object.values(SECTION_ADAPTERS.builtin).map((adapter) => adapter.refusal), SECTION_ADAPTERS.plugins.refusal,
  ]);
  let names: readonly SectionName[] | null = null;
  let disposed = false;

  function read<S extends SectionName>(section: S): SectionValue<S> {
    if (disposed) throw new Error('The project history has closed.');
    if (values.has(section)) return values.get(section) as SectionValue<S>;
    if (Object.hasOwn(SECTION_ADAPTERS.builtin, section)) throw new Error(`Missing project section "${section}".`);
    if (pluginOfSection(section) === null) throw new Error(`Unknown project section "${section}".`);
    return null as SectionValue<S>;
  }

  function input(values: SectionValues): readonly SectionName[] {
    for (const section of builtin) {
      if (!Object.hasOwn(values, section)) throw new Error(`Missing project section "${section}".`);
    }
    const sections = [...new Set([...builtin, ...Object.keys(values) as SectionName[]])];
    let plugins = 0;
    for (const section of sections) {
      adapterFor(section);
      if (values[section] === undefined) throw new Error(`Missing project section "${section}".`);
      frozen(values[section]);
      if (values[section] !== null && !Object.hasOwn(SECTION_ADAPTERS.builtin, section)) plugins++;
    }
    if (plugins > PLUGIN_DATA_LIMITS.plugins) throw new Error('The project has too many plugin data sections.');
    return sections;
  }

  const initialNames = input(initial);
  try {
    for (const section of initialNames) {
      const value = initial[section];
      if (value === null && !Object.hasOwn(SECTION_ADAPTERS.builtin, section)) continue;
      documentFiles.set(section, options.files.retain(adapterFor(section).files(value), 'document'));
      values.set(section, value);
    }
  } catch (error) {
    const disposal = new Disposal();
    disposal.run(() => { throw error; });
    for (const release of documentFiles.values()) disposal.run(release);
    disposal.finish();
    throw error;
  }
  const undoSteps = new Chain<StoredStep>();
  const redoSteps = new Chain<StoredStep>();
  const pendingEdits = new Chain<LivePending>();
  const pendingRedo = new Set<LivePending>();
  // Per-section tails locate a cut without scanning untouched steps.
  const sectionSteps = new Map<SectionName, Chain<StoredStep>>();
  const listeners = new Set<() => void>();
  let undoBytes = 0;
  let redoBytes = 0;
  let order = 0;
  // A generation makes all earlier steps unmergeable without walking them.
  let epoch = 0;
  let transaction: LiveTransaction | null = null;
  let context: { readonly key: string; readonly label: string } | null = null;
  let holds = 0;
  let notifying = false;

  const document: ProjectDocument = Object.freeze({
    get<S extends SectionName>(section: S): SectionValue<S> {
      return read(section);
    },
    subscribe<S extends SectionName>(section: S, listener: SectionListener<S>): () => void {
      read(section);
      const subscribed: ChangeListener = (change, cause, info) => listener(change as SectionChange<S>, cause, info);
      let target = sectionListeners.get(section);
      if (target === undefined) {
        target = new Set();
        sectionListeners.set(section, target);
      }
      target.add(subscribed);
      const subscribers = target;
      return () => {
        subscribers.delete(subscribed);
        if (subscribers.size === 0 && sectionListeners.get(section) === subscribers) sectionListeners.delete(section);
      };
    },
    sections(): readonly SectionName[] {
      if (disposed) throw new Error('The project history has closed.');
      if (names === null) names = Object.freeze([...values.keys()].sort());
      return names;
    },
    subscribeAll(listener: BatchListener): () => void {
      if (disposed) throw new Error('The project history has closed.');
      const subscribed: BatchListener = (changes, cause, info) => listener(changes, cause, info);
      batchListeners.add(subscribed);
      return () => { batchListeners.delete(subscribed); };
    },
  });

  function guard(): void {
    if (notifying) throw new Error('A listener cannot change the project while it hears a change.');
    if (disposed) throw new Error('The project history has closed.');
  }

  function notify(changes: readonly SomeSectionChange[] = [], cause: ChangeCause = 'edit',
    info: StepInfo | null = null, callbacks: readonly (() => void)[] = []): void {
    const sections = changes.map((change) => ({ change, listeners: [...(sectionListeners.get(change.section) ?? [])] }));
    const batches = changes.length === 0 ? [] : [...batchListeners];
    const subscribers = [...listeners];
    let failed = false;
    let firstError: unknown;
    function tell(run: () => void): void {
      try { run(); } catch (error) {
        if (!failed) { failed = true; firstError = error; }
      }
    }
    notifying = true;
    try {
      for (const callback of callbacks) tell(callback);
      for (const { change, listeners: sectionListeners } of sections) {
        for (const listener of sectionListeners) tell(() => listener(change, cause, info));
      }
      for (const listener of batches) tell(() => listener(changes, cause, info));
      for (const listener of subscribers) tell(listener);
    } finally {
      notifying = false;
    }
    if (failed) throw firstError;
  }

  function checked(changes: readonly SomeSectionChange[]): readonly SomeSectionChange[] {
    const seen = new Set<SectionName>();
    const result: SomeSectionChange[] = [];
    for (const change of changes) {
      if (seen.has(change.section)) throw new Error('A step can change each section only once.');
      seen.add(change.section);
      if (read(change.section) !== change.before) {
        throw new Error('A section change must replace the current value.');
      }
      frozen(change.after);
      if (change.before !== change.after) result.push(change);
    }
    return result;
  }

  function runCommand(run: Command['run']): readonly SomeSectionChange[] | Error {
    let changes: readonly SomeSectionChange[];
    try { changes = run(document); } catch (error) {
      for (const refusal of refusals) if (error instanceof refusal) return error;
      throw error;
    }
    return checked(changes);
  }

  function acquireDocument(changes: readonly SomeSectionChange[]): Map<SectionName, () => void> {
    const leases = new Map<SectionName, () => void>();
    try {
      for (const change of changes) {
        leases.set(change.section, options.files.retain(adapterFor(change.section).files(change.after), 'document'));
      }
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      for (const release of leases.values()) disposal.run(release);
      disposal.finish();
      throw error;
    }
    return leases;
  }

  function set(changes: readonly SomeSectionChange[], leases = acquireDocument(changes)): void {
    for (const change of changes) {
      const present = values.has(change.section);
      if (change.after === null && !Object.hasOwn(SECTION_ADAPTERS.builtin, change.section)) values.delete(change.section);
      else values.set(change.section, change.after);
      if (present !== values.has(change.section)) names = null;
    }
    const disposal = new Disposal();
    for (const [section, release] of leases) {
      const previous = documentFiles.get(section);
      if (values.has(section)) documentFiles.set(section, release);
      else {
        documentFiles.delete(section);
        disposal.run(release);
      }
      if (previous !== undefined) disposal.run(previous);
    }
    disposal.finish();
  }

  function compose(first: readonly SomeSectionChange[], next: readonly SomeSectionChange[]): readonly SomeSectionChange[] {
    const changes = new Map<SectionName, SomeSectionChange>();
    for (const change of first) changes.set(change.section, change);
    for (const change of next) {
      const previous = changes.get(change.section);
      const combined = previous === undefined ? change
        : adapterFor(change.section).compose(previous, change) as SomeSectionChange | null;
      if (combined === null) changes.delete(change.section);
      else changes.set(change.section, combined);
    }
    return [...changes.values()];
  }

  function handles(changes: readonly SomeSectionChange[]): readonly FileHandle[] {
    const files = new Set<FileHandle>();
    for (const change of changes) {
      const adapter = adapterFor(change.section);
      for (const file of adapter.files(change.before)) files.add(file);
      for (const file of adapter.files(change.after)) files.add(file);
    }
    return Object.freeze([...files]);
  }

  function capture(changes: readonly SomeSectionChange[]): StepResources {
    const retained = new Set<FileHandle>();
    const changed = new Set<FileHandle>();
    const removed = new Set<FileHandle>();
    let bytes = 0;
    for (const change of changes) {
      const adapter = adapterFor(change.section);
      bytes += adapter.bytes(change);
      const before = new Set(adapter.files(change.before));
      const after = new Set(adapter.files(change.after));
      for (const file of before) {
        retained.add(file);
        if (!after.has(file)) { changed.add(file); removed.add(file); }
      }
      for (const file of after) {
        retained.add(file);
        if (!before.has(file)) changed.add(file);
      }
    }
    for (const file of changed) {
      const page = options.files.pageBytes(file);
      // A removal reserves remote bytes before a destructive save lazily preserves them.
      const charge = page === 0 && removed.has(file) ? file.bytes : page;
      if (charge > 0) bytes += charge;
    }
    return { bytes, release: options.files.retain([...retained], 'history') };
  }

  function checkStep(changes: readonly SomeSectionChange[], side: 'before' | 'after'): void {
    for (const change of changes) {
      if (read(change.section) !== change[side]) {
        throw new Error('The project changed outside its history.');
      }
    }
  }

  function inverse(changes: readonly SomeSectionChange[]): readonly SomeSectionChange[] {
    checkStep(changes, 'after');
    return checked([...changes].reverse().map((change) => adapterFor(change.section).invert(change) as SomeSectionChange));
  }

  function linkSections(step: StoredStep): void {
    for (const change of step.changes) {
      let chain = sectionSteps.get(change.section);
      if (chain === undefined) {
        chain = new Chain<StoredStep>();
        sectionSteps.set(change.section, chain);
      }
      step.sections.set(change.section, chain.append(step));
    }
  }

  function unlinkSections(step: StoredStep): void {
    for (const [section, link] of step.sections) {
      const chain = sectionSteps.get(section);
      if (chain === undefined) throw new Error('History section indexes are inconsistent.');
      chain.remove(link);
      if (chain.size === 0) sectionSteps.delete(section);
    }
    step.sections.clear();
  }

  function addUndo(step: StoredStep): void {
    undoSteps.append(step);
    undoBytes += step.bytes;
    linkSections(step);
  }

  function removeUndo(link: Link<StoredStep>): StoredStep {
    const step = link.value;
    unlinkSections(step);
    undoSteps.remove(link);
    undoBytes -= step.bytes;
    return step;
  }

  function clearRedo(): void {
    const disposal = new Disposal();
    for (let link = redoSteps.first; link !== null; link = link.next) disposal.run(link.value.release);
    redoSteps.clear();
    redoBytes = 0;
    disposal.finish();
  }

  function clearUndo(): void {
    const disposal = new Disposal();
    for (let link = undoSteps.first; link !== null; link = link.next) disposal.run(link.value.release);
    undoSteps.clear();
    undoBytes = 0;
    sectionSteps.clear();
    disposal.finish();
  }

  function clearPendingRedo(): void {
    for (const pending of pendingRedo) pending.undone.length = 0;
    pendingRedo.clear();
  }

  function trim(): void {
    while (undoSteps.size > 1 && (undoSteps.size > HISTORY_LIMITS.steps || undoBytes + redoBytes > HISTORY_LIMITS.bytes)) {
      const oldest = undoSteps.first;
      if (oldest === null) throw new Error('History steps are inconsistent.');
      removeUndo(oldest).release();
    }
  }

  function record(changes: readonly SomeSectionChange[], info: StepInfo, key: string | null, resources: StepResources): StoredStep {
    const step: StoredStep = { info, changes, ...resources, order: ++order, key, epoch, sealedAt: null, sections: new Map() };
    addUndo(step);
    clearRedo();
    clearPendingRedo();
    trim();
    return step;
  }

  function edit(changes: readonly SomeSectionChange[], info: StepInfo, key: string | null, allowMerge: boolean): StoredStep | null {
    const latest = undoSteps.last;
    const step = latest?.value;
    const merge = allowMerge && latest !== null && step !== undefined && key !== null && step.key === key
      && step.epoch === epoch && (step.sealedAt === null || performance.now() - step.sealedAt < HISTORY_LIMITS.coalesceMs)
      && redoSteps.size === 0 && (pendingEdits.last === null || pendingEdits.last.value.order < step.order)
      && transaction === null;
    const combined = merge ? compose(step.changes, changes) : changes;
    const resources = capture(combined);
    try { set(changes); } catch (error) {
      resources.release();
      throw error;
    }
    if (merge) {
      const release = step.release;
      if (combined.length === 0) {
        removeUndo(latest);
        resources.release();
      } else {
        unlinkSections(step);
        undoBytes += resources.bytes - step.bytes;
        step.bytes = resources.bytes;
        step.release = resources.release;
        step.changes = combined;
        step.info = mergedInfo(step.info, info);
        step.sealedAt = null;
        linkSections(step);
      }
      release();
      clearRedo();
      clearPendingRedo();
      trim();
      return combined.length === 0 ? null : step;
    }
    return record(changes, info, key, resources);
  }

  function liveTransaction(value: LiveTransaction): void {
    if (value.done || transaction !== value) throw new Error('The transaction has ended.');
  }

  function commit(value: LiveTransaction, select?: Selection): void {
    liveTransaction(value);
    const changes = value.changes;
    const info = select === undefined ? value.info : withSelection(value.info, selection(select));
    const resources = changes.length === 0 ? null : capture(changes);
    const release = value.release;
    value.done = true;
    value.changes = [];
    value.release = () => {};
    transaction = null;
    epoch++;
    if (resources !== null) record(changes, info, null, resources);
    release();
    notify();
  }

  function commitOpen(): void {
    if (transaction !== null) commit(transaction);
  }

  function livePending(value: LivePending): void {
    if (value.done) throw new Error('The pending edit has ended.');
  }

  function endPending(value: LivePending, recorded: boolean): (() => void) | null {
    livePending(value);
    if (value.entry === null) throw new Error('Pending edit indexes are inconsistent.');
    pendingEdits.remove(value.entry);
    value.entry = null;
    value.done = true;
    value.strokes.length = 0;
    value.undone.length = 0;
    pendingRedo.delete(value);
    return recorded ? null : value.cancelled;
  }

  function undoStroke(value: LivePending): boolean {
    const stroke = value.strokes.pop();
    if (stroke === undefined) return false;
    value.undone.push(stroke);
    pendingRedo.add(value);
    notify([], 'undo', value.info, [stroke.before]);
    return true;
  }

  function undoPending(): LivePending | null {
    const pending = pendingEdits.last?.value;
    const step = undoSteps.last?.value;
    return pending !== undefined && (step === undefined || pending.order > step.order) ? pending : null;
  }

  function cut(sections: readonly SectionName[]): boolean {
    let boundary: StoredStep | null = null;
    for (const section of sections) {
      const step = sectionSteps.get(section)?.last?.value;
      if (step !== undefined && (boundary === null || step.order > boundary.order)) boundary = step;
    }
    const changed = boundary !== null || redoSteps.size > 0;
    clearRedo();
    if (boundary !== null) {
      while (undoSteps.first !== null) {
        const step = removeUndo(undoSteps.first);
        step.release();
        if (step === boundary) break;
      }
    }
    return changed;
  }

  const history: History = {
    document,
    apply(command): Error | null {
      guard();
      commitOpen();
      const info = stepInfo(command, context === null ? command.label : context.label);
      const changes = runCommand(command.run.bind(command));
      if (changes instanceof Error) return changes;
      if (changes.length === 0) return null;
      edit(changes, info, context === null ? command.coalesce : context.key, true);
      notify(changes, 'edit', info);
      return null;
    },
    coalescing<R>(key: string, name: string, run: () => R): R {
      guard();
      const previous = context;
      context = { key, label: label(name) };
      try { return run(); } finally { context = previous; }
    },
    seal(key): void {
      guard();
      const step = undoSteps.last?.value;
      if (step !== undefined && step.key === key && step.sealedAt === null) step.sealedAt = performance.now();
    },
    begin(info): Transaction {
      guard();
      commitOpen();
      const value: LiveTransaction = { info: stepInfo(info), changes: [], release: () => {}, done: false };
      transaction = value;
      const result: Transaction = {
        apply(run): Error | null {
          guard();
          liveTransaction(value);
          const changes = runCommand(run);
          if (changes instanceof Error) return changes;
          if (changes.length === 0) return null;
          const combined = compose(value.changes, changes);
          // Uncommitted inverses already need protection from destructive saves.
          const retained = options.files.retain(handles(combined), 'history');
          try { set(changes); } catch (error) {
            retained();
            throw error;
          }
          const release = value.release;
          value.changes = combined;
          value.release = retained;
          release();
          notify(changes, 'edit', value.info);
          return null;
        },
        commit(select): void {
          guard();
          commit(value, select);
        },
        cancel(): void {
          guard();
          liveTransaction(value);
          const changes = inverse(value.changes);
          set(changes);
          value.done = true;
          value.changes = [];
          transaction = null;
          value.release();
          value.release = () => {};
          notify(changes, 'undo', value.info);
        },
      };
      notify();
      return Object.freeze(result);
    },
    prepare<T = never>(info: StepInfo & { restore?(value: T): void; cancelled(): void }): PendingEdit<T> {
      guard();
      const value: LivePending = {
        info: stepInfo(info), order: ++order, strokes: [], undone: [], cancelled: () => info.cancelled(),
        entry: null, done: false,
      };
      value.entry = pendingEdits.append(value);
      clearRedo();
      const result: PendingEdit<T> = {
        get done(): boolean { return value.done; },
        step(name, before, after): void {
          guard();
          livePending(value);
          const stroke: Stroke = { label: label(name), before: () => info.restore?.(before), after: () => info.restore?.(after) };
          if (value.entry === null) throw new Error('Pending edit indexes are inconsistent.');
          value.strokes.push(stroke);
          value.undone.length = 0;
          pendingRedo.delete(value);
          value.order = ++order;
          pendingEdits.remove(value.entry);
          value.entry = pendingEdits.append(value);
          clearRedo();
          notify();
        },
        undoStep(): void {
          guard();
          livePending(value);
          if (holds > 0) return;
          undoStroke(value);
        },
        finish(command): Error | null {
          guard();
          livePending(value);
          commitOpen();
          const key = context === null ? command.coalesce : context.key;
          const place = stepInfo(command, context === null ? command.label : context.label);
          const changes = runCommand(command.run.bind(command));
          if (changes instanceof Error || changes.length === 0) {
            const cancelled = endPending(value, false);
            notify([], 'edit', null, cancelled === null ? [] : [cancelled]);
            return changes instanceof Error ? changes : null;
          }
          if (key === null) {
            epoch++;
            edit(changes, place, null, false);
            endPending(value, true);
            epoch++;
          } else {
            endPending(value, true);
            const step = edit(changes, place, key, true);
            if (step !== null) step.sealedAt = performance.now();
          }
          notify(changes, 'edit', place);
          return null;
        },
        cancel(): void {
          guard();
          const cancelled = endPending(value, false);
          notify([], 'edit', null, cancelled === null ? [] : [cancelled]);
        },
      };
      notify();
      return Object.freeze(result);
    },
    undo(): void {
      guard();
      if (holds > 0) return;
      commitOpen();
      epoch++;
      const pending = undoPending();
      if (pending !== null) {
        if (!undoStroke(pending)) {
          const cancelled = endPending(pending, false);
          notify([], 'undo', pending.info, cancelled === null ? [] : [cancelled]);
        }
        return;
      }
      const latest = undoSteps.last;
      if (latest === null) return;
      const changes = inverse(latest.value.changes);
      const step = removeUndo(latest);
      redoSteps.append(step);
      redoBytes += step.bytes;
      set(changes);
      notify(changes, 'undo', step.info);
    },
    redo(): void {
      guard();
      if (holds > 0) return;
      commitOpen();
      epoch++;
      const pending = pendingEdits.last?.value;
      const stroke = pending?.undone.pop();
      if (pending !== undefined && stroke !== undefined) {
        if (pending.undone.length === 0) pendingRedo.delete(pending);
        pending.strokes.push(stroke);
        notify([], 'redo', pending.info, [stroke.after]);
        return;
      }
      const latest = redoSteps.last;
      if (latest === null) return;
      const step = latest.value;
      checkStep(step.changes, 'before');
      const changes = checked(step.changes);
      redoSteps.remove(latest);
      redoBytes -= step.bytes;
      addUndo(step);
      set(changes);
      notify(changes, 'redo', step.info);
    },
    load(next): void {
      guard();
      const incoming = input(next);
      const changes: SomeSectionChange[] = [];
      for (const section of new Set([...values.keys(), ...incoming])) {
        const before = read(section);
        const after = Object.hasOwn(next, section) ? next[section] : null;
        if (before !== after) changes.push(adapterFor(section).change(before, after) as SomeSectionChange);
      }
      const leases = acquireDocument(changes);
      const callbacks: (() => void)[] = [];
      while (pendingEdits.first !== null) {
        const cancelled = endPending(pendingEdits.first.value, false);
        if (cancelled !== null) callbacks.push(cancelled);
      }
      if (transaction !== null) {
        transaction.done = true;
        transaction.changes = [];
        callbacks.unshift(transaction.release);
        transaction.release = () => {};
        transaction = null;
      }
      epoch++;
      const disposal = new Disposal();
      disposal.run(clearUndo);
      disposal.run(clearRedo);
      disposal.run(() => set(changes, leases));
      disposal.run(() => notify(changes, 'open', null, callbacks));
      disposal.finish();
    },
    external(changes, cause = 'server'): void {
      guard();
      commitOpen();
      const next = checked(changes);
      epoch++;
      const leases = acquireDocument(next);
      let changed: boolean;
      try { changed = cut(changes.map((change) => change.section)); } catch (error) {
        const disposal = new Disposal();
        disposal.run(() => { throw error; });
        for (const release of leases.values()) disposal.run(release);
        disposal.finish();
        throw error;
      }
      set(next, leases);
      if (changed || next.length > 0) notify(next, cause);
    },
    cut(sections): void {
      guard();
      commitOpen();
      for (const section of sections) adapterFor(section);
      epoch++;
      if (cut(sections)) notify();
    },
    hold(): () => void {
      guard();
      holds++;
      if (holds === 1) {
        try { notify(); } catch (error) {
          holds--;
          try { notify(); } catch {
            // The acquisition error takes precedence over rollback listener errors.
          }
          throw error;
        }
      }
      let released = false;
      return () => {
        if (released) return;
        if (disposed) { released = true; return; }
        guard();
        released = true;
        holds--;
        if (holds === 0) notify();
      };
    },
    state(): HistoryState {
      const pending = undoPending();
      const step = undoSteps.last?.value;
      const stroke = pending?.strokes.at(-1);
      const undo = transaction !== null && transaction.changes.length > 0 ? action(transaction.info, 'step')
        : pending !== null ? action(pending.info, stroke === undefined ? 'cancel' : 'stroke', stroke?.label ?? pending.info.label)
          : step === undefined ? null : action(step.info, 'step');
      const newest = pendingEdits.last?.value;
      const undone = newest?.undone.at(-1);
      const redoStep = redoSteps.last?.value;
      const redo = newest !== undefined && undone !== undefined ? action(newest.info, 'stroke', undone.label)
        : (transaction !== null && transaction.changes.length > 0) || redoStep === undefined ? null : action(redoStep.info, 'step');
      const pendingLabels: string[] = [];
      for (let link = pendingEdits.first; link !== null; link = link.next) pendingLabels.push(link.value.info.label);
      return Object.freeze({
        steps: undoSteps.size, redoSteps: redoSteps.size, bytes: undoBytes + redoBytes,
        undo, redo, pending: Object.freeze(pendingLabels), transaction: transaction?.info.label ?? null, held: holds > 0,
      });
    },
    subscribe(listener): () => void {
      if (disposed) throw new Error('The project history has closed.');
      const subscribed = () => listener();
      listeners.add(subscribed);
      return () => { listeners.delete(subscribed); };
    },
    dispose(): void {
      if (disposed) return;
      guard();
      const callbacks: (() => void)[] = [];
      while (pendingEdits.first !== null) {
        const cancelled = endPending(pendingEdits.first.value, false);
        if (cancelled !== null) callbacks.push(cancelled);
      }
      if (transaction !== null) {
        transaction.done = true;
        transaction.changes = [];
        callbacks.unshift(transaction.release);
        transaction.release = () => {};
        transaction = null;
      }
      disposed = true;
      holds = 0;
      const disposal = new Disposal();
      disposal.run(clearUndo);
      disposal.run(clearRedo);
      for (const release of documentFiles.values()) disposal.run(release);
      documentFiles.clear();
      values.clear();
      names = null;
      sectionListeners.clear();
      batchListeners.clear();
      listeners.clear();
      notifying = true;
      try { for (const callback of callbacks) disposal.run(callback); } finally { notifying = false; }
      disposal.finish();
    },
  };
  return Object.freeze(history);
}
