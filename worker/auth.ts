import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { ArtEnvironment } from './environment';
import { HttpError } from './environment';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const loopback = (hostname: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export async function authenticate(request: Request, env: ArtEnvironment): Promise<string> {
  const url = new URL(request.url);
  const local = env.ART_LOCAL === 'true' && loopback(url.hostname);
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('Origin');
    const trustedLocal = local && origin !== null && ['http://localhost:5181', 'http://127.0.0.1:5181',
      'http://localhost:8787', 'http://127.0.0.1:8787'].includes(origin);
    if ((origin !== url.origin && !trustedLocal) || request.headers.get('X-Art-Request') !== '1') {
      throw new HttpError(403, 'Artwork changes require a same-origin editor request.');
    }
  }
  if (local) return 'local-developer';
  if (!env.ACCESS_TEAM_DOMAIN || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) {
    throw new HttpError(503, 'Shared artwork needs Cloudflare Access configuration. See the course artwork setup guide.');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Sign in through Cloudflare Access to use this editor.');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256) {
      throw new HttpError(401, 'The Access identity is missing.');
    }
    return payload.sub;
  } catch (error) {
    if (error instanceof errors.JOSEError) throw new HttpError(401, 'Your editor sign-in expired or is invalid. Sign in again.');
    throw error;
  }
}

async function encryptionKey(env: ArtEnvironment): Promise<CryptoKey> {
  if (!env.ART_KEY_SECRET || !/^[A-Za-z0-9+/]{43}=$/.test(env.ART_KEY_SECRET)) {
    throw new HttpError(503, 'The editor host must configure a 32-byte ART_KEY_SECRET before connecting Tripo.');
  }
  const raw = Uint8Array.from(atob(env.ART_KEY_SECRET), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealKey(value: string, owner: string, env: ArtEnvironment): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner),
  }, await encryptionKey(env), new TextEncoder().encode(value));
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv); packed.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function userKey(owner: string, env: ArtEnvironment): Promise<string> {
  const record = await env.ART_DB.prepare('SELECT credential FROM art_connections WHERE owner = ?').bind(owner)
    .first<{ credential: string }>();
  if (!record) throw new HttpError(409, 'Connect your own Tripo API key before generating artwork.');
  const data = Uint8Array.from(atob(record.credential), (char) => char.charCodeAt(0));
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: data.slice(0, 12), additionalData: new TextEncoder().encode(owner),
    }, await encryptionKey(env), data.slice(12));
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    throw new HttpError(409, 'The saved Tripo connection cannot be decrypted. Reconnect your API key.');
  }
}
