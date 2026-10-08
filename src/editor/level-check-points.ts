// The Workshop's points for the Level tab's checks (docs/workshop-plugins.md): plugins' rules, and where the reach model
// comes from. Validated in the browser at load and hot update; the rules run in the page, after the engine's checks.
import type { Point } from '../config';
import { checkReachModel, FINDING_SEVERITIES, levelGoal, reachForSettings } from '../course-checks';
import type { FindingSeverity, LevelFinding, LevelReachSummary, ReachModel } from '../course-checks';
import type { GameSettings } from '../game-settings';
import type { LevelDefinition } from '../level';
import { invalidResult, keyedPoint, slotPoint } from '../plugins/kernel';
import type { Attributed } from '../plugins/kernel';
import type { WorkshopProjectSnapshot } from './workshop-sdk';

export const LEVEL_CHECK_LIMITS = Object.freeze({ checks: 32, findings: 64, message: 300, objects: 16 });

/** A plugin's own rule for the Level tab's checks. */
export interface LevelCheck {
  // `<plugin>/<name>`: the Checks list names it beside its findings.
  readonly id: string;
  // The rule's findings for `input`'s level: at most LEVEL_CHECK_LIMITS.findings, synchronously. Pure: it never changes
  // the level, and its input is borrowed until it returns.
  check(input: LevelCheckInput): readonly LevelCheckFinding[];
}

// What a rule finds, in the engine's form; the Workshop names the rule as the finding's check.
export interface LevelCheckFinding {
  readonly severity: FindingSeverity;
  // Plain text, at most LEVEL_CHECK_LIMITS.message characters.
  readonly message: string;
  // Where, in world metres, for the course marker and to focus the view; none for a finding about the whole level.
  readonly at?: Readonly<Point> | null;
  // The level objects it concerns, at most LEVEL_CHECK_LIMITS.objects; picking the finding selects the first.
  readonly objects?: readonly string[];
}

export interface LevelCheckInput {
  // The level the engine checked: the open level once edits settled, unsaved changes included.
  readonly level: LevelDefinition;
  // The open project, as host.project.snapshot() gives it: its settings, art, theme and the rest.
  readonly project: WorkshopProjectSnapshot;
  // The engine's own findings for the level.
  readonly findings: readonly LevelFinding[];
  // The level's placed collision, and queries on it.
  readonly course: LevelCheckCourse;
  // The reach model's result, or null when it measured none.
  readonly reach: LevelCheckReach | null;
}

export interface LevelCheckCourse {
  // A terrain object's placed collision, in world metres: loops with the solid on each edge's left, outer loops
  // counterclockwise and holes clockwise, and a circle as its polygon; null for an ID that is not terrain.
  loops(id: string): readonly (readonly Readonly<Point>[])[] | null;
  // The terrain object, other than an illusion, whose collision holds `point`, or null.
  inside(point: Readonly<Point>): string | null;
  // Whether the segment passes through the inside of terrain other than illusions; touching it does not count.
  blocks(from: Readonly<Point>, to: Readonly<Point>): boolean;
}

export interface LevelCheckReach extends LevelReachSummary {
  // The model and goal it measured with.
  readonly model: ReachModel;
  readonly goal: Readonly<Point> | null;
}

export interface LevelReachInput {
  readonly level: LevelDefinition;
  readonly settings: GameSettings;
}

export interface LevelReachPlan {
  // A complete reach model (docs/course-kit.md, The reach model).
  readonly model: ReachModel;
  // What a level without an ending trigger measures reach to, or null for nothing.
  readonly goal: Readonly<Point> | null;
}

/** Where the reach model comes from: the model for the game's settings, and the goal of a level without an ending. */
export type LevelReachSource = (input: LevelReachInput) => LevelReachPlan;

/** The engine's: reachForSettings for the game's rig and grip, and the level's highest bonfire as its goal. */
export const ENGINE_LEVEL_REACH: LevelReachSource = (input) => Object.freeze({
  model: reachForSettings(input.settings), goal: levelGoal(input.level),
});

function checkRule(value: unknown): LevelCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'id' && key !== 'check')) {
    throw new TypeError('A level check is an object with exactly an id and a check function.');
  }
  const rule = value as { readonly id: unknown; readonly check: unknown };
  const { id, check } = rule;
  if (typeof id !== 'string') throw new TypeError('A level check needs its "<plugin>/<name>" ID.');
  if (typeof check !== 'function') throw new TypeError(`Level check "${id}" needs a check function.`);
  // The rule keeps its own `this`, and its ID cannot change after it loads.
  return Object.freeze({ id, check: (input: LevelCheckInput) => check.call(rule, input) as readonly LevelCheckFinding[] });
}

function checkSource(value: unknown): LevelReachSource {
  if (typeof value !== 'function') throw new TypeError('The level reach source is a function of the level and the game settings.');
  return value as LevelReachSource;
}

export const LEVEL_CHECKS = keyedPoint<LevelCheck>('level.checks', 'workshop', LEVEL_CHECK_LIMITS.checks, checkRule);
export const LEVEL_REACH = slotPoint<LevelReachSource>('level.reach', 'workshop', checkSource);

const finitePoint = (value: unknown): value is Point => typeof value === 'object' && value !== null &&
  Number.isFinite(Reflect.get(value, 'x')) && Number.isFinite(Reflect.get(value, 'y'));

/** A reach source's result, checked: a complete valid model, and a goal that is null or a finite point. */
export function checkReachPlan(value: unknown): LevelReachPlan {
  if (typeof value !== 'object' || value === null) throw new TypeError('A level reach source returns { model, goal }.');
  const goal: unknown = Reflect.get(value, 'goal');
  if (goal !== null && !finitePoint(goal)) throw new TypeError('A level reach source\'s goal is null or a finite { x, y } point.');
  return Object.freeze({ model: checkReachModel(Reflect.get(value, 'model')), goal: goal === null ? null : Object.freeze({ x: goal.x, y: goal.y }) });
}

/** A rule's result as the engine's findings, its check its ID; a result that breaks the contract throws invalidResult. */
export function ruleFindings(rule: Attributed<LevelCheck>, result: unknown): LevelFinding[] {
  const fail = (requirement: string): never => { throw invalidResult(rule, `check "${rule.value.id}" ${requirement}`); };
  if (!Array.isArray(result)) fail('must return a list of findings');
  const entries = result as readonly unknown[];
  if (entries.length > LEVEL_CHECK_LIMITS.findings) fail(`returns at most ${LEVEL_CHECK_LIMITS.findings} findings`);
  return entries.map((entry): LevelFinding => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) ||
      Object.keys(entry).some((key) => !['severity', 'message', 'at', 'objects'].includes(key))) {
      fail('returns findings with only severity, message, at and objects');
    }
    const { severity, message, at, objects } = entry as Record<string, unknown>;
    if (typeof severity !== 'string' || !FINDING_SEVERITIES.includes(severity as FindingSeverity)) {
      fail(`gives each finding a severity of ${FINDING_SEVERITIES.join(' or ')}`);
    }
    if (typeof message !== 'string' || message.trim() === '' || message.length > LEVEL_CHECK_LIMITS.message) {
      fail(`gives each finding a message of 1-${LEVEL_CHECK_LIMITS.message} characters`);
    }
    if (at !== undefined && at !== null && !finitePoint(at)) fail('places findings at finite { x, y } points');
    const ids = objects === undefined ? [] : objects;
    if (!Array.isArray(ids) || ids.length > LEVEL_CHECK_LIMITS.objects || ids.some((id) => typeof id !== 'string')) {
      fail(`names at most ${LEVEL_CHECK_LIMITS.objects} object IDs per finding`);
    }
    const point = finitePoint(at) ? Object.freeze({ x: at.x, y: at.y }) : null;
    return Object.freeze({
      check: rule.value.id, severity: severity as FindingSeverity, message: (message as string).trim(), at: point,
      objects: Object.freeze([...new Set(ids as readonly string[])]),
    });
  });
}
