import { DynamicTree } from 'planck';
import type { AABBValue } from 'planck';
import type { Point } from './config';
import { isTriggerObject, TRIGGER_LIMITS, triggerBounds, triggerContains } from './level';
import type { LevelChange, TriggerObject } from './level';
import { EventExecutionError } from './trigger-events';
import type { EventOutcome, TriggerAction, TriggerExecutor } from './trigger-events';

export type TriggerActionStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'cancelled' | 'failed';
export type TriggerRunStatus = 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface TriggerRunTransition {
  readonly scope: 'trigger';
  readonly triggerId: string;
  readonly status: TriggerRunStatus;
  readonly generation: number;
  readonly activationCount: number;
  readonly time: number;
}

export interface TriggerActionTransition {
  readonly scope: 'action';
  readonly triggerId: string;
  readonly generation: number;
  readonly activationCount: number;
  readonly actionIndex: number;
  readonly status: Exclude<TriggerActionStatus, 'pending'>;
  readonly time: number;
}

export type TriggerTransition = TriggerRunTransition | TriggerActionTransition;

export interface TriggerDiagnostics {
  readonly id: string;
  readonly name: string;
  readonly activation: 'once' | 'on-enter';
  readonly inside: boolean;
  readonly consumed: boolean;
  readonly active: boolean;
  readonly status: TriggerRunStatus;
  readonly generation: number;
  readonly activationCount: number;
  readonly lastActivatedAt: number | null;
  readonly actionStatuses: readonly TriggerActionStatus[];
}

export interface TriggerRuntimeSnapshot {
  readonly disposed: boolean;
  readonly queued: number;
  readonly running: string | null;
  readonly triggers: readonly TriggerDiagnostics[];
}

export interface TriggerFailureDetails {
  readonly triggerId: string;
  readonly eventIndex: number;
  readonly message: string;
}

export interface TriggerRuntimeCallbacks {
  readonly execute: TriggerExecutor;
  readonly onFailure: (details: TriggerFailureDetails) => void;
  readonly onFault: (error: unknown) => void;
}

interface TriggerRecord {
  readonly object: TriggerObject;
  readonly order: number;
  readonly proxyId: number;
  inside: boolean;
  consumed: boolean;
  generation: number;
  activationCount: number;
  lastActivatedAt: number | null;
  run: ActiveRun | null;
}

interface ActiveRun {
  readonly triggerId: string;
  readonly record: TriggerRecord;
  readonly generation: number;
  readonly activationCount: number;
  readonly actions: readonly TriggerAction[];
  readonly actionStatuses: TriggerActionStatus[];
  readonly controller: AbortController;
  status: Exclude<TriggerRunStatus, 'idle'>;
  step: { phase: 'start' | 'execute' | 'await'; index: number };
}

type RuntimeEffect =
  | { kind: 'transition'; event: TriggerTransition }
  | { kind: 'abort'; controller: AbortController }
  | { kind: 'failure'; details: TriggerFailureDetails }
  | { kind: 'fault'; error: unknown };

function pointToSegmentDistanceSquared(p: Readonly<Point>, a: Readonly<Point>, b: Readonly<Point>): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared === 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

// Liang-Barsky clip of segment a->b against an axis-aligned box; degenerates to a point test when a === b.
function segmentIntersectsBox(bounds: { minX: number; maxX: number; minY: number; maxY: number },
  a: Readonly<Point>, b: Readonly<Point>): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, a.x - bounds.minX) && clip(dx, bounds.maxX - a.x) &&
    clip(-dy, a.y - bounds.minY) && clip(dy, bounds.maxY - a.y) && t0 <= t1;
}

function segmentIntersectsTrigger(trigger: TriggerObject, a: Readonly<Point>, b: Readonly<Point>): boolean {
  if (trigger.region.type === 'circle') {
    return pointToSegmentDistanceSquared({ x: trigger.x, y: trigger.y }, a, b) <= trigger.region.radius ** 2;
  }
  return segmentIntersectsBox(triggerBounds(trigger), a, b);
}

function triggerAabb(object: TriggerObject): AABBValue {
  const bounds = triggerBounds(object);
  return { lowerBound: { x: bounds.minX, y: bounds.minY }, upperBound: { x: bounds.maxX, y: bounds.maxY } };
}

export class TriggerRuntime {
  private readonly callbacks: TriggerRuntimeCallbacks;
  private readonly index = new DynamicTree<string>();
  private readonly records = new Map<string, TriggerRecord>();
  private readonly listeners = new Set<(event: TriggerTransition) => void>();
  private readonly queue: ActiveRun[] = [];
  private readonly effects: RuntimeEffect[] = [];
  private activeRun: ActiveRun | null = null;
  private previousPosition: Point | null = null;
  private previousTime: number | null = null;
  private time = 0;
  private orderCounter = 0;
  private draining = false;
  private disposed = false;

  constructor(objects: readonly TriggerObject[], callbacks: TriggerRuntimeCallbacks) {
    this.callbacks = callbacks;
    for (const object of objects) {
      if (this.records.has(object.id)) throw new Error(`Duplicate trigger ID: ${object.id}.`);
      this.createRecord(object);
    }
  }

  update(position: Readonly<Point>, time: number): void {
    this.ensureLive();
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(time)) {
      throw new Error('Trigger position and time must be finite numbers.');
    }
    const previousPosition = this.previousPosition;
    const previousTime = this.previousTime;
    this.time = time;
    this.previousPosition = { x: position.x, y: position.y };
    this.previousTime = time;
    if (previousPosition && position.x === previousPosition.x && position.y === previousPosition.y) {
      return;
    }
    const sweepEligible = previousPosition !== null && previousTime !== null && time >= previousTime;
    const from = sweepEligible ? previousPosition : position;
    const pad = TRIGGER_LIMITS.exitMargin;
    const query: AABBValue = {
      lowerBound: { x: Math.min(from.x, position.x) - pad, y: Math.min(from.y, position.y) - pad },
      upperBound: { x: Math.max(from.x, position.x) + pad, y: Math.max(from.y, position.y) + pad },
    };
    const candidates: TriggerRecord[] = [];
    this.index.query(query, (nodeId) => {
      const record = this.records.get(this.index.getUserData(nodeId));
      if (record) candidates.push(record);
      return true;
    });
    candidates.sort((a, b) => a.order - b.order);
    for (const record of candidates) this.evaluate(record, from, position, sweepEligible);
    this.drain();
  }

  apply(change: LevelChange): void {
    this.ensureLive();
    if (change.kind === 'replace') {
      this.rebuild(change.level.objects.filter(isTriggerObject));
    } else {
      const removed = new Set(change.remove.filter((id) => this.records.has(id)));
      for (const object of change.upsert) {
        if (!isTriggerObject(object) && this.records.has(object.id)) removed.add(object.id);
      }
      const triggers = change.upsert.filter(isTriggerObject);
      if (removed.size === 0 && triggers.length === 0) return;
      for (const id of removed) this.removeTrigger(id);
      for (const object of triggers) {
        const previous = this.records.get(object.id);
        if (previous) this.removeTrigger(object.id);
        this.createRecord(object, previous);
      }
    }
    this.previousPosition = null;
    this.previousTime = null;
    this.drain();
  }

  reset(): void {
    this.ensureLive();
    for (const record of this.records.values()) {
      this.cancelRecord(record);
      record.inside = false;
      record.consumed = false;
      record.generation += 1;
      record.activationCount = 0;
      record.lastActivatedAt = null;
      record.run = null;
    }
    this.previousPosition = null;
    this.previousTime = null;
    this.time = 0;
    this.drain();
  }

  subscribe(listener: (event: TriggerTransition) => void): () => void {
    this.ensureLive();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  inspect(): TriggerRuntimeSnapshot {
    const triggers = [...this.records.values()].sort((a, b) => a.order - b.order)
      .map((record): TriggerDiagnostics => ({
        id: record.object.id, name: record.object.name, activation: record.object.activation,
        inside: record.inside, consumed: record.consumed,
        active: record.run?.status === 'queued' || record.run?.status === 'running',
        status: record.run ? record.run.status : 'idle',
        generation: record.generation, activationCount: record.activationCount,
        lastActivatedAt: record.lastActivatedAt,
        actionStatuses: record.run ? [...record.run.actionStatuses] : record.object.events.map(() => 'pending'),
      }));
    return {
      disposed: this.disposed, queued: this.queue.length,
      running: this.activeRun ? this.activeRun.triggerId : null, triggers,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.records.keys()) this.removeTrigger(id);
    this.previousPosition = null;
    this.previousTime = null;
    this.drain();
  }

  private evaluate(record: TriggerRecord, from: Readonly<Point>, to: Readonly<Point>,
    sweepEligible: boolean): void {
    const trigger = record.object;
    const wasInside = record.inside;
    const nowInside = triggerContains(trigger, to, wasInside ? TRIGGER_LIMITS.exitMargin : 0);
    const swept = !nowInside && !wasInside && sweepEligible && segmentIntersectsTrigger(trigger, from, to);
    record.inside = nowInside;
    if ((nowInside && !wasInside) || swept) this.fire(record);
  }

  private fire(record: TriggerRecord): void {
    if (record.object.activation === 'once' && record.consumed) return;
    if (record.run?.status === 'queued' || record.run?.status === 'running') return;
    if (record.object.activation === 'once') record.consumed = true;
    record.generation += 1;
    record.activationCount += 1;
    record.lastActivatedAt = this.time;
    const run: ActiveRun = {
      triggerId: record.object.id, record, generation: record.generation,
      activationCount: record.activationCount, actions: record.object.events,
      actionStatuses: record.object.events.map(() => 'pending'),
      controller: new AbortController(), status: 'queued', step: { phase: 'start', index: 0 },
    };
    record.run = run;
    this.queue.push(run);
    this.emitTrigger(run);
  }

  // Finish model mutations before draining effects. Callbacks may reset/edit/dispose;
  // their mutations take effect immediately, but cannot recursively start another executor.
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    let delivered = 0;
    try {
      for (;;) {
        if (delivered < this.effects.length) {
          this.deliver(this.effects[delivered++]);
        } else if (this.disposed || !this.advance()) {
          break;
        }
      }
    } finally {
      this.effects.splice(0, delivered);
      this.draining = false;
      if (this.disposed) this.listeners.clear();
    }
  }

  private deliver(effect: RuntimeEffect): void {
    switch (effect.kind) {
      case 'abort':
        effect.controller.abort();
        break;
      case 'transition':
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue;
          try {
            listener(effect.event);
          } catch (error) {
            this.listeners.clear();
            this.dispose();
            this.effects.push({ kind: 'fault', error });
            break;
          }
        }
        break;
      case 'failure':
        this.callbacks.onFailure(effect.details);
        break;
      case 'fault':
        this.dispose();
        this.callbacks.onFault(effect.error);
        break;
    }
  }

  private advance(): boolean {
    if (!this.activeRun) {
      const run = this.queue.shift();
      if (!run) return false;
      this.activeRun = run;
      run.status = 'running';
      this.emitTrigger(run);
      return true;
    }
    const run = this.activeRun;
    const { phase, index } = run.step;
    if (phase === 'await') return false;
    if (phase === 'start') {
      if (index === run.actions.length) {
        this.settle(run, 'completed');
        this.emitTrigger(run);
      } else {
        run.actionStatuses[index] = 'running';
        run.step = { phase: 'execute', index };
        this.emitAction(run, index, 'running');
      }
    } else {
      run.step = { phase: 'await', index };
      this.execute(run, index);
    }
    return true;
  }

  private execute(run: ActiveRun, index: number): void {
    let result: EventOutcome | Promise<EventOutcome>;
    try {
      result = this.callbacks.execute(run.actions[index], run.controller.signal);
    } catch (error) {
      this.fail(run, index, error);
      return;
    }
    if (typeof result === 'object' && result !== null && 'then' in result) {
      void Promise.resolve(result).then(
        (outcome) => { this.completeAction(run, index, outcome); this.drain(); },
        (error: unknown) => { this.fail(run, index, error); this.drain(); },
      );
    } else {
      this.completeAction(run, index, result);
    }
  }

  private completeAction(run: ActiveRun, index: number, outcome: EventOutcome): void {
    if (this.activeRun !== run || run.status !== 'running') return;
    switch (outcome) {
      case 'completed':
      case 'skipped':
        run.actionStatuses[index] = outcome;
        run.step = { phase: 'start', index: index + 1 };
        this.emitAction(run, index, outcome);
        break;
      case 'cancelled':
        this.cancelRecord(run.record);
        break;
      default:
        this.fail(run, index, new Error(`Unknown trigger event outcome: ${String(outcome)}.`));
    }
  }

  private fail(run: ActiveRun, index: number, error: unknown): void {
    if (this.activeRun !== run || run.status !== 'running') return;
    this.settle(run, 'failed');
    this.effects.push({ kind: 'abort', controller: run.controller });
    run.actionStatuses[index] = 'failed';
    this.emitAction(run, index, 'failed');
    this.cancelRemaining(run);
    this.emitTrigger(run);
    if (error instanceof EventExecutionError) {
      this.effects.push({ kind: 'failure', details: { triggerId: run.triggerId, eventIndex: index, message: error.message } });
    } else {
      this.effects.push({ kind: 'fault', error });
    }
  }

  private cancelRemaining(run: ActiveRun): void {
    for (let index = 0; index < run.actionStatuses.length; index++) {
      const current = run.actionStatuses[index];
      if (current === 'pending' || current === 'running') {
        run.actionStatuses[index] = 'cancelled';
        this.emitAction(run, index, 'cancelled');
      }
    }
  }

  private settle(run: ActiveRun, status: 'completed' | 'cancelled' | 'failed'): void {
    run.status = status;
    if (this.activeRun === run) this.activeRun = null;
    const index = this.queue.indexOf(run);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private cancelRecord(record: TriggerRecord): void {
    const run = record.run;
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    this.settle(run, 'cancelled');
    this.effects.push({ kind: 'abort', controller: run.controller });
    this.cancelRemaining(run);
    this.emitTrigger(run);
  }

  private emitTrigger(run: ActiveRun): void {
    if (this.listeners.size === 0) return;
    this.effects.push({ kind: 'transition', event: {
      scope: 'trigger', triggerId: run.triggerId, status: run.status,
      generation: run.generation, activationCount: run.activationCount, time: this.time,
    } });
  }

  private emitAction(run: ActiveRun, actionIndex: number, status: Exclude<TriggerActionStatus, 'pending'>): void {
    if (this.listeners.size === 0) return;
    this.effects.push({ kind: 'transition', event: {
      scope: 'action', triggerId: run.triggerId, generation: run.generation,
      activationCount: run.activationCount, actionIndex, status, time: this.time,
    } });
  }

  private createRecord(object: TriggerObject, previous?: TriggerRecord): void {
    const record: TriggerRecord = {
      object, order: previous ? previous.order : this.orderCounter++,
      proxyId: this.index.createProxy(triggerAabb(object), object.id),
      inside: false, consumed: false, generation: previous ? previous.generation + 1 : 0,
      activationCount: 0, lastActivatedAt: null, run: null,
    };
    this.records.set(object.id, record);
  }

  private removeTrigger(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.cancelRecord(record);
    this.index.destroyProxy(record.proxyId);
    this.records.delete(id);
  }

  private rebuild(triggers: readonly TriggerObject[]): void {
    for (const id of this.records.keys()) this.removeTrigger(id);
    this.orderCounter = 0;
    for (const object of triggers) {
      if (this.records.has(object.id)) throw new Error(`Duplicate trigger ID: ${object.id}.`);
      this.createRecord(object);
    }
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot use a disposed trigger runtime.');
  }
}
