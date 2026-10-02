import { createHash } from 'node:crypto';
import { appendFile, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { levelCourse } from '../build/level-hash';
import { RECORDINGS_FOLDER } from '../build/release-phantoms';
import type { LevelDefinition } from '../src/level';
import { decodePhantom, isPhantomCourse, PhantomError } from '../src/phantom-format';
import { atomicWrite, missing } from './files';
import { HttpError } from './http';

// A project's level history, kept in its folder beside the project's files and outliving them: every saved version
// of the level, and the phantom recordings made while playing one. See docs/projects.md.
//
//   level-versions/index.jsonl        one LevelVersion per line, oldest first
//   level-versions/<content>.json.gz  each distinct level, as its compact JSON
//   phantoms/<course>/v<version>-<session>-<clip>.phantom
//
// Recordings are filed by course, the SHA-256 of the level's play layout, so every version that plays the same keeps
// them together: a release bundles the recordings of its level's course.
export const LEVEL_HISTORY_FOLDERS = ['level-versions', RECORDINGS_FOLDER] as const;

export interface LevelVersion {
  readonly version: number;
  // The SHA-256 of the level's compact JSON, which names its stored copy.
  readonly content: string;
  readonly course: string;
  readonly savedAt: string;
}

// A recording as listed: its file name and size.
export interface PhantomRecording {
  readonly name: string;
  readonly bytes: number;
}

const INDEX = 'index.jsonl';
// The end of the index read for its newest versions, about 40 lines.
const TAIL_BYTES = 8192;
const SHA256 = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{32}$/;
const RECORDING = /^v([1-9][0-9]{0,8})-([0-9a-f]{32})-(0|[1-9][0-9]{0,5})\.phantom$/;
export const RECORDING_LIMITS = { clip: 999_999 } as const;

const gzipped = promisify(gzip);
const gunzipped = promisify(gunzip);

function versions(directory: string): string {
  return join(directory, LEVEL_HISTORY_FOLDERS[0]);
}

function courseFolder(directory: string, course: string): string {
  if (!isPhantomCourse(course)) throw new Error(`Invalid phantom course ${course}.`);
  return join(directory, LEVEL_HISTORY_FOLDERS[1], course);
}

function parseVersion(line: string): LevelVersion | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { version, content, course, savedAt } = value as Record<string, unknown>;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || typeof content !== 'string' || !SHA256.test(content) ||
    typeof course !== 'string' || !isPhantomCourse(course) || typeof savedAt !== 'string') return null;
  return { version, content, course, savedAt };
}

function parseVersions(lines: readonly string[]): LevelVersion[] {
  return lines.flatMap((line) => {
    const version = line.trim() === '' ? null : parseVersion(line);
    return version === null ? [] : [version];
  });
}

// Every version, oldest first. A line cut short by a crash, or edited into nonsense, is skipped.
export async function listLevelVersions(directory: string): Promise<LevelVersion[]> {
  let text: string;
  try {
    text = await readFile(join(versions(directory), INDEX), 'utf8');
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  return parseVersions(text.split('\n'));
}

// The newest versions, from the end of the index: whether they are all of them, and whether the index ends mid-line.
async function newest(directory: string): Promise<{ versions: LevelVersion[]; whole: boolean; unterminated: boolean }> {
  let handle;
  try {
    handle = await open(join(versions(directory), INDEX), 'r');
  } catch (error) {
    if (missing(error)) return { versions: [], whole: true, unterminated: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    // A read that starts inside the index may start inside a line.
    if (length < size) lines.shift();
    return { versions: parseVersions(lines), whole: length === size, unterminated: size > 0 && !text.endsWith('\n') };
  } finally {
    await handle.close();
  }
}

// A version by number. Recent versions, which nearly every request names, come from the end of the index.
export async function findLevelVersion(directory: string, version: number): Promise<LevelVersion> {
  const recent = await newest(directory);
  const match = (entry: LevelVersion): boolean => entry.version === version;
  const found = recent.versions.findLast(match) ?? (recent.whole ? undefined : (await listLevelVersions(directory)).findLast(match));
  if (found === undefined) throw new HttpError(404, 'not-found', `Level version ${version} does not exist.`, { section: 'level' });
  return found;
}

/**
 * The version of `level`, a validated level just stored as the project's: the latest version when that holds the same
 * level and course, otherwise a new one. Callers hold the project's lock.
 */
export async function recordLevelVersion(directory: string, level: LevelDefinition): Promise<LevelVersion> {
  const text = JSON.stringify(level);
  const content = createHash('sha256').update(text).digest('hex');
  // Computed every time: a new play layout format gives the same level a new course.
  const course = levelCourse(level);
  const recent = await newest(directory);
  const previous = recent.versions.at(-1) ?? (recent.whole ? null : (await listLevelVersions(directory)).at(-1) ?? null);
  if (previous?.content === content && previous.course === course) return previous;
  const copy = join(versions(directory), `${content}.json.gz`);
  const stored = await stat(copy).then(() => true, (error: unknown) => { if (missing(error)) return false; throw error; });
  if (!stored) await atomicWrite(copy, await gzipped(text));
  const next: LevelVersion = { version: (previous?.version ?? 0) + 1, content, course, savedAt: new Date().toISOString() };
  await appendFile(join(versions(directory), INDEX), `${recent.unterminated ? '\n' : ''}${JSON.stringify(next)}\n`);
  return next;
}

// A version's level as its compact JSON.
export async function readLevelVersion(directory: string, version: LevelVersion): Promise<Buffer> {
  try {
    return await gunzipped(await readFile(join(versions(directory), `${version.content}.json.gz`)));
  } catch (error) {
    if (missing(error)) throw new HttpError(404, 'not-found', `The level of version ${version.version} is no longer stored.`, { section: 'level' });
    throw error;
  }
}

export function recordingName(version: number, session: string, clip: number): string {
  if (!SESSION.test(session)) throw new HttpError(400, 'invalid', 'A recording session is 32 lowercase hexadecimal digits.');
  if (!Number.isSafeInteger(clip) || clip < 0 || clip > RECORDING_LIMITS.clip) {
    throw new HttpError(400, 'invalid', `A recording's clip is a whole number from 0 to ${RECORDING_LIMITS.clip}.`);
  }
  return `v${version}-${session}-${clip}.phantom`;
}

function recordingVersion(name: string): number | null {
  const match = RECORDING.exec(name);
  return match === null ? null : Number(match[1]);
}

// Stores a recording made on `version`, replacing one sent before under the same name. Invalid recordings fail.
export async function addRecording(directory: string, version: LevelVersion, name: string, bytes: Uint8Array): Promise<void> {
  try {
    decodePhantom(bytes);
  } catch (error) {
    if (!(error instanceof PhantomError)) throw error;
    throw new HttpError(400, 'invalid', `Not a phantom recording: ${error.message}`);
  }
  await atomicWrite(join(courseFolder(directory, version.course), name), bytes);
}

// The recording file names in a course's folder, in name order.
async function courseNames(directory: string, course: string): Promise<string[]> {
  try {
    return (await readdir(courseFolder(directory, course))).filter((name) => recordingVersion(name) !== null).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

export async function listRecordings(directory: string, version: LevelVersion): Promise<PhantomRecording[]> {
  const folder = courseFolder(directory, version.course);
  const recordings: PhantomRecording[] = [];
  for (const name of await courseNames(directory, version.course)) {
    if (recordingVersion(name) !== version.version) continue;
    const file = await stat(join(folder, name)).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (file?.isFile()) recordings.push({ name, bytes: file.size });
  }
  return recordings;
}

// How many recordings each version has, reading each course's folder once.
export async function countRecordings(directory: string, list: readonly LevelVersion[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const course of new Set(list.map((entry) => entry.course))) {
    for (const name of await courseNames(directory, course)) {
      const version = recordingVersion(name)!;
      counts.set(version, (counts.get(version) ?? 0) + 1);
    }
  }
  return counts;
}

function recordingPath(directory: string, version: LevelVersion, name: string): string {
  if (recordingVersion(name) !== version.version) throw new HttpError(404, 'not-found', `Version ${version.version} has no recording ${name}.`);
  return join(courseFolder(directory, version.course), name);
}

export async function readRecording(directory: string, version: LevelVersion, name: string): Promise<Buffer> {
  try {
    return await readFile(recordingPath(directory, version, name));
  } catch (error) {
    if (missing(error)) throw new HttpError(404, 'not-found', `Version ${version.version} has no recording ${name}.`);
    throw error;
  }
}

export async function removeRecording(directory: string, version: LevelVersion, name: string): Promise<void> {
  const path = recordingPath(directory, version, name);
  const found = await stat(path).then(() => true, (error: unknown) => { if (missing(error)) return false; throw error; });
  if (!found) throw new HttpError(404, 'not-found', `Version ${version.version} has no recording ${name}.`);
  await rm(path, { force: true });
}
