import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SPRITE_RIGGING, validateSpriteDocument } from '../src/sprite-data.ts';

const [anchor, ...extra] = process.argv.slice(2);
if (!anchor || extra.length > 0) {
  throw new Error('Usage: node --experimental-strip-types examples/sprites.mjs <anchor>');
}

// Original 32x32 geometric swatch, generated without external artwork.
const TILE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAfUlEQVR4AeyWMQrAIAxFg1PP0zt06lk69WyderFudf8Bw0eDIF/IEBL08SRo2a/7nxnFJi8BOAPv+Vlm4I07AGzIzgUgAzJAGziezVrBji0NwB4Q9QtABmSANhD9FaKxwzoNgBv05gKQARlwBlpv/Ygajq0DwIbsfH2AyGAFAAD//4tzEOYAAAAGSURBVAMABWeiYWqgyVwAAAAASUVORK5CYII=';
const document = validateSpriteDocument({
  schemaVersion: 3,
  skeleton: null,
  presentation: null,
  images: [{ id: 'tile', name: 'Geometric tile', source: TILE_PNG }],
  layers: [
    {
      ...DEFAULT_SPRITE_RIGGING,
      id: 'panel', name: 'Main panel', anchor, image: 'tile', width: 1, height: 1,
      offset: { x: 0, y: 0, z: 0 }, rotation: 0, underlay: 'replace',
    },
    {
      ...DEFAULT_SPRITE_RIGGING,
      id: 'accent', name: 'Offset accent', anchor, image: 'tile', width: 0.35, height: 0.35,
      offset: { x: 0.45, y: 0.35, z: 0.05 }, rotation: 30, underlay: 'overlay',
    },
  ],
});
const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = join(project, 'artifacts');
await mkdir(artifacts, { recursive: true });
if (await realpath(artifacts) !== artifacts) throw new Error('Example output requires an ordinary, ignored artifacts directory.');
const output = join(artifacts, 'sprite-example.json');
await writeFile(output, JSON.stringify(document), { flag: 'wx' });
console.info(`Created ${output}: ${document.images.length} shared image, ${document.layers.length} layers on anchor "${anchor}".`);
