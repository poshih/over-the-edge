import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TakenFile } from './project-release';

/**
 * A file a release packages: its bytes, or a file on disk the build already checked and named by its SHA-256, which it
 * reads again only to write or serve it, so a build holds at most one project file at a time.
 */
export type ReleaseFile = Uint8Array | { readonly path: string; readonly bytes: number; readonly sha256: string };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// How a release packages a file it has checked: a file on disk is copied when the release is written, so its bytes
// can go now.
export function releaseFile(taken: TakenFile): ReleaseFile {
  return taken.path === null ? taken.bytes : { path: taken.path, bytes: taken.bytes.byteLength, sha256: sha256Hex(taken.bytes) };
}

export function releaseFileSize(file: ReleaseFile): number {
  return file instanceof Uint8Array ? file.byteLength : file.bytes;
}

export function releaseFileDigest(file: ReleaseFile): string {
  return file instanceof Uint8Array ? sha256Hex(file) : file.sha256;
}

// A file's bytes; one on disk is read again and refused if it changed since the build checked it.
export function readReleaseFile(file: ReleaseFile): Uint8Array {
  if (file instanceof Uint8Array) return file;
  const bytes = new Uint8Array(readFileSync(file.path));
  if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
    throw new Error(`${file.path} changed while the release was built; build it again.`);
  }
  return bytes;
}
