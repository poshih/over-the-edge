import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { packProjectBundle, validateProjectId } from '../src/project';
import type { ProjectContent } from '../src/project';
import { HttpError, sendFile } from './http';

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
 * Builds game-only releases from stored projects with the regular release build, one at a time,
 * into releases/<id>/, and serves them at /play/<id>/ for previewing before you deploy them.
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

  // `content` is a validated snapshot, so later edits cannot change a build that is in progress.
  publish(id: string, revision: number, content: ProjectContent): Promise<PublishRecord> {
    const task = this.queue.then(() => this.build(id, revision, content));
    this.queue = task.catch(() => undefined);
    return task;
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

  private async build(id: string, revision: number, content: ProjectContent): Promise<PublishRecord> {
    this.running.add(id);
    const started = Date.now();
    const work = join(this.releases, `.build-${id}-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(work, { recursive: true });
      // One bundle file keeps the snapshot self-contained and validated by the same release loader.
      const bundlePath = join(work, 'project.bundle.json');
      await writeFile(bundlePath, JSON.stringify(packProjectBundle(content)));
      const output = join(work, 'release');
      await this.runBuild(relative(this.root, bundlePath), output);
      const target = join(this.releases, id);
      const previous = join(this.releases, `.previous-${id}-${randomBytes(6).toString('hex')}`);
      if (existsSync(target)) await rename(target, previous);
      await rename(output, target);
      await rm(previous, { recursive: true, force: true });
      const size = await folderSize(target);
      const record: PublishRecord = {
        id, revision, publishedAt: new Date().toISOString(), durationMs: Date.now() - started, ...size,
        url: `/play/${id}/`, directory: relative(this.root, target),
      };
      await writeFile(join(this.releases, `${id}.publish.json`), `${JSON.stringify(record, null, 2)}\n`);
      return record;
    } finally {
      this.running.delete(id);
      await rm(work, { recursive: true, force: true });
    }
  }

  private runBuild(project: string, output: string): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env, GAME_PROJECT: project, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' };
    // The project is the whole game; per-file inputs from the studio's own environment must not leak in.
    for (const variable of ['GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES', 'GAME_TITLE', 'GAME_ART_MODE']) delete env[variable];
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
