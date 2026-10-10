import { ArtError } from '../art-types';
import type { MeshTerrain } from '../mesh-collision';
import type { EnemyBake } from '../enemy-model-check';
import type { MeshBakeRequest, MeshBakeResponse } from './mesh-bake-worker';

type Answer = Exclude<MeshBakeResponse, { readonly failure: string }>;

interface Waiting {
  readonly resolve: (answer: Answer) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Bakes in a worker (src/editor/mesh-bake-worker.ts), so a large GLB never holds up the page: course meshes turned about
 * their vertical axis, each GLB sent to the worker once, ahead of the first bake asked of it; and enemy models' clips and
 * root motion.
 */
export class MeshBaker {
  private worker: Worker | null = null;
  // The GLBs sent to the current worker: each settles once its GLB is on its way.
  private delivered = new Map<string, Promise<void>>();
  private readonly waiting = new Map<number, Waiting>();
  private next = 0;
  private disposed = false;
  // Why the last worker failed.
  private failure = 'its worker failed to load';

  // `assetId` turned `turn` radians, reading its GLB with `bytes` when the worker does not hold it yet. Rejects with an
  // ArtError saying what to change when the mesh cannot be baked at that turn.
  bake(assetId: string, bytes: () => Promise<ArrayBuffer>, turn: number): Promise<MeshTerrain> {
    return this.send(assetId, bytes, turn, false);
  }

  // An enemy model's clips and every clip's root motion. Rejects with an ArtError saying what to change when the GLB is
  // not an enemy model.
  bakeEnemy(bytes: ArrayBuffer): Promise<EnemyBake> {
    if (this.disposed) return Promise.reject(new ArtError('The Workshop has closed.'));
    const worker = this.connect();
    const id = ++this.next;
    const answer = new Promise<EnemyBake>((resolve, reject) => this.waiting.set(id, {
      resolve: (response) => { if ('enemy' in response) resolve(response.enemy); else reject(new ArtError('The baker answered another request.')); },
      reject,
    }));
    const request: MeshBakeRequest = { kind: 'enemy', id, bytes };
    worker.postMessage(request, [bytes]);
    return answer;
  }

  forget(assetId: string): void {
    this.delivered.delete(assetId);
    if (this.worker === null) return;
    const request: MeshBakeRequest = { kind: 'forget', assetId };
    this.worker.postMessage(request);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.fail('The Workshop has closed.');
  }

  // A worker that fails while the GLB is on its way is replaced once; a second failure rejects.
  private async send(assetId: string, bytes: () => Promise<ArrayBuffer>, turn: number, retried: boolean): Promise<MeshTerrain> {
    if (this.disposed) throw new ArtError('The Workshop has closed.');
    const worker = this.connect();
    let delivery = this.delivered.get(assetId);
    if (delivery === undefined) {
      const sending = bytes().then((data) => {
        // A worker replaced meanwhile never gets it; the bake below sends it again to the new one.
        if (worker !== this.worker || this.delivered.get(assetId) !== sending) return;
        const request: MeshBakeRequest = { kind: 'mesh', assetId, bytes: data };
        worker.postMessage(request, [data]);
      });
      sending.catch(() => { if (this.delivered.get(assetId) === sending) this.delivered.delete(assetId); });
      this.delivered.set(assetId, sending);
      delivery = sending;
    }
    await delivery;
    if (this.disposed) throw new ArtError('The Workshop has closed.');
    if (worker !== this.worker) {
      if (retried) throw new ArtError(`The mesh could not be baked: ${this.failure}.`);
      return this.send(assetId, bytes, turn, true);
    }
    if (this.delivered.get(assetId) !== delivery) throw new ArtError('The mesh was released before its bake.');
    const id = ++this.next;
    const answer = new Promise<MeshTerrain>((resolve, reject) => this.waiting.set(id, {
      resolve: (response) => { if ('terrain' in response) resolve(response.terrain); else reject(new ArtError('The baker answered another request.')); },
      reject,
    }));
    const request: MeshBakeRequest = { kind: 'bake', id, assetId, turn };
    worker.postMessage(request);
    return answer;
  }

  private connect(): Worker {
    if (this.worker !== null) return this.worker;
    const created = new Worker(new URL('./mesh-bake-worker.ts', import.meta.url), { type: 'module', name: 'mesh-baker' });
    created.addEventListener('message', (event: MessageEvent<MeshBakeResponse>) => {
      if (created !== this.worker) return;
      const response = event.data;
      const waiting = this.waiting.get(response.id);
      if (waiting === undefined) return;
      this.waiting.delete(response.id);
      if ('failure' in response) waiting.reject(new ArtError(response.failure));
      else waiting.resolve(response);
    });
    created.addEventListener('error', (event) => {
      if (created !== this.worker) return;
      event.preventDefault();
      created.terminate();
      this.worker = null;
      this.failure = event.message || 'its worker failed to load';
      this.fail(`The mesh could not be baked: ${this.failure}.`);
    });
    this.worker = created;
    this.delivered = new Map();
    return created;
  }

  private fail(message: string): void {
    this.delivered.clear();
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const { reject } of waiting) reject(new ArtError(message));
  }
}
