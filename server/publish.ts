import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, relative, sep } from 'node:path';
import { validateProjectId } from '../src/project';
import type { ProjectManifest } from '../src/project';
import type { LevelDefinition } from '../src/level';
import { pathType } from '../src/content';
import { isContentPath } from '../src/content-ref';
import { contentDirectory } from '../build/release';
import { releaseProjectFiles } from '../build/release-input';
import { HttpError, sendFile } from './http';

// The binary files of a project, by path, that a release of it takes.
export type ReleaseSelection = (manifest: ProjectManifest, level: LevelDefinition) => Iterable<string>;

const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_LIMIT = 16 * 1024;
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
};

export interface PublishRecord {
  readonly id: string;
  readonly revision: number;
  readonly publishedAt: string;
  readonly durationMs: number;
  readonly files: number;
  readonly bytes: number;
  readonly url: string;
  readonly directory: string;
  // The release's content, kept beside the shell's folder and served at <url>content/.
  readonly content: { readonly files: number; readonly bytes: number; readonly directory: string };
}

async function folderSize(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

/**
 * Builds game-only releases from stored projects with the regular release build, one at a time.
 * The shell goes to releases/<id>/ and its content to releases/<id>.content/, never inside the
 * shell's folder; both are served at /play/<id>/, behind the studio's own authentication, for
 * previewing before you deploy them.
 */
export class Publisher {
  private readonly root: string;
  private readonly releases: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly running = new Set<string>();

  constructor(options: { root: string; releases: string }) {
    this.root = options.root;
    this.releases = options.releases;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  async status(id: string): Promise<PublishRecord | null> {
    try {
      return JSON.parse(await readFile(join(this.releases, `${validateProjectId(id)}.publish.json`), 'utf8')) as PublishRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  // `snapshot` copies the project, with the binary files the selection it is given names, into the directory it is given
  // and returns the revision it copied, at once, so later edits cannot change a build that is waiting or in progress;
  // `recordings` is the project's folder of phantom recordings, which the release bundles for its level.
  async publish(id: string, snapshot: (directory: string, select: ReleaseSelection) => Promise<number>, recordings: string): Promise<PublishRecord> {
    const work = join(this.releases, `.build-${id}-${randomBytes(6).toString('hex')}`);
    try {
      // Only the files the release takes: a studio preview keeps runtime facets but has no release facets, so no
      // library models.
      const revision = await snapshot(join(work, 'project'), (manifest, level) => releaseProjectFiles(manifest, level, false));
      const task = this.queue.then(() => this.build(id, revision, work, recordings));
      this.queue = task.catch(() => undefined);
      return await task;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async serve(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const match = /^\/play\/([^/]+)(\/.*)?$/.exec(pathname);
    if (match === null) throw new HttpError(404, 'not-found', 'Unknown release path.');
    const id = validateId(match[1]!);
    if (match[2] === undefined) {
      response.writeHead(308, { Location: `/play/${id}/` });
      response.end();
      return;
    }
    const directory = join(this.releases, id);
    if (match[2].startsWith('/content/')) {
      const content = match[2].slice('/content/'.length);
      const file = isContentPath(content) ? join(this.releases, `${id}.content`, ...content.split('/')) : null;
      if (file === null || !existsSync(file) || !(await stat(file)).isFile()) throw new HttpError(404, 'not-found', 'Unknown release content.');
      sendFile(request, response, file, pathType(content), { 'Cache-Control': 'public, max-age=31536000, immutable' });
      return;
    }
    let path: string;
    try {
      path = join(directory, ...decodeURIComponent(match[2] === '/' ? '/index.html' : match[2]).split('/').filter(Boolean));
    } catch {
      throw new HttpError(400, 'invalid-path', 'Invalid release path.');
    }
    const inside = relative(directory, path);
    if (inside.startsWith('..') || inside.split(sep).some((part) => part.startsWith('.'))) {
      throw new HttpError(404, 'not-found', 'Unknown release file.');
    }
    if (!existsSync(path) || !(await stat(path)).isFile()) {
      throw new HttpError(404, 'not-found', existsSync(directory) ? 'Unknown release file.' : `Project "${id}" has not been published yet.`);
    }
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    sendFile(request, response, path, type, {
      'Cache-Control': inside.startsWith(`assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  }

  // Builds the project copied into `work`/project with the regular release build, as GAME_PROJECT, so the build reads
  // the project's files from that directory like any other.
  private async build(id: string, revision: number, work: string, recordings: string): Promise<PublishRecord> {
    this.running.add(id);
    const started = Date.now();
    try {
      const output = join(work, 'release');
      await this.runBuild(relative(this.root, join(work, 'project')), recordings, output);
      // The release build writes the content beside its output folder.
      const outputs = [[output, join(this.releases, id)], [contentDirectory(output), join(this.releases, `${id}.content`)]] as const;
      const previous = outputs.map(([, target]) =>
        existsSync(target) ? join(this.releases, `.previous-${basename(target)}-${randomBytes(6).toString('hex')}`) : null);
      for (const [index, [, target]] of outputs.entries()) if (previous[index] !== null) await rename(target, previous[index]!);
      for (const [built, target] of outputs) await rename(built, target);
      for (const folder of previous) if (folder !== null) await rm(folder, { recursive: true, force: true });
      const [shellFolder, contentFolder] = outputs.map(([, target]) => target) as [string, string];
      const record: PublishRecord = {
        id, revision, publishedAt: new Date().toISOString(), durationMs: Date.now() - started, ...await folderSize(shellFolder),
        url: `/play/${id}/`, directory: relative(this.root, shellFolder),
        content: { ...await folderSize(contentFolder), directory: relative(this.root, contentFolder) },
      };
      await writeFile(join(this.releases, `${id}.publish.json`), `${JSON.stringify(record, null, 2)}\n`);
      return record;
    } finally {
      this.running.delete(id);
    }
  }

  private runBuild(project: string, recordings: string, output: string): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env, GAME_PROJECT: project, GAME_STUDIO_PREVIEW: '1',
      GAME_PHANTOM_RECORDINGS: recordings, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
    };
    // The project is the whole game; per-file inputs from the studio's own environment must not leak in.
    // A studio preview serves its own content, so it keeps the default content URL and public access, and
    // it has no phantom service: it replays the project's own recordings. It keeps GAME_PLUGINS for kinds and runtime,
    // but serves no release facets and packages no library models (docs/plugins.md).
    for (const variable of [
      'GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES', 'GAME_TITLE', 'GAME_CONTENT_URL',
      'GAME_PHANTOMS_URL',
    ]) delete env[variable];
    const vite = join(this.root, 'node_modules', 'vite', 'bin', 'vite.js');
    const args = [vite, 'build', '--config', join(this.root, 'vite.game.config.ts'), '--outDir', output, '--emptyOutDir', '--base', './', '--logLevel', 'warn'];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: this.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const append = (chunk: Buffer): void => { log = (log + chunk.toString('utf8')).slice(-LOG_LIMIT); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => child.kill('SIGTERM'), BUILD_TIMEOUT_MS);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const detail = log.split('\n').filter((line) => /error|GAME_PROJECT|failed/i.test(line)).slice(-6).join('\n') || log.slice(-2000);
          reject(new HttpError(422, 'publish-failed', `The release build failed${signal ? ` (${signal})` : ''}: ${detail.trim()}`));
        }
      });
    });
  }
}

function validateId(id: string): string {
  try {
    return validateProjectId(id);
  } catch {
    throw new HttpError(404, 'not-found', 'Unknown release.');
  }
}
