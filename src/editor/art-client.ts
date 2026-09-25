import { ArtError, artRecord } from '../art-types';

export async function artRequest(path: string, options: { method?: string; body?: object | FormData; signal?: AbortSignal } = {}): Promise<unknown> {
  const headers = new Headers({ 'X-Art-Request': '1' });
  const body = options.body;
  const multipart = body instanceof FormData;
  if (body && !multipart) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/api/art/${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin', headers, signal: options.signal,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (!(error instanceof TypeError)) throw error;
    throw new ArtError('The shared library could not be reached. A submitted job may still be running; refresh jobs before generating again.');
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new ArtError('The shared library is not available here. Start the local artwork Worker or sign in to the configured Cloudflare editor.');
  }
  let data: unknown;
  try { data = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    throw new ArtError('The shared library response was interrupted or malformed. Refresh jobs before submitting another generation.');
  }
  if (!response.ok) {
    const failure = artRecord(data, 'Artwork error');
    throw new ArtError(typeof failure.error === 'string' ? failure.error : `The shared artwork request failed (${response.status}).`);
  }
  return data;
}
