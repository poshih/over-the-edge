import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { AvatarRigRegistry } from '../src/avatar-rig';
import { ProjectError, validateProjectId } from '../src/project';
import { loadProjectInput } from './project-release';
import { SERVER_SCENES } from './server-scene-paths';
import { workshopFiles } from './workshop-files';
import type { WorkshopFile } from './workshop-files';
import { projectFiles } from './workshop-project';

/** An example scene: a project folder in the scenes folder, named by the folder, with its files as the folder holds them. */
export interface ServerScene {
  readonly name: string;
  readonly title: string;
  readonly files: readonly WorkshopFile[];
}

/**
 * The example scenes: every project folder in the scenes folder, in name order, each checked as a Workshop checks the
 * project it is built with (GAME_PROJECT), so one that fails stops it, naming the scene. None without the folder.
 */
export function loadServerScenes(root: string, registry: AvatarRigRegistry): ServerScene[] {
  let names: string[];
  try {
    names = readdirSync(join(root, SERVER_SCENES), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.map((name) => {
    const label = `${SERVER_SCENES}/${name}`;
    try {
      validateProjectId(name);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      throw new Error(`${label}: name scene folders as project IDs. ${error.message}`, { cause: error });
    }
    const { content } = loadProjectInput(root, label, registry, label);
    return { name, title: content.manifest.title, files: projectFiles(content) };
  });
}

/**
 * Serves the example scenes with the Workshop, and with nothing else; `virtual:workshop-scenes` lists each by its folder
 * name, with its title, a version that changes whenever one of its files does, and its files' sizes and SHA-256.
 */
export function workshopScenes(scenes: readonly ServerScene[]): Plugin {
  const files = scenes.flatMap((scene) => scene.files.map((file): WorkshopFile => ({ ...file, path: `${scene.name}/${file.path}` })));
  const digests = files.map((file) => createHash('sha256').update(file.bytes).digest('hex'));
  return workshopFiles({
    name: 'workshop-scenes', files,
    code: (urls) => {
      let at = 0;
      const listed = scenes.map((scene) => {
        const version = createHash('sha256');
        const entries = scene.files.map((file) => {
          const index = at++;
          version.update(`${file.path}\0${digests[index]}\0`);
          return `{path:${JSON.stringify(file.path)},url:${urls[index]},bytes:${file.bytes.byteLength},sha256:${JSON.stringify(digests[index])}}`;
        });
        return `{name:${JSON.stringify(scene.name)},title:${JSON.stringify(scene.title)},version:${JSON.stringify(version.digest('hex'))},` +
          `files:[${entries.join(',')}]}`;
      });
      return `export default [${listed.join(',')}];`;
    },
  });
}
