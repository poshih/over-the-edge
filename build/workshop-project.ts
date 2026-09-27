import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Plugin } from 'vite';
import { PROJECT_FILES, projectFileRefs, projectFileType } from '../src/project';
import type { ProjectContent } from '../src/project';
import type { ProjectInput } from './project-release';

const MODULE = 'virtual:workshop-project';
const RESOLVED = `\0${MODULE}`;
const DEV_PATH = '/__workshop-project/';

interface ProjectFile {
  readonly path: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

// The project's files as they are stored in a project directory.
function projectFiles(content: ProjectContent): ProjectFile[] {
  const encoder = new TextEncoder();
  const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
  const files: ProjectFile[] = [{ path: PROJECT_FILES.manifest, type: 'application/json', bytes: json(content.manifest) }];
  for (const ref of projectFileRefs(content.manifest)) {
    const bytes = ref.kind === 'level' ? json(content.level)
      : ref.kind === 'character' ? json(ref.path === PROJECT_FILES.primary ? content.characters.primary : content.characters.alternate)
        : content.files.get(ref.path);
    if (bytes === undefined) throw new Error(`GAME_PROJECT is missing ${ref.path}.`);
    files.push({ path: ref.path, type: projectFileType(ref, content.manifest), bytes });
  }
  return files;
}

/**
 * Publishes GAME_PROJECT with the Workshop: every project file becomes a hashed static asset that
 * the page downloads when it opens the project, so the JavaScript stays small and unchanged files
 * keep their URLs across deployments. `virtual:workshop-project` lists the files with the
 * project's content version, or is null without a project.
 */
export function workshopProject(input: ProjectInput | null): Plugin {
  const files = input === null ? [] : projectFiles(input.content);
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.bytes.byteLength}\0`).update(file.bytes);
  const version = hash.digest('hex');
  let building = false;
  return {
    name: 'workshop-project',
    configResolved(config) { building = config.command === 'build'; },
    resolveId(id) { if (id === MODULE) return RESOLVED; },
    load(id) {
      if (id !== RESOLVED) return;
      if (input === null) return 'export default null;';
      const entries = files.map((file) => {
        const url = building
          ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: basename(file.path), source: file.bytes })}`
          : JSON.stringify(`${DEV_PATH}${version}/${file.path}`);
        return `{path:${JSON.stringify(file.path)},url:${url},bytes:${file.bytes.byteLength}}`;
      });
      return `export default {title:${JSON.stringify(input.content.manifest.title)},version:${JSON.stringify(version)},files:[${entries.join(',')}]};`;
    },
    configureServer(server) {
      if (input === null) return;
      // The development server reads the project once, when it starts.
      const served = new Map(files.map((file) => [`${DEV_PATH}${version}/${file.path}`, file]));
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
