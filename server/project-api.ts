import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { validateAppearanceParts, validateArmIk, DEFAULT_ALIGNMENT } from '../src/appearance-profile';
import { validateAudio } from '../src/audio-settings';
import { ART_LIMITS } from '../src/art-types';
import { checkCharacterModels } from '../src/character-model-check';
import { VISUAL_PART_IDS } from '../src/character';
import type { VisualPartId } from '../src/character';
import { validateCourseModel } from '../src/course-art-model';
import { DEFAULT_LEVEL } from '../src/default-level';
import { validateEnemyArt } from '../src/enemy-art-data';
import { validateGameSettings } from '../src/game-settings';
import { validateHud } from '../src/hud';
import { LEVEL_LIMITS, validateLevel } from '../src/level';
import type { LevelDefinition, LevelObject } from '../src/level';
import { checkMediaBytes, MEDIA_LIMITS, mediaFile, mediaPath, mediaType } from '../src/media';
import { MODEL_LIMITS } from '../src/model-data';
import {
  appearanceFile, artAssetHashMatches, artFile, checkProjectReferences, defaultProjectManifest, inSection,
  isProjectDataError, PROJECT_FILES, PROJECT_LIMITS, projectFileRefs, ProjectError, projectIdForTitle, projectTitle,
  unpackProjectBundle, validateMediaIndex, validateProjectArt, validateProjectCharacter, validateProjectId,
  validateProjectManifest, packProjectBundle, loadProjectContent,
} from '../src/project';
import type { ProjectContent, ProjectManifest } from '../src/project';
import { mergePatch } from '../src/project-fields';
import { EMPTY_SPRITES, SPRITE_FILE_BYTES, spriteSchemaVersion } from '../src/sprite-data';
import { validateTheme } from '../src/theme';
import { checkAppearanceModel } from '../src/appearance-model';
import { apiManual } from './api-manual';
import { formatBytes, HttpError, mediaTypeOf, readBody, readJson, sendError, sendFile, sendJson } from './http';
import { ProjectStore, SECTION_NAMES } from './project-store';
import type { ProjectChange, ProjectState, SectionName } from './project-store';
import { Publisher } from './publish';

export interface StudioConfig {
  readonly root: string;
  readonly projects: string;
  readonly releases: string;
  readonly token: string | null;
}

interface Context {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

type Handler = (context: Context) => Promise<void>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: Handler;
}

const JSON_LIMIT = 1024 * 1024;
// Vite's default server.fs.deny list, which a configured list replaces rather than extends.
const VITE_FS_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const COOKIE = 'ote-studio';
const MIN_TOKEN = 16;
const LEVEL_REF = { path: PROJECT_FILES.level, maxBytes: LEVEL_LIMITS.fileBytes } as const;
const PATCHABLE: ReadonlySet<SectionName> = new Set(['settings', 'characters/primary', 'characters/alternate', 'arm-ik', 'theme', 'hud', 'audio', 'enemies', 'art']);

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function sameSecret(value: string, expected: Buffer): boolean {
  const actual = digest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hostName(host: string | undefined): string | null {
  if (host === undefined) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return new HttpError(404, 'not-found', 'That project file does not exist.');
  if (isProjectDataError(error)) return new HttpError(400, 'invalid', error.message, { section: error instanceof ProjectError ? error.section : null, cause: error });
  console.error('[project studio]', error);
  return new HttpError(500, 'internal', `The studio failed: ${error instanceof Error ? error.message : String(error)}`);
}

// Deleting a file the level or audio still uses is a conflict, not a validation error.
function stillUnused(file: string, next: ProjectManifest, current: LevelDefinition): void {
  try {
    checkProjectReferences(next, current);
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    throw new HttpError(409, 'in-use', `${file} is still used; remove those references first. ${error.message}`, { section: error.section });
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withManifest(manifest: ProjectManifest, changes: Partial<ProjectManifest>): ProjectManifest {
  return validateProjectManifest({ ...manifest, ...changes });
}

export function createStudioHandler(config: StudioConfig) {
  const store = new ProjectStore(config.projects);
  const publisher = new Publisher({ root: config.root, releases: config.releases });
  const tokenDigest = config.token === null ? null : digest(config.token);
  const routes: Route[] = [];

  const authenticated = (request: IncomingMessage): boolean => {
    if (tokenDigest === null) {
      return LOOPBACK.has(request.socket.remoteAddress ?? '') && LOCAL_HOSTS.has(hostName(request.headers.host) ?? '');
    }
    const header = request.headers.authorization ?? '';
    if (header.startsWith('Bearer ') && sameSecret(header.slice('Bearer '.length), tokenDigest)) return true;
    const cookie = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    if (cookie === undefined) return false;
    const value = Buffer.from(cookie.slice(COOKIE.length + 1), 'hex');
    const expected = digest(tokenDigest.toString('hex'));
    return value.length === expected.length && timingSafeEqual(value, expected);
  };

  const authorize = (request: IncomingMessage): void => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      if (request.headers['x-studio-request'] !== '1') {
        throw new HttpError(403, 'missing-header', 'Send the header X-Studio-Request: 1 with every change.');
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        let host: string | null = null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        if (host !== request.headers.host) throw new HttpError(403, 'cross-origin', 'Changes must come from the studio page itself.');
      }
    }
    if (authenticated(request)) return;
    if (tokenDigest !== null) throw new HttpError(401, 'unauthorized', 'This studio needs its access token: send Authorization: Bearer <STUDIO_TOKEN>.');
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) {
      throw new HttpError(403, 'remote', 'The project API only answers this computer until the server sets STUDIO_TOKEN.');
    }
    throw new HttpError(403, 'host', 'Open the studio through localhost or 127.0.0.1, or set STUDIO_TOKEN on the server.');
  };

  const route = (method: string, path: string, handler: Handler): void => {
    const pattern = new RegExp(`^${path.replace(/\//g, '\\/').replace(/:([a-zA-Z]+)\*/g, '(?<$1>.+)').replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, pattern, handler });
  };

  const expectRevision = (context: Context, state: ProjectState, sections: readonly SectionName[]): void => {
    const header = context.request.headers['if-match'];
    if (header === undefined) return;
    const expected = Number(header.replace(/^W\//, '').replace(/"/g, ''));
    if (sections.some((section) => state.sections[section] !== expected)) {
      throw new HttpError(412, 'conflict', `The ${sections.join(', ')} section changed on the server (revision ${
        state.sections[sections[0]!]}); reload it and try again.`, { section: sections[0] });
    }
  };

  const respondState = (context: Context, state: ProjectState, section: SectionName | null, extra: Record<string, unknown> = {}): void => {
    sendJson(context.response, 200, { revision: state.revision, sections: state.sections, ...extra },
      section === null ? {} : { ETag: `"${state.sections[section]}"` });
  };

  const level = async (id: string): Promise<LevelDefinition> => {
    const value = await store.readJson(id, LEVEL_REF);
    return inSection('level', () => validateLevel(value));
  };

  // Loads the level lazily: only changes that can break references need it.
  const change = async (context: Context, sections: readonly SectionName[], build: (manifest: ProjectManifest, state: ProjectState) =>
    Promise<Omit<ProjectChange, 'sections'> & { result?: unknown }>): Promise<void> => {
    const id = context.params.id!;
    const { state, result } = await store.mutate(id, async (current) => {
      expectRevision(context, current.state, sections);
      const next = await build(current.manifest, current.state);
      return { ...next, sections };
    });
    respondState(context, state, sections[0] ?? null, result === undefined ? {} : { result });
  };

  // One entry per API section: how to read it and how a new value becomes a validated change.
  const sections: Record<SectionName, {
    limit: number;
    read: (id: string, manifest: ProjectManifest) => Promise<unknown>;
    write: (id: string, manifest: ProjectManifest, value: unknown) => Promise<Omit<ProjectChange, 'sections'>>;
  }> = {
    title: {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.title,
      write: async (_id, manifest, value) => ({ manifest: withManifest(manifest, { title: inSection('title', () => projectTitle(value)) }) }),
    },
    level: {
      limit: LEVEL_LIMITS.fileBytes,
      read: async (id) => level(id),
      write: async (_id, manifest, value) => {
        const next = inSection('level', () => validateLevel(value));
        checkProjectReferences(manifest, next);
        return { json: new Map([[PROJECT_FILES.level, next]]) };
      },
    },
    settings: {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.settings,
      write: async (_id, manifest, value) => ({ manifest: withManifest(manifest, { settings: inSection('settings', () => validateGameSettings(value)) }) }),
    },
    'characters/primary': characterSection('primary'),
    'characters/alternate': characterSection('alternate'),
    'arm-ik': {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.armIk,
      write: async (_id, manifest, value) => ({ manifest: withManifest(manifest, { armIk: inSection('arm-ik', () => validateArmIk(value)) }) }),
    },
    appearance: {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.appearance,
      write: async (_id, manifest, value) => {
        const parts = inSection('appearance', () => validateAppearanceParts(value));
        const added = parts.filter((part) => !manifest.appearance.some((current) => current.part === part.part));
        if (added.length > 0) {
          throw new HttpError(400, 'missing-file', `Upload ${added[0]!.part} with PUT appearance/${added[0]!.part}/model before listing it.`, { section: 'appearance' });
        }
        const removed = manifest.appearance.filter((current) => !parts.some((part) => part.part === current.part));
        return { manifest: withManifest(manifest, { appearance: parts }), remove: removed.map((part) => appearanceFile(part.part)) };
      },
    },
    theme: manifestSection('theme', validateTheme),
    hud: manifestSection('hud', validateHud),
    audio: {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.audio,
      write: async (id, manifest, value) => {
        const next = withManifest(manifest, { audio: inSection('audio', () => validateAudio(value)) });
        checkProjectReferences(next, await level(id));
        return { manifest: next };
      },
    },
    enemies: manifestSection('enemies', validateEnemyArt),
    art: {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.art,
      write: async (id, manifest, value) => {
        const art = inSection('art', () => validateProjectArt(value));
        const added = art.assets.filter((asset) => !manifest.art.assets.some((current) => current.id === asset.id));
        if (added.length > 0) throw new HttpError(400, 'missing-file', `Upload course artwork with POST art/assets before listing ${added[0]!.id}.`, { section: 'art' });
        const next = withManifest(manifest, { art });
        checkProjectReferences(next, await level(id));
        const removed = manifest.art.assets.filter((current) => !art.assets.some((asset) => asset.id === current.id));
        return { manifest: next, remove: removed.map((asset) => artFile(asset.id)) };
      },
    },
    media: {
      limit: JSON_LIMIT,
      read: async (_id, manifest) => manifest.media,
      write: async (id, manifest, value) => {
        const media = inSection('media', () => validateMediaIndex(value));
        const added = media.filter((entry) => !manifest.media.some((current) => current.path === entry.path));
        if (added.length > 0) throw new HttpError(400, 'missing-file', `Upload ${added[0]!.path} with PUT media/... before listing it.`, { section: 'media' });
        const next = withManifest(manifest, { media });
        checkProjectReferences(next, await level(id));
        const removed = manifest.media.filter((current) => !media.some((entry) => entry.path === current.path));
        return { manifest: next, remove: removed.map((entry) => mediaFile(entry.path)) };
      },
    },
  };

  function manifestSection<K extends 'theme' | 'hud' | 'enemies'>(key: K, validate: (value: unknown) => ProjectManifest[K]) {
    return {
      limit: JSON_LIMIT,
      read: async (_id: string, manifest: ProjectManifest) => manifest[key],
      write: async (_id: string, manifest: ProjectManifest, value: unknown) =>
        ({ manifest: withManifest(manifest, { [key]: inSection(key, () => validate(value)) } as Partial<ProjectManifest>) }),
    };
  }

  function characterSection(role: 'primary' | 'alternate') {
    const path = PROJECT_FILES[role];
    const section = `characters/${role}` as const;
    return {
      limit: SPRITE_FILE_BYTES,
      read: async (id: string, manifest: ProjectManifest) =>
        manifest.characters[role] === null ? null : store.readJson(id, { path, maxBytes: SPRITE_FILE_BYTES }),
      write: async (_id: string, manifest: ProjectManifest, value: unknown): Promise<Omit<ProjectChange, 'sections'>> => {
        if (value === null) {
          if (role === 'primary' && manifest.characters.alternate !== null) {
            throw new HttpError(409, 'in-use', 'Remove the alternate character before the primary one.', { section });
          }
          return { manifest: withManifest(manifest, { characters: { ...manifest.characters, [role]: null } }), remove: [path] };
        }
        if (role === 'alternate' && manifest.characters.primary === null) {
          throw new HttpError(409, 'missing-primary', 'Set a primary character before adding an alternate one.', { section });
        }
        const document = inSection(section, () => validateProjectCharacter(value));
        inSection(section, () => checkCharacterModels(document, `${role} character`));
        return {
          manifest: withManifest(manifest, { characters: { ...manifest.characters, [role]: path } }),
          json: new Map([[path, document]]),
        };
      },
    };
  }

  const project = async (context: Context) => store.read(context.params.id!);

  // Levels and objects -------------------------------------------------------------------------
  const writeLevel = async (context: Context, edit: (current: LevelDefinition) => { level: unknown; result?: unknown }): Promise<void> => {
    await change(context, ['level'], async (manifest) => {
      const current = await level(context.params.id!);
      const next = edit(current);
      const validated = inSection('level', () => validateLevel(next.level));
      checkProjectReferences(manifest, validated);
      return { json: new Map([[PROJECT_FILES.level, validated]]), result: next.result };
    });
  };
  const objectById = (current: LevelDefinition, id: string): LevelObject => {
    const object = current.objects.find((candidate) => candidate.id === id);
    if (object === undefined) throw new HttpError(404, 'not-found', `Level object "${id}" does not exist.`, { section: 'level' });
    return object;
  };

  route('GET', '/api', async ({ response }) => sendJson(response, 200, apiManual(tokenDigest === null ? 'loopback' : 'token')));
  route('GET', '/api/projects', async ({ response }) => sendJson(response, 200, { projects: await store.list() }));
  route('POST', '/api/projects', async (context) => {
    const body = await readJson(context.request, JSON_LIMIT);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalid', 'Send { "title": "...", "id"?: "..." }.');
    const title = inSection('title', () => projectTitle(Reflect.get(body, 'title')));
    let id = Reflect.get(body, 'id');
    if (id === undefined) {
      const base = projectIdForTitle(title);
      const taken = new Set((await store.list()).map((entry) => entry.id));
      id = base;
      for (let suffix = 2; taken.has(id as string); suffix++) id = `${base.slice(0, PROJECT_LIMITS.id - String(suffix).length - 1)}-${suffix}`;
    }
    const manifest = defaultProjectManifest(title);
    const content = loadProjectContent(manifest, () => DEFAULT_LEVEL);
    const state = await store.write(validateProjectId(id), content, { replace: false });
    sendJson(context.response, 201, { id, revision: state.revision, sections: state.sections });
  });
  route('GET', '/api/projects/:id', async (context) => {
    const { manifest, state } = await project(context);
    const files = await Promise.all(projectFileRefs(manifest).map(async (ref) =>
      ({ path: ref.path, kind: ref.kind, bytes: await store.size(context.params.id!, ref.path) })));
    sendJson(context.response, 200, { id: context.params.id, revision: state.revision, sections: state.sections, updatedAt: state.updatedAt, manifest, files });
  });
  route('DELETE', '/api/projects/:id', async (context) => {
    await store.remove(context.params.id!);
    sendJson(context.response, 200, { deleted: context.params.id });
  });
  route('GET', '/api/projects/:id/revision', async (context) => {
    const { state } = await project(context);
    sendJson(context.response, 200, { revision: state.revision, sections: state.sections, updatedAt: state.updatedAt });
  });
  route('GET', '/api/projects/:id/bundle', async (context) => {
    const id = context.params.id!;
    const bundle = packProjectBundle((await store.snapshot(id)).content);
    sendJson(context.response, 200, bundle, context.url.searchParams.has('download')
      ? { 'Content-Disposition': `attachment; filename="${id}.project.json"` } : {});
  });
  route('PUT', '/api/projects/:id/bundle', async (context) => {
    const id = context.params.id!;
    store.directory(id);
    const content = await importBundle(await readJson(context.request, PROJECT_LIMITS.bundleBytes));
    const state = await store.write(id, content, { replace: true });
    sendJson(context.response, 200, { id, revision: state.revision, sections: state.sections });
  });
  route('POST', '/api/projects/:id/validate', async (context) => {
    const id = context.params.id!;
    const problems: { section: string | null; message: string }[] = [];
    try {
      await checkedContent(id);
    } catch (error) {
      const failure = toHttpError(error);
      if (failure.status >= 500 || failure.code === 'not-found') throw failure;
      problems.push({ section: failure.section, message: failure.message });
    }
    sendJson(context.response, 200, { ok: problems.length === 0, problems });
  });
  route('POST', '/api/projects/:id/publish', async (context) => {
    const id = context.params.id!;
    const { content, state } = await store.snapshot(id);
    const record = await publisher.publish(id, state.revision, verifyContent(content));
    sendJson(context.response, 200, record);
  });
  route('GET', '/api/projects/:id/publish', async (context) => {
    await project(context);
    sendJson(context.response, 200, { running: publisher.isRunning(context.params.id!), release: await publisher.status(context.params.id!) });
  });

  route('GET', '/api/projects/:id/level/objects', async (context) => {
    const kind = context.url.searchParams.get('kind');
    const objects = (await level(context.params.id!)).objects.filter((object) => kind === null || object.kind === kind);
    sendJson(context.response, 200, objects);
  });
  route('POST', '/api/projects/:id/level/objects', async (context) => {
    const body = await readJson(context.request, LEVEL_LIMITS.fileBytes);
    const added = Array.isArray(body) ? body : typeof body === 'object' && body !== null && Array.isArray(Reflect.get(body, 'objects'))
      ? Reflect.get(body, 'objects') as unknown[] : [body];
    await writeLevel(context, (current) => ({ level: { ...current, objects: [...current.objects, ...added] }, result: added.length }));
  });
  route('GET', '/api/projects/:id/level/objects/:objectId', async (context) => {
    sendJson(context.response, 200, objectById(await level(context.params.id!), decodeURIComponent(context.params.objectId!)));
  });
  for (const method of ['PUT', 'PATCH'] as const) {
    route(method, '/api/projects/:id/level/objects/:objectId', async (context) => {
      const objectId = decodeURIComponent(context.params.objectId!);
      const body = await readJson(context.request, LEVEL_LIMITS.fileBytes);
      await writeLevel(context, (current) => {
        const previous = objectById(current, objectId);
        const next = method === 'PUT' ? body : mergePatch(previous, body);
        if (typeof next !== 'object' || next === null || (Reflect.get(next, 'id') ?? objectId) !== objectId) {
          throw new HttpError(400, 'invalid', 'An object keeps its id; delete it and add a new one to rename it.', { section: 'level' });
        }
        return { level: { ...current, objects: current.objects.map((object) => object.id === objectId ? { ...next, id: objectId } : object) } };
      });
    });
  }
  route('DELETE', '/api/projects/:id/level/objects/:objectId', async (context) => {
    const objectId = decodeURIComponent(context.params.objectId!);
    await writeLevel(context, (current) => {
      if (objectById(current, objectId).kind === 'start') throw new HttpError(409, 'in-use', 'A level needs its start; move it instead.', { section: 'level' });
      return { level: { ...current, objects: current.objects.filter((object) => object.id !== objectId) } };
    });
  });
  route('GET', '/api/projects/:id/level/labels', async (context) => sendJson(context.response, 200, (await level(context.params.id!)).labels));
  route('PUT', '/api/projects/:id/level/labels', async (context) => {
    const labels = await readJson(context.request, JSON_LIMIT);
    await writeLevel(context, (current) => ({ level: { ...current, labels } }));
  });

  // Binary files ------------------------------------------------------------------------------
  route('POST', '/api/projects/:id/art/assets', async (context) => {
    const bytes = await readUpload(context.request, ART_LIMITS.bytes, ['model/gltf-binary']);
    const name = context.url.searchParams.get('name') ?? 'Course model';
    inSection('art', () => validateCourseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    const id = `asset-${sha256Hex(bytes)}`;
    await change(context, ['art'], async (manifest) => {
      if (manifest.art.assets.some((asset) => asset.id === id)) return { result: { id } };
      const art = inSection('art', () => validateProjectArt({ ...manifest.art, assets: [...manifest.art.assets, { id, name }] }));
      let total = bytes.byteLength;
      for (const asset of manifest.art.assets) total += await store.size(context.params.id!, artFile(asset.id));
      if (total > ART_LIMITS.totalBytes) throw new HttpError(413, 'too-large', `Course artwork exceeds ${formatBytes(ART_LIMITS.totalBytes)}.`, { section: 'art' });
      return { manifest: withManifest(manifest, { art }), binary: new Map([[artFile(id), bytes]]), result: { id } };
    });
  });
  route('GET', '/api/projects/:id/art/assets/:assetId', async (context) => {
    const { manifest } = await project(context);
    const asset = manifest.art.assets.find((candidate) => candidate.id === context.params.assetId);
    if (asset === undefined) throw new HttpError(404, 'not-found', 'Unknown course artwork.', { section: 'art' });
    sendFile(context.request, context.response, store.filePath(context.params.id!, artFile(asset.id)), 'model/gltf-binary');
  });
  route('DELETE', '/api/projects/:id/art/assets/:assetId', async (context) => {
    await change(context, ['art'], async (manifest) => {
      const assets = manifest.art.assets.filter((asset) => asset.id !== context.params.assetId);
      if (assets.length === manifest.art.assets.length) throw new HttpError(404, 'not-found', 'Unknown course artwork.', { section: 'art' });
      const next = withManifest(manifest, { art: { ...manifest.art, assets } });
      stillUnused(context.params.assetId!, next, await level(context.params.id!));
      return { manifest: next, remove: [artFile(context.params.assetId!)] };
    });
  });
  const part = (context: Context): VisualPartId => {
    const candidate = context.params.part!;
    if (!(VISUAL_PART_IDS as readonly string[]).includes(candidate)) {
      throw new HttpError(404, 'not-found', `Unknown part "${candidate}". Use one of ${VISUAL_PART_IDS.join(', ')}.`, { section: 'appearance' });
    }
    return candidate as VisualPartId;
  };
  route('PUT', '/api/projects/:id/appearance/:part/model', async (context) => {
    const slot = part(context);
    const bytes = await readUpload(context.request, MODEL_LIMITS.bytes, ['model/gltf-binary']);
    inSection('appearance', () => checkAppearanceModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    const name = context.url.searchParams.get('name') ?? `${slot}.glb`;
    await change(context, ['appearance'], async (manifest) => {
      let total = bytes.byteLength;
      for (const entry of manifest.appearance) if (entry.part !== slot) total += await store.size(context.params.id!, appearanceFile(entry.part));
      if (total > PROJECT_LIMITS.appearanceBytes) {
        throw new HttpError(413, 'too-large', `Appearance models exceed ${formatBytes(PROJECT_LIMITS.appearanceBytes)}.`, { section: 'appearance' });
      }
      const existing = manifest.appearance.find((entry) => entry.part === slot);
      const appearance = inSection('appearance', () => validateAppearanceParts([
        ...manifest.appearance.filter((entry) => entry.part !== slot),
        { part: slot, name, alignment: existing?.alignment ?? DEFAULT_ALIGNMENT },
      ]));
      return { manifest: withManifest(manifest, { appearance }), binary: new Map([[appearanceFile(slot), bytes]]) };
    });
  });
  route('GET', '/api/projects/:id/appearance/:part/model', async (context) => {
    const slot = part(context);
    const { manifest } = await project(context);
    if (!manifest.appearance.some((entry) => entry.part === slot)) throw new HttpError(404, 'not-found', `No ${slot} model.`, { section: 'appearance' });
    sendFile(context.request, context.response, store.filePath(context.params.id!, appearanceFile(slot)), 'model/gltf-binary');
  });
  route('GET', '/api/projects/:id/appearance/:part', async (context) => {
    const slot = part(context);
    const entry = (await project(context)).manifest.appearance.find((candidate) => candidate.part === slot);
    if (entry === undefined) throw new HttpError(404, 'not-found', `No ${slot} model.`, { section: 'appearance' });
    sendJson(context.response, 200, entry);
  });
  route('PATCH', '/api/projects/:id/appearance/:part', async (context) => {
    const slot = part(context);
    const body = await readJson(context.request, JSON_LIMIT);
    await change(context, ['appearance'], async (manifest) => {
      const entry = manifest.appearance.find((candidate) => candidate.part === slot);
      if (entry === undefined) throw new HttpError(404, 'not-found', `No ${slot} model.`, { section: 'appearance' });
      const patched = mergePatch(entry, body);
      const appearance = inSection('appearance', () => validateAppearanceParts(manifest.appearance.map((candidate) =>
        candidate.part === slot ? { ...(patched as object), part: slot } : candidate)));
      return { manifest: withManifest(manifest, { appearance }) };
    });
  });
  for (const path of ['/api/projects/:id/appearance/:part', '/api/projects/:id/appearance/:part/model']) {
    route('DELETE', path, async (context) => {
      const slot = part(context);
      await change(context, ['appearance'], async (manifest) => {
        if (!manifest.appearance.some((entry) => entry.part === slot)) throw new HttpError(404, 'not-found', `No ${slot} model.`, { section: 'appearance' });
        return {
          manifest: withManifest(manifest, { appearance: manifest.appearance.filter((entry) => entry.part !== slot) }),
          remove: [appearanceFile(slot)],
        };
      });
    });
  }
  const mediaEntry = (context: Context): string => {
    try {
      return mediaPath(`/media/${decodeURIComponent(context.params.file!)}`);
    } catch (error) {
      throw toHttpError(error);
    }
  };
  route('PUT', '/api/projects/:id/media/:file', async (context) => {
    const path = mediaEntry(context);
    const bytes = await readUpload(context.request, MEDIA_LIMITS.bytes, [mediaType(path)]);
    inSection('media', () => checkMediaBytes(path, bytes));
    await change(context, ['media'], async (manifest) => {
      let total = bytes.byteLength;
      for (const entry of manifest.media) if (entry.path !== path) total += await store.size(context.params.id!, mediaFile(entry.path));
      if (total > MEDIA_LIMITS.totalBytes) throw new HttpError(413, 'too-large', `The media library exceeds ${formatBytes(MEDIA_LIMITS.totalBytes)}.`, { section: 'media' });
      const media = manifest.media.some((entry) => entry.path === path) ? manifest.media
        : inSection('media', () => validateMediaIndex([...manifest.media, { path }]));
      return { manifest: withManifest(manifest, { media }), binary: new Map([[mediaFile(path), bytes]]), result: { path } };
    });
  });
  route('GET', '/api/projects/:id/media/:file', async (context) => {
    const path = mediaEntry(context);
    const { manifest } = await project(context);
    if (!manifest.media.some((entry) => entry.path === path)) throw new HttpError(404, 'not-found', `${path} is not in the media library.`, { section: 'media' });
    sendFile(context.request, context.response, store.filePath(context.params.id!, mediaFile(path)), mediaType(path), { 'Cache-Control': 'no-cache' });
  });
  route('DELETE', '/api/projects/:id/media/:file', async (context) => {
    const path = mediaEntry(context);
    await change(context, ['media'], async (manifest) => {
      if (!manifest.media.some((entry) => entry.path === path)) throw new HttpError(404, 'not-found', `${path} is not in the media library.`, { section: 'media' });
      const next = withManifest(manifest, { media: manifest.media.filter((entry) => entry.path !== path) });
      stillUnused(path, next, await level(context.params.id!));
      return { manifest: next, remove: [mediaFile(path)] };
    });
  });

  // Generic sections, registered last so the specific routes above win.
  for (const name of SECTION_NAMES) {
    const spec = sections[name];
    const path = `/api/projects/:id/${name}`;
    route('GET', path, async (context) => {
      const { manifest, state } = await project(context);
      sendJson(context.response, 200, await spec.read(context.params.id!, manifest), { ETag: `"${state.sections[name]}"` });
    });
    route('PUT', path, async (context) => {
      const value = await readJson(context.request, spec.limit);
      await change(context, [name], async (manifest) => spec.write(context.params.id!, manifest, value));
    });
    if (PATCHABLE.has(name)) {
      route('PATCH', path, async (context) => {
        const patch = await readJson(context.request, spec.limit);
        await change(context, [name], async (manifest) => {
          let value = mergePatch(await spec.read(context.params.id!, manifest) ?? (name.startsWith('characters/') ? EMPTY_SPRITES : null), patch);
          if (name.startsWith('characters/') && typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'layers'))) {
            // Profiles record the schema their content needs; recompute it so a patch cannot leave it stale.
            value = { ...value, schemaVersion: spriteSchemaVersion(Reflect.get(value, 'layers'), value) };
          }
          return spec.write(context.params.id!, manifest, value);
        });
      });
    }
    if (name === 'characters/primary' || name === 'characters/alternate') {
      route('DELETE', path, async (context) => {
        await change(context, [name], async (manifest) => spec.write(context.params.id!, manifest, null));
      });
    }
  }

  async function readUpload(request: IncomingMessage, limit: number, types: readonly string[]): Promise<Uint8Array> {
    const type = mediaTypeOf(request);
    if (type !== 'application/octet-stream' && !types.includes(type)) {
      throw new HttpError(415, 'unsupported-media-type', `Upload the raw file with Content-Type ${[...types, 'application/octet-stream'].join(' or ')}.`);
    }
    const bytes = await readBody(request, limit);
    if (bytes.byteLength === 0) throw new HttpError(400, 'empty', 'The uploaded file is empty.');
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async function importBundle(value: unknown): Promise<ProjectContent> {
    return verifyContent(unpackProjectBundle(value));
  }

  // The checks a release build makes beyond the file formats: hashes, GLB structure and character rigs.
  function verifyContent(content: ProjectContent): ProjectContent {
    for (const asset of content.manifest.art.assets) {
      const bytes = content.files.get(artFile(asset.id))!;
      if (!artAssetHashMatches(asset.id, sha256Hex(bytes))) throw new ProjectError(`Course artwork ${asset.id} does not match its content hash.`, { section: 'art' });
      inSection('art', () => validateCourseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    }
    for (const part of content.manifest.appearance) {
      const bytes = content.files.get(appearanceFile(part.part))!;
      inSection('appearance', () => checkAppearanceModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    }
    for (const role of ['primary', 'alternate'] as const) {
      const document = content.characters[role];
      if (document !== null) inSection(`characters/${role}`, () => checkCharacterModels(document, `${role} character`));
    }
    return content;
  }

  // Everything a release build checks, run against the stored files.
  async function checkedContent(id: string): Promise<ProjectContent> {
    return verifyContent((await store.snapshot(id)).content);
  }

  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://studio.invalid');
    } catch {
      next();
      return;
    }
    const pathname = url.pathname;
    if (pathname !== '/api' && !pathname.startsWith('/api/') && !pathname.startsWith('/play/')) {
      next();
      return;
    }
    try {
      if (pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, api: 1, auth: tokenDigest === null ? 'loopback' : 'token', authenticated: authenticated(request) });
        return;
      }
      if (pathname === '/api/session' && request.method === 'POST') {
        authorize(request);
        if (tokenDigest === null) {
          sendJson(response, 200, { auth: 'loopback' });
          return;
        }
        sendJson(response, 200, { auth: 'token' }, {
          'Set-Cookie': `${COOKIE}=${digest(tokenDigest.toString('hex')).toString('hex')}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        });
        return;
      }
      authorize(request);
      if (pathname.startsWith('/play/')) {
        await publisher.serve(request, response, pathname);
        return;
      }
      const method = request.method === 'HEAD' ? 'GET' : request.method ?? 'GET';
      let allowed = false;
      for (const candidate of routes) {
        const match = candidate.pattern.exec(pathname);
        if (match === null) continue;
        allowed = true;
        if (candidate.method !== method) continue;
        await candidate.handler({ request, response, url, params: match.groups ?? {} });
        return;
      }
      throw allowed ? new HttpError(405, 'method-not-allowed', `${method} is not supported here; see GET /api.`)
        : new HttpError(404, 'not-found', 'Unknown API path; see GET /api.');
    } catch (error) {
      sendError(response, toHttpError(error));
    }
  };
}

function insideRoot(root: string, value: string, variable: string): string {
  const path = isAbsolute(value) ? value : resolve(root, value);
  const inside = relative(root, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${variable} must name a folder inside ${root}.`);
  return path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** The self-hosted project server, added to the Workshop's dev and preview servers. */
export function projectStudio(options: { root: string; mode: string }): Plugin | null {
  const env = loadEnv(options.mode, options.root, 'STUDIO_');
  if (env.STUDIO_API === 'off') return null;
  const token = env.STUDIO_TOKEN === undefined || env.STUDIO_TOKEN === '' ? null : env.STUDIO_TOKEN;
  if (token !== null && token.length < MIN_TOKEN) throw new Error(`STUDIO_TOKEN must contain at least ${MIN_TOKEN} characters.`);
  const projects = env.STUDIO_PROJECTS ? resolve(options.root, env.STUDIO_PROJECTS) : resolve(options.root, 'projects');
  const releases = insideRoot(options.root, env.STUDIO_RELEASES ?? 'releases', 'STUDIO_RELEASES');
  const handler = createStudioHandler({ root: options.root, projects, releases, token });
  // Hooks must not return the middleware stack: Vite would call a returned function as a post hook.
  const use = (server: { middlewares: { use: (handler: (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void) => unknown } }): void => {
    server.middlewares.use((request, response, next) => { void handler(request, response, next); });
  };
  return {
    name: 'project-studio',
    // The dev server serves every file under its root; stored projects and releases must only be
    // reachable through the checked /api and /play routes.
    config: () => ({ server: { fs: { deny: [...VITE_FS_DENY, ...[projects, releases].map((folder) => `${folder.replaceAll('\\', '/')}/**`)] } } }),
    configureServer(server) { use(server); },
    configurePreviewServer(server) { use(server); },
  };
}
