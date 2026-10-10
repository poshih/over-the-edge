import { ArtError } from './art-types';

export interface Gltf {
  readonly asset?: unknown;
  readonly scene?: unknown;
  readonly scenes?: unknown;
  readonly nodes?: unknown;
  readonly meshes?: unknown;
  readonly skins?: unknown;
  readonly animations?: unknown;
  readonly accessors?: unknown;
  readonly bufferViews?: unknown;
  readonly buffers?: unknown;
}

export type Record_ = Record<string, unknown>;

export interface Accessor {
  readonly count: number;
  readonly components: number;
  readonly componentType: number;
  readonly normalized: boolean;
  // Component `component` of element `element`, normalized integers as fractions.
  readonly read: (element: number, component: number) => number;
}

function fail(message: string): never {
  throw new ArtError(message);
}

export function record(value: unknown, label: string): Record_ {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`The GLB's ${label} is invalid.`);
  return value as Record_;
}

export function list(value: unknown, label: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`The GLB's ${label} list is invalid.`);
  return value;
}

export function index(value: unknown, length: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) fail(`The GLB has an invalid ${label} reference.`);
  return value;
}

// The GLB's JSON description and its buffers' bytes: the binary chunk, and any embedded data: URIs.
export function readContainer(data: ArrayBuffer): { json: Gltf; buffers: Uint8Array[] } {
  const view = new DataView(data);
  let json: Gltf | null = null;
  let binary: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const chunk = new Uint8Array(data, offset + 8, length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
    else if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  if (json === null) fail('The GLB has no model description.');
  const buffers = list(json.buffers, 'buffer').map((entry, at) => {
    const buffer = record(entry, 'buffer');
    const uri = buffer.uri;
    if (uri === undefined) {
      if (at !== 0 || binary === null) fail('The GLB references a buffer it does not contain.');
      return binary;
    }
    if (typeof uri !== 'string' || !uri.startsWith('data:')) fail('Embed every buffer in the GLB.');
    const text = atob(uri.slice(uri.indexOf(',') + 1));
    return Uint8Array.from(text, (character) => character.charCodeAt(0));
  });
  return { json, buffers };
}

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function accessor(json: Gltf, buffers: readonly Uint8Array[], at: number): Accessor {
  const accessors = list(json.accessors, 'accessor');
  const data = record(accessors[index(at, accessors.length, 'accessor')], 'accessor');
  if (data.sparse !== undefined) fail('Mesh positions and indices cannot use sparse accessors.');
  const count = data.count;
  const components = typeof data.type === 'string' ? COMPONENTS[data.type] : undefined;
  const size = typeof data.componentType === 'number' ? COMPONENT_BYTES[data.componentType] : undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || components === undefined || size === undefined) {
    fail('The GLB has an invalid accessor.');
  }
  if (data.bufferView === undefined) return { count, components, componentType: data.componentType as number, normalized: data.normalized === true, read: () => 0 };
  const views = list(json.bufferViews, 'buffer view');
  const bufferView = record(views[index(data.bufferView, views.length, 'buffer view')], 'buffer view');
  const bytes = buffers[index(bufferView.buffer, buffers.length, 'buffer')];
  const viewOffset = typeof bufferView.byteOffset === 'number' ? bufferView.byteOffset : 0;
  const stride = typeof bufferView.byteStride === 'number' ? bufferView.byteStride : size * components;
  const start = viewOffset + (typeof data.byteOffset === 'number' ? data.byteOffset : 0);
  const end = count === 0 ? start : start + stride * (count - 1) + size * components;
  if (typeof bufferView.byteLength !== 'number' || !Number.isInteger(start) || start < 0 || end > bytes.byteLength ||
    end > viewOffset + bufferView.byteLength) {
    fail('A GLB accessor exceeds its buffer.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normalized = data.normalized === true;
  const type = data.componentType as number;
  return {
    count, components, componentType: type, normalized,
    read: (element, component) => {
      const offset = start + element * stride + component * size;
      switch (type) {
        case 5126: return view.getFloat32(offset, true);
        case 5125: return view.getUint32(offset, true);
        case 5123: return normalized ? view.getUint16(offset, true) / 65535 : view.getUint16(offset, true);
        case 5122: return normalized ? Math.max(view.getInt16(offset, true) / 32767, -1) : view.getInt16(offset, true);
        case 5121: return normalized ? view.getUint8(offset) / 255 : view.getUint8(offset);
        default: return normalized ? Math.max(view.getInt8(offset) / 127, -1) : view.getInt8(offset);
      }
    },
  };
}

export function accessorValues(json: Gltf, buffers: readonly Uint8Array[], at: number): { readonly accessor: Accessor; readonly values: Float64Array } {
  const data = accessor(json, buffers, at);
  const values = new Float64Array(data.count * data.components);
  for (let element = 0; element < data.count; element++) {
    for (let component = 0; component < data.components; component++) values[element * data.components + component] = data.read(element, component);
  }
  return { accessor: data, values };
}
