import type { ContentAccess, ContentError, ContentProgress } from '../content-session';
import type { PhantomService } from '../phantom-service-types';
import type { ModelLibraryApi } from '../release-library';
import { NOTICES } from '../notice';
import { FATAL } from '../fatal-display';
import { MENU } from '../game-menu';
import { apply1, checkFacetEntries, Composition, listPoint, PLUGIN_LIMITS, PluginError, pluginFailure, slotPoint } from './kernel';
import type { Attributed, Contribution, KeyedPoint, ListPoint, SlotPoint } from './kernel';

export interface ReleaseHost {
  readonly plugin: string;
  readonly mount: HTMLElement;
  readonly contentUrl: string;
  readonly phantomsUrl: string | null;
  readonly signal: AbortSignal;
  notice(message: string, kind?: 'info' | 'error'): void;
}
export interface ReleaseApi {
  // Each API is bound to its plugin's reason, never another plugin's or the player's.
  setPause(paused: boolean): void;
  setInputBlock(blocked: boolean): void;
  readonly halted: boolean;
  readonly modelLibrary: ModelLibraryApi;
}
export interface ReleaseFacet {
  start(host: ReleaseHost): readonly Contribution[] | Promise<readonly Contribution[]>;
}

export function defineRelease<T extends ReleaseFacet>(facet: T): T { return facet; }

function access(value: unknown): ContentAccess {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'grant') !== 'function' ||
    Reflect.get(value, 'select') !== undefined && typeof Reflect.get(value, 'select') !== 'function') {
    throw new TypeError('Content access must supply grant() and, when given, select().');
  }
  return value as ContentAccess;
}
function phantoms(value: unknown): PhantomService | null {
  if (value === null) return null;
  if (typeof value !== 'object' || typeof Reflect.get(value, 'submit') !== 'function' || typeof Reflect.get(value, 'nearby') !== 'function') {
    throw new TypeError('A phantom service must supply submit() and nearby(), or be null.');
  }
  return value as PhantomService;
}
function callback<T extends (...args: never[]) => unknown>(value: unknown): T {
  if (typeof value !== 'function') throw new TypeError('A release callback must be a function.');
  return value as T;
}

export const ACCESS = slotPoint('release.access', 'release', access);
export const PHANTOMS = slotPoint('release.phantoms', 'release', phantoms);
export const FAILED = slotPoint('release.failed', 'release', callback<(error: ContentError) => Promise<void>>);
export const PROGRESS = listPoint('release.progress', 'release', PLUGIN_LIMITS.plugins, callback<(progress: ContentProgress) => void>);
export const MODEL_FAILED = listPoint('release.model-failed', 'release', PLUGIN_LIMITS.plugins, callback<(error: Error) => void>);
export const READY = listPoint('release.ready', 'release', PLUGIN_LIMITS.plugins, callback<(api: ReleaseApi) => void>);
export const RELEASE = Object.freeze([NOTICES, FATAL, ACCESS, PHANTOMS, FAILED, PROGRESS, MODEL_FAILED, READY, MENU]);

function checkRelease(value: unknown, plugin: string): ReleaseFacet {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof Reflect.get(value, 'start') !== 'function') {
    throw new PluginError('invalid-facet', `Plugin "${plugin}" must default-export a release facet with start(host).`, plugin);
  }
  return value as ReleaseFacet;
}

/** Await release facets in manifest order, before fetching anything. Abort startup and stop in reverse order. */
export class ReleasePlugins {
  private composition: Composition | null = null;
  private readonly controllers: AbortController[] = [];
  private readonly signal: AbortSignal;
  private readonly stop: () => void;
  private stopped = false;

  private constructor(signal: AbortSignal) {
    this.signal = signal;
    this.stop = () => this.dispose();
    signal.addEventListener('abort', this.stop, { once: true });
  }

  static async start(value: unknown, options: Omit<ReleaseHost, 'plugin'>): Promise<ReleasePlugins> {
    const entries = checkFacetEntries(value, checkRelease);
    const session = new ReleasePlugins(options.signal);
    try {
      const plugins: { plugin: string; contributions: readonly Contribution[] }[] = [];
      for (const { id, facet } of entries) {
        options.signal.throwIfAborted();
        const controller = new AbortController();
        session.controllers.push(controller);
        const host: ReleaseHost = Object.freeze({ ...options, plugin: id, signal: controller.signal });
        let contributions: readonly Contribution[];
        try { contributions = await facet.start(host); } catch (error) {
          options.signal.throwIfAborted();
          throw pluginFailure(error, id, null, 'start');
        }
        options.signal.throwIfAborted();
        plugins.push({ plugin: id, contributions });
      }
      options.signal.throwIfAborted();
      session.composition = new Composition('release', RELEASE, plugins);
      // Once startup succeeds the release owner disposes consumers before aborting facet signals.
      options.signal.removeEventListener('abort', session.stop);
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  private live(): Composition {
    if (this.stopped || this.composition === null) throw new PluginError('plugin-stopped', 'The release plugin session is not running.');
    return this.composition;
  }

  slot<T>(point: SlotPoint<T>, base: T): Attributed<T> { return this.live().slot(point, base); }
  keyed<T extends { readonly id: string }>(point: KeyedPoint<T>, builtIns: readonly T[]): ReadonlyMap<string, T> {
    return this.live().keyed(point, builtIns);
  }
  list<T>(point: ListPoint<T>): readonly Attributed<T>[] { return this.live().list(point); }
  notify<A>(point: ListPoint<(argument: A) => void>, argument: (plugin: string) => A): void {
    for (const item of this.list(point)) apply1(item, 'callback', argument(item.plugin!));
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.signal.removeEventListener('abort', this.stop);
    for (let index = this.controllers.length - 1; index >= 0; index--) this.controllers[index]!.abort();
  }
}
