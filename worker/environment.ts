export interface ArtEnvironment {
  ASSETS: Fetcher;
  ART_DB: D1Database;
  ART_FILES: R2Bucket;
  ART_KEY_SECRET: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ART_LOCAL?: string;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function boundedBytes(source: Request | Response, maximum: number): Promise<ArrayBuffer> {
  if (Number(source.headers.get('Content-Length')) > maximum) throw new HttpError(413, 'The asset or request exceeds the size limit.');
  if (source.body === null) throw new HttpError(400, 'The request or asset has no body.');
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new HttpError(413, 'The asset or request exceeds the size limit.');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data.buffer;
}
