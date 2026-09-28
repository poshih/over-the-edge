import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { pathType } from '../src/content';
import { isContentPath } from '../src/content-ref';
import { sendBytes, sendFile } from '../server/http';
import { packReleaseContent } from './release-content';
import type { ReleaseContent } from './release-content';
import type { ReleaseInput } from './release-input';

const MODULES = {
  content: 'virtual:game-content',
  models: 'virtual:game-character-models',
  art: 'virtual:game-art',
  appearance: 'virtual:game-appearance',
  audio: 'virtual:game-audio',
  module: 'virtual:game-module',
} as const;
type ModuleName = keyof typeof MODULES;
const RESOLVED = Object.fromEntries(Object.entries(MODULES).map(([name, id]) => [`\0${id}`, name])) as Record<string, ModuleName>;
const runtime = (path: string): string => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
// Each loader enters the shell only when the release uses it.
const LOADERS = {
  models: `export { createCharacterModelLoader as default } from ${JSON.stringify(runtime('character-model-loader.ts'))};`,
  art: `export { loadCourseArt as default } from ${JSON.stringify(runtime('release-art.ts'))};`,
  appearance: `export { loadAppearance as default } from ${JSON.stringify(runtime('appearance-loader.ts'))};`,
  audio: `export { AudioDirector as default } from ${JSON.stringify(runtime('audio.ts'))};`,
} as const;
const FAVICON = fileURLToPath(new URL('../public/favicon.svg', import.meta.url));
// Where the shell finds its content by default: beside itself, as dev and preview serve it.
export const DEFAULT_CONTENT_URL = 'content/';

// A game build's content directory, beside its shell's: dist-game/ writes dist-game-content/.
export function contentDirectory(outDir: string): string {
  return `${resolve(outDir)}-content`;
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  response.end('Unknown content file.');
}

// The path under /content/ that a request names, or null when it is not a content request.
function contentRequest(request: IncomingMessage, base: string): string | null {
  const pathname = new URL(request.url ?? '/', 'http://content.invalid').pathname;
  const prefix = `${base.endsWith('/') ? base : `${base}/`}content/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
}

/**
 * Builds a game release as a public shell plus private content. The shell (dist-game/) holds only
 * code, styles, the page and the icon, and pins the content's manifest; the content (dist-game-
 * content/) holds every level, profile, setting, image, model and media file, named by SHA-256.
 * Development and preview servers serve the content at the default content URL.
 */
export function gameRelease(options: {
  readonly load: () => ReleaseInput;
  readonly contentUrl: string;
  readonly module: string | null;
  // Input files known before loading; a change reloads the page, or restarts the server for a project.
  readonly watch: readonly string[];
  readonly restartOnChange: boolean;
}): Plugin {
  let packed: { readonly input: ReleaseInput; readonly content: ReleaseContent } | null = null;
  let development: ViteDevServer | null = null;
  const watched = new Set(options.watch);
  const current = (): { readonly input: ReleaseInput; readonly content: ReleaseContent } => {
    if (packed === null) {
      const input = options.load();
      packed = { input, content: packReleaseContent(input) };
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
    if (name === 'module') {
      return options.module === null ? 'export default null;' : `export { start as default } from ${JSON.stringify(options.module)};`;
    }
    const { content } = current();
    if (name === 'content') return `export default ${JSON.stringify({ contentUrl: options.contentUrl, ...content.pins })};`;
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
      for (const [path, bytes] of current().content.files) {
        const file = join(directory, ...path.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
    },
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('href="/favicon.svg"', 'href="favicon.svg"') },
    configureServer(server) {
      development = server;
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
        let bytes: Uint8Array | undefined;
        try {
          bytes = isContentPath(path) ? current().content.files.get(path) : undefined;
        } catch (error) {
          next(error);
          return;
        }
        if (bytes === undefined) {
          notFound(response);
          return;
        }
        sendBytes(request, response, bytes, pathType(path), { 'Cache-Control': 'no-cache' });
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
