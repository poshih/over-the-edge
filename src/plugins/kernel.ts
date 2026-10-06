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

export function checkSynchronous(result: unknown, plugin: string | null, point: string, method: string): void {
  // A void callback may return an incidental value (for example Array.push's count). Only async work is invalid:
  // a promise would outlive borrowed input or output, and the engine never awaits these callbacks.
  if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
    typeof Reflect.get(result, 'then') === 'function') {
    throw new PluginError('invalid-contribution',
      `Plugin "${plugin ?? 'engine'}": "${point}" ${method} must finish synchronously, not return a promise.`, plugin, point);
  }
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
export interface Attributed<T> {
  readonly plugin: string;
  readonly value: T;
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
  private readonly resolvedSlots = new Map<string, unknown>();
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
          previous.push(Object.freeze({ plugin, verb: verb as 'replace' | 'wrap', value: verb === 'replace' ? checked(point, value, plugin) : value }));
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
          items.push(Object.freeze({ plugin, value: result }));
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

  slot<T>(descriptor: SlotPoint<T>, base: T): T {
    const point = this.point(descriptor.id, 'slot') as SlotPoint<T>;
    if (this.resolvedSlots.has(point.id)) return this.resolvedSlots.get(point.id) as T;
    let result = base;
    let owner: string | null = null;
    for (const contribution of this.slots.get(point.id) ?? []) {
      owner = contribution.plugin;
      if (contribution.verb === 'replace') result = contribution.value as T;
      else {
        try {
          result = (contribution.value as (previous: T) => T)(result);
        } catch (error) {
          throw new PluginError('plugin-failed', `Plugin "${owner}" failed wrapping "${point.id}".`, owner, point.id, { cause: error });
        }
      }
      result = checked(point, result, owner);
    }
    if (owner === null) result = checked(point, result, null);
    this.resolvedSlots.set(point.id, result);
    return result;
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

  // The last contributor owns a slot's resolved value, for host restrictions and creation diagnostics.
  owner(point: SlotPoint<unknown>): string | null {
    this.point(point.id, 'slot');
    return this.slots.get(point.id)?.at(-1)?.plugin ?? null;
  }
}
