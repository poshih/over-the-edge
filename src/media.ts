import { ProjectError } from './project-fields';

// Project media: videos for trigger events and audio for music, cues and sound events. Files are
// addressed by site-relative /media/ paths, exactly as level video events already reference them.
export const MEDIA_TYPES = {
  webm: 'video/webm', mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
} as const;
export type MediaExtension = keyof typeof MEDIA_TYPES;
export const MEDIA_LIMITS = {
  files: 64,
  bytes: 64 * 1024 * 1024,
  totalBytes: 160 * 1024 * 1024,
  name: 80,
  source: 2048,
} as const;

export interface MediaEntry {
  readonly path: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(webm|mp4|mp3|ogg|wav|m4a)$/;

export function mediaPath(value: unknown): string {
  const name = typeof value === 'string' && value.startsWith('/media/') ? value.slice('/media/'.length) : null;
  if (name === null || name.length > MEDIA_LIMITS.name || !NAME.test(name)) {
    throw new ProjectError(`Media paths look like /media/intro.webm: lowercase letters, digits, dots, - and _, at most ${
      MEDIA_LIMITS.name} characters, ending in ${Object.keys(MEDIA_TYPES).map(extension => `.${extension}`).join(', ')}.`);
  }
  return value as string;
}

export function mediaExtension(path: string): MediaExtension {
  return mediaPath(path).slice(path.lastIndexOf('.') + 1) as MediaExtension;
}

export function mediaType(path: string): string {
  return MEDIA_TYPES[mediaExtension(path)];
}

export function mediaKind(path: string): 'video' | 'audio' {
  return mediaType(path).startsWith('video/') ? 'video' : 'audio';
}

// Project file holding a media path's bytes.
export function mediaFile(path: string): string {
  return `media/${mediaPath(path).slice('/media/'.length)}`;
}

// Turns a chosen file name into a valid /media/ path, or null when nothing usable remains.
export function mediaPathForFile(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  const extension = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
  if (!Object.hasOwn(MEDIA_TYPES, extension)) return null;
  const stem = fileName.slice(0, dot).toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.').replace(/^[^a-z0-9]+/, '').replace(/[.-]+$/, '').slice(0, MEDIA_LIMITS.name - extension.length - 1)
    .replace(/[.-]+$/, '');
  const path = `/media/${stem}.${extension}`;
  return stem.length === 0 || !NAME.test(path.slice('/media/'.length)) ? null : path;
}

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean =>
  bytes.length >= offset + text.length && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));

// Checks the file signature so a media path can only ever serve the kind of file it names.
export function checkMediaBytes(path: string, bytes: Uint8Array): void {
  const extension = mediaExtension(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_LIMITS.bytes) {
    throw new ProjectError(`Media file ${path} must contain 1 byte to ${MEDIA_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
  const valid = extension === 'webm' ? bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
    : extension === 'mp4' || extension === 'm4a' ? ascii(bytes, 4, 'ftyp')
      : extension === 'mp3' ? ascii(bytes, 0, 'ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
        : extension === 'ogg' ? ascii(bytes, 0, 'OggS')
          : ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE');
  if (!valid) throw new ProjectError(`Media file ${path} is not a valid .${extension} file.`);
}

// A playable source: a site-relative path (usually /media/...) or a public HTTP(S) URL without credentials.
export function mediaSource(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MEDIA_LIMITS.source || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProjectError(`${label} must be a /media/ path or an HTTP(S) URL.`);
  }
  const source = value.trim();
  let url: URL;
  try {
    url = new URL(source, 'https://media.invalid');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ProjectError(`${label} must be a /media/ path or an HTTP(S) URL.`);
  }
  const local = source.startsWith('/') && !source.startsWith('//') && url.origin === 'https://media.invalid';
  const remote = /^https?:\/\//i.test(source) && (url.protocol === 'https:' || url.protocol === 'http:');
  if ((!local && !remote) || url.username || url.password) {
    throw new ProjectError(`${label} must be a /media/ path or an HTTP(S) URL without credentials.`);
  }
  return source;
}

export function isMediaLibraryPath(source: string): boolean {
  return source.startsWith('/media/');
}
