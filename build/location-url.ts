// A location a build's page requests files from: an HTTP(S) URL or a path relative to the page,
// ending in /, without credentials, query or fragment. Returns the value as configured.
export function locationUrl(variable: string, value: string): string {
  let url: URL | null = null;
  try { url = new URL(value, 'https://page.invalid/game/'); } catch { url = null; }
  if (url === null || !value.endsWith('/') || /[\s\\]/.test(value) || !['https:', 'http:'].includes(url.protocol) ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${variable} must be an HTTP(S) URL or a relative path ending in /, without credentials, query or fragment.`);
  }
  return value;
}
