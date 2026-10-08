/**
 * The Level tab's checks: the engine's course checks (src/course-checks.ts) on the open level once edits settle, unsaved
 * changes included, then the plugins' rules (LEVEL_CHECKS). The engine's run in a worker, so the editor stays responsive
 * on the largest levels; a newer edit replaces a run still going. They run only while the Level tab is being edited, and
 * only report: findings never change the level or hold up a save. Work beyond the engine's budget stops a run, which
 * says so and keeps what it found before.
 */
import type { Point } from '../config';
import type { LevelCheckReport, LevelCheckStop, LevelFinding } from '../course-checks';
import { createCourseJob } from '../course-snapshot';
import type { CourseSnapshot } from '../course-snapshot';
import type { GameSettings } from '../game-settings';
import { objectLoops } from '../level';
import type { LevelChange, LevelDefinition, TerrainObject } from '../level';
import { apply1, attributed, call1, namespaceOf, PluginError } from '../plugins/kernel';
import type { Attributed } from '../plugins/kernel';
import { checkReachPlan, ENGINE_LEVEL_REACH, LEVEL_CHECKS, ruleFindings } from './level-check-points';
import type { LevelCheck, LevelCheckCourse, LevelCheckInput, LevelReachPlan, LevelReachSource } from './level-check-points';
import type { LevelCheckRequest, LevelCheckResponse } from './level-checks-worker';
import { SET_PIECES } from './set-pieces';
import type { WorkshopProjectSnapshot } from './workshop-sdk';

// After the last edit, so a drag or a run of typing checks once.
const SETTLE_MS = 350;
const SET_PIECE_IDS = Object.freeze(SET_PIECES.map((piece) => piece.id));

/** A finding as the Checks list shows it: the engine's, or a plugin rule's, named by its source. */
export interface ShownFinding extends LevelFinding {
  // The plugin rule's ID, or null for the engine's checks.
  readonly source: string | null;
}

export interface LevelChecksState {
  // Whether a check of the open level is waiting for edits to settle or running.
  readonly checking: boolean;
  // Whether the findings are for the open level as it is now.
  readonly current: boolean;
  // The latest run's findings, engine's then plugins', or none before the first.
  readonly findings: readonly ShownFinding[];
  // Where the latest run stopped for want of work, if it did.
  readonly stopped: LevelCheckStop | null;
  // Why the latest run could not check at all, if it could not.
  readonly failure: string | null;
}

export interface LevelChecksOptions {
  readonly level: { definition(): LevelDefinition; subscribe(listener: (change: LevelChange) => void): () => void };
  // The game settings, which the reach model comes from.
  readonly settings: () => GameSettings;
  readonly plugins: {
    checks(): ReadonlyMap<string, LevelCheck>;
    reach(): Attributed<LevelReachSource>;
    failed(plugin: string): boolean;
    // The error that stopped a plugin, or null.
    lastError(plugin: string): Error | null;
    // Stops a plugin that failed, as any plugin error does, and tells the Workshop.
    fail(plugin: string, error: unknown, action: string): void;
    // Tells `listener` whenever the plugins change.
    subscribe(listener: () => void): () => void;
    // The open project as plugins read it, or null before it opens; rules run only with one.
    project(): WorkshopProjectSnapshot | null;
  };
}

export interface LevelChecks {
  // Checks only while the Level tab is being edited; on becoming active it checks whatever changed meanwhile.
  setActive(active: boolean): void;
  // Checks again once edits settle, for a change the checks cannot hear of themselves, such as the game settings.
  invalidate(): void;
  state(): LevelChecksState;
  // Tells `listener` whenever the state changes; returns its removal.
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

interface Run {
  readonly id: number;
  readonly version: number;
  readonly level: LevelDefinition;
  readonly plan: LevelReachPlan;
}

// A rule's failure in its own words: the error inside the Workshop's attributions of it.
function reason(error: unknown): string {
  let cause = error;
  while (cause instanceof PluginError && cause.code === 'plugin-failed' && cause.cause instanceof Error) cause = cause.cause;
  return cause instanceof Error ? cause.message : String(cause);
}

// A posted report, frozen again: posting copies it unfrozen, and plugins' rules borrow it.
function frozen(report: LevelCheckReport): LevelCheckReport {
  for (const finding of report.findings) {
    if (finding.at !== null) Object.freeze(finding.at);
    Object.freeze(finding.objects);
    Object.freeze(finding);
  }
  Object.freeze(report.findings);
  if (report.reach !== null) {
    Object.freeze(report.reach.highest);
    if (report.reach.stands !== null) {
      for (const stand of report.reach.stands) Object.freeze(stand);
      Object.freeze(report.reach.stands);
    }
    Object.freeze(report.reach);
  }
  if (report.stopped !== null) Object.freeze(report.stopped);
  Object.freeze(report.work);
  return Object.freeze(report);
}

// A rule's view of the placed collision, prepared only if it asks: rules that never query cost nothing.
function courseOf(level: LevelDefinition): LevelCheckCourse {
  const terrain = new Map<string, TerrainObject>();
  for (const object of level.objects) if (object.kind === 'terrain') terrain.set(object.id, object);
  let snapshot: CourseSnapshot | null = null;
  const prepared = (): CourseSnapshot => snapshot ??= createCourseJob().prepare(level);
  return Object.freeze({
    loops: (id: string) => {
      const object = terrain.get(id);
      return object === undefined ? null : objectLoops(object);
    },
    inside: (point: Readonly<Point>) => prepared().inside({ x: point.x, y: point.y })?.id ?? null,
    blocks: (from: Readonly<Point>, to: Readonly<Point>) => prepared().blocksSegment({ x: from.x, y: from.y }, { x: to.x, y: to.y }),
  });
}

export function createLevelChecks(options: LevelChecksOptions): LevelChecks {
  const listeners = new Set<() => void>();
  let active = false;
  let disposed = false;
  // Counts every change the checks depend on; a run is current while nothing has changed since it began.
  let version = 0;
  let checkedVersion = -1;
  let timer: number | null = null;
  let worker: Worker | null = null;
  let running: Run | null = null;
  let runs = 0;
  let state: LevelChecksState = Object.freeze({ checking: false, current: false, findings: [], stopped: null, failure: null });

  const publish = (next: Partial<LevelChecksState>): void => {
    state = Object.freeze({ ...state, ...next });
    for (const listener of listeners) listener();
  };
  const pending = (): boolean => timer !== null || running !== null;

  function changed(): void {
    version++;
    if (!active) {
      if (state.current) publish({ current: false });
      return;
    }
    schedule(SETTLE_MS);
  }

  function schedule(delay: number): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      start();
    }, delay);
    // Listeners hear only of a change: this runs while the level tells its own listeners of an edit.
    const current = checkedVersion === version && state.current;
    if (!state.checking || state.current !== current) publish({ checking: true, current });
  }

  // The reach model and goal for this level: the source's, or the engine's when a plugin's fails.
  function plan(level: LevelDefinition): LevelReachPlan {
    const source = options.plugins.reach();
    const input = { level, settings: options.settings() };
    if (source.plugin !== null && !options.plugins.failed(source.plugin)) {
      try {
        return checkReachPlan(apply1(source, 'reach', input));
      } catch (error) {
        options.plugins.fail(source.plugin, error, 'level reach');
      }
    }
    return ENGINE_LEVEL_REACH(input);
  }

  function start(): void {
    if (disposed || !active) return;
    // A newer edit replaces a run still going: its worker stops at once, and its result would be stale anyway.
    if (running !== null) {
      worker?.terminate();
      worker = null;
      running = null;
    }
    const level = options.level.definition();
    // The plan first: a plugin whose reach source fails stops, which counts as a change, and the run covers it.
    const reach = plan(level);
    const run: Run = { id: ++runs, version, level, plan: reach };
    running = run;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    const request: LevelCheckRequest = {
      id: run.id, level, reach: reach.model, goal: reach.goal, setPieces: SET_PIECE_IDS,
      stands: options.plugins.checks().size > 0,
    };
    connect().postMessage(request);
    if (!state.checking) publish({ checking: true });
  }

  function connect(): Worker {
    if (worker !== null) return worker;
    const created = new Worker(new URL('./level-checks-worker.ts', import.meta.url), { type: 'module', name: 'level-checks' });
    created.addEventListener('message', (event: MessageEvent<LevelCheckResponse>) => {
      if (created === worker) receive(event.data);
    });
    created.addEventListener('error', (event) => {
      if (created !== worker) return;
      event.preventDefault();
      created.terminate();
      worker = null;
      const run = running;
      running = null;
      if (run === null) return;
      checkedVersion = run.version;
      publish({
        checking: pending(), current: run.version === version, findings: [], stopped: null,
        failure: `The checks could not run: ${event.message || 'their worker failed to load'}.`,
      });
    });
    worker = created;
    return created;
  }

  function receive(response: LevelCheckResponse): void {
    const run = running;
    if (run === null || response.id !== run.id) return;
    running = null;
    checkedVersion = run.version;
    if ('failure' in response) {
      publish({
        checking: pending(), current: run.version === version, findings: [], stopped: null,
        failure: `The checks could not run: ${response.failure}`,
      });
      return;
    }
    const report = frozen(response.report);
    const engine: ShownFinding[] = report.findings.map((finding) => Object.freeze({ ...finding, source: null }));
    // Rules wait for results that are still current: an edit since brings a newer run. A rule that fails counts as a
    // change, so the state is read after them.
    const plugins = run.version === version ? rules(run, report) : [];
    publish({
      checking: pending(), current: run.version === version, findings: Object.freeze([...engine, ...plugins]),
      stopped: report.stopped, failure: null,
    });
  }

  // Each plugin's rules, on the engine's results. A rule that fails stops its plugin, as any plugin error does; its
  // rules then report that among the findings until the plugin changes, and the others go on.
  function rules(run: Run, report: LevelCheckReport): ShownFinding[] {
    const checks = options.plugins.checks();
    const project = checks.size === 0 ? null : options.plugins.project();
    if (project === null) return [];
    const findings: ShownFinding[] = [];
    const stopped = (rule: LevelCheck, error: unknown): void => {
      findings.push(Object.freeze({
        check: 'plugin-failed', severity: 'problem', message: `Its plugin stopped: ${reason(error)}`, at: null,
        objects: Object.freeze([]), source: rule.id,
      }));
    };
    const reach = report.reach === null ? null : Object.freeze({ ...report.reach, model: run.plan.model, goal: run.plan.goal });
    for (const rule of checks.values()) {
      const plugin = namespaceOf(rule.id);
      // Keyed composition gives every rule an ID in its plugin's namespace.
      if (plugin === null) continue;
      if (options.plugins.failed(plugin)) {
        stopped(rule, options.plugins.lastError(plugin) ?? 'it failed');
        continue;
      }
      const target = attributed(plugin, LEVEL_CHECKS.id, rule);
      const input: LevelCheckInput = Object.freeze({
        level: run.level, project, findings: report.findings, course: courseOf(run.level), reach,
      });
      try {
        for (const finding of ruleFindings(target, call1(target, 'check', input))) findings.push(Object.freeze({ ...finding, source: rule.id }));
      } catch (error) {
        options.plugins.fail(plugin, error, 'level check');
        stopped(rule, error);
      }
    }
    return findings;
  }

  const unsubscribe = [
    options.level.subscribe(() => changed()),
    options.plugins.subscribe(() => changed()),
  ];

  return {
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (!active) {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (state.checking !== (running !== null)) publish({ checking: running !== null });
        return;
      }
      if (checkedVersion !== version && running?.version !== version) schedule(0);
    },
    invalidate: () => changed(),
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stop of unsubscribe) stop();
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      worker?.terminate();
      worker = null;
      running = null;
      listeners.clear();
    },
  };
}
