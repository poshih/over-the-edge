// Where phantoms are kept: the game's backend. A release hands it the player's recordings and asks it
// for other players' recordings near the player; the backend decides what it keeps and whom it shows
// what. A release validates every recording it receives. See docs/phantoms.md.
import { decodePhantomBatch, isPhantomCourse, PHANTOM_LIMITS } from './phantom-format';
import { PhantomServiceError } from './phantom-service-types';
import type { PhantomService } from './phantom-service-types';

// The largest batch: its count, and each recording's length and bytes.
const BATCH_BYTES = PHANTOM_LIMITS.batch * (PHANTOM_LIMITS.bytes + 5) + 5;

// A batch's bytes, read no further than the largest batch.
async function readBatch(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new PhantomServiceError(response.status, 'The phantom service sent no batch.');
  if (Number(response.headers.get('Content-Length')) > BATCH_BYTES) {
    await response.body.cancel();
    throw new PhantomServiceError(response.status, 'The phantom service sent more than a batch.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      length += next.value.byteLength;
      if (length > BATCH_BYTES) {
        await reader.cancel();
        throw new PhantomServiceError(response.status, 'The phantom service sent more than a batch.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The reference protocol, under `url` (absolute, ending in /):
 *   POST {url}{course}                       the recording's bytes, as application/octet-stream
 *   GET  {url}{course}?x={x}&y={y}&limit={n}  a batch of recordings, as application/octet-stream
 * Requests carry cookies to the same origin only, unless `credentials` says otherwise; `headers` adds
 * the game's own, such as an authorization token, to every request.
 */
export function httpPhantoms(url: string, options: {
  readonly credentials?: RequestCredentials;
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
} = {}): PhantomService {
  const root = new URL(url);
  if (!root.pathname.endsWith('/') || root.search !== '' || root.hash !== '') {
    throw new Error('A phantom service URL must end in / and have no query or fragment.');
  }
  const credentials = options.credentials ?? 'same-origin';
  const endpoint = (course: string): URL => {
    if (!isPhantomCourse(course)) throw new Error('A phantom course is a lowercase hex SHA-256.');
    return new URL(course, root);
  };
  const headers = async (extra: Record<string, string> = {}): Promise<Headers> => {
    const merged = new Headers(options.headers === undefined ? undefined : await options.headers());
    for (const [name, value] of Object.entries(extra)) merged.set(name, value);
    return merged;
  };
  const refused = async (response: Response, action: string): Promise<PhantomServiceError> => {
    await response.body?.cancel();
    return new PhantomServiceError(response.status, `The phantom service ${action} (HTTP ${response.status}).`);
  };
  return {
    async submit(course, recording, signal) {
      const response = await fetch(endpoint(course), {
        method: 'POST', body: recording, credentials, signal,
        headers: await headers({ 'Content-Type': 'application/octet-stream' }),
      });
      if (!response.ok) throw await refused(response, 'refused a recording');
      await response.body?.cancel();
    },
    async nearby(course, query, signal) {
      const target = endpoint(course);
      target.searchParams.set('x', query.x.toFixed(3));
      target.searchParams.set('y', query.y.toFixed(3));
      target.searchParams.set('limit', String(query.limit));
      const response = await fetch(target, { credentials, signal, cache: 'no-store', headers: await headers() });
      if (!response.ok) throw await refused(response, 'refused a request for recordings');
      return decodePhantomBatch(await readBatch(response));
    },
  };
}
