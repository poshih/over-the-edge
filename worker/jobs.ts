import { ART_LIMITS, artName } from '../src/art-types';
import { ModelError } from '../src/model-data';
import { validateContainer } from '../src/visual-model';
import { userKey } from './auth';
import type { ArtEnvironment } from './environment';
import { HttpError } from './environment';
import { saveAsset } from './library';
import { downloadModel, providerId, tripo } from './tripo';

export interface ArtJob {
  id: string;
  owner: string;
  name: string;
  status: string;
  task_id: string | null;
  progress: number;
  asset_id: string | null;
  error: string | null;
  created_at: number;
}

export async function createJob(form: FormData, owner: string, env: ArtEnvironment): Promise<ArtJob> {
  const requestId = form.get('requestId');
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) throw new HttpError(400, 'Invalid generation request ID.');
  const existing = await env.ART_DB.prepare('SELECT * FROM art_jobs WHERE owner = ? AND request_id = ?')
    .bind(owner, requestId).first<ArtJob>();
  if (existing) return existing;
  if (form.get('consent') !== 'true') throw new HttpError(400, 'Confirm spending your Tripo API credits before generating.');
  const name = artName(form.get('name'));
  const prompt = form.get('prompt');
  const kind = form.get('kind');
  const rawSeed = form.get('seed');
  const seed = Number(rawSeed);
  const faces = Number(form.get('faces'));
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > ART_LIMITS.prompt ||
    (kind !== 'texture' && kind !== 'mesh') || typeof rawSeed !== 'string' || !rawSeed.trim() ||
    !Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647 ||
    !Number.isInteger(faces) || faces < 150 || faces > 20_000) throw new HttpError(400, 'Invalid generation prompt, mode, seed, or polygon budget.');
  const guide = form.get('guide');
  let bytes: ArrayBuffer | null = null;
  if (kind === 'texture') {
    if (!(guide instanceof File) || guide.size > ART_LIMITS.bytes) throw new HttpError(400, 'Texture generation requires a bounded GLB shape guide.');
    bytes = await guide.arrayBuffer();
    validateContainer(bytes);
  }
  const key = await userKey(owner, env);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.ART_DB.prepare(`INSERT OR IGNORE INTO art_jobs (id, owner, request_id, name, status, created_at, updated_at)
    SELECT ?, ?, ?, ?, 'submitting', ?, ? WHERE
    (SELECT COUNT(*) FROM art_jobs WHERE owner = ? AND status IN ('submitting', 'queued', 'running', 'saving')) < 4`)
    .bind(id, owner, requestId, name, now, now, owner).run();
  const inserted = await env.ART_DB.prepare('SELECT * FROM art_jobs WHERE owner = ? AND request_id = ?')
    .bind(owner, requestId).first<ArtJob>();
  if (!inserted) throw new HttpError(409, 'You already have four active generations. Wait for one to finish.');
  if (inserted.id !== id) return inserted;
  try {
    let task: Record<string, unknown>;
    if (bytes !== null) {
      const upload = new FormData();
      upload.set('file', new Blob([bytes], { type: 'model/gltf-binary' }), 'terrain-guide.glb');
      const file = await tripo(key, '/files', upload);
      task = await tripo(key, '/models/texture', {
        input: providerId(file.file_token, 'file token'), model: 'v3.0-20250812',
        texture_prompt: { text: prompt.trim() }, texture_seed: seed, texture_quality: 'standard', pbr: true,
      });
    } else {
      task = await tripo(key, '/generation/text-to-model', {
        prompt: prompt.trim(), model: 'P1-20260311', face_limit: faces,
        model_seed: seed, image_seed: seed, texture_seed: seed, texture: true, pbr: true, texture_quality: 'standard',
      });
    }
    const taskId = providerId(task.task_id, 'task ID');
    await env.ART_DB.prepare("UPDATE art_jobs SET task_id = ?, status = 'queued', updated_at = ? WHERE id = ?")
      .bind(taskId, Date.now(), id).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation submission failed.';
    await env.ART_DB.prepare("UPDATE art_jobs SET status = 'attention', error = ?, updated_at = ? WHERE id = ?")
      .bind(`${message} Submission is not retried automatically. Check your Tripo account before generating again.`, Date.now(), id).run();
    if (!(error instanceof HttpError || error instanceof ModelError)) console.error('Tripo submission could not be recorded safely.');
  }
  const job = await env.ART_DB.prepare('SELECT * FROM art_jobs WHERE id = ?').bind(id).first<ArtJob>();
  if (!job) throw new HttpError(500, 'The generation record was lost. Check your Tripo account before generating again.');
  return job;
}

export async function pumpJobs(env: ArtEnvironment, owner?: string): Promise<void> {
  const now = Date.now();
  await env.ART_DB.prepare(`UPDATE art_jobs SET status = 'attention',
    error = 'Submission was interrupted. Check your Tripo account; do not blindly regenerate.'
    WHERE status = 'submitting' AND updated_at < ?`).bind(now - 180_000).run();
  const candidates = await env.ART_DB.prepare(`SELECT * FROM art_jobs
    WHERE status IN ('queued', 'running', 'saving') AND lease_until < ? AND (? IS NULL OR owner = ?)
    ORDER BY updated_at LIMIT 12`).bind(now, owner ?? null, owner ?? null).all<ArtJob>();
  for (const job of candidates.results) {
    const claimed = await env.ART_DB.prepare(`UPDATE art_jobs SET lease_until = ? WHERE id = ? AND lease_until < ?
      AND status IN ('queued', 'running', 'saving') RETURNING id`)
      .bind(Date.now() + 90_000, job.id, now).first();
    if (!claimed) continue;
    try {
      if (job.task_id === null) throw new HttpError(502, 'This generation has no provider task ID. Check your Tripo account.');
      const task = await tripo(await userKey(job.owner, env), `/tasks/${providerId(job.task_id, 'task ID')}`);
      const status = task.status;
      if (status === 'success') {
        await env.ART_DB.prepare("UPDATE art_jobs SET status = 'saving', progress = 100 WHERE id = ?").bind(job.id).run();
        const output = task.output;
        const source = typeof output === 'object' && output !== null ? Reflect.get(output, 'model_url') : undefined;
        const bytes = await downloadModel(source, ART_LIMITS.bytes);
        const asset = await saveAsset(bytes, job.name, job.owner, env);
        await env.ART_DB.prepare("UPDATE art_jobs SET status = 'ready', asset_id = ?, error = NULL WHERE id = ?")
          .bind(asset.id, job.id).run();
      } else if (status === 'queued' || status === 'running') {
        if (now - job.created_at > 15 * 60_000) throw new HttpError(504, 'Generation has taken over 15 minutes. Resume this job later without spending credits again.');
        const progress = typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, Math.round(task.progress))) : 0;
        await env.ART_DB.prepare('UPDATE art_jobs SET status = ?, progress = ?, error = NULL WHERE id = ?')
          .bind(status, progress, job.id).run();
      } else if (['failed', 'cancelled', 'banned', 'expired'].includes(String(status))) {
        throw new HttpError(502, `Tripo task ${String(status)}. Review it in Tripo before choosing a new generation.`);
      } else throw new HttpError(502, 'Tripo returned an unsupported task status. Resume this job after checking the provider.');
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof ModelError || error instanceof TypeError || error instanceof DOMException;
      if (!expected) console.error('Shared artwork job processing failed.');
      await env.ART_DB.prepare("UPDATE art_jobs SET status = 'attention', error = ? WHERE id = ?")
        .bind(expected && error instanceof Error ? error.message : 'The asset could not be saved. Resume this job; do not regenerate.', job.id).run();
    } finally {
      await env.ART_DB.prepare('UPDATE art_jobs SET lease_until = 0, updated_at = ? WHERE id = ?').bind(Date.now(), job.id).run();
    }
  }
}
