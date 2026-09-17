import * as THREE from 'three';
import { embeddedPng, inspectPng, SPRITE_LIMITS, SpriteError, validateSpriteAnchors, validateSpriteLayer, validateSpriteMetadata } from './sprite-data';
import type { SpriteDocument, SpriteLayer } from './sprite-data';

export interface SpriteAnchor {
  readonly node: THREE.Object3D;
  readonly setCovered: (options: { covered: boolean }) => void;
}

interface ImageResource {
  readonly bitmap: ImageBitmap;
  readonly texture: THREE.Texture;
  readonly material: THREE.MeshBasicMaterial;
  readonly bytes: number;
  readonly pixels: number;
  disposed: boolean;
}

interface Attachment {
  readonly group: THREE.Group;
  count: number;
  replacements: number;
  covered: boolean;
}

interface LayerInstance {
  data: SpriteLayer;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}

interface Replacement {
  readonly controller: AbortController;
  readonly staged: Map<string, ImageResource>;
}

const ALPHA_CUTOFF = 0.5;

function cancellation(signal: AbortSignal): DOMException {
  if (signal.reason instanceof DOMException && signal.reason.name === 'AbortError') return signal.reason;
  return new DOMException('Sprite replacement was cancelled.', 'AbortError');
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof SpriteError ? signal.reason : cancellation(signal);
}

function decodeFailure(error: unknown): unknown {
  if (error instanceof DOMException &&
    ['InvalidStateError', 'EncodingError', 'NotSupportedError'].includes(error.name)) {
    return new SpriteError('The PNG could not be decoded.', { cause: error });
  }
  return error;
}

function decodePng(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal, onSettled: () => void): Promise<ImageBitmap> {
  checkSignal(signal);
  const blob = new Blob([bytes], { type: 'image/png' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (settled) return;
      finish();
      reject(cancellation(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    // ImageBitmap uploads ignore Texture.flipY; perform the flip during decoding.
    let decoding: Promise<ImageBitmap>;
    try {
      decoding = createImageBitmap(blob, {
        imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
      });
    } catch (error) {
      finish();
      onSettled();
      reject(decodeFailure(error));
      return;
    }
    decoding.then(bitmap => {
      onSettled();
      if (settled) {
        bitmap.close();
        return;
      }
      finish();
      resolve(bitmap);
    }, error => {
      onSettled();
      if (settled) return;
      finish();
      reject(decodeFailure(error));
    });
  });
}

async function downloadPng(source: string, signal: AbortSignal, maximumBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  checkSignal(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(cancellation(signal));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new SpriteError('The PNG download timed out.'));
  }, SPRITE_LIMITS.fetchMilliseconds);
  try {
    const response = await fetch(source, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new SpriteError(`The PNG download failed (HTTP ${response.status}).`);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
      throw new SpriteError('The PNG download exceeds its image or document byte budget.');
    }
    if (response.body === null) throw new SpriteError('The PNG download has no response body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        checkSignal(controller.signal);
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          throw new SpriteError('The PNG download exceeds its image or document byte budget.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    checkSignal(controller.signal);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    checkSignal(controller.signal);
    if (error instanceof TypeError || error instanceof DOMException && error.name === 'NetworkError') {
      throw new SpriteError('The PNG could not be downloaded. Check the URL and its CORS permissions.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

export class SpriteRig {
  private readonly anchors: ReadonlyMap<string, SpriteAnchor>;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private images = new Map<string, ImageResource>();
  private resources = new Map<string, ImageResource>();
  private layers = new Map<string, LayerInstance>();
  private attachments = new Map<string, Attachment>();
  private replacement: Replacement | null = null;
  private disposed = false;
  private pendingDecodes = 0;
  private texturesCreated = 0;
  private texturesDisposed = 0;

  constructor(anchors: ReadonlyMap<string, SpriteAnchor>) {
    this.anchors = new Map(anchors);
  }

  async replace(document: SpriteDocument, options: { signal: AbortSignal }): Promise<void> {
    this.assertMutable();
    if (options.signal.aborted) throw cancellation(options.signal);
    document = validateSpriteMetadata(document);
    validateSpriteAnchors(document, this.anchors.keys());
    const operation: Replacement = { controller: new AbortController(), staged: new Map() };
    const signal = operation.controller.signal;
    const abort = () => operation.controller.abort(cancellation(options.signal));
    options.signal.addEventListener('abort', abort, { once: true });
    this.replacement = operation;
    const resources = new Map<string, ImageResource>();
    const images = new Map<string, ImageResource>();
    let pixels = 0;
    let bytes = 0;
    try {
      for (const image of document.images) {
        checkSignal(signal);
        let resource = resources.get(image.source);
        if (resource === undefined) {
          resource = this.resources.get(image.source);
          if (resource === undefined) {
            const remainingBytes = Math.min(SPRITE_LIMITS.imageBytes, SPRITE_LIMITS.documentBytes - bytes);
            const embedded = embeddedPng(image.source);
            const png = embedded === null
              ? await downloadPng(image.source, signal, remainingBytes)
              : embedded;
            checkSignal(signal);
            if (png.byteLength > remainingBytes) throw new SpriteError('The sprite document exceeds its image byte budget.');
            const size = inspectPng(png);
            if (pixels + size.width * size.height > SPRITE_LIMITS.decodedPixels) {
              throw new SpriteError('The sprite document exceeds its decoded-pixel budget.');
            }
            const bitmap = await this.decode(png, signal);
            if (signal.aborted) {
              bitmap.close();
              checkSignal(signal);
            }
            if (bitmap.width !== size.width || bitmap.height !== size.height) {
              bitmap.close();
              throw new SpriteError('The decoded PNG dimensions do not match its header.');
            }
            resource = this.createResource(bitmap, png.byteLength);
            operation.staged.set(image.source, resource);
          }
          pixels += resource.pixels;
          bytes += resource.bytes;
          if (pixels > SPRITE_LIMITS.decodedPixels || bytes > SPRITE_LIMITS.documentBytes) {
            throw new SpriteError('The sprite document exceeds its image-memory or byte budget.');
          }
          resources.set(image.source, resource);
        }
        images.set(image.id, resource);
      }
      checkSignal(signal);
      const layers = new Map<string, LayerInstance>();
      const attachments = new Map<string, Attachment>();
      for (const data of document.layers) {
        const image = images.get(data.image);
        if (image === undefined) throw new SpriteError(`Sprite ${data.id} references missing image "${data.image}".`);
        const attachment = this.attachment(data.anchor, attachments);
        const instance = this.createLayer(data, image);
        attachment.group.add(instance.mesh);
        attachment.count++;
        if (data.underlay === 'replace') attachment.replacements++;
        layers.set(data.id, instance);
      }
      checkSignal(signal);
      this.commit({ resources, images, layers, attachments });
    } finally {
      options.signal.removeEventListener('abort', abort);
      for (const resource of operation.staged.values()) this.releaseResource(resource);
      operation.staged.clear();
      if (this.replacement === operation) this.replacement = null;
    }
  }

  upsert(layer: SpriteLayer): void {
    this.assertMutable();
    layer = validateSpriteLayer(layer);
    this.anchor(layer.anchor);
    const image = this.images.get(layer.image);
    if (image === undefined) throw new SpriteError(`Sprite ${layer.id} references unloaded image "${layer.image}".`);
    const previous = this.layers.get(layer.id);
    if (previous === undefined && this.layers.size >= SPRITE_LIMITS.layers) {
      throw new SpriteError(`A sprite rig supports at most ${SPRITE_LIMITS.layers} layers.`);
    }
    const affected = new Set<string>();
    if (previous !== undefined) {
      const old = this.attachments.get(previous.data.anchor)!;
      old.count--;
      if (previous.data.underlay === 'replace') old.replacements--;
      affected.add(previous.data.anchor);
    }
    const attachment = this.attachment(layer.anchor, this.attachments);
    const instance = previous ?? this.createLayer(layer, image);
    if (previous !== undefined) {
      instance.data = layer;
      instance.mesh.material = image.material;
      this.transform(instance);
    }
    if (instance.mesh.parent !== attachment.group) attachment.group.add(instance.mesh);
    attachment.count++;
    if (layer.underlay === 'replace') attachment.replacements++;
    this.layers.set(layer.id, instance);
    affected.add(layer.anchor);
    for (const name of affected) this.updateCoverage(name);
  }

  remove(id: string): void {
    this.assertMutable();
    const instance = this.layers.get(id);
    if (instance === undefined) throw new SpriteError(`Unknown sprite layer "${id}".`);
    instance.mesh.removeFromParent();
    this.layers.delete(id);
    const attachment = this.attachments.get(instance.data.anchor)!;
    attachment.count--;
    if (instance.data.underlay === 'replace') attachment.replacements--;
    this.updateCoverage(instance.data.anchor);
  }

  hasLayers(anchor: string): boolean {
    this.assertLive();
    this.anchor(anchor);
    return (this.attachments.get(anchor)?.count ?? 0) > 0;
  }

  replaces(anchor: string): boolean {
    this.assertLive();
    this.anchor(anchor);
    return (this.attachments.get(anchor)?.replacements ?? 0) > 0;
  }

  inspect() {
    const resources = [...this.resources.values()];
    const staged = [...this.replacement?.staged.values() ?? []];
    return {
      disposed: this.disposed,
      busy: !this.disposed && (this.replacement !== null || this.pendingDecodes > 0),
      pendingDecodeCount: this.pendingDecodes,
      layerCount: this.layers.size,
      imageCount: this.images.size,
      textureCount: resources.length,
      materialCount: resources.length,
      geometryCount: this.disposed ? 0 : 1,
      pixelCount: resources.reduce((total, resource) => total + resource.pixels, 0),
      byteCount: resources.reduce((total, resource) => total + resource.bytes, 0),
      stagedTextureCount: staged.length,
      stagedPixelCount: staged.reduce((total, resource) => total + resource.pixels, 0),
      texturesCreated: this.texturesCreated,
      texturesDisposed: this.texturesDisposed,
      resources: resources.map(resource => ({
        textureId: resource.texture.uuid,
        materialId: resource.material.uuid,
        width: resource.bitmap.width,
        height: resource.bitmap.height,
        pixels: resource.pixels,
        bytes: resource.bytes,
      })),
      layers: [...this.layers.values()].map(({ data, mesh }) => ({
        ...data, offset: { ...data.offset },
        localTransform: {
          position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
          scale: { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z },
          rotationZ: mesh.rotation.z,
        },
        textureId: mesh.material.map!.uuid,
        materialId: mesh.material.uuid,
        geometryId: mesh.geometry.uuid,
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replacement?.controller.abort(new DOMException('The sprite rig was disposed.', 'AbortError'));
    for (const resource of this.replacement?.staged.values() ?? []) this.releaseResource(resource);
    this.replacement?.staged.clear();
    for (const attachment of this.attachments.values()) attachment.group.removeFromParent();
    for (const resource of this.resources.values()) this.releaseResource(resource);
    this.resources.clear();
    this.images.clear();
    this.layers.clear();
    this.geometry.dispose();
    const covered = [...this.attachments].filter(([, attachment]) => attachment.covered);
    this.attachments.clear();
    for (const [name] of covered) this.anchor(name).setCovered({ covered: false });
  }

  private assertLive(): void {
    if (this.disposed) throw new SpriteError('The sprite rig has been disposed.');
  }

  private assertMutable(): void {
    this.assertLive();
    if (this.replacement !== null || this.pendingDecodes > 0) {
      throw new SpriteError('A sprite replacement or cancelled PNG decode is still in progress.');
    }
  }

  private decode(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<ImageBitmap> {
    // Native decodes cannot be aborted; block another import until a late bitmap is closed.
    this.pendingDecodes++;
    try {
      return decodePng(bytes, signal, () => { this.pendingDecodes--; });
    } catch (error) {
      this.pendingDecodes--;
      throw error;
    }
  }

  private anchor(name: string): SpriteAnchor {
    const anchor = this.anchors.get(name);
    if (anchor === undefined) throw new SpriteError(`Unknown sprite anchor "${name}".`);
    return anchor;
  }

  private createResource(bitmap: ImageBitmap, bytes: number): ImageResource {
    let texture: THREE.Texture | undefined;
    try {
      texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      const material = new THREE.MeshBasicMaterial({
        map: texture, side: THREE.DoubleSide, alphaTest: ALPHA_CUTOFF, depthWrite: true, toneMapped: false,
      });
      this.texturesCreated++;
      return { bitmap, texture, material, bytes, pixels: bitmap.width * bitmap.height, disposed: false };
    } catch (error) {
      texture?.dispose();
      bitmap.close();
      throw error;
    }
  }

  private releaseResource(resource: ImageResource): void {
    if (resource.disposed) return;
    resource.disposed = true;
    resource.material.dispose();
    resource.texture.dispose();
    resource.bitmap.close();
    this.texturesDisposed++;
  }

  private createLayer(data: SpriteLayer, image: ImageResource): LayerInstance {
    const instance = { data, mesh: new THREE.Mesh(this.geometry, image.material) };
    instance.mesh.matrixAutoUpdate = false;
    this.transform(instance);
    return instance;
  }

  private transform({ data, mesh }: LayerInstance): void {
    mesh.name = data.name;
    mesh.position.set(data.offset.x, data.offset.y, data.offset.z);
    mesh.scale.set(data.width, data.height, 1);
    mesh.rotation.set(0, 0, THREE.MathUtils.degToRad(data.rotation));
    mesh.updateMatrix();
  }

  private attachment(name: string, attachments: Map<string, Attachment>): Attachment {
    let attachment = attachments.get(name);
    if (attachment === undefined) {
      const group = new THREE.Group();
      group.name = `sprites:${name}`;
      group.matrixAutoUpdate = false;
      attachment = { group, count: 0, replacements: 0, covered: false };
      attachments.set(name, attachment);
    }
    return attachment;
  }

  private updateCoverage(name: string): void {
    const attachment = this.attachments.get(name)!;
    const anchor = this.anchor(name);
    if (attachment.count === 0) {
      attachment.group.removeFromParent();
      this.attachments.delete(name);
    } else if (attachment.group.parent !== anchor.node) {
      anchor.node.add(attachment.group);
    }
    const covered = attachment.replacements > 0;
    if (covered !== attachment.covered) {
      attachment.covered = covered;
      anchor.setCovered({ covered });
    }
  }

  private commit(next: {
    resources: Map<string, ImageResource>;
    images: Map<string, ImageResource>;
    layers: Map<string, LayerInstance>;
    attachments: Map<string, Attachment>;
  }): void {
    const oldResources = this.resources;
    const oldAttachments = this.attachments;
    for (const attachment of oldAttachments.values()) attachment.group.removeFromParent();
    this.resources = next.resources;
    this.images = next.images;
    this.layers = next.layers;
    this.attachments = next.attachments;
    // Ownership transfers before calling the injected visibility gate.
    this.replacement!.staged.clear();
    for (const [name, attachment] of this.attachments) {
      this.anchor(name).node.add(attachment.group);
      attachment.covered = attachment.replacements > 0;
    }
    try {
      for (const name of new Set([...oldAttachments.keys(), ...this.attachments.keys()])) {
        const wasCovered = oldAttachments.get(name)?.covered ?? false;
        const covered = this.attachments.get(name)?.covered ?? false;
        if (wasCovered !== covered) this.anchor(name).setCovered({ covered });
      }
    } finally {
      for (const [source, resource] of oldResources) {
        if (!this.resources.has(source)) this.releaseResource(resource);
      }
    }
  }
}
