import { createHash } from 'node:crypto';
import type { LevelDefinition } from '../src/level';
import { phantomLayout } from '../src/phantom-layout';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// A level version's identity: the SHA-256 of its validated definition's JSON.
export function levelContentHash(level: LevelDefinition): string {
  return sha256(JSON.stringify(level));
}

// The phantom course a level's recordings belong to: the SHA-256 of its play layout (src/phantom-layout.ts), so
// every version with the same layout shares its recordings.
export function levelCourse(level: LevelDefinition): string {
  return sha256(phantomLayout(level));
}
