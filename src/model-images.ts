import { ART_LIMITS, artRecord } from './art-types';
import { MODEL_LIMITS, ModelError } from './model-data';

function dimensions(bytes: Uint8Array, subject: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => new TextDecoder().decode(bytes.subarray(offset, offset + length));
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && text(12, 4) === 'IHDR') {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    if (kind === 'VP8X') {
      const uint24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
      return [uint24(24) + 1, uint24(27) + 1];
    }
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }
  }
  if (bytes.length >= 25 && text(0, 4) === 'RIFF' && text(8, 8) === 'WEBPVP8L' && bytes[20] === 0x2f) {
    const packed = view.getUint32(21, true);
    return [(packed & 0x3fff) + 1, (packed >>> 14 & 0x3fff) + 1];
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }
  throw new ModelError(`${subject[0].toUpperCase()}${subject.slice(1)} textures must be embedded PNG, JPEG, or WebP images with readable dimensions. Convert AVIF before sharing.`);
}

// Visits every texture's pixel size in document order; `subject` names the model in messages.
export function forEachModelImage(
  data: ArrayBuffer,
  document: Record<string, unknown>,
  subject: string,
  visit: (width: number, height: number) => void,
  // 'skip' ignores images whose size cannot be read without decoding them, such as AVIF.
  unreadable: 'throw' | 'skip' = 'throw',
): void {
  if (document.images === undefined) return;
  if (!Array.isArray(document.images)) throw new ModelError(`Invalid ${subject} texture list.`);
  const header = new DataView(data);
  let binary = new Uint8Array();
  for (let offset = 12; offset < data.byteLength;) {
    const length = header.getUint32(offset, true);
    if (header.getUint32(offset + 4, true) === 0x004e4942) binary = new Uint8Array(data, offset + 8, length);
    offset += length + 8;
  }
  const decoded = new Map<number, Uint8Array>();
  const decode = (uri: unknown): Uint8Array => {
    if (typeof uri !== 'string' || !uri.startsWith('data:') || !uri.includes(';base64,')) throw new ModelError(`Embed every ${subject} texture and buffer.`);
    try { return Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), (character) => character.charCodeAt(0)); }
    catch (error) {
      if (!(error instanceof DOMException)) throw error;
      throw new ModelError(`An embedded ${subject} texture or buffer is not valid base64.`);
    }
  };
  for (const entry of document.images) {
    const image = artRecord(entry, `${subject[0].toUpperCase()}${subject.slice(1)} texture`);
    let bytes: Uint8Array;
    if (image.uri !== undefined) bytes = decode(image.uri);
    else {
      if (!Array.isArray(document.bufferViews) || typeof image.bufferView !== 'number' || !Number.isInteger(image.bufferView) ||
        image.bufferView < 0 || image.bufferView >= document.bufferViews.length) throw new ModelError(`A ${subject} texture has no valid buffer view.`);
      const view = artRecord(document.bufferViews[image.bufferView], 'Texture buffer view');
      if (!Array.isArray(document.buffers) || typeof view.buffer !== 'number' || !Number.isInteger(view.buffer) ||
        view.buffer < 0 || view.buffer >= document.buffers.length) throw new ModelError(`A ${subject} texture has no valid buffer.`);
      let buffer = decoded.get(view.buffer);
      if (!buffer) {
        const description = artRecord(document.buffers[view.buffer], 'Texture buffer');
        buffer = description.uri === undefined && view.buffer === 0 ? binary : decode(description.uri);
        decoded.set(view.buffer, buffer);
      }
      const offset = view.byteOffset ?? 0, length = view.byteLength;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 ||
        typeof length !== 'number' || !Number.isInteger(length) || length < 1 || offset + length > buffer.byteLength) {
        throw new ModelError(`A ${subject} texture exceeds its embedded buffer.`);
      }
      bytes = buffer.subarray(offset, offset + length);
    }
    let size: [number, number];
    try {
      size = dimensions(bytes, subject);
    } catch (error) {
      if (unreadable === 'skip' && error instanceof ModelError) continue;
      throw error;
    }
    visit(...size);
  }
}

export function modelImagePixels(data: ArrayBuffer, document: Record<string, unknown>): number {
  let pixels = 0;
  forEachModelImage(data, document, 'course', (width, height) => {
    if (width < 1 || height < 1 || width > MODEL_LIMITS.textureEdge || height > MODEL_LIMITS.textureEdge) {
      throw new ModelError('Course textures must be at most 4096 pixels on either edge.');
    }
    pixels += width * height;
    if (pixels > ART_LIMITS.texturePixels) throw new ModelError('Course textures exceed 32 million decoded pixels.');
  });
  return pixels;
}
