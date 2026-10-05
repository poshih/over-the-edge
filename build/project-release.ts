import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import {
  appearanceFile, artAssetHashMatches, artFile, isProjectBundle, loadProjectDocuments, loadProjectFiles, openProjectBundle,
  PROJECT_FILES, PROJECT_LIMITS, ProjectError, validateProjectManifest,
} from '../src/project';
import type { ProjectContent, ProjectDocuments, ProjectFileRef } from '../src/project';
import { checkAppearanceModel } from '../src/appearance-model';
import type { AvatarRigRegistry } from '../src/avatar-rig';
import { checkModelLibrary } from '../src/model-library';

function inside(root: string, path: string, label: string): string {
  const real = realpathSync(path);
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`${label} must stay inside ${root}.`);
  return real;
}

// A project's data errors, named as GAME_PROJECT's; anything else is a bug and stays as it is.
function projectFailure(error: unknown): unknown {
  return error instanceof ProjectError || error instanceof SyntaxError ? new Error(`GAME_PROJECT: ${error.message}`, { cause: error }) : error;
}

/** A binary project file a build takes: its bytes, and where it is on disk (null inside a project file). */
export interface TakenFile {
  readonly bytes: Uint8Array;
  readonly path: string | null;
}

/**
 * GAME_PROJECT opened for a build: its documents, validated with every reference, and its binary files, each read only
 * when the build takes it, so a build reads nothing it does not use.
 */
export interface ProjectSource extends ProjectDocuments {
  // The files read to open it, whose changes should reload a development server: project.json and the documents, or
  // the project file.
  readonly files: readonly string[];
  // Reads a binary file the manifest references, held to the ref's limit; a missing or oversized file throws a
  // ProjectError, which the build names.
  take(ref: ProjectFileRef): TakenFile;
}

function openDirectory(directory: string): ProjectSource {
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
  // A referenced file's real path inside the project, no larger than its limit.
  const locate = (ref: ProjectFileRef): string => {
    let path: string;
    try {
      path = inside(directory, join(directory, ...ref.path.split('/')), ref.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProjectError(`The project is missing ${ref.path}.`, { section: ref.path });
      throw error;
    }
    if (statSync(path).size > ref.maxBytes) throw new ProjectError(`${ref.path} exceeds ${ref.maxBytes / 1024 ** 2} MiB.`, { section: ref.path });
    return path;
  };
  const documents = loadProjectDocuments(manifest, (ref) => {
    const path = locate(ref);
    files.push(path);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ProjectError(`${ref.path} is not valid JSON: ${error.message}`, { section: ref.path });
    }
  });
  return {
    ...documents, files,
    take: (ref) => {
      const path = locate(ref);
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.byteLength === 0 || bytes.byteLength > ref.maxBytes) {
        throw new ProjectError(`${ref.path} must contain 1 byte to ${ref.maxBytes / 1024 ** 2} MiB.`, { section: ref.path });
      }
      return { bytes, path };
    },
  };
}

// A project file is one JSON text, read whole; its binary files are decoded and checked only when taken.
function openBundle(target: string): ProjectSource {
  if (statSync(target).size > PROJECT_LIMITS.bundleBytes) {
    throw new ProjectError('GAME_PROJECT must be a project directory, its project.json, or a project bundle JSON file.');
  }
  const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
  if (!isProjectBundle(value)) throw new ProjectError('This JSON file is not an over-the-edge project bundle.');
  const bundle = openProjectBundle(value);
  return {
    manifest: bundle.manifest, level: bundle.level, characters: bundle.characters, files: [target],
    take: (ref) => ({ bytes: bundle.file(ref), path: null }),
  };
}

// Opens GAME_PROJECT (a project directory, its project.json, or a single-file project bundle) and validates its
// documents; failures name the section.
export function openProjectSource(root: string, requested: string): ProjectSource {
  let target: string;
  try {
    target = inside(root, join(root, requested), 'GAME_PROJECT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`GAME_PROJECT ${requested} does not exist.`);
    throw error;
  }
  try {
    if (statSync(target).isDirectory()) return openDirectory(target);
    if (basename(target) === PROJECT_FILES.manifest) return openDirectory(dirname(target));
    if (!target.endsWith('.json')) throw new ProjectError('GAME_PROJECT must be a project directory, its project.json, or a project bundle JSON file.');
    return openBundle(target);
  } catch (error) {
    throw projectFailure(error);
  }
}

// A validated GAME_PROJECT with every file, as the Workshop build publishes it.
export interface ProjectInput {
  readonly content: ProjectContent;
  // Files whose changes should reload a development server.
  readonly files: readonly string[];
}

// Loads all of GAME_PROJECT with every project check, for the Workshop, which edits all of it; failures name the
// section. A game build takes only what the game uses, through openProjectSource.
export function loadProjectInput(root: string, requested: string, avatarRigs: AvatarRigRegistry): ProjectInput {
  const source = openProjectSource(root, requested);
  const files = [...source.files];
  let content: ProjectContent;
  try {
    content = loadProjectFiles(source, (ref) => {
      const taken = source.take(ref);
      if (taken.path !== null) files.push(taken.path);
      return taken.bytes;
    });
  } catch (error) {
    throw projectFailure(error);
  }
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
    checkModelLibrary(manifest.models, binary, avatarRigs);
  } catch (error) {
    throw new Error(`GAME_PROJECT: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return { content, files };
}

function projectBinary(content: ProjectContent): (path: string) => Uint8Array {
  return (path) => {
    const bytes = content.files.get(path);
    if (bytes === undefined) throw new Error(`GAME_PROJECT is missing ${path}.`);
    return bytes;
  };
}
