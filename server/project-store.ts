import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  loadProjectContent, PROJECT_FILES, PROJECT_LIMITS, projectFileRefs, ProjectError, validateProjectId,
  validateProjectManifest,
} from '../src/project';
import type { ProjectContent, ProjectFileRef, ProjectManifest } from '../src/project';
import { HttpError } from './http';

// API sections; each has its own revision so concurrent editors only conflict on what they share.
export const SECTION_NAMES = [
  'title', 'level', 'settings', 'characters/primary', 'characters/alternate', 'arm-ik', 'appearance',
  'theme', 'hud', 'audio', 'enemies', 'art', 'media',
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export interface ProjectState {
  readonly revision: number;
  readonly sections: Readonly<Record<SectionName, number>>;
  readonly updatedAt: string;
}

export interface ProjectChange {
  readonly manifest?: ProjectManifest;
  readonly json?: ReadonlyMap<string, unknown>;
  readonly binary?: ReadonlyMap<string, Uint8Array>;
  // Files deleted after the new manifest is written.
  readonly remove?: readonly string[];
  readonly sections: readonly SectionName[];
}

export interface ProjectSummary {
  readonly id: string;
  readonly title: string | null;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

const STATE_FILE = '.studio.json';
const FILE_PATTERN = /^(?:project\.json|level\.json|characters\/(?:primary|alternate)\.json|art\/asset-[a-f0-9]{64}\.glb|appearance\/[a-z-]+\.glb|media\/[a-z0-9][a-z0-9._-]*)$/;

function initialState(): ProjectState {
  return {
    revision: 1, updatedAt: new Date().toISOString(),
    sections: Object.fromEntries(SECTION_NAMES.map((name) => [name, 1])) as Record<SectionName, number>,
  };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Projects stored as directories: project.json, its referenced files, and revision state. */
export class ProjectStore {
  readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  directory(id: string): string {
    try {
      return join(this.root, validateProjectId(id));
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      throw new HttpError(400, 'invalid-id', error.message);
    }
  }

  filePath(id: string, path: string): string {
    if (!FILE_PATTERN.test(path) || path.split('/').some((part) => part === '..' || part === '.')) {
      throw new HttpError(400, 'invalid-path', `Unknown project file ${path}.`);
    }
    return join(this.directory(id), ...path.split('/'));
  }

  async list(): Promise<ProjectSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const summaries: ProjectSummary[] = [];
    for (const id of entries.sort()) {
      try {
        validateProjectId(id);
      } catch {
        continue;
      }
      try {
        const { manifest, state } = await this.read(id);
        summaries.push({ id, title: manifest.title, revision: state.revision, updatedAt: state.updatedAt, error: null });
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) continue;
        summaries.push({ id, title: null, revision: 0, updatedAt: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return summaries;
  }

  async read(id: string): Promise<{ manifest: ProjectManifest; state: ProjectState }> {
    const directory = this.directory(id);
    // Commits write data before state; reading state first keeps a revision from describing newer data.
    const state = await this.state(directory);
    let text: string;
    try {
      const path = join(directory, PROJECT_FILES.manifest);
      if ((await stat(path)).size > PROJECT_LIMITS.manifestBytes) throw new ProjectError('project.json exceeds its size limit.');
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (missing(error)) throw new HttpError(404, 'not-found', `Project "${id}" does not exist.`);
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`project.json is not valid JSON: ${error.message}`);
    }
    return { manifest: validateProjectManifest(value), state };
  }

  async readJson(id: string, ref: Pick<ProjectFileRef, 'path' | 'maxBytes'>): Promise<unknown> {
    const bytes = await this.readBytes(id, ref);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${ref.path} is not valid JSON: ${error.message}`, { section: ref.path });
    }
  }

  async readBytes(id: string, ref: Pick<ProjectFileRef, 'path' | 'maxBytes'>): Promise<Buffer> {
    const path = this.filePath(id, ref.path);
    try {
      if ((await stat(path)).size > ref.maxBytes) throw new ProjectError(`${ref.path} exceeds ${ref.maxBytes / 1024 ** 2} MiB.`, { section: ref.path });
      return await readFile(path);
    } catch (error) {
      if (missing(error)) throw new ProjectError(`The project is missing ${ref.path}.`, { section: ref.path });
      throw error;
    }
  }

  async size(id: string, path: string): Promise<number> {
    try {
      return (await stat(this.filePath(id, path))).size;
    } catch (error) {
      if (missing(error)) return 0;
      throw error;
    }
  }

  // Reads and fully validates every referenced file.
  async content(id: string, manifest?: ProjectManifest): Promise<ProjectContent> {
    const current = manifest ?? (await this.read(id)).manifest;
    const values = new Map<string, unknown>();
    for (const ref of projectFileRefs(current)) {
      values.set(ref.path, ref.binary ? new Uint8Array(await this.readBytes(id, ref)) : await this.readJson(id, ref));
    }
    return loadProjectContent(current, (ref) => values.get(ref.path));
  }

  // A consistent copy of the whole project with its revision, taken while no change can commit.
  async snapshot(id: string): Promise<{ content: ProjectContent; state: ProjectState }> {
    return this.locked(id, async () => {
      const { manifest, state } = await this.read(id);
      return { content: await this.content(id, manifest), state };
    });
  }

  // Serializes changes per project; `change` sees the current manifest and state under the lock.
  async mutate<T>(id: string, change: (current: { manifest: ProjectManifest; state: ProjectState }) =>
    Promise<ProjectChange & { readonly result?: T }>): Promise<{ state: ProjectState; result: T | undefined }> {
    return this.locked(id, async () => {
      const current = await this.read(id);
      const next = await change(current);
      const state = await this.commit(id, current.state, next);
      return { state, result: next.result };
    });
  }

  // Writes a complete project, replacing any existing one only when asked.
  async write(id: string, content: ProjectContent, options: { replace: boolean }): Promise<ProjectState> {
    return this.locked(id, async () => {
      const directory = this.directory(id);
      let previous: ProjectState | null = null;
      try {
        previous = (await this.read(id)).state;
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) {
          if (!options.replace) throw error;
        }
      }
      const exists = await stat(directory).then(() => true, (error: unknown) => { if (missing(error)) return false; throw error; });
      if (exists && !options.replace) throw new HttpError(409, 'exists', `Project "${id}" already exists.`);
      await mkdir(this.root, { recursive: true });
      const staging = join(this.root, `.staging-${id}-${randomBytes(6).toString('hex')}`);
      try {
        for (const ref of projectFileRefs(content.manifest)) {
          const target = join(staging, ...ref.path.split('/'));
          if (ref.kind === 'level') await atomicWrite(target, `${JSON.stringify(content.level, null, 2)}\n`);
          else if (ref.kind === 'character') {
            await atomicWrite(target, JSON.stringify(ref.path === PROJECT_FILES.primary ? content.characters.primary : content.characters.alternate));
          } else await atomicWrite(target, content.files.get(ref.path)!);
        }
        await atomicWrite(join(staging, PROJECT_FILES.manifest), `${JSON.stringify(content.manifest, null, 2)}\n`);
        const base = previous ?? { ...initialState(), revision: 0, sections: Object.fromEntries(SECTION_NAMES.map((name) => [name, 0])) as Record<SectionName, number> };
        const state: ProjectState = {
          revision: base.revision + 1, updatedAt: new Date().toISOString(),
          sections: Object.fromEntries(SECTION_NAMES.map((name) => [name, base.sections[name] + 1])) as Record<SectionName, number>,
        };
        await atomicWrite(join(staging, STATE_FILE), `${JSON.stringify(state)}\n`);
        const trash = join(this.root, `.trash-${id}-${randomBytes(6).toString('hex')}`);
        if (exists) await rename(directory, trash);
        await rename(staging, directory);
        if (exists) await rm(trash, { recursive: true, force: true });
        return state;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.locked(id, async () => {
      await this.read(id);
      const trash = join(this.root, `.trash-${id}-${randomBytes(6).toString('hex')}`);
      await rename(this.directory(id), trash);
      await rm(trash, { recursive: true, force: true });
    });
  }

  private async state(directory: string): Promise<ProjectState> {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, STATE_FILE), 'utf8'));
      if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'revision') === 'number') {
        const sections = Reflect.get(value, 'sections') as Record<string, unknown> | undefined;
        const base = initialState();
        return {
          revision: Reflect.get(value, 'revision') as number,
          updatedAt: typeof Reflect.get(value, 'updatedAt') === 'string' ? Reflect.get(value, 'updatedAt') as string : base.updatedAt,
          sections: Object.fromEntries(SECTION_NAMES.map((name) =>
            [name, typeof sections?.[name] === 'number' ? sections[name] : 1])) as Record<SectionName, number>,
        };
      }
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    // Hand-made projects have no state file yet.
    return initialState();
  }

  private async commit(id: string, state: ProjectState, change: ProjectChange): Promise<ProjectState> {
    if (change.sections.length === 0) return state;
    for (const [path, value] of change.json ?? []) {
      await atomicWrite(this.filePath(id, path), path === PROJECT_FILES.level ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
    }
    for (const [path, bytes] of change.binary ?? []) await atomicWrite(this.filePath(id, path), bytes);
    if (change.manifest !== undefined) {
      await atomicWrite(this.filePath(id, PROJECT_FILES.manifest), `${JSON.stringify(change.manifest, null, 2)}\n`);
    }
    for (const path of change.remove ?? []) await rm(this.filePath(id, path), { force: true });
    const sections = { ...state.sections };
    for (const name of new Set(change.sections)) sections[name] += 1;
    const next: ProjectState = { revision: state.revision + 1, sections, updatedAt: new Date().toISOString() };
    await atomicWrite(join(this.directory(id), STATE_FILE), `${JSON.stringify(next)}\n`);
    return next;
  }

  private async locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(id, chained);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }
}
