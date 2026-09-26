import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly section: string | null;

  constructor(status: number, code: string, message: string, options: { section?: string | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = status;
    this.code = code;
    this.section = options.section ?? null;
  }
}

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } as const;

export function mediaTypeOf(request: IncomingMessage): string {
  return (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpError(413, 'too-large', `The request body exceeds ${formatBytes(limit)}.`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    if (bytes > limit) {
      request.resume();
      throw new HttpError(413, 'too-large', `The request body exceeds ${formatBytes(limit)}.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

export async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (mediaTypeOf(request) !== 'application/json') {
    throw new HttpError(415, 'unsupported-media-type', 'Send JSON bodies with Content-Type: application/json.');
  }
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HttpError(400, 'malformed-json', `The request body is not valid JSON: ${error.message}`);
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = value === undefined ? '' : JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)), ...headers,
  });
  response.end(body);
}

export function sendError(response: ServerResponse, error: HttpError): void {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  sendJson(response, error.status, { error: { code: error.code, message: error.message, section: error.section } });
}

// Sends a file with single-range support, so media elements can seek.
export function sendFile(request: IncomingMessage, response: ServerResponse, path: string, type: string, headers: Record<string, string> = {}): void {
  const size = statSync(path).size;
  const common = { ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', ...headers };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range !== null && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(size - 1, Number(range[2]));
    if (start > end || start >= size) {
      response.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, { ...common, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    if (request.method === 'HEAD') response.end();
    else pipeline(createReadStream(path, { start, end }), response, () => {});
    return;
  }
  response.writeHead(200, { ...common, 'Content-Length': String(size) });
  if (request.method === 'HEAD') response.end();
  // pipeline closes the file when the client aborts (media seeking does this constantly).
  else pipeline(createReadStream(path), response, () => {});
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}
