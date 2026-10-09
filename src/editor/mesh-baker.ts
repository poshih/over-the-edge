import { ArtError } from '../art-types';
import type { MeshTerrain } from '../mesh-collision';
import type { MeshBakeRequest, MeshBakeResponse } from './mesh-bake-worker';

interface Waiting {
  readonly resolve: (terrain: MeshTerrain) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Bakes course meshes turned about their vertical axis in a worker (src/editor/mesh-bake-worker.ts), so a large mesh never
 * holds up the page. Each GLB goes to the worker once, ahead of the first bake asked of it.
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
        if (worker !== this.worker) return;
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
    const id = ++this.next;
    const answer = new Promise<MeshTerrain>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
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
      else waiting.resolve(response.terrain);
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
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const { reject } of waiting) reject(new ArtError(message));
  }
}
