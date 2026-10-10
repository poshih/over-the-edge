import type { AudioSettings } from '../../audio-settings';
import type { DecorationArt } from '../../decoration-art';
import { Disposal } from '../../disposal';
import { enemyArtAssets } from '../../enemy-art-data';
import { ENEMY_SPECIES } from '../../enemy-types';
import type { EnemyBake } from '../../enemy-model-check';
import type { CourseArtwork, GameLook } from '../../game-look';
import { NO_COURSE_ARTWORK } from '../../game-look';
import type { HammerHead } from '../../hammer-head';
import { isMediaLibraryPath, mediaType } from '../../media';
import type { MeshTerrain } from '../../mesh-collision';
import { libraryAvatarSettings } from '../../model-library';
import type { LibraryAvatarEntry, LibraryAvatarSettings, LibraryEntry, LibraryHammerEntry, PartRole } from '../../model-library';
import { isProjectDataError, ProjectError } from '../../project';
import { MeshBaker } from '../mesh-baker';
import type { FileHandle, FileStore, FileUrl } from './files';
import type { DocumentArt, DocumentArtAsset, DocumentMedia, DocumentModel, DocumentModels, ProjectDocument } from './project-document';

export interface LibraryModel {
  readonly role: PartRole;
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly avatar: LibraryAvatarSettings | null;
  readonly head: HammerHead | null;
}

export interface ProjectLook {
  readonly game: GameLook;
  readonly audio: AudioSettings;
  readonly resolveMedia: (source: string) => string;
  readonly mediaVersion: number;
}

export interface ProjectBake<T> {
  readonly promise: Promise<T>;
  release(): void;
}

export interface ProjectProjection {
  activate(): void;
  libraryModels(): readonly LibraryModel[];
  libraryHammers(): readonly { readonly id: string; readonly name: string; readonly head: HammerHead }[];
  courseMeshes(): readonly { readonly id: string; readonly name: string }[];
  decorationArt(): DecorationArt;
  decorationModels(): readonly { readonly id: string; readonly name: string }[];
  courseMeshBlob(id: string, signal?: AbortSignal): Promise<Blob>;
  courseMeshTerrain(id: string, turn: number): Promise<MeshTerrain | ProjectError>;
  enemyClips(id: string): Promise<EnemyBake | ProjectError>;
  // Supplied bytes were staged or read for this handle through FileStore.
  bakeMesh(file: FileHandle, turn: number, blob?: Blob): ProjectBake<MeshTerrain>;
  bakeEnemy(file: FileHandle, blob?: Blob): ProjectBake<EnemyBake>;
  libraryBlob(role: PartRole, id: string, signal?: AbortSignal): Promise<Blob>;
  dispose(): void;
}

interface EnemyResource {
  readonly key: string;
  readonly promise: Promise<EnemyBake>;
  users: number;
  phase: 'waiting' | 'baking' | 'ready' | 'ended';
}

interface EnemyRead {
  readonly controller: AbortController;
  readonly promise: Promise<EnemyBake>;
  users: number;
  resource: EnemyResource | null;
}

interface MediaUrl {
  readonly file: FileHandle;
  readonly lease: FileUrl | null;
}

interface MeshResource {
  readonly file: FileHandle;
  readonly key: string;
  readonly controller: AbortController;
  readonly turns: Map<number, MeshBake>;
  pending: number;
  users: number;
  wanted: boolean;
}

interface MeshBake {
  readonly promise: Promise<MeshTerrain>;
  users: number;
  pending: boolean;
}

const TERRAIN_CACHE_LIMIT = 128;
const ENEMY_CACHE_LIMIT = 32;
const LOOK_SECTIONS = ['art', 'media', 'theme', 'hud', 'enemies', 'audio'] as const;

function refusal(error: unknown, section: 'art' | 'models'): ProjectError {
  if (error instanceof ProjectError) return error;
  if (isProjectDataError(error)) return new ProjectError(error.message, { section, cause: error });
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ProjectError('The file read was cancelled.', { section, cause: error });
  }
  throw error;
}

export function createProjectProjection(options: {
  readonly document: ProjectDocument;
  readonly files: FileStore;
  readonly onLook: (look: ProjectLook) => void;
}): ProjectProjection {
  const { document, files } = options;
  const lifecycle = new AbortController();
  const baker = new MeshBaker();
  const species = new Set(ENEMY_SPECIES);
  const artwork = new WeakMap<DocumentArt, CourseArtwork>();
  const avatarSettings = new WeakMap<LibraryAvatarEntry, LibraryAvatarSettings>();
  const libraryViews = new WeakMap<DocumentModel<LibraryEntry>, LibraryModel>();
  const meshes = new Map<FileHandle, MeshResource>();
  const finishedTerrains = new Map<Promise<MeshTerrain>, { readonly resource: MeshResource; readonly turn: number; readonly bake: MeshBake }>();
  const enemyBakes = new Map<string, EnemyResource>();
  const enemyReads = new Map<FileHandle, EnemyRead>();
  const finishedEnemies = new Map<string, EnemyResource>();
  let currentArtFiles = new Set(document.get('art').assets.map((asset) => asset.file));
  let active = false;
  let meshKey = 0;
  let shown: ProjectLook | null = null;
  let mediaRoot: DocumentMedia | null = null;
  let mediaUrls = new Map<string, MediaUrl>();
  let mediaFiles = new Set<FileHandle>();
  let mediaVersion = 0;
  let library: { readonly root: DocumentModels; readonly values: readonly LibraryModel[] } | null = null;
  let hammers: { readonly root: DocumentModels['hammer']; readonly values: ReturnType<ProjectProjection['libraryHammers']> } | null = null;
  let courses: { readonly art: DocumentArt; readonly enemies: GameLook['enemies']; readonly values: ReturnType<ProjectProjection['courseMeshes']> } | null = null;
  let decorations: { readonly art: DocumentArt; readonly values: ReturnType<ProjectProjection['decorationModels']> } | null = null;
  const relocated = new Set<FileHandle>();
  let relocationQueued = false;

  function live(): void {
    if (lifecycle.signal.aborted) throw new ProjectError('The Workshop has closed.');
  }

  function artAsset(id: string): DocumentArtAsset {
    live();
    const asset = document.get('art').assets.find((candidate) => candidate.id === id);
    if (asset === undefined) throw new ProjectError(`The course artwork has no mesh ${id}.`, { section: 'art' });
    return asset;
  }

  function modelFile(role: PartRole, id: string): FileHandle {
    live();
    const items = document.get('models')[role];
    if (items === undefined) throw new ProjectError(`Unknown library role "${role}".`, { section: 'models' });
    const item = items.find((candidate) => candidate.entry.id === id);
    if (item === undefined) throw new ProjectError(`The project has no library ${role} "${id}".`, { section: 'models' });
    return item.file;
  }

  function readSignal(signal?: AbortSignal): { readonly signal: AbortSignal; release(): void } {
    if (signal === undefined || signal === lifecycle.signal) return { signal: lifecycle.signal, release() {} };
    const controller = new AbortController();
    const abortOwner = (): void => controller.abort(signal.reason);
    const abortProject = (): void => controller.abort(lifecycle.signal.reason);
    signal.addEventListener('abort', abortOwner, { once: true });
    lifecycle.signal.addEventListener('abort', abortProject, { once: true });
    if (signal.aborted) abortOwner();
    if (lifecycle.signal.aborted) abortProject();
    return {
      signal: controller.signal,
      release(): void {
        signal.removeEventListener('abort', abortOwner);
        lifecycle.signal.removeEventListener('abort', abortProject);
      },
    };
  }

  async function readBlob(file: FileHandle, signal?: AbortSignal): Promise<Blob> {
    live();
    const reading = readSignal(signal);
    let release = (): void => {};
    try {
      release = files.retain([file], 'work');
      return await files.blob(file, reading.signal);
    } finally {
      const disposal = new Disposal();
      disposal.run(release);
      disposal.run(() => reading.release());
      disposal.finish();
    }
  }

  function refreshMedia(changed: ReadonlySet<FileHandle> = new Set()): void {
    const root = document.get('media');
    if (root === mediaRoot && changed.size === 0) return;
    const next = new Map<string, MediaUrl>();
    const acquired: FileUrl[] = [];
    let different = root.length !== mediaUrls.size;
    try {
      for (const item of root) {
        const previous = mediaUrls.get(item.path);
        const locations = files.locations(item.file);
        if (locations.page === null && locations.published.length === 0 && locations.servers.length === 0) {
          const same = previous !== undefined && previous.file === item.file && previous.lease === null;
          next.set(item.path, same ? previous : { file: item.file, lease: null });
          different ||= !same;
          continue;
        }
        if (previous !== undefined && previous.file === item.file && previous.lease !== null && !changed.has(item.file)) {
          next.set(item.path, previous);
          continue;
        }
        const lease = files.url(item.file, mediaType(item.path));
        acquired.push(lease);
        next.set(item.path, { file: item.file, lease });
        different ||= previous === undefined || previous.file !== item.file || previous.lease?.url !== lease.url;
      }
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      for (const lease of acquired) disposal.run(() => lease.release());
      disposal.finish();
      throw error;
    }
    const previous = mediaUrls;
    mediaUrls = next;
    mediaFiles = new Set([...next.values()].map((item) => item.file));
    mediaRoot = root;
    if (different) mediaVersion++;
    const disposal = new Disposal();
    for (const [path, value] of previous) {
      const lease = value.lease;
      if (next.get(path) !== value && lease !== null) disposal.run(() => lease.release());
    }
    disposal.finish();
  }

  const resolveMedia = (source: string): string => {
    live();
    const media = mediaUrls.get(source);
    if (media !== undefined) {
      if (media.lease === null) throw new ProjectError(`Media file ${source} is no longer available.`, { section: 'media' });
      return media.lease.url;
    }
    if (isMediaLibraryPath(source)) throw new ProjectError(`Media file ${source} is not in the project.`, { section: 'media' });
    return source;
  };

  function courseArtwork(): CourseArtwork {
    if (!active) return NO_COURSE_ARTWORK;
    const art = document.get('art');
    let value = artwork.get(art);
    if (value === undefined) {
      value = Object.freeze({
        assets: Object.freeze(art.assets.map(({ id, name }) => Object.freeze({ id, name }))),
        decorations: art.decorations,
      });
      artwork.set(art, value);
    }
    return value;
  }

  function publishLook(): void {
    const theme = document.get('theme');
    const hud = document.get('hud');
    const enemies = document.get('enemies');
    const art = courseArtwork();
    const audio = document.get('audio');
    const previous = shown?.game;
    const game = previous !== undefined && previous.theme === theme && previous.hud === hud && previous.enemies === enemies && previous.art === art
      ? previous : Object.freeze({ theme, hud, enemies, art });
    if (shown !== null && shown.game === game && shown.audio === audio && shown.mediaVersion === mediaVersion) return;
    const look = Object.freeze({ game, audio, resolveMedia, mediaVersion });
    options.onLook(look);
    shown = look;
  }

  function retireMesh(resource: MeshResource): void {
    if (resource.wanted || resource.users > 0) return;
    resource.controller.abort();
    if (resource.pending > 0) return;
    for (const bake of resource.turns.values()) finishedTerrains.delete(bake.promise);
    resource.turns.clear();
    if (meshes.get(resource.file) === resource) meshes.delete(resource.file);
    baker.forget(resource.key);
  }

  function followFiles(): void {
    currentArtFiles = new Set(document.get('art').assets.map((asset) => asset.file));
    for (const resource of meshes.values()) {
      resource.wanted = currentArtFiles.has(resource.file) && !resource.controller.signal.aborted;
      retireMesh(resource);
    }
  }

  function idleTerrain(resource: MeshResource, turn: number, bake: MeshBake): void {
    if (bake.pending || bake.users > 0 || resource.controller.signal.aborted || resource.turns.get(turn) !== bake) return;
    finishedTerrains.delete(bake.promise);
    finishedTerrains.set(bake.promise, { resource, turn, bake });
    while (finishedTerrains.size > TERRAIN_CACHE_LIMIT) {
      const oldest = finishedTerrains.entries().next().value;
      if (oldest === undefined) throw new Error('Mesh cache indexes are inconsistent.');
      const [held, entry] = oldest;
      finishedTerrains.delete(held);
      if (entry.resource.turns.get(entry.turn) === entry.bake) entry.resource.turns.delete(entry.turn);
      retireMesh(entry.resource);
    }
  }

  function verifiedBlob(file: FileHandle, blob: Blob): void {
    if (blob.size !== file.bytes || files.locations(file).sha256 === null) {
      throw new Error('Bake bytes must be verified for their file handle.');
    }
  }

  function retainMesh(file: FileHandle, turn: number, blob?: Blob): ProjectBake<MeshTerrain> {
    live();
    if (blob !== undefined) verifiedBlob(file, blob);
    let resource = meshes.get(file);
    if (resource === undefined || resource.controller.signal.aborted) {
      resource = {
        file, key: `${file.key}:mesh:${++meshKey}`, controller: new AbortController(), turns: new Map(),
        pending: 0, users: 0, wanted: currentArtFiles.has(file),
      };
      meshes.set(file, resource);
    }
    const owner = resource;
    let bake = owner.turns.get(turn);
    if (bake === undefined) {
      owner.pending++;
      const created: MeshBake = {
        users: 0, pending: true,
        promise: Promise.resolve().then(async (): Promise<MeshTerrain> => {
          let release = (): void => {};
          try {
            live();
            const signal = AbortSignal.any([owner.controller.signal, lifecycle.signal]);
            signal.throwIfAborted();
            release = files.retain([file], 'work');
            const result = await baker.bake(owner.key, async () => {
              const source = blob ?? await files.blob(file, signal);
              signal.throwIfAborted();
              const bytes = await source.arrayBuffer();
              signal.throwIfAborted();
              return bytes;
            }, turn);
            signal.throwIfAborted();
            created.pending = false;
            idleTerrain(owner, turn, created);
            return result;
          } catch (error) {
            if (owner.turns.get(turn) === created) owner.turns.delete(turn);
            throw error;
          } finally {
            created.pending = false;
            owner.pending--;
            const disposal = new Disposal();
            disposal.run(release);
            disposal.run(() => retireMesh(owner));
            disposal.finish();
          }
        }),
      };
      owner.turns.set(turn, created);
      bake = created;
    }
    const held = bake;
    owner.users++;
    held.users++;
    finishedTerrains.delete(held.promise);
    let released = false;
    return Object.freeze({
      promise: held.promise,
      release(): void {
        if (released) return;
        released = true;
        if (--owner.users < 0 || --held.users < 0) throw new Error('Mesh bake references are inconsistent.');
        const disposal = new Disposal();
        disposal.run(() => idleTerrain(owner, turn, held));
        disposal.run(() => retireMesh(owner));
        disposal.finish();
      },
    });
  }

  function unusedEnemy(resource: EnemyResource): void {
    if (resource.users > 0 || enemyBakes.get(resource.key) !== resource) return;
    if (resource.phase === 'waiting') {
      resource.phase = 'ended';
      enemyBakes.delete(resource.key);
      return;
    }
    if (resource.phase !== 'ready') return;
    finishedEnemies.delete(resource.key);
    finishedEnemies.set(resource.key, resource);
    while (finishedEnemies.size > ENEMY_CACHE_LIMIT) {
      const oldest = finishedEnemies.entries().next().value;
      if (oldest === undefined) throw new Error('Enemy cache indexes are inconsistent.');
      const [key, held] = oldest;
      finishedEnemies.delete(key);
      if (enemyBakes.get(key) === held) enemyBakes.delete(key);
    }
  }

  function enemyResource(key: string, blob: Blob): EnemyResource {
    const existing = enemyBakes.get(key);
    if (existing !== undefined) return existing;
    const resource: EnemyResource = {
      key, users: 0, phase: 'waiting',
      promise: Promise.resolve().then(async (): Promise<EnemyBake> => {
        try {
          activeEnemy(resource);
          const bytes = await blob.arrayBuffer();
          activeEnemy(resource);
          resource.phase = 'baking';
          const result = await baker.bakeEnemy(bytes);
          live();
          resource.phase = 'ready';
          unusedEnemy(resource);
          return result;
        } catch (error) {
          resource.phase = 'ended';
          if (enemyBakes.get(key) === resource) enemyBakes.delete(key);
          if (finishedEnemies.get(key) === resource) finishedEnemies.delete(key);
          throw error;
        }
      }),
    };
    enemyBakes.set(key, resource);
    return resource;
  }

  function activeEnemy(resource: EnemyResource): void {
    live();
    if (resource.phase === 'ended' || resource.users === 0) throw new DOMException('The enemy bake was cancelled.', 'AbortError');
  }

  function enemyKey(file: FileHandle): string | null {
    const sha256 = files.locations(file).sha256;
    return sha256 === null ? null : `${sha256}:${file.bytes}`;
  }

  async function readEnemy(file: FileHandle, read: EnemyRead, supplied?: Blob): Promise<EnemyBake> {
    let release = (): void => {};
    try {
      live();
      const signal = AbortSignal.any([read.controller.signal, lifecycle.signal]);
      signal.throwIfAborted();
      release = files.retain([file], 'work');
      let resource = read.resource;
      if (resource === null) {
        const known = enemyKey(file);
        let cached = known === null ? undefined : enemyBakes.get(known);
        if (cached === undefined) {
          const blob = supplied ?? await files.blob(file, signal);
          signal.throwIfAborted();
          // Unread server handles join a cache only after their bytes have been verified.
          const key = enemyKey(file);
          if (key === null) throw new Error('The checked enemy file must have a digest.');
          cached = enemyResource(key, blob);
        }
        resource = cached;
        read.resource = resource;
        resource.users += read.users;
        finishedEnemies.delete(resource.key);
      }
      return await resource.promise;
    } finally {
      if (enemyReads.get(file) === read) enemyReads.delete(file);
      release();
    }
  }

  function retainEnemy(file: FileHandle, blob?: Blob): ProjectBake<EnemyBake> {
    live();
    if (blob !== undefined) verifiedBlob(file, blob);
    let read = enemyReads.get(file);
    if (read === undefined || read.controller.signal.aborted) {
      const known = enemyKey(file);
      const created: EnemyRead = {
        controller: new AbortController(), users: 0, resource: known === null ? null : enemyBakes.get(known) ?? null,
        promise: Promise.resolve().then(() => readEnemy(file, created, blob)),
      };
      enemyReads.set(file, created);
      read = created;
    }
    const held = read;
    held.users++;
    if (held.resource !== null) {
      held.resource.users++;
      finishedEnemies.delete(held.resource.key);
    }
    let released = false;
    return Object.freeze({
      promise: held.promise,
      release(): void {
        if (released) return;
        released = true;
        if (--held.users < 0) throw new Error('Enemy read references are inconsistent.');
        if (held.resource !== null) {
          if (--held.resource.users < 0) throw new Error('Enemy bake references are inconsistent.');
          unusedEnemy(held.resource);
        }
        if (held.users === 0) held.controller.abort();
      },
    });
  }

  let unsubscribeDocument = (): void => {};
  let unsubscribeFiles = (): void => {};
  try {
    unsubscribeDocument = document.subscribeAll((changes) => {
      const changed = new Set(changes.map((change) => change.section));
      if (changed.has('art')) followFiles();
      if (changed.has('media')) refreshMedia();
      if (LOOK_SECTIONS.some((section) => changed.has(section))) publishLook();
    });
    unsubscribeFiles = files.subscribe((event) => {
      if (lifecycle.signal.aborted) return;
      for (const file of event.files) if (mediaFiles.has(file)) relocated.add(file);
      if (relocated.size === 0 || relocationQueued) return;
      relocationQueued = true;
      queueMicrotask(() => {
        relocationQueued = false;
        if (lifecycle.signal.aborted) return;
        const changed = new Set(relocated);
        relocated.clear();
        refreshMedia(changed);
        publishLook();
      });
    });
  } catch (error) {
    const disposal = new Disposal();
    disposal.run(() => { throw error; });
    disposal.run(unsubscribeDocument);
    disposal.run(unsubscribeFiles);
    disposal.run(() => baker.dispose());
    disposal.finish();
    throw error;
  }

  function libraryView(role: PartRole, model: DocumentModel<LibraryEntry>): LibraryModel {
    let value = libraryViews.get(model);
    if (value !== undefined && value.role === role) return value;
    const { entry, file } = model;
    let avatar: LibraryAvatarSettings | null = null;
    if (role === 'avatar') {
      const source = entry as LibraryAvatarEntry;
      avatar = avatarSettings.get(source) ?? null;
      if (avatar === null) {
        avatar = libraryAvatarSettings(source);
        avatarSettings.set(source, avatar);
      }
    }
    value = Object.freeze({
      role, id: entry.id, name: entry.name, key: `${role}:${entry.id}:${file.key}`, avatar,
      head: role === 'hammer' ? (entry as LibraryHammerEntry).head : null,
    });
    libraryViews.set(model, value);
    return value;
  }

  const projection: ProjectProjection = {
    activate(): void {
      live();
      if (active) return;
      active = true;
      refreshMedia();
      publishLook();
    },
    libraryModels() {
      live();
      const root = document.get('models');
      if (library === null || library.root !== root) {
        library = {
          root,
          values: Object.freeze([
            ...root.avatar.map((model) => libraryView('avatar', model)),
            ...root.hammer.map((model) => libraryView('hammer', model)),
            ...root.pot.map((model) => libraryView('pot', model)),
          ]),
        };
      }
      return library.values;
    },
    libraryHammers() {
      live();
      const root = document.get('models').hammer;
      if (hammers === null || hammers.root !== root) {
        hammers = { root, values: Object.freeze(root.map(({ entry }) => Object.freeze({ id: entry.id, name: entry.name, head: entry.head }))) };
      }
      return hammers.values;
    },
    courseMeshes() {
      live();
      const art = document.get('art');
      const enemies = document.get('enemies');
      if (courses === null || courses.art !== art || courses.enemies !== enemies) {
        const hidden = enemyArtAssets(enemies, species);
        courses = { art, enemies, values: Object.freeze(art.assets.filter(({ id }) => !hidden.has(id)).map(({ id, name }) => Object.freeze({ id, name }))) };
      }
      return courses.values;
    },
    decorationArt(): DecorationArt { live(); return document.get('art').decorations; },
    decorationModels() {
      live();
      const art = document.get('art');
      if (decorations === null || decorations.art !== art) {
        const names = new Map(art.assets.map((asset) => [asset.id, asset.name]));
        decorations = {
          art, values: Object.freeze(Object.entries(art.decorations).map(([id, asset]) => {
            const name = names.get(asset);
            if (name === undefined) throw new Error(`Decoration "${id}" has no document artwork.`);
            return Object.freeze({ id, name });
          })),
        };
      }
      return decorations.values;
    },
    async courseMeshBlob(id, signal) {
      const asset = artAsset(id);
      const blob = await readBlob(asset.file, signal);
      if (artAsset(id).file !== asset.file) throw new ProjectError(`Course mesh ${id} changed while it was read.`, { section: 'art' });
      return blob;
    },
    async courseMeshTerrain(id, turn) {
      try {
        const asset = artAsset(id);
        const held = retainMesh(asset.file, turn);
        try {
          const result = await held.promise;
          if (artAsset(id).file !== asset.file) throw new ProjectError(`Course mesh ${id} changed while it was baked.`, { section: 'art' });
          return Object.freeze({ ...result, mesh: Object.freeze({ ...result.mesh, assetId: id }) });
        } finally {
          held.release();
        }
      } catch (error) {
        return refusal(error, 'art');
      }
    },
    bakeMesh: retainMesh,
    bakeEnemy: retainEnemy,
    async enemyClips(id) {
      try {
        const asset = artAsset(id);
        const held = retainEnemy(asset.file);
        try {
          const result = await held.promise;
          if (artAsset(id).file !== asset.file) throw new ProjectError(`Enemy model ${id} changed while it was baked.`, { section: 'art' });
          return result;
        } finally {
          held.release();
        }
      } catch (error) {
        return refusal(error, 'art');
      }
    },
    async libraryBlob(role, id, signal) {
      const file = modelFile(role, id);
      const blob = await readBlob(file, signal);
      if (modelFile(role, id) !== file) throw new ProjectError(`Library ${role} "${id}" changed while it was read.`, { section: 'models' });
      return blob;
    },
    dispose(): void {
      if (lifecycle.signal.aborted) return;
      lifecycle.abort();
      const disposal = new Disposal();
      disposal.run(unsubscribeDocument);
      disposal.run(unsubscribeFiles);
      for (const { lease } of mediaUrls.values()) if (lease !== null) disposal.run(() => lease.release());
      mediaUrls.clear();
      mediaFiles.clear();
      mediaRoot = null;
      relocated.clear();
      for (const resource of meshes.values()) {
        resource.wanted = false;
        disposal.run(() => retireMesh(resource));
      }
      disposal.run(() => baker.dispose());
      finishedTerrains.clear();
      meshes.clear();
      enemyBakes.clear();
      enemyReads.clear();
      finishedEnemies.clear();
      currentArtFiles.clear();
      library = null;
      hammers = null;
      courses = null;
      decorations = null;
      shown = null;
      disposal.finish();
    },
  };
  return Object.freeze(projection);
}
