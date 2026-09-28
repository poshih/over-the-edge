// The grammar of packaged release content: groups, file paths and content: sources. Dependency-free,
// so profile validators can accept packaged sources without importing the release manifest.
export const CONTENT_REF_PREFIX = 'content:';
export const CONTENT_EXTENSIONS = ['json', 'png', 'glb', 'webm', 'mp4', 'mp3', 'ogg', 'wav', 'm4a'] as const;
export type ContentExtension = (typeof CONTENT_EXTENSIONS)[number];
export const CONTENT_GROUP_LIMIT = 128;

const SEGMENT = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
const GROUP = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,3}$`);
const PATH = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,3}/[0-9a-f]{64}\\.(?:${CONTENT_EXTENSIONS.join('|')})$`);

export function isContentGroup(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CONTENT_GROUP_LIMIT && GROUP.test(value);
}

// <group>/<sha256>.<extension>: a file named by its bytes.
export function isContentPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CONTENT_GROUP_LIMIT + 70 && PATH.test(value);
}

// Whether a source is meant as packaged content; isPackagedSource() also checks its path.
export function isContentRef(source: string): boolean {
  return source.startsWith(CONTENT_REF_PREFIX);
}

export function isPackagedSource(source: string): boolean {
  return isContentRef(source) && isContentPath(source.slice(CONTENT_REF_PREFIX.length));
}

// Loads a packaged source's verified bytes; the release answers through its content access.
export type ContentLoader = (source: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;

export function pathGroup(path: string): string { return path.slice(0, path.lastIndexOf('/')); }
export function pathHash(path: string): string { return path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.')); }
export function pathExtension(path: string): ContentExtension { return path.slice(path.lastIndexOf('.') + 1) as ContentExtension; }
