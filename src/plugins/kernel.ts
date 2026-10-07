// The plugin kernel is DOM-free, three-free and safe on the Node type-stripping import chain.
// Points travel by ID, not object identity: Vite's Node runner can hold another copy of an SDK.
import { isNamespacedId, isPluginId, namespaceOf } from './ids.ts';
export { isNamespacedId, isPluginId, namespaceOf } from './ids.ts';

export const PLUGIN_API_VERSION = 2;
export const PLUGIN_LIMITS = Object.freeze({ plugins: 32 });
export const PLUGIN_ERROR_CODES = Object.freeze([
  'invalid-manifest', 'api-version', 'invalid-plugin', 'duplicate-plugin', 'reserved-plugin', 'invalid-facet',
  'unknown-point', 'invalid-contribution', 'duplicate-contribution', 'slot-conflict', 'duplicate-id',
  'foreign-namespace', 'too-many', 'plugin-failed', 'plugin-stopped',
] as const);
const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/;

export class PluginError extends Error {
  readonly kind = 'plugin-error';
  readonly code: string;
  readonly plugin: string | null;
  readonly point: string | null;

  constructor(code: string, message: string, plugin: string | null = null, point: string | null = null, options?: ErrorOptions) {
    super(message, options);
    if (!ERROR_CODE.test(code)) throw new TypeError(`Plugin error codes use lowercase letters, digits and hyphens, not "${code}".`);
    this.name = 'PluginError';
    this.code = code;
    this.plugin = plugin;
    this.point = point;
  }
}

export interface Attributed<T> {
  readonly plugin: string | null;
  readonly point: string | null;
  readonly value: T;
}

export interface CheckedInstance<T extends object> extends Attributed<T> {
  readonly captured: Readonly<Partial<T>>;
}

export function attributed<T>(plugin: string | null, point: string | null, value: T): Attributed<T> {
  return Object.freeze({ plugin, point, value });
}

export function pluginFailure(error: unknown, plugin: string | null, point: string | null, action: string): PluginError {
  if (error instanceof PluginError && error.plugin === plugin && error.point === point) return error;
  return new PluginError('plugin-failed',
    `Plugin "${plugin ?? 'engine'}" failed ${point === null ? '' : `"${point}" `}${action}: ${error instanceof Error ? error.message : String(error)}`,
    plugin, point, { cause: error });
}

export function invalidResult(target: Pick<Attributed<unknown>, 'plugin' | 'point'>, requirement: string,
  code: 'invalid-contribution' | 'invalid-plugin' = 'invalid-contribution'): PluginError {
  return new PluginError(code,
    `Plugin "${target.plugin ?? 'engine'}": ${target.point === null ? '' : `"${target.point}" `}${requirement}.`,
    target.plugin, target.point);
}

export function checkSynchronous(result: unknown, target: Pick<Attributed<unknown>, 'plugin' | 'point'>, action: string): void {
  // A void callback may return an incidental value (for example Array.push's count). Only async work is invalid:
  // a promise would outlive borrowed input or output, and the engine never awaits these callbacks.
  let asynchronous = false;
  try {
    asynchronous = result !== null && (typeof result === 'object' || typeof result === 'function') &&
      typeof Reflect.get(result, 'then') === 'function';
  } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, action);
  }
  if (asynchronous) throw invalidResult(target, `${action} must finish synchronously, not return a promise`);
}

export interface InstanceContract {
  readonly returns: string;
  readonly methods: readonly string[];
  readonly optional?: readonly string[];
  readonly root?: true;
  readonly passes?: readonly string[];
  // Read once with attribution. When given, check receives these captured members (and pass), not the instance.
  readonly capture?: readonly string[];
  readonly check?: (value: object) => boolean;
}

export function instanceContract(contract: InstanceContract): InstanceContract {
  return Object.freeze({
    ...contract,
    methods: Object.freeze([...contract.methods]),
    ...(contract.optional === undefined ? {} : { optional: Object.freeze([...contract.optional]) }),
    ...(contract.passes === undefined ? {} : { passes: Object.freeze([...contract.passes]) }),
    ...(contract.capture === undefined ? {} : { capture: Object.freeze([...contract.capture]) }),
  });
}

export function isObject3D(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'isObject3D') === true;
}

const EMPTY_CAPTURED: Record<string, unknown> = Object.freeze({});

export function checkInstance<T extends object>(contract: InstanceContract, value: unknown,
  source: Pick<Attributed<unknown>, 'plugin' | 'point'>,
  code: 'invalid-contribution' | 'invalid-plugin' = 'invalid-contribution'): CheckedInstance<T> {
  let valid = false;
  const captured = contract.passes === undefined && contract.capture === undefined
    ? EMPTY_CAPTURED : Object.create(null) as Record<string, unknown>;
  try {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      valid = contract.methods.every((method) => typeof Reflect.get(value, method) === 'function') &&
        (contract.optional === undefined || contract.optional.every((method) => {
          const member: unknown = Reflect.get(value, method);
          return member === undefined || typeof member === 'function';
        }));
      if (valid && contract.root) {
        valid = isObject3D(Reflect.get(value, 'root'));
      }
      if (valid && contract.passes !== undefined) {
        const pass: unknown = Reflect.get(value, 'pass');
        captured.pass = pass;
        valid = contract.passes.includes(pass as string);
      }
      if (valid && contract.capture !== undefined) {
        for (const member of contract.capture) {
          if (!Object.hasOwn(captured, member)) captured[member] = Reflect.get(value, member);
        }
      }
      if (valid && contract.check !== undefined) valid = contract.check(contract.capture === undefined ? value : captured);
    }
  } catch (error) {
    throw pluginFailure(error, source.plugin, source.point, 'create');
  }
  if (!valid) throw invalidResult(source, `must return ${contract.returns}`, code);
  return Object.freeze({
    plugin: source.plugin, point: source.point, value: value as T,
    captured: Object.freeze(captured) as Readonly<Partial<T>>,
  });
}

export function createInstance<T extends object>(contract: InstanceContract, source: Attributed<unknown>,
  create: () => unknown): CheckedInstance<T> {
  let value: unknown;
  try { value = create(); } catch (error) {
    throw pluginFailure(error, source.plugin, source.point, 'create');
  }
  checkSynchronous(value, source, 'create');
  return checkInstance<T>(contract, value, source);
}

type Callable = (...args: never[]) => unknown;
export type MethodKey<T> = { [K in keyof T]-?: NonNullable<T[K]> extends Callable ? K : never }[keyof T] & string;
type MethodOf<T, K extends keyof T> = Extract<NonNullable<T[K]>, Callable>;

function method<T, K extends MethodKey<T>>(target: Attributed<T>, key: K): MethodOf<T, K> {
  let value: unknown;
  try { value = target.value[key]; } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, key);
  }
  if (typeof value !== 'function') throw new Error(`Cannot call non-method "${key}".`);
  return value as MethodOf<T, K>;
}

export function call0<T, K extends MethodKey<T>>(target: Attributed<T>, key: K): ReturnType<MethodOf<T, K>> {
  const fn = method(target, key);
  let result: ReturnType<MethodOf<T, K>>;
  try { result = fn.call(target.value) as ReturnType<MethodOf<T, K>>; } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, key);
  }
  checkSynchronous(result, target, key);
  return result;
}

export function call1<T, K extends MethodKey<T>>(target: Attributed<T>, key: K,
  a: Parameters<MethodOf<T, K>>[0]): ReturnType<MethodOf<T, K>> {
  const fn = method(target, key);
  let result: ReturnType<MethodOf<T, K>>;
  try { result = fn.call(target.value, a as never) as ReturnType<MethodOf<T, K>>; } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, key);
  }
  checkSynchronous(result, target, key);
  return result;
}

export function call2<T, K extends MethodKey<T>>(target: Attributed<T>, key: K,
  a: Parameters<MethodOf<T, K>>[0], b: Parameters<MethodOf<T, K>>[1]): ReturnType<MethodOf<T, K>> {
  const fn = method(target, key);
  let result: ReturnType<MethodOf<T, K>>;
  try { result = fn.call(target.value, a as never, b as never) as ReturnType<MethodOf<T, K>>; } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, key);
  }
  checkSynchronous(result, target, key);
  return result;
}

export function call3<T, K extends MethodKey<T>>(target: Attributed<T>, key: K,
  a: Parameters<MethodOf<T, K>>[0], b: Parameters<MethodOf<T, K>>[1],
  c: Parameters<MethodOf<T, K>>[2]): ReturnType<MethodOf<T, K>> {
  const fn = method(target, key);
  let result: ReturnType<MethodOf<T, K>>;
  try { result = fn.call(target.value, a as never, b as never, c as never) as ReturnType<MethodOf<T, K>>; } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, key);
  }
  checkSynchronous(result, target, key);
  return result;
}

export function apply1<A, R>(target: Attributed<(a: A) => R>, action: string, a: A): R {
  const fn = target.value;
  if (typeof fn !== 'function') throw new Error(`Cannot apply non-function "${action}".`);
  let result: R;
  try { result = fn(a); } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, action);
  }
  checkSynchronous(result, target, action);
  return result;
}

export function apply2<A, B, R>(target: Attributed<(a: A, b: B) => R>, action: string, a: A, b: B): R {
  const fn = target.value;
  if (typeof fn !== 'function') throw new Error(`Cannot apply non-function "${action}".`);
  let result: R;
  try { result = fn(a, b); } catch (error) {
    throw pluginFailure(error, target.plugin, target.point, action);
  }
  checkSynchronous(result, target, action);
  return result;
}

// Rebuild a typed refusal crossing a module-runner boundary. Never match error messages.
export function pluginRefusal(error: unknown, plugin: string): PluginError | null {
  if (typeof error !== 'object' || error === null || Reflect.get(error, 'kind') !== 'plugin-error') return null;
  const code: unknown = Reflect.get(error, 'code');
  const message: unknown = Reflect.get(error, 'message');
  const point: unknown = Reflect.get(error, 'point');
  if (typeof code !== 'string' || !ERROR_CODE.test(code) || typeof message !== 'string' ||
    point !== null && typeof point !== 'string') return null;
  if (error instanceof PluginError && error.plugin === plugin) return error;
  return new PluginError(code, message, plugin, point, { cause: Reflect.get(error, 'cause') });
}

export type PluginEnvironment = 'kinds' | 'runtime' | 'release' | 'workshop';

export interface SlotPoint<T> {
  readonly type: 'slot';
  readonly id: string;
  readonly environment: PluginEnvironment;
  check(value: unknown): T;
}
export interface KeyedPoint<T extends { readonly id: string }> {
  readonly type: 'keyed';
  readonly id: string;
  readonly environment: PluginEnvironment;
  readonly limit: number;
  check(value: unknown): T;
}
export interface ListPoint<T> {
  readonly type: 'list';
  readonly id: string;
  readonly environment: PluginEnvironment;
  readonly limit: number;
  check(value: unknown): T;
}
export type PluginPoint = SlotPoint<unknown> | KeyedPoint<{ readonly id: string }> | ListPoint<unknown>;

export function slotPoint<T>(id: string, environment: PluginEnvironment, check: (value: unknown) => T): SlotPoint<T> {
  return Object.freeze({ type: 'slot', id, environment, check });
}
export function keyedPoint<T extends { readonly id: string }>(id: string, environment: PluginEnvironment,
  limit: number, check: (value: unknown) => T): KeyedPoint<T> {
  return Object.freeze({ type: 'keyed', id, environment, limit, check });
}
export function listPoint<T>(id: string, environment: PluginEnvironment, limit: number, check: (value: unknown) => T): ListPoint<T> {
  return Object.freeze({ type: 'list', id, environment, limit, check });
}

export interface Contribution {
  readonly point: string;
  readonly verb: 'replace' | 'wrap' | 'add';
  readonly value: unknown;
}
export interface PluginContributions {
  readonly plugin: string;
  readonly contributions: readonly Contribution[];
}
export interface PluginEntry<F> {
  readonly id: string;
  readonly facet: F;
}
const NO_ADDITIONS: readonly Attributed<never>[] = Object.freeze([]);

export function replace<T>(point: SlotPoint<T>, value: T): Contribution {
  return Object.freeze({ point: point.id, verb: 'replace', value });
}
export function wrap<T>(point: SlotPoint<T>, decorate: (previous: T) => T): Contribution {
  return Object.freeze({ point: point.id, verb: 'wrap', value: decorate });
}
export function add<T extends { readonly id: string }>(point: KeyedPoint<T>, ...items: T[]): Contribution;
export function add<T>(point: ListPoint<T>, ...items: T[]): Contribution;
export function add(point: PluginPoint, ...items: unknown[]): Contribution {
  return Object.freeze({ point: point.id, verb: 'add', value: Object.freeze(items) });
}

// Facet identity is supplied by the manifest, never by a facet's export.
export function checkPluginIds(ids: readonly string[]): void {
  if (ids.length > PLUGIN_LIMITS.plugins) throw new PluginError('too-many', `At most ${PLUGIN_LIMITS.plugins} plugins may compose a session.`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isPluginId(id)) throw new PluginError('invalid-plugin', `Invalid plugin ID "${String(id)}".`, typeof id === 'string' ? id : null);
    if (id === 'engine') throw new PluginError('reserved-plugin', 'The plugin ID "engine" is reserved.', id);
    if (seen.has(id)) throw new PluginError('duplicate-plugin', `Two plugins share the ID "${id}".`, id);
    seen.add(id);
  }
}

export function checkFacetEntries<F>(value: unknown, check: (facet: unknown, plugin: string) => F): readonly PluginEntry<F>[] {
  if (!Array.isArray(value)) throw new PluginError('invalid-facet', 'Plugin facet entries must be a list.');
  if (value.length > PLUGIN_LIMITS.plugins) throw new PluginError('too-many', `At most ${PLUGIN_LIMITS.plugins} plugins may compose a session.`);
  const entries = value.map((entry: unknown): { id: string; facet: unknown } => {
    if (typeof entry !== 'object' || entry === null || typeof Reflect.get(entry, 'id') !== 'string') {
      throw new PluginError('invalid-facet', 'A plugin facet entry needs its manifest ID and facet.');
    }
    return { id: Reflect.get(entry, 'id') as string, facet: Reflect.get(entry, 'facet') };
  });
  checkPluginIds(entries.map(({ id }) => id));
  return Object.freeze(entries.map(({ id, facet }) => Object.freeze({ id, facet: check(facet, id) })));
}

function checked<T>(point: { readonly id: string; check(value: unknown): T }, value: unknown, plugin: string | null): T {
  try {
    return point.check(value);
  } catch (error) {
    const refusal = plugin === null ? null : pluginRefusal(error, plugin);
    throw new PluginError(refusal?.code ?? 'invalid-contribution',
      `Plugin "${plugin ?? 'engine'}", point "${point.id}": ${refusal?.message ?? (error instanceof Error ? error.message : String(error))}`,
      plugin, point.id, { cause: error });
  }
}

interface SlotContribution extends Attributed<unknown> {
  readonly verb: 'replace' | 'wrap';
}

/** Validate a complete environment atomically. Resolve points once per session, never on a frame path. */
export class Composition {
  private readonly catalogue: ReadonlyMap<string, PluginPoint>;
  private readonly slots = new Map<string, readonly SlotContribution[]>();
  private readonly additions = new Map<string, readonly Attributed<unknown>[]>();
  private readonly resolvedSlots = new Map<string, Attributed<unknown>>();
  private readonly resolvedKeyed = new Map<string, ReadonlyMap<string, { readonly id: string }>>();

  constructor(environment: PluginEnvironment, catalogue: readonly PluginPoint[], plugins: readonly PluginContributions[]) {
    const points = new Map<string, PluginPoint>();
    for (const point of catalogue) {
      if (point.environment !== environment || points.has(point.id)) {
        throw new PluginError('unknown-point', `Invalid ${environment} catalogue point "${point.id}".`, null, point.id);
      }
      points.set(point.id, point);
    }
    this.catalogue = points;
    checkPluginIds(plugins.map(({ plugin }) => plugin));
    const slots = new Map<string, SlotContribution[]>();
    const additions = new Map<string, Attributed<unknown>[]>();
    const ids = new Map<string, Set<string>>();
    for (const { plugin, contributions } of plugins) {
      if (!Array.isArray(contributions)) {
        throw new PluginError('invalid-contribution', `Plugin "${plugin}" must return a list of contributions.`, plugin);
      }
      const seen = new Set<string>();
      for (const contribution of contributions) {
        if (typeof contribution !== 'object' || contribution === null || typeof contribution.point !== 'string') {
          throw new PluginError('invalid-contribution', `Plugin "${plugin}" has a malformed contribution.`, plugin);
        }
        const { point: id, verb, value } = contribution;
        const point = points.get(id);
        if (point === undefined) throw new PluginError('unknown-point', `Plugin "${plugin}" contributes to unknown ${environment} point "${id}".`, plugin, id);
        if (point.type === 'slot' ? verb !== 'replace' && verb !== 'wrap' : verb !== 'add') {
          throw new PluginError('invalid-contribution', `Point "${id}" does not take "${String(verb)}".`, plugin, id);
        }
        if (seen.has(id)) throw new PluginError('duplicate-contribution', `Plugin "${plugin}" contributes to "${id}" twice.`, plugin, id);
        seen.add(id);
        if (point.type === 'slot') {
          const previous = slots.get(id) ?? [];
          if (verb === 'replace' && previous.length > 0) {
            throw new PluginError('slot-conflict',
              `Plugin "${plugin}" replaces "${id}" after plugin "${previous[0]!.plugin}" contributed to it; reorder the manifest or wrap instead.`,
              plugin, id);
          }
          if (verb === 'wrap' && typeof value !== 'function') {
            throw new PluginError('invalid-contribution', `Plugin "${plugin}" must wrap "${id}" with a function.`, plugin, id);
          }
          previous.push(Object.freeze({ plugin, point: id, verb: verb as 'replace' | 'wrap', value: verb === 'replace' ? checked(point, value, plugin) : value }));
          slots.set(id, previous);
          continue;
        }
        if (!Array.isArray(value)) throw new PluginError('invalid-contribution', `Plugin "${plugin}" must add a list to "${id}".`, plugin, id);
        const items = additions.get(id) ?? [];
        if (items.length + value.length > point.limit) {
          throw new PluginError('too-many', `Point "${id}" holds at most ${point.limit} items.`, plugin, id);
        }
        for (const item of value as unknown[]) {
          const result = checked(point, item, plugin);
          if (point.type === 'keyed') {
            const key = (result as { readonly id: string }).id;
            if (!isNamespacedId(key) || namespaceOf(key) !== plugin) {
              throw new PluginError('foreign-namespace', `Plugin "${plugin}" must name "${id}" items "${plugin}/<name>", not "${key}".`, plugin, id);
            }
            const keys = ids.get(id) ?? new Set<string>();
            if (keys.has(key)) throw new PluginError('duplicate-id', `Point "${id}" has duplicate ID "${key}".`, plugin, id);
            keys.add(key);
            ids.set(id, keys);
          }
          items.push(attributed(plugin, id, result));
        }
        additions.set(id, items);
      }
    }
    for (const [id, values] of slots) this.slots.set(id, Object.freeze(values));
    for (const [id, values] of additions) this.additions.set(id, Object.freeze(values));
  }

  private point(id: string, type: PluginPoint['type']): PluginPoint {
    const point = this.catalogue.get(id);
    if (point === undefined || point.type !== type) throw new PluginError('unknown-point', `Unknown ${type} point "${id}".`, null, id);
    return point;
  }

  slot<T>(descriptor: SlotPoint<T>, base: T): Attributed<T> {
    const point = this.point(descriptor.id, 'slot') as SlotPoint<T>;
    const cached = this.resolvedSlots.get(point.id);
    if (cached !== undefined) return cached as Attributed<T>;
    let result = base;
    let owner: string | null = null;
    for (const contribution of this.slots.get(point.id) ?? []) {
      owner = contribution.plugin;
      if (contribution.verb === 'replace') result = contribution.value as T;
      else {
        result = apply1(contribution as Attributed<(previous: T) => T>, 'wrap', result);
      }
      result = checked(point, result, owner);
    }
    if (owner === null) result = checked(point, result, null);
    const resolved = attributed(owner, point.id, result);
    this.resolvedSlots.set(point.id, resolved);
    return resolved;
  }

  keyed<T extends { readonly id: string }>(descriptor: KeyedPoint<T>, builtIns: readonly T[]): ReadonlyMap<string, T> {
    const point = this.point(descriptor.id, 'keyed') as KeyedPoint<T>;
    const cached = this.resolvedKeyed.get(point.id);
    if (cached !== undefined) return cached as ReadonlyMap<string, T>;
    const result = new Map<string, T>();
    const insert = (value: T, plugin: string | null): void => {
      if (result.has(value.id)) throw new PluginError('duplicate-id', `Point "${point.id}" has duplicate ID "${value.id}".`, plugin, point.id);
      if (result.size >= point.limit) throw new PluginError('too-many', `Point "${point.id}" holds at most ${point.limit} items including built-ins.`, plugin, point.id);
      result.set(value.id, value);
    };
    for (const value of builtIns) {
      const item = checked(point, value, null);
      if (!isPluginId(item.id)) {
        throw new PluginError('invalid-contribution', `Built-in IDs at "${point.id}" must be unnamespaced, not "${item.id}".`, null, point.id);
      }
      insert(item, null);
    }
    for (const { plugin, value } of this.additions.get(point.id) ?? []) insert(value as T, plugin);
    this.resolvedKeyed.set(point.id, result);
    return result;
  }

  list<T>(descriptor: ListPoint<T>): readonly Attributed<T>[] {
    this.point(descriptor.id, 'list');
    return (this.additions.get(descriptor.id) ?? NO_ADDITIONS) as readonly Attributed<T>[];
  }
}
