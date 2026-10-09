import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { pathType } from '../src/content';
import { isContentPath } from '../src/content-ref';
import { sendBytes, sendFile } from '../server/http';
import { phantomMiddleware, PhantomStore } from '../server/phantom-store';
import { phantomCourse } from './phantom-course';
import { packReleaseContent } from './release-content';
import type { ReleaseContent } from './release-content';
import { readReleaseFile } from './release-file';
import type { ReleaseFile } from './release-file';
import type { ReleaseInput } from './release-input';
import { loadReleaseRecordings } from './release-phantoms';

const MODULES = {
  content: 'virtual:game-content',
  models: 'virtual:game-character-models',
  art: 'virtual:game-art',
  appearance: 'virtual:game-appearance',
  audio: 'virtual:game-audio',
  decorations: 'virtual:game-decorations',
  phantoms: 'virtual:game-phantoms',
} as const;
type ModuleName = keyof typeof MODULES;
const RESOLVED = Object.fromEntries(Object.entries(MODULES).map(([name, id]) => [`\0${id}`, name])) as Record<string, ModuleName>;
const runtime = (path: string): string => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
// Each loader enters the shell only when the release uses it.
const LOADERS = {
  models: `export { createCharacterModelLoader as default } from ${JSON.stringify(runtime('character-model-loader.ts'))};`,
  art: `export { loadCourseArt as default } from ${JSON.stringify(runtime('release-art.ts'))};`,
  appearance: `export { loadAppearance as default } from ${JSON.stringify(runtime('appearance-loader.ts'))};`,
  audio: `export { DEFAULT_AUDIO_OUTPUT as default } from ${JSON.stringify(runtime('audio.ts'))};`,
  decorations: `export { createDecorationView as default } from ${JSON.stringify(runtime('decoration-library.ts'))};`,
} as const;
const FAVICON = fileURLToPath(new URL('../public/favicon.svg', import.meta.url));
// Where the shell finds its content by default: beside itself, as dev and preview serve it.
export const DEFAULT_CONTENT_URL = 'content/';

// A game build's content directory, beside its shell's: dist-game/ writes dist-game-content/.
export function contentDirectory(outDir: string): string {
  return `${resolve(outDir)}-content`;
}

export function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  response.end('Unknown content file.');
}

// The path a server answers phantom requests under: the phantom URL's, when it is on that server.
function phantomPrefix(url: string | null, base: string): string | null {
  if (url === null) return null;
  const local = 'http://phantoms.invalid';
  const resolved = new URL(url, `${local}${base.startsWith('/') ? base : '/'}`);
  return resolved.origin === local ? resolved.pathname : null;
}

// The path under /content/ that a request names, or null when it is not a content request.
export function contentRequest(request: IncomingMessage, base: string): string | null {
  const pathname = new URL(request.url ?? '/', 'http://content.invalid').pathname;
  const prefix = `${base.endsWith('/') ? base : `${base}/`}content/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
}

/**
 * Builds a game release as a public shell plus private content. The shell (dist-game/) holds only
 * code, styles, the page and the icon, and pins the content's manifest; the content (dist-game-
 * content/) holds the level, profiles, settings, images, models and media the game uses, named by
 * SHA-256. Development and preview servers serve the content at the default content URL.
 */
export function gameRelease(options: {
  readonly load: () => ReleaseInput;
  readonly contentUrl: string;
  // GAME_PHANTOMS_URL: where phantoms go and come from, or null without a phantom backend.
  readonly phantomsUrl: string | null;
  // A folder of phantom recordings by course, whose recordings of the level the release bundles; null for none. Read
  // once: new recordings join the next build or server start.
  readonly recordings: string | null;
  // Input files known before loading; a change reloads the page, or restarts the server for a project.
  readonly watch: readonly string[];
  readonly restartOnChange: boolean;
}): Plugin {
  type Packed = { readonly input: ReleaseInput; readonly course: string; readonly content: ReleaseContent };
  let packed: Packed | null = null;
  let development: ViteDevServer | null = null;
  const watched = new Set(options.watch);
  const current = (): Packed => {
    if (packed === null) {
      const input = options.load();
      const course = phantomCourse(input.level, input.settings);
      packed = { input, course, content: packReleaseContent(input, loadReleaseRecordings(options.recordings, course)) };
      // Files found while loading, such as a level's public/media/ files, join the watch.
      for (const file of input.files) {
        if (watched.has(file)) continue;
        watched.add(file);
        development?.watcher.add(file);
      }
    }
    return packed;
  };
  const code = (name: ModuleName): string => {
    const { course, content } = current();
    if (name === 'content') {
      return `export default ${JSON.stringify({ contentUrl: options.contentUrl, ...content.pins })};\n` +
        `export const course = ${JSON.stringify(course)};`;
    }
    if (name === 'phantoms') {
      // Phantoms run with a backend, bundled recordings, or both.
      if (options.phantomsUrl === null && !content.uses.phantoms) return 'export default null;';
      return `import { startPhantoms } from ${JSON.stringify(runtime('phantoms.ts'))};\n` +
        `export default { url: ${JSON.stringify(options.phantomsUrl)}, start: startPhantoms };`;
    }
    return content.uses[name] ? LOADERS[name] : 'export default null;';
  };
  return {
    name: 'game-release',
    resolveId(id) {
      if (Object.values(MODULES).includes(id as (typeof MODULES)[ModuleName])) return `\0${id}`;
    },
    load(id) {
      const name = RESOLVED[id];
      return name === undefined ? undefined : code(name);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: readFileSync(FAVICON) });
    },
    writeBundle(output) {
      if (output.dir === undefined) return;
      const directory = contentDirectory(output.dir);
      rmSync(directory, { recursive: true, force: true });
      // One file at a time: a project file is read again, and checked, only as it is written.
      for (const [path, file] of current().content.files) {
        const target = join(directory, ...path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readReleaseFile(file));
      }
    },
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('href="/favicon.svg"', 'href="favicon.svg"') },
    configureServer(server) {
      development = server;
      const phantoms = phantomPrefix(options.phantomsUrl, server.config.base);
      if (phantoms !== null) server.middlewares.use(phantomMiddleware(new PhantomStore(), phantoms));
      server.middlewares.use('/favicon.svg', (_request, response) => {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(readFileSync(FAVICON));
      });
      server.middlewares.use((request, response, next) => {
        const path = contentRequest(request, server.config.base);
        if (path === null) {
          next();
          return;
        }
        let file: ReleaseFile | undefined;
        try {
          file = isContentPath(path) ? current().content.files.get(path) : undefined;
        } catch (error) {
          next(error);
          return;
        }
        if (file === undefined) {
          notFound(response);
          return;
        }
        // A project file streams from disk; a change to it restarts the server, which packages it again.
        if (file instanceof Uint8Array) sendBytes(request, response, file, pathType(path), { 'Cache-Control': 'no-cache' });
        else sendFile(request, response, file.path, pathType(path), { 'Cache-Control': 'no-cache' });
      });
      server.watcher.add([...watched]);
      server.watcher.on('change', (file) => {
        if (!watched.has(file)) return;
        if (options.restartOnChange) {
          void server.restart();
          return;
        }
        packed = null;
        for (const id of Object.keys(RESOLVED)) {
          const module = server.moduleGraph.getModuleById(id);
          if (module) server.moduleGraph.invalidateModule(module);
        }
        server.ws.send({ type: 'full-reload' });
      });
    },
    configurePreviewServer(server) {
      const phantoms = phantomPrefix(options.phantomsUrl, server.config.base);
      if (phantoms !== null) server.middlewares.use(phantomMiddleware(new PhantomStore(), phantoms));
      const directory = contentDirectory(resolve(server.config.root, server.config.build.outDir));
      server.middlewares.use((request, response, next) => {
        const path = contentRequest(request, server.config.base);
        if (path === null) {
          next();
          return;
        }
        const file = isContentPath(path) ? join(directory, ...path.split('/')) : null;
        if (file === null || !existsSync(file) || !statSync(file).isFile()) {
          notFound(response);
          return;
        }
        sendFile(request, response, file, pathType(path), { 'Cache-Control': 'public, max-age=31536000, immutable' });
      });
    },
  };
}
