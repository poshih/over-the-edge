import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { PROJECT_FILES, projectFileRefs, projectFileType } from '../src/project';
import type { ProjectContent } from '../src/project';
import type { ProjectInput } from './project-release';
import { workshopFiles } from './workshop-files';
import type { WorkshopFile } from './workshop-files';

// The project's files as they are stored in a project directory.
function projectFiles(content: ProjectContent): WorkshopFile[] {
  const encoder = new TextEncoder();
  const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
  const files: WorkshopFile[] = [{ path: PROJECT_FILES.manifest, type: 'application/json', bytes: json(content.manifest) }];
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
 * Publishes GAME_PROJECT with the Workshop: the page downloads each of the project's files when it uses it.
 * `virtual:workshop-project` lists the files, each with its size and SHA-256, and the project's content version, or is
 * null without a project.
 */
export function workshopProject(input: ProjectInput | null): Plugin {
  const files = input === null ? [] : projectFiles(input.content);
  const digests = files.map((file) => createHash('sha256').update(file.bytes).digest('hex'));
  return workshopFiles({
    name: 'workshop-project', files,
    code: (urls, version) => input === null ? 'export default null;'
      : `export default {title:${JSON.stringify(input.content.manifest.title)},version:${JSON.stringify(version)},files:[${files.map((file, index) =>
        `{path:${JSON.stringify(file.path)},url:${urls[index]},bytes:${file.bytes.byteLength},sha256:${JSON.stringify(digests[index])}}`).join(',')}]};`,
  });
}
