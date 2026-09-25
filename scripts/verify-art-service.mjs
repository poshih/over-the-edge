import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { getPlatformProxy } from 'wrangler';
import { createServer } from 'vite';
import { modelFixture } from './verify-appearance.mjs';

export async function verifyArtService(directory) {
  const proxy = await getPlatformProxy({
    configPath: 'wrangler.local.toml', persist: { path: `${directory}/worker-state` },
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: 'silent' });
  const originalFetch = globalThis.fetch;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'art-proof', alg: 'RS256', use: 'sig' };
  const issuer = 'https://art-proof.cloudflareaccess.com';
  const origin = 'https://editor.example.test';
  const token = owner => new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setSubject(owner).setIssuer(issuer).setAudience('art-proof-audience').setExpirationTime('5m').sign(privateKey);
  const alice = await token('alice'), bob = await token('bob');
  const fixture = modelFixture({ textured: true });
  let creates = 0, uploads = 0, downloads = 0;
  let output = 'https://cdn.tripo3d.ai/proof.glb';
  const providerRequests = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.hostname === 'openapi.tripo3d.ai') {
      assert.match(request.headers.get('Authorization'), /^Bearer tsk-proof-/);
      providerRequests.push({ path: url.pathname, method: request.method });
      if (url.pathname === '/v3/account/balance') return Response.json({ code: 0, data: { balance: 500, frozen: 0 } });
      if (url.pathname === '/v3/files') {
        uploads++;
        const file = (await request.formData()).get('file');
        assert.ok(file instanceof File);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), fixture);
        return Response.json({ code: 0, data: { file_token: 'file_proof' } });
      }
      if (['/v3/models/texture', '/v3/generation/text-to-model'].includes(url.pathname)) {
        const data = await request.json();
        assert.equal(data.pbr, true);
        if (url.pathname.endsWith('/texture')) {
          assert.equal(data.input, 'file_proof');
          assert.equal(data.texture_prompt.text, 'Weathered stone');
        } else {
          assert.equal(data.model, 'P1-20260311');
          assert.equal(data.face_limit, 3000);
        }
        creates++;
        return Response.json({ code: 0, data: { task_id: `task_proof_${creates}` } });
      }
      if (/^\/v3\/tasks\/task_proof_\d+$/.test(url.pathname)) {
        return Response.json({ code: 0, data: { status: 'success', progress: 100, output: { model_url: output } } });
      }
    }
    if (url.href === 'https://cdn.tripo3d.ai/proof.glb') {
      assert.equal(request.headers.get('Authorization'), null, 'Never forward API keys to model storage.');
      downloads++;
      return new Response(fixture, { headers: { 'Content-Type': 'model/gltf-binary' } });
    }
    throw new Error(`Unexpected outbound request in artwork proof: ${url.origin}${url.pathname}`);
  };
  try {
    const sql = await readFile(new URL('../worker/migrations/0001_shared_art.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await proxy.env.ART_DB.prepare(statement).run();
    const module = await server.ssrLoadModule('/worker/index.ts');
    const env = {
      ...proxy.env, ART_LOCAL: undefined, ACCESS_TEAM_DOMAIN: 'art-proof.cloudflareaccess.com',
      ACCESS_AUD: 'art-proof-audience', ART_KEY_SECRET: randomBytes(32).toString('base64'),
    };
    async function call(path, { method = 'GET', body, identity = alice, headers = {} } = {}) {
      const pending = [];
      const requestHeaders = new Headers({ Origin: origin, 'X-Art-Request': '1', ...headers });
      if (identity !== null) requestHeaders.set('Cf-Access-Jwt-Assertion', identity);
      if (body && !(body instanceof FormData)) requestHeaders.set('Content-Type', 'application/json');
      const request = new Request(`${origin}/api/art/${path}`, {
        method, headers: requestHeaders, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
      const response = await module.default.fetch(request, env, { waitUntil: promise => pending.push(promise) });
      await Promise.all(pending);
      return response;
    }
    assert.equal((await call('session', { identity: null })).status, 401);
    assert.equal((await call('connection', { method: 'PUT', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
    const connection = await call('connection', { method: 'PUT', body: { apiKey: 'tsk-proof-alice-123456789' } });
    assert.equal(connection.status, 200);
    assert.equal((await connection.json()).balance, 500);
    const stored = await env.ART_DB.prepare('SELECT credential FROM art_connections WHERE owner = ?').bind('alice').first();
    assert.ok(stored.credential && !stored.credential.includes('tsk-proof'), 'Credentials must be encrypted at rest.');
    assert.equal((await call('session', { identity: bob }).then(response => response.json())).connected, false);
    const form = (id, kind = 'texture') => {
      const data = new FormData();
      for (const [key, value] of Object.entries({
        requestId: id, consent: 'true', name: 'Shared stone', prompt: 'Weathered stone', kind, seed: '1', faces: '3000',
      })) data.set(key, value);
      if (kind === 'texture') data.set('guide', new Blob([fixture], { type: 'model/gltf-binary' }), 'guide.glb');
      return data;
    };
    const requestId = crypto.randomUUID();
    const unapproved = form(requestId); unapproved.set('consent', 'false');
    assert.equal((await call('jobs', { method: 'POST', body: unapproved })).status, 400);
    assert.equal(creates, 0);
    const first = await call('jobs', { method: 'POST', body: form(requestId) });
    assert.equal(first.status, 202);
    const job = await first.json(); assert.equal(job.status, 'queued');
    const duplicate = await call('jobs', { method: 'POST', body: form(requestId) }).then(response => response.json());
    assert.equal(duplicate.id, job.id);
    assert.equal(creates, 1, 'Retrying the same request must not create another paid task.');
    assert.equal(uploads, 1);
    assert.equal((await call('connection', { method: 'DELETE' })).status, 409);
    assert.deepEqual(await call('jobs', { identity: bob }).then(response => response.json()), []);
    await call('jobs');
    const ready = await call('jobs').then(response => response.json());
    assert.equal(ready[0].status, 'ready');
    const library = await call('catalog', { identity: bob }).then(response => response.json());
    assert.equal(library.assets.length, 1, 'Other Access users must see saved shared assets.');
    assert.deepEqual(Buffer.from(await call(`assets/${library.assets[0].id}/model`, { identity: bob }).then(response => response.arrayBuffer())), fixture);
    const variant = {
      id: `variant-${crypto.randomUUID()}`, name: 'Stone stairs', prefab: 'rising-steps', owner: 'alice',
      parts: [{ index: 0, assetId: library.assets[0].id }],
    };
    assert.equal((await call('variants', { method: 'POST', body: variant, identity: bob })).status, 403);
    assert.equal((await call('variants', { method: 'POST', body: variant })).status, 201);
    assert.equal((await call('catalog', { identity: bob }).then(response => response.json())).variants.length, 1);
    output = 'http://127.0.0.1/private';
    const second = await call('jobs', { method: 'POST', body: form(crypto.randomUUID(), 'mesh') }).then(response => response.json());
    await call('jobs');
    const blocked = await call('jobs').then(response => response.json());
    assert.equal(blocked.find(entry => entry.id === second.id).status, 'attention');
    assert.equal(downloads, 1, 'Provider URLs must not turn the Worker into an arbitrary URL proxy.');
    assert.equal((await call(`jobs/${second.id}/resume`, { method: 'POST', body: {}, identity: bob })).status, 409);
    output = 'https://cdn.tripo3d.ai/proof.glb';
    assert.equal((await call(`jobs/${second.id}/resume`, { method: 'POST', body: {} })).status, 200);
    assert.equal(creates, 2, 'Resuming retrieval must never regenerate.');
    assert.equal((await call('catalog').then(response => response.json())).assets.length, 1, 'Identical GLBs are content-deduplicated.');
    const bad = new FormData(); bad.set('name', 'External texture');
    bad.set('file', new Blob([modelFixture({ externalTexture: true })]), 'invalid.glb');
    assert.equal((await call('assets', { method: 'POST', body: bad })).status, 400);
    const largeTexture = Buffer.from(fixture);
    const png = largeTexture.indexOf(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(png > 0);
    largeTexture.writeUInt32BE(4097, png + 16);
    const oversized = new FormData(); oversized.set('name', 'Oversized texture');
    oversized.set('file', new Blob([largeTexture]), 'oversized.glb');
    const rejected = await call('assets', { method: 'POST', body: oversized });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /4096/, 'Reject oversized decoded textures before browser allocation.');
    assert.equal((await call('connection', { method: 'DELETE' })).status, 200);
    assert.equal((await call('session').then(response => response.json())).connected, false);
    return { authentication: true, userIsolation: true, encryptedCredentials: true, idempotentSubmission: true,
      sharedVariants: true, durableDownload: true, blockedAssetHosts: true, textureBudgets: true, providerRequests: providerRequests.length };
  } finally {
    globalThis.fetch = originalFetch;
    await server.close(); await proxy.dispose();
  }
}
