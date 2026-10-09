// Bakes turned course meshes' collision off the page's thread (src/editor/mesh-baker.ts). A GLB arrives once and is read
// once; then each bake message bakes it at one turn, answered with the terrain mesh or why it could not be baked.
import { bakeMeshTerrain, readCourseMesh } from '../mesh-collision';
import type { CourseMesh, MeshTerrain } from '../mesh-collision';

export type MeshBakeRequest =
  | { readonly kind: 'mesh'; readonly assetId: string; readonly bytes: ArrayBuffer }
  | { readonly kind: 'bake'; readonly id: number; readonly assetId: string; readonly turn: number };

export type MeshBakeResponse =
  | { readonly id: number; readonly terrain: MeshTerrain }
  | { readonly id: number; readonly failure: string };

// Each mesh as read, or why it could not be read.
const meshes = new Map<string, CourseMesh | string>();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

addEventListener('message', (event: MessageEvent<MeshBakeRequest>) => {
  const request = event.data;
  if (request.kind === 'mesh') {
    try {
      meshes.set(request.assetId, readCourseMesh(request.bytes));
    } catch (error) {
      meshes.set(request.assetId, reason(error));
    }
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
