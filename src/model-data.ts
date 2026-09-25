export const MODEL_LIMITS = {
  bytes: 20 * 1024 * 1024,
  triangles: 250_000,
  meshes: 128,
  nodes: 2048,
  textureEdge: 4096,
  minimumSpan: 0.000001,
  maximumSpan: 1_000_000,
} as const;

export class ModelError extends Error {}

export async function fetchModelBlob(source: string, signal?: AbortSignal): Promise<Blob> {
  try {
    const response = await fetch(source, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new ModelError(`Could not load the saved GLB (${response.status}). Check your library sign-in or release assets.`);
    if (Number(response.headers.get('Content-Length')) > MODEL_LIMITS.bytes || !response.body) {
      throw new ModelError('The saved GLB is empty or exceeds 20 MiB.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MODEL_LIMITS.bytes) {
          await reader.cancel();
          throw new ModelError('The saved GLB exceeds 20 MiB.');
        }
        chunks.push(new Uint8Array(next.value));
      }
    } finally { reader.releaseLock(); }
    return new Blob(chunks, { type: 'model/gltf-binary' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ModelError('The GLB download was interrupted. Reconnect and load the saved asset again; no regeneration is needed.');
  }
}

export async function modelAssetId(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return `asset-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
