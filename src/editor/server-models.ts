import type { PartRole } from '../model-library';
import { sha256Hex } from '../sha256';

/** A character model this Workshop's server shares: an avatar, hammer or pot GLB. */
export interface ServerModel {
  readonly role: PartRole;
  // The file's name, without .glb.
  readonly name: string;
  // Where it is under the content URL: named by its SHA-256.
  readonly path: string;
  // Known from the build: a file of any other size or digest belongs to another deployment.
  readonly bytes: number;
  readonly sha256: string;
}

export interface ServerModels {
  // Where the models are delivered from (WORKSHOP_CONTENT_URL), maybe relative to the page.
  readonly contentUrl: string;
  readonly models: readonly ServerModel[];
}

export class ServerModelError extends Error {}

/**
 * Downloads a server model from the content URL as a GLB file named after it, checked against the size
 * and SHA-256 this Workshop was built with, so a CDN serving anything else is refused.
 */
export async function downloadServerModel(served: ServerModels, model: ServerModel, signal: AbortSignal): Promise<File> {
  const stale = (): ServerModelError => new ServerModelError(`"${model.name}" on the server does not match this Workshop. ` +
    'Reload the page; if it persists, this build\'s models are not uploaded to its content URL.');
  const bytes = new Uint8Array(model.bytes);
  try {
    const response = await fetch(new URL(model.path, new URL(served.contentUrl, document.baseURI)), { signal });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new ServerModelError(`"${model.name}" could not be downloaded from the server (HTTP ${response.status}).`);
    }
    const reader = response.body.getReader();
    let length = 0;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        if (length + next.value.byteLength > model.bytes) {
          await reader.cancel();
          throw stale();
        }
        bytes.set(next.value, length);
        length += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (length !== model.bytes) throw stale();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ServerModelError(`"${model.name}" could not be downloaded from the server. Check the connection, then try again.`);
    }
    throw error;
  }
  if (await sha256Hex(bytes) !== model.sha256) throw stale();
  return new File([bytes], `${model.name}.glb`, { type: 'model/gltf-binary' });
}
