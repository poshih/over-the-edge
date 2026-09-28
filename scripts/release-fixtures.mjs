import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// A written release's content: every file by path, and the parsed manifest.
export async function releaseContent(outDir) {
  const directory = `${outDir}-content`;
  const files = new Map();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.set(relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'), await readFile(join(entry.parentPath, entry.name)));
  }
  const manifests = [...files.keys()].filter(path => path.endsWith('.json'));
  assert.equal(manifests.length, 1, 'A release has exactly one content manifest.');
  return { files, manifestPath: manifests[0], manifest: JSON.parse(files.get(manifests[0]).toString('utf8')) };
}

// Everything the shell ships as code, for checking that no content leaked into it.
export function shellCode(bundle) {
  return (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output)
    .map(file => file.type === 'chunk' ? file.code : String(file.source)).join('\n');
}
