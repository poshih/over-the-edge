import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectError } from '../src/project';
import { isSharedName, SHARED_EXTENSION, validateSharedName } from '../src/shared-copies';
import type { SharedCopySummary, SharedKind } from '../src/shared-copies';
import { atomicWrite, missing } from './files';
import { HttpError } from './http';

/**
 * The shared folders of the repository at `root`, one per kind (see src/shared-copies.ts). A copy is one JSON file
 * named by the copy, replaced whole, so readers never see half of it. Other files in the folders are left alone.
 */
export class SharedStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  path(kind: SharedKind, name: string): string {
    try {
      return join(this.root, kind, `${validateSharedName(name)}${SHARED_EXTENSION}`);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      throw new HttpError(400, 'invalid-name', error.message);
    }
  }

  // The copies of `kind`, by name.
  async list(kind: SharedKind): Promise<SharedCopySummary[]> {
    let names: string[];
    try {
      names = (await readdir(join(this.root, kind), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(SHARED_EXTENSION))
        .map((entry) => entry.name.slice(0, -SHARED_EXTENSION.length)).filter(isSharedName).sort();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const copies: SharedCopySummary[] = [];
    for (const name of names) {
      try {
        copies.push(summary(name, await stat(join(this.root, kind, `${name}${SHARED_EXTENSION}`))));
      } catch (error) {
        // Deleted while listing.
        if (!missing(error)) throw error;
      }
    }
    return copies;
  }

  // The size of a stored copy; fails when there is none.
  async size(kind: SharedKind, name: string): Promise<number> {
    try {
      return (await stat(this.path(kind, name))).size;
    } catch (error) {
      if (missing(error)) throw notFound(kind, name);
      throw error;
    }
  }

  // Stores a copy, replacing any copy with that name.
  async write(kind: SharedKind, name: string, text: string): Promise<SharedCopySummary> {
    const path = this.path(kind, name);
    await atomicWrite(path, text);
    return summary(name, await stat(path));
  }

  async remove(kind: SharedKind, name: string): Promise<void> {
    try {
      await rm(this.path(kind, name));
    } catch (error) {
      if (missing(error)) throw notFound(kind, name);
      throw error;
    }
  }
}

function summary(name: string, file: { readonly size: number; readonly mtime: Date }): SharedCopySummary {
  return { name, bytes: file.size, updatedAt: file.mtime.toISOString() };
}

function notFound(kind: SharedKind, name: string): HttpError {
  return new HttpError(404, 'not-found', `The server has no ${kind}/${name}${SHARED_EXTENSION}.`);
}
