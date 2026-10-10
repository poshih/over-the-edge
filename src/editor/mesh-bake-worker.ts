// Bakes off the page's thread (src/editor/mesh-baker.ts): turned course meshes' collision, and enemy models' root motion.
// A course GLB arrives once and is read once; then each bake message bakes it at one turn, answered with the terrain
// mesh or why it could not be baked. An enemy model is read and baked in one message.
import { bakeMeshTerrain, readCourseMesh } from '../mesh-collision';
import type { CourseMesh, MeshTerrain } from '../mesh-collision';
import { enemyModelBake } from '../enemy-model-check';
import type { EnemyBake } from '../enemy-model-check';

type ForgetMesh = { readonly kind: 'forget'; readonly assetId: string };

export type MeshBakeRequest =
  | { readonly kind: 'mesh'; readonly assetId: string; readonly bytes: ArrayBuffer }
  | { readonly kind: 'bake'; readonly id: number; readonly assetId: string; readonly turn: number }
  | { readonly kind: 'enemy'; readonly id: number; readonly bytes: ArrayBuffer }
  | ForgetMesh;

export type MeshBakeResponse =
  | { readonly id: number; readonly terrain: MeshTerrain }
  | { readonly id: number; readonly enemy: EnemyBake }
  | { readonly id: number; readonly failure: string };

// Each mesh as read, or why it could not be read.
const meshes = new Map<string, CourseMesh | string>();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

addEventListener('message', (event: MessageEvent<MeshBakeRequest>) => {
  const request = event.data;
  if (request.kind === 'forget') {
    meshes.delete(request.assetId);
    return;
  }
  if (request.kind === 'mesh') {
    try {
      meshes.set(request.assetId, readCourseMesh(request.bytes));
    } catch (error) {
      meshes.set(request.assetId, reason(error));
    }
    return;
  }
  if (request.kind === 'enemy') {
    let answer: MeshBakeResponse;
    try {
      answer = { id: request.id, enemy: enemyModelBake(request.bytes) };
    } catch (error) {
      answer = { id: request.id, failure: reason(error) };
    }
    postMessage(answer);
    return;
  }
  let response: MeshBakeResponse;
  try {
    const mesh = meshes.get(request.assetId);
    if (mesh === undefined) throw new Error('The mesh never reached the baker.');
    if (typeof mesh === 'string') throw new Error(mesh);
    response = { id: request.id, terrain: bakeMeshTerrain(request.assetId, mesh, request.turn) };
  } catch (error) {
    response = { id: request.id, failure: reason(error) };
  }
  postMessage(response);
});
