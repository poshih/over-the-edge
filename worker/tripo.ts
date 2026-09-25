import { artRecord } from '../src/art-types';
import { boundedBytes, HttpError } from './environment';

const BASE = 'https://openapi.tripo3d.ai/v3';

export async function tripo(key: string, path: string, body?: object | FormData): Promise<Record<string, unknown>> {
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  if (body !== undefined && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
    throw new HttpError(502, 'Tripo did not respond. A submitted generation may still have spent credits; check the task before trying a new generation.');
  }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 256 * 1024))); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HttpError(502, 'Tripo returned an unreadable response. No generation was retried.');
  }
  const result = artRecord(raw, 'Tripo response');
  if (!response.ok || result.code !== 0) {
    const message = typeof result.message === 'string' ? result.message.slice(0, 300).replaceAll(key, '[redacted]') : 'Request rejected';
    throw new HttpError(response.status === 429 ? 429 : 502, `Tripo ${String(result.code ?? response.status)}: ${message}`);
  }
  return artRecord(result.data, 'Tripo task data');
}

export function providerId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new HttpError(502, `Tripo returned an invalid ${label}.`);
  return value;
}

export async function downloadModel(source: unknown, maximum: number): Promise<ArrayBuffer> {
  if (typeof source !== 'string') throw new HttpError(502, 'Tripo did not return a model download URL.');
  let url: URL;
  try { url = new URL(source); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new HttpError(502, 'Tripo returned an invalid model URL.');
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['tripo3d.ai', 'tripo3d.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      throw new HttpError(502, 'Tripo returned an unrecognized asset host. The host must be reviewed before this asset can be downloaded.');
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location) throw new HttpError(502, 'The Tripo asset redirect has no destination.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new HttpError(502, `The generated model could not be downloaded (${response.status}). Resume this job; do not regenerate.`);
    return boundedBytes(response, maximum);
  }
  throw new HttpError(502, 'The Tripo model download redirected too many times.');
}
