import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import {
  appearanceFile, artAssetHashMatches, artFile, isProjectBundle, loadProjectContent, PROJECT_FILES,
  PROJECT_LIMITS, ProjectError, unpackProjectBundle, validateProjectManifest,
} from '../src/project';
import type { ProjectContent } from '../src/project';
import { checkAppearanceModel } from '../src/appearance-model';
import { checkModelLibrary } from '../src/model-library';

function inside(root: string, path: string, label: string): string {
  const real = realpathSync(path);
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`${label} must stay inside ${root}.`);
  return real;
}

function readProjectDirectory(directory: string): { content: ProjectContent; files: string[] } {
  const manifestPath = inside(directory, join(directory, PROJECT_FILES.manifest), 'project.json');
  if (statSync(manifestPath).size > PROJECT_LIMITS.manifestBytes) throw new ProjectError('project.json exceeds its size limit.');
  const files = [manifestPath];
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ProjectError(`project.json is not valid JSON: ${error.message}`);
  }
  const manifest = validateProjectManifest(manifestValue);
  const content = loadProjectContent(manifest, (ref) => {
    let path: string;
    try {
      path = inside(directory, join(directory, ...ref.path.split('/')), ref.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProjectError(`The project is missing ${ref.path}.`, { section: ref.path });
      throw error;
    }
    if (statSync(path).size > ref.maxBytes) throw new ProjectError(`${ref.path} exceeds ${ref.maxBytes / 1024 ** 2} MiB.`, { section: ref.path });
    files.push(path);
    if (ref.binary) return new Uint8Array(readFileSync(path));
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${ref.path} is not valid JSON: ${error.message}`, { section: ref.path });
    }
  });
  return { content, files };
}

// A validated GAME_PROJECT, as the release and the Workshop builds receive it.
export interface ProjectInput {
  readonly content: ProjectContent;
  // Files whose changes should reload a development server.
  readonly files: readonly string[];
}

// Loads GAME_PROJECT (a project directory, its project.json, or a single-file project bundle) with
// every release check; failures name the section.
export function loadProjectInput(root: string, requested: string): ProjectInput {
  let target: string;
  try {
    target = inside(root, join(root, requested), 'GAME_PROJECT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`GAME_PROJECT ${requested} does not exist.`);
    throw error;
  }
  let loaded: { content: ProjectContent; files: string[] };
  try {
    if (statSync(target).isDirectory()) loaded = readProjectDirectory(target);
    else if (basename(target) === PROJECT_FILES.manifest) loaded = readProjectDirectory(dirname(target));
    else {
      if (!target.endsWith('.json') || statSync(target).size > PROJECT_LIMITS.bundleBytes) {
        throw new ProjectError('GAME_PROJECT must be a project directory, its project.json, or a project bundle JSON file.');
      }
      const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
      if (!isProjectBundle(value)) throw new ProjectError('This JSON file is not an over-the-edge project bundle.');
      loaded = { content: unpackProjectBundle(value), files: [target] };
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof SyntaxError) throw new Error(`GAME_PROJECT: ${error.message}`, { cause: error });
    throw error;
  }
  const { content } = loaded;
  const { manifest } = content;
  const binary = projectBinary(content);
  for (const asset of manifest.art.assets) {
    const hash = createHash('sha256').update(binary(artFile(asset.id))).digest('hex');
    if (!artAssetHashMatches(asset.id, hash)) throw new Error(`GAME_PROJECT: course artwork ${asset.id} does not match its content hash.`);
  }
  for (const part of manifest.appearance) {
    const bytes = binary(appearanceFile(part.part));
    try {
      checkAppearanceModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch (error) {
      throw new Error(`GAME_PROJECT: appearance model ${part.name} (${part.part}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  try {
    checkModelLibrary(manifest.models, binary);
  } catch (error) {
    throw new Error(`GAME_PROJECT: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return loaded;
}

function projectBinary(content: ProjectContent): (path: string) => Uint8Array {
  return (path) => {
    const bytes = content.files.get(path);
    if (bytes === undefined) throw new Error(`GAME_PROJECT is missing ${path}.`);
    return bytes;
  };
}
