import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GameSettings } from '../src/game-settings';
import { LEVEL_LIMITS, validateLevel } from '../src/level';
import type { LevelDefinition } from '../src/level';
import { PHANTOM_COURSE_FORMAT } from '../src/phantom-course';
import {
  inSection, isProjectDataError, loadProjectContent, PROJECT_FILES, PROJECT_LIMITS, projectFileRefs, ProjectError, validateProjectId,
  validateProjectManifest,
} from '../src/project';
import type { ProjectContent, ProjectFileKind, ProjectFileRef, ProjectManifest } from '../src/project';
import { atomicWrite, missing } from './files';
import { HttpError } from './http';
import {
  addRecording, countRecordings, findLevelVersion, LEVEL_HISTORY_FOLDERS, listLevelVersions, listRecordings, readLevelVersion,
  readRecording, recordingName, recordLevelVersion, removeRecording,
} from './level-history';
import type { LevelVersion, LevelVersionRef, PhantomRecording } from './level-history';

// API sections; each has its own revision so concurrent editors only conflict on what they share.
export const SECTION_NAMES = [
  'title', 'level', 'settings', 'characters/primary', 'characters/alternate', 'arm-ik', 'appearance', 'models',
  'theme', 'hud', 'audio', 'enemies', 'art', 'media',
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export interface ProjectState {
  readonly revision: number;
  readonly sections: Readonly<Record<SectionName, number>>;
  readonly updatedAt: string;
  // The version the stored level and game settings are, and the course of its recordings; null while the stored level
  // is not a valid level.
  readonly level: LevelVersionRef | null;
}

// The state file also records what each section's stored content was when the store last counted it, so a change
// made outside the API (a tool, an editor or version control writing the files) is counted too. Null until first seen.
// The level version is worked out again when the course format it was worked out with is not this code's.
interface StoredState extends ProjectState {
  readonly observed: Readonly<Record<SectionName, string>> | null;
  readonly courseFormat: number;
}

// The sections a level version holds.
const VERSIONED: ReadonlySet<SectionName> = new Set(['level', 'settings']);

// Each section's stored content: its part of the manifest (null for one kept only in files) and the files it owns.
const SECTION_MANIFEST: Readonly<Record<SectionName, (manifest: ProjectManifest) => unknown>> = {
  title: (manifest) => manifest.title,
  level: () => null,
  settings: (manifest) => manifest.settings,
  'characters/primary': (manifest) => manifest.characters.primary,
  'characters/alternate': (manifest) => manifest.characters.alternate,
  'arm-ik': (manifest) => manifest.armIk,
  appearance: (manifest) => manifest.appearance,
  models: (manifest) => manifest.models,
  theme: (manifest) => manifest.theme,
  hud: (manifest) => manifest.hud,
  audio: (manifest) => manifest.audio,
  enemies: (manifest) => manifest.enemies,
  art: (manifest) => manifest.art,
  media: (manifest) => manifest.media,
};
const FILE_SECTIONS: Readonly<Record<ProjectFileKind, (path: string) => SectionName>> = {
  level: () => 'level',
  character: (path) => path === PROJECT_FILES.primary ? 'characters/primary' : 'characters/alternate',
  art: () => 'art',
  appearance: () => 'appearance',
  model: () => 'models',
  media: () => 'media',
};

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
const LEVEL_REF = { path: PROJECT_FILES.level, maxBytes: LEVEL_LIMITS.fileBytes } as const;
const FILE_PATTERN = /^(?:project\.json|level\.json|characters\/(?:primary|alternate)\.json|art\/asset-[a-f0-9]{64}\.glb|appearance\/[a-z-]+\.glb|models\/(?:avatar|hammer|pot)\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.glb|media\/[a-z0-9][a-z0-9._-]*)$/;

function initialState(): StoredState {
  return {
    revision: 1, updatedAt: new Date().toISOString(), observed: null, level: null, courseFormat: 0,
    sections: Object.fromEntries(SECTION_NAMES.map((name) => [name, 1])) as Record<SectionName, number>,
  };
}

function isVersionRef(value: unknown): value is LevelVersionRef {
  if (typeof value !== 'object' || value === null) return false;
  const { version, course } = value as Record<string, unknown>;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 && typeof course === 'string' && /^[0-9a-f]{64}$/.test(course);
}

// Each section's stored content in `directory` as a short signature: its part of the manifest and, for every file it
// owns, the file's size and modification time in nanoseconds, which any write changes. Costs one stat per file.
async function signatures(directory: string, manifest: ProjectManifest): Promise<Record<SectionName, string>> {
  const parts = Object.fromEntries(SECTION_NAMES.map((name) => [name, [SECTION_MANIFEST[name](manifest)]])) as Record<SectionName, unknown[]>;
  for (const ref of projectFileRefs(manifest)) {
    const found = await stat(join(directory, ...ref.path.split('/')), { bigint: true }).then(
      (file) => `${file.size}:${file.mtimeNs}`,
      (error: unknown) => { if (missing(error)) return 'missing'; throw error; });
    parts[FILE_SECTIONS[ref.kind](ref.path)]!.push(ref.path, found);
  }
  return Object.fromEntries(SECTION_NAMES.map((name) =>
    [name, createHash('sha256').update(JSON.stringify(parts[name])).digest('hex')])) as Record<SectionName, string>;
}

/**
 * Projects stored as directories: project.json, its referenced files, and revision state. Every read counts sections
 * whose files changed outside the API as changed, so pages reload them instead of overwriting them. Every level that
 * is stored becomes a numbered version, kept with the recordings played on it (server/level-history.ts).
 */
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
    return this.locked(id, () => this.current(id));
  }

  // The manifest and its state under the project's lock, with sections whose stored content changed since the store
  // last counted them (by the signatures above) counted as changed; the state file keeps that bookkeeping. A level or
  // game settings changed outside the API become a level version here, as does a project first seen.
  private async current(id: string): Promise<{ manifest: ProjectManifest; state: StoredState }> {
    const directory = this.directory(id);
    const recorded = await this.state(directory);
    const manifest = await this.manifest(id);
    const observed = await signatures(directory, manifest);
    const changed = recorded.observed === null ? [] : SECTION_NAMES.filter((name) => recorded.observed![name] !== observed[name]);
    const versioned = recorded.observed === null || recorded.courseFormat !== PHANTOM_COURSE_FORMAT || changed.some((name) => VERSIONED.has(name));
    if (changed.length === 0 && !versioned) return { manifest, state: recorded };
    const sections = { ...recorded.sections };
    for (const name of changed) sections[name] += 1;
    const level = versioned ? await this.version(id, null, manifest.settings) : recorded.level;
    const state: StoredState = changed.length === 0 ? { ...recorded, observed, level, courseFormat: PHANTOM_COURSE_FORMAT } : {
      revision: recorded.revision + 1, sections, updatedAt: new Date().toISOString(), observed, level, courseFormat: PHANTOM_COURSE_FORMAT,
    };
    await atomicWrite(join(directory, STATE_FILE), `${JSON.stringify(state)}\n`);
    return { manifest, state };
  }

  // The version of the stored level, or of `level` just stored, with `settings`, recorded if it is new; null while the
  // stored level is not a valid level, on which nothing can be played.
  private async version(id: string, level: LevelDefinition | null, settings: GameSettings): Promise<LevelVersionRef | null> {
    let played = level;
    if (played === null) {
      try {
        played = await this.storedLevel(id);
      } catch (error) {
        if (isProjectDataError(error)) return null;
        throw error;
      }
    }
    const { version, course } = await recordLevelVersion(this.directory(id), played, settings);
    return { version, course };
  }

  private async storedLevel(id: string): Promise<LevelDefinition> {
    const value = await this.readJson(id, LEVEL_REF);
    return inSection('level', () => validateLevel(value));
  }

  private async manifest(id: string): Promise<ProjectManifest> {
    const directory = this.directory(id);
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
    return validateProjectManifest(value);
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
  async content(id: string, manifest: ProjectManifest): Promise<ProjectContent> {
    const values = new Map<string, unknown>();
    for (const ref of projectFileRefs(manifest)) {
      values.set(ref.path, ref.binary ? new Uint8Array(await this.readBytes(id, ref)) : await this.readJson(id, ref));
    }
    return loadProjectContent(manifest, (ref) => values.get(ref.path));
  }

  // A consistent copy of the whole project with its revision, taken while no change can commit.
  async snapshot(id: string): Promise<{ content: ProjectContent; state: ProjectState }> {
    return this.locked(id, async () => {
      const { manifest, state } = await this.current(id);
      return { content: await this.content(id, manifest), state };
    });
  }

  // Serializes changes per project; `change` sees the current manifest and state under the lock.
  async mutate<T>(id: string, change: (current: { manifest: ProjectManifest; state: ProjectState }) =>
    Promise<ProjectChange & { readonly result?: T }>): Promise<{ state: ProjectState; result: T | undefined }> {
    return this.locked(id, async () => {
      const current = await this.current(id);
      const next = await change(current);
      const state = await this.commit(id, current, next);
      return { state, result: next.result };
    });
  }

  // Writes a complete project, replacing any existing one only when asked; a replaced project's level versions and
  // recordings stay.
  async write(id: string, content: ProjectContent, options: { replace: boolean }): Promise<ProjectState> {
    return this.locked(id, async () => {
      const directory = this.directory(id);
      let previous: ProjectState | null = null;
      try {
        previous = (await this.current(id)).state;
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
        // Renaming the staging folder keeps its files' sizes and times, so they are signed here. The level version is
        // worked out once the project is in place with its history.
        const state: StoredState = {
          revision: base.revision + 1, updatedAt: new Date().toISOString(), observed: await signatures(staging, content.manifest),
          sections: Object.fromEntries(SECTION_NAMES.map((name) => [name, base.sections[name] + 1])) as Record<SectionName, number>,
          level: null, courseFormat: 0,
        };
        await atomicWrite(join(staging, STATE_FILE), `${JSON.stringify(state)}\n`);
        const trash = join(this.root, `.trash-${id}-${randomBytes(6).toString('hex')}`);
        if (exists) await rename(directory, trash);
        await rename(staging, directory);
        if (exists) {
          for (const folder of LEVEL_HISTORY_FOLDERS) {
            await rename(join(trash, folder), join(directory, folder)).catch((error: unknown) => { if (!missing(error)) throw error; });
          }
          await rm(trash, { recursive: true, force: true });
        }
        const placed: StoredState = {
          ...state, level: await this.version(id, content.level, content.manifest.settings), courseFormat: PHANTOM_COURSE_FORMAT,
        };
        await atomicWrite(join(directory, STATE_FILE), `${JSON.stringify(placed)}\n`);
        return placed;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.locked(id, async () => {
      await this.current(id);
      const trash = join(this.root, `.trash-${id}-${randomBytes(6).toString('hex')}`);
      await rename(this.directory(id), trash);
      await rm(trash, { recursive: true, force: true });
    });
  }

  private async state(directory: string): Promise<StoredState> {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, STATE_FILE), 'utf8'));
      if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'revision') === 'number') {
        const sections = Reflect.get(value, 'sections') as Record<string, unknown> | undefined;
        const observed = Reflect.get(value, 'observed') as Record<string, unknown> | null | undefined;
        const level: unknown = Reflect.get(value, 'level');
        const courseFormat: unknown = Reflect.get(value, 'courseFormat');
        const base = initialState();
        return {
          revision: Reflect.get(value, 'revision') as number,
          updatedAt: typeof Reflect.get(value, 'updatedAt') === 'string' ? Reflect.get(value, 'updatedAt') as string : base.updatedAt,
          sections: Object.fromEntries(SECTION_NAMES.map((name) =>
            [name, typeof sections?.[name] === 'number' ? sections[name] : 1])) as Record<SectionName, number>,
          observed: typeof observed === 'object' && observed !== null && SECTION_NAMES.every((name) => typeof observed[name] === 'string')
            ? Object.fromEntries(SECTION_NAMES.map((name) => [name, observed[name] as string])) as Record<SectionName, string> : null,
          level: isVersionRef(level) ? { version: level.version, course: level.course } : null,
          // A version that cannot be read is worked out again.
          courseFormat: (level === null || isVersionRef(level)) && typeof courseFormat === 'number' ? courseFormat : 0,
        };
      }
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    // Hand-made projects have no state file yet.
    return initialState();
  }

  private async commit(id: string, current: { manifest: ProjectManifest; state: StoredState }, change: ProjectChange): Promise<ProjectState> {
    const { state } = current;
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
    const manifest = change.manifest ?? current.manifest;
    // Levels reach the store validated.
    const level = change.json?.get(PROJECT_FILES.level) as LevelDefinition | undefined;
    const next: StoredState = {
      revision: state.revision + 1, sections, updatedAt: new Date().toISOString(),
      observed: await signatures(this.directory(id), manifest),
      level: change.sections.some((name) => VERSIONED.has(name)) ? await this.version(id, level ?? null, manifest.settings) : state.level,
      courseFormat: PHANTOM_COURSE_FORMAT,
    };
    await atomicWrite(join(this.directory(id), STATE_FILE), `${JSON.stringify(next)}\n`);
    return next;
  }

  // The stored level with the state it belongs to, read together under the lock. The level version is worked out
  // again from the level read, so a history removed or rewritten by hand is numbered afresh when the project opens.
  async readLevel(id: string): Promise<{ level: LevelDefinition; state: ProjectState }> {
    return this.locked(id, async () => {
      const { manifest, state } = await this.current(id);
      const level = await this.storedLevel(id);
      const version = await this.version(id, level, manifest.settings);
      if (version?.version === state.level?.version && version?.course === state.level?.course) return { level, state };
      const next: StoredState = { ...state, level: version };
      await atomicWrite(join(this.directory(id), STATE_FILE), `${JSON.stringify(next)}\n`);
      return { level, state: next };
    });
  }

  // Every version of the level, oldest first, with the number of recordings made on each.
  async levelVersions(id: string): Promise<(LevelVersion & { readonly recordings: number })[]> {
    return this.history(id, async (directory) => {
      const list = await listLevelVersions(directory);
      const counts = await countRecordings(directory, list);
      return list.map((entry) => ({ ...entry, recordings: counts.get(entry.version) ?? 0 }));
    });
  }

  // A version as JSON, with its level and game settings.
  async levelVersion(id: string, version: number): Promise<Buffer> {
    return this.history(id, async (directory) => readLevelVersion(directory, await findLevelVersion(directory, version)));
  }

  // Stores a phantom recording of `version` under a name made of its session and clip, which the same clip sent again
  // keeps.
  async addRecording(id: string, version: number, clip: { session: string; clip: number }, bytes: Uint8Array): Promise<{ name: string; version: LevelVersion }> {
    return this.history(id, async (directory) => {
      const entry = await findLevelVersion(directory, version);
      const name = recordingName(version, clip.session, clip.clip);
      await addRecording(directory, entry, name, bytes);
      return { name, version: entry };
    });
  }

  async recordings(id: string, version: number): Promise<PhantomRecording[]> {
    return this.history(id, async (directory) => listRecordings(directory, await findLevelVersion(directory, version)));
  }

  async recording(id: string, version: number, name: string): Promise<Buffer> {
    return this.history(id, async (directory) => readRecording(directory, await findLevelVersion(directory, version), name));
  }

  async removeRecording(id: string, version: number, name: string): Promise<void> {
    await this.history(id, async (directory) => removeRecording(directory, await findLevelVersion(directory, version), name));
  }

  // Where a project keeps its recordings, by course; release builds bundle from it.
  recordingsDirectory(id: string): string {
    return join(this.directory(id), LEVEL_HISTORY_FOLDERS[1]);
  }

  // Runs `task` on an existing project's folder under its lock, so a replacement never moves the history mid-task.
  private async history<T>(id: string, task: (directory: string) => Promise<T>): Promise<T> {
    return this.locked(id, async () => {
      await this.manifest(id);
      return task(this.directory(id));
    });
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
