import { DataTexture, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector4 } from 'three';
import { ENEMY_SPECIES } from './enemy-types';
import type { EnemySpecies } from './enemy-types';
import { builtInEnemyArt, DEFAULT_ENEMY_ART, ENEMY_ART_LIMITS } from './enemy-art-data';
import type { EnemyArtSettings } from './enemy-art-data';

// Packs every species' two frames into one texture, so all enemies share a single draw batch.
export function createEnemyAtlas(art: EnemyArtSettings = DEFAULT_ENEMY_ART) {
  const frameCount = ENEMY_ART_LIMITS.frames;
  const sources = ENEMY_SPECIES.map((species) => ({ species, art: art[species] ?? builtInEnemyArt(species) }));
  const sizes = sources.map(({ species, art: source }) => ({
    species, source, width: source.frames[0]![0]!.length, height: source.frames[0]!.length,
  }));
  const width = Math.max(...sizes.map((size) => size.width * frameCount));
  const height = sizes.reduce((sum, size) => sum + size.height, 0);
  const pixels = new Uint8Array(width * height * 4);
  const frames = new Map<EnemySpecies, Vector4>();
  let top = 0;
  for (const size of sizes) {
    const palette = new Map(Object.entries(size.source.palette).map(([key, color]) => [key, Number.parseInt(color.slice(1), 16)]));
    for (const [frameIndex, frame] of size.source.frames.entries()) {
      if (frame.length !== size.height) throw new Error(`Inconsistent ${size.species} frame height.`);
      for (const [y, row] of frame.entries()) {
        if (row.length !== size.width) throw new Error(`Inconsistent ${size.species} frame row ${y}.`);
        for (let x = 0; x < row.length; x++) {
          const pixel = row[x]!;
          if (pixel === '.') continue;
          const color = palette.get(pixel);
          if (color === undefined) throw new Error(`Unknown enemy art pixel "${pixel}".`);
          // DataTexture rows start at the bottom; the authored rows read top to bottom.
          const offset = ((height - top - y - 1) * width + frameIndex * size.width + x) * 4;
          pixels[offset] = color >>> 16;
          pixels[offset + 1] = (color >>> 8) & 0xff;
          pixels[offset + 2] = color & 0xff;
          pixels[offset + 3] = 0xff;
        }
      }
    }
    frames.set(size.species, new Vector4(
      0, (height - top - size.height) / height, size.width / width, size.height / height,
    ));
    top += size.height;
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, UnsignedByteType);
  texture.name = art === DEFAULT_ENEMY_ART ? 'original-enemy-atlas' : 'project-enemy-atlas';
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, frames, frameCount, bytes: pixels.byteLength };
}
