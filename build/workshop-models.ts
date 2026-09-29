import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { inspectCharacterModel } from '../src/character-model-inspect';
import { CharacterModelError } from '../src/character-profile';
import { MODEL_LIMITS, ModelError } from '../src/model-data';
import { PART_ROLES } from '../src/model-library';
import type { PartRole } from '../src/model-library';
import { sendBytes, sendFile } from '../server/http';
import { contentDirectory, contentRequest, notFound } from './release';

/** The folder, relative to the repository root, whose GLBs a Workshop offers: `models/<part>/<name>.glb`. */
export const SERVER_MODELS = 'models';
const MODEL_TYPE = 'model/gltf-binary';
// Where a server model is under the Workshop's content URL: named by its SHA-256.
const MODEL_PATH = /^models\/[0-9a-f]{64}\.glb$/;

export interface ServerModelFile {
  readonly role: PartRole;
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * The server models: every `.glb` in the avatar, hammer and pot folders of the models folder, in name
 * order, each checked like a GLB imported for that part. None without the folder.
 */
export function loadServerModels(root: string): ServerModelFile[] {
  const models: ServerModelFile[] = [];
  for (const role of PART_ROLES) {
    const directory = join(root, SERVER_MODELS, role);
    let names: string[];
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.glb$/i.test(entry.name)).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      const file = `${SERVER_MODELS}/${role}/${name}`;
      const path = join(directory, name);
      if (statSync(path).size > MODEL_LIMITS.bytes) throw new Error(`${file} exceeds ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
      const bytes = new Uint8Array(readFileSync(path));
      try {
        inspectCharacterModel(bytes.buffer, role);
      } catch (error) {
        if (error instanceof CharacterModelError || error instanceof ModelError) throw new Error(`${file}: ${error.message}`, { cause: error });
        throw error;
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      models.push({ role, name: name.replace(/\.glb$/i, ''), path: `models/${sha256}.glb`, sha256, bytes });
    }
  }
  return models;
}

/**
 * Offers the server models in the Workshop. `virtual:workshop-models` lists each model's part, name,
 * size and SHA-256, and where it is under the content URL; the page downloads a model only when one is
 * chosen. A build writes the models, named by their SHA-256, to the content directory beside its
 * output (dist-content/ for dist/) for a CDN; the development and preview servers serve them at the
 * default content URL.
 */
export function workshopModels(options: { readonly models: readonly ServerModelFile[]; readonly contentUrl: string }): Plugin {
  const module = 'virtual:workshop-models';
  const resolved = `\0${module}`;
  const served = new Map(options.models.map((model) => [model.path, model]));
  return {
    name: 'workshop-models',
    resolveId(id) { if (id === module) return resolved; },
    load(id) {
      if (id !== resolved) return;
      const models = options.models.map(({ role, name, path, sha256, bytes }) => ({ role, name, path, sha256, bytes: bytes.byteLength }));
      return `export default ${JSON.stringify({ contentUrl: options.contentUrl, models })};`;
    },
    writeBundle(output) {
      if (output.dir === undefined) return;
      const directory = contentDirectory(output.dir);
      rmSync(directory, { recursive: true, force: true });
      for (const model of options.models) {
        const file = join(directory, ...model.path.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, model.bytes);
      }
    },
    configureServer(server) {
      if (served.size === 0) return;
      // The development server reads the models once, when it starts.
      server.middlewares.use((request, response, next) => {
        const path = contentRequest(request, server.config.base);
        if (path === null) {
          next();
          return;
        }
        const model = served.get(path);
        if (model === undefined) notFound(response);
        else sendBytes(request, response, model.bytes, MODEL_TYPE, { 'Cache-Control': 'no-cache' });
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
        const file = MODEL_PATH.test(path) ? join(directory, ...path.split('/')) : null;
        if (file === null || !existsSync(file) || !statSync(file).isFile()) notFound(response);
        else sendFile(request, response, file, MODEL_TYPE, { 'Cache-Control': 'public, max-age=31536000, immutable' });
      });
    },
  };
}
