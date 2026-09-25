import { ART_LIMITS, ArtError, artRecord } from '../src/art-types';
import { ModelError } from '../src/model-data';
import { authenticate, sealKey, userKey } from './auth';
import type { ArtEnvironment } from './environment';
import { boundedBytes, HttpError, json } from './environment';
import { createJob, pumpJobs } from './jobs';
import { catalog, saveAsset, saveVariant } from './library';
import { tripo } from './tripo';

async function form(request: Request): Promise<FormData> {
  const data = await boundedBytes(request, ART_LIMITS.bytes + 16 * 1024);
  return new Response(data, { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } }).formData();
}

async function body(request: Request): Promise<unknown> {
  try { return JSON.parse(new TextDecoder().decode(await boundedBytes(request, 64 * 1024))); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HttpError(400, 'The artwork request is not valid JSON.');
  }
}

export async function handleArt(request: Request, env: ArtEnvironment, context: ExecutionContext): Promise<Response> {
  const owner = await authenticate(request, env);
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/art/')) return env.ASSETS.fetch(request);
  if (!env.ART_DB || !env.ART_FILES) throw new HttpError(503, 'The shared library needs D1 and R2 bindings. See the course artwork setup guide.');
  if (path === '/api/art/session' && request.method === 'GET') {
    const connected = await env.ART_DB.prepare('SELECT owner FROM art_connections WHERE owner = ?').bind(owner).first();
    return json({ owner, connected: connected !== null });
  }
  if (path === '/api/art/connection') {
    if (request.method === 'GET') return json(await tripo(await userKey(owner, env), '/account/balance'));
    if (!['PUT', 'DELETE'].includes(request.method)) throw new HttpError(405, 'Unsupported connection operation.');
    const active = await env.ART_DB.prepare(`SELECT id FROM art_jobs WHERE owner = ?
      AND status IN ('submitting', 'queued', 'running', 'saving') LIMIT 1`).bind(owner).first();
    if (active) throw new HttpError(409, 'Wait for active jobs to finish before replacing or disconnecting your Tripo key.');
    if (request.method === 'DELETE') {
      await env.ART_DB.prepare('DELETE FROM art_connections WHERE owner = ?').bind(owner).run();
      return json({ connected: false });
    }
    const data = artRecord(await body(request), 'Connection');
    const key = data.apiKey;
    if (typeof key !== 'string' || key.length < 16 || key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new HttpError(400, 'Enter a valid Tripo API key.');
    }
    const balance = await tripo(key, '/account/balance');
    const encrypted = await sealKey(key, owner, env);
    await env.ART_DB.prepare('INSERT OR REPLACE INTO art_connections (owner, credential, updated_at) VALUES (?, ?, ?)')
      .bind(owner, encrypted, Date.now()).run();
    return json({ connected: true, balance: balance.balance, frozen: balance.frozen });
  }
  if (path === '/api/art/catalog' && request.method === 'GET') return json(await catalog(env));
  if (path === '/api/art/assets' && request.method === 'POST') {
    const data = await form(request);
    const file = data.get('file');
    if (!(file instanceof File)) throw new HttpError(400, 'Choose a self-contained GLB file.');
    const name = data.get('name');
    if (typeof name !== 'string') throw new HttpError(400, 'Name the asset before sharing it.');
    return json(await saveAsset(await file.arrayBuffer(), name, owner, env), 201);
  }
  const assetMatch = /^\/api\/art\/assets\/(asset-[a-f0-9]{64})\/model$/.exec(path);
  if (assetMatch && request.method === 'GET') {
    const record = await env.ART_DB.prepare('SELECT id FROM art_assets WHERE id = ?').bind(assetMatch[1]).first();
    const asset = record && await env.ART_FILES.get(`assets/${assetMatch[1]}.glb`);
    if (!asset) throw new HttpError(404, 'The shared artwork asset is unavailable.');
    return new Response(asset.body, { headers: {
      'Content-Type': 'model/gltf-binary', 'Content-Length': String(asset.size),
      'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    } });
  }
  if (path === '/api/art/variants' && request.method === 'POST') {
    return json(await saveVariant(await body(request), owner, env), 201);
  }
  if (path === '/api/art/jobs') {
    if (request.method === 'POST') return json(await createJob(await form(request), owner, env), 202);
    if (request.method === 'GET') {
      context.waitUntil(pumpJobs(env, owner));
      const jobs = await env.ART_DB.prepare(`SELECT id, name, status, task_id, progress, asset_id, error, created_at
        FROM art_jobs WHERE owner = ? ORDER BY created_at DESC LIMIT 40`).bind(owner).all();
      return json(jobs.results);
    }
  }
  const resume = /^\/api\/art\/jobs\/([a-f0-9-]{36})\/resume$/.exec(path);
  if (resume && request.method === 'POST') {
    const changed = await env.ART_DB.prepare(`UPDATE art_jobs SET status = 'running', error = NULL, created_at = ?, updated_at = ?
      WHERE id = ? AND owner = ? AND task_id IS NOT NULL AND status = 'attention' RETURNING id`)
      .bind(Date.now(), Date.now(), resume[1], owner).first();
    if (!changed) throw new HttpError(409, 'This job cannot be resumed. Only your own completed submissions can be checked again.');
    context.waitUntil(pumpJobs(env, owner));
    return json({ resumed: true });
  }
  throw new HttpError(404, 'Unknown shared artwork operation.');
}

export default {
  async fetch(request: Request, env: ArtEnvironment, context: ExecutionContext): Promise<Response> {
    try { return await handleArt(request, env, context); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof ArtError || error instanceof ModelError) return json({ error: error.message }, 400);
      console.error('The shared artwork service encountered an unexpected error.');
      return json({ error: 'The shared library is unavailable. Your current course was not changed; ask the host to inspect the Worker logs.' }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: ArtEnvironment): Promise<void> { await pumpJobs(env); },
} satisfies ExportedHandler<ArtEnvironment>;
