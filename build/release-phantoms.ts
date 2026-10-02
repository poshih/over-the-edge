import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodePhantom, encodePhantomPack, PHANTOM_LIMITS, PhantomError } from '../src/phantom-format';
import type { PhantomBounds } from '../src/phantom-format';

// A project folder's phantom recordings, filed by course: phantoms/<course>/*.phantom.
export const RECORDINGS_FOLDER = 'phantoms';
const EXTENSION = '.phantom';

export const PHANTOM_BUNDLE = {
  // Metres: recordings are packed by the height band their character's path is centred in, so a release loads only
  // the packs around the player.
  band: 10,
  // Recordings kept per band, at most one pack's worth: spread evenly at random, the same in every build.
  perBand: 32,
} as const;
if (PHANTOM_BUNDLE.perBand > PHANTOM_LIMITS.pack) throw new Error('A band\'s recordings must fit in one phantom pack.');

export interface ReleaseRecording {
  readonly bytes: Uint8Array;
  readonly bounds: PhantomBounds;
  // The recording's SHA-256: orders the choice and drops copies.
  readonly hash: string;
}

/**
 * The valid recordings of `course` in `folder`, a folder of recordings by course, in name order; none without the
 * folder or the course's. A file that is not a phantom recording fails the build.
 */
export function loadReleaseRecordings(folder: string | null, course: string): ReleaseRecording[] {
  if (folder === null) return [];
  const directory = join(folder, course);
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(EXTENSION))
      .map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.map((name) => {
    const path = join(directory, name);
    if (statSync(path).size > PHANTOM_LIMITS.bytes) throw new Error(`${path} is larger than a phantom recording may be.`);
    const bytes = new Uint8Array(readFileSync(path));
    try {
      return { bytes, bounds: decodePhantom(bytes).bounds, hash: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error instanceof PhantomError) throw new Error(`${path} is not a phantom recording: ${error.message}`, { cause: error });
      throw error;
    }
  });
}

/**
 * Packs the recordings a release bundles: per height band, up to PHANTOM_BUNDLE.perBand of them, chosen by their
 * hashes so the choice is spread across sessions and stable from build to build. Each pack covers its recordings'
 * bounds; packs come in band order.
 */
export function packReleaseRecordings(recordings: readonly ReleaseRecording[]): { bytes: Uint8Array; bounds: PhantomBounds }[] {
  const bands = new Map<number, Map<string, ReleaseRecording>>();
  for (const recording of recordings) {
    const band = Math.floor((recording.bounds.minY + recording.bounds.maxY) / 2 / PHANTOM_BUNDLE.band);
    let members = bands.get(band);
    if (members === undefined) bands.set(band, members = new Map());
    members.set(recording.hash, recording);
  }
  return [...bands].sort(([a], [b]) => a - b).map(([, members]) => {
    const chosen = [...members.values()].sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0).slice(0, PHANTOM_BUNDLE.perBand);
    const bounds = {
      minX: Math.min(...chosen.map((recording) => recording.bounds.minX)), minY: Math.min(...chosen.map((recording) => recording.bounds.minY)),
      maxX: Math.max(...chosen.map((recording) => recording.bounds.maxX)), maxY: Math.max(...chosen.map((recording) => recording.bounds.maxY)),
    };
    return { bytes: encodePhantomPack(chosen.map((recording) => recording.bytes)), bounds };
  });
}
