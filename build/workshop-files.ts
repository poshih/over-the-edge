import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Plugin } from 'vite';

/** A file served next to the Workshop. */
export interface WorkshopFile {
  readonly path: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

/**
 * Serves files next to the Workshop through `virtual:<name>`. A build emits every file as a hashed
 * static asset, so the JavaScript does not grow with them and unchanged files keep their URLs
 * across deployments; the development server serves them under a path versioned by their content.
 * `code` writes the module from each file's URL, given as a JavaScript expression, and the files'
 * content version, which changes whenever any file changes.
 */
export function workshopFiles(options: {
  readonly name: string;
  readonly files: readonly WorkshopFile[];
  readonly code: (urls: readonly string[], version: string) => string;
}): Plugin {
  const module = `virtual:${options.name}`;
  const resolved = `\0${module}`;
  const hash = createHash('sha256');
  for (const file of options.files) hash.update(`${file.path}\0${file.bytes.byteLength}\0`).update(file.bytes);
  const version = hash.digest('hex');
  const development = `/__${options.name}/${version}/`;
  let building = false;
  return {
    name: options.name,
    configResolved(config) { building = config.command === 'build'; },
    resolveId(id) { if (id === module) return resolved; },
    load(id) {
      if (id !== resolved) return;
      const urls = options.files.map((file) => building
        ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: basename(file.path), source: file.bytes })}`
        : JSON.stringify(`${development}${file.path}`));
      return options.code(urls, version);
    },
    configureServer(server) {
      if (options.files.length === 0) return;
      // The development server reads the files once, when it starts.
      const served = new Map(options.files.map((file) => [`${development}${file.path}`, file]));
      server.middlewares.use((request, response, next) => {
        const file = served.get((request.url ?? '').split('?')[0]);
        if (file === undefined) {
          next();
          return;
        }
        response.setHeader('Content-Type', file.type);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(file.bytes);
      });
    },
  };
}
