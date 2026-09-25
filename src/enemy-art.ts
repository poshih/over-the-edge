import { DataTexture, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector4 } from 'three';
import { ENEMY_SPECIES } from './enemy-types';
import type { EnemySpecies } from './enemy-types';

type Frames = readonly [readonly string[], readonly string[]];

// Hand-authored pixel art. Both frames face right; '.' is transparent.
const ART: Readonly<Record<EnemySpecies, Frames>> = {
  bird: [
    [
      '........................',
      '.......##...............',
      '......#TT#..............',
      '.....#TTW#..............',
      '.....#TWW#....####......',
      '....#TWWW#...#BBEE#.....',
      '...#TWWWW####BBEXB#.....',
      '..##WWWWWBBBTTBBBOOO#...',
      '.#WWWWBBBBBBBCCC#OO#....',
      '#WW###BBBBBCCCC#..#.....',
      '.##...#BBBCCCC#.........',
      '.......######...........',
      '.........O..O...........',
      '........OO.OO...........',
      '........................',
      '........................',
    ],
    [
      '........................',
      '........................',
      '........................',
      '........................',
      '..............####......',
      '.............#BBEE#.....',
      '.........####BBEXB#.....',
      '..#######BBBTTBBBOOO#...',
      '.#WWWWBBBBBBBCCC#OO#....',
      '#WW###BBWWWWCCC#..#.....',
      '.##...#BTWWWWC#.........',
      '.......#TTWWW#..........',
      '........#TTWWW#.........',
      '........O#TWWW#.........',
      '.......OO.####..........',
      '........................',
    ],
  ],
  'hollow-soldier': [
    [
      '......##........',
      '.....#AA#.......',
      '....#AAAA#......',
      '....#AHHh#......',
      '....#HG#G#......',
      '.....#Hh#.......',
      '.....#h##.......',
      '...###aa###...S.',
      '..#AARAAAaH#..S.',
      '.###AARAAaH#..S.',
      '#AaA#AAAaaH#..S.',
      '#aRa#AAAAaH#..S.',
      '#aRa#Arrrra#..S.',
      '#aRa#rrrrraHH#R#',
      '.#a#rrrrrr#..#R#',
      '..#.#rr#rr#...#.',
      '....#aa#aa#.....',
      '....#a#.#a#.....',
      '....#h#.#h#.....',
      '....#h#.#h#.....',
      '....#a#.#a#.....',
      '...#AA#.#AA#....',
      '...####.####....',
    ],
    [
      '......##........',
      '.....#AA#.......',
      '....#AAAA#......',
      '....#AHHh#......',
      '....#HG#G#......',
      '.....#Hh#.......',
      '.....#h##.......',
      '...###aa###...S.',
      '..#AARAAAaH#..S.',
      '.###AARAAaH#..S.',
      '#AaA#AAAaaH#..S.',
      '#aRa#AAAAaH#..S.',
      '#aRa#Arrrra#..S.',
      '#aRa#rrrrraHH#R#',
      '.#a#rrrrrr#..#R#',
      '..#.#rr#rr#...#.',
      '....#aa#aa#.....',
      '...#aa#..#a#....',
      '..#hh#...#h#....',
      '..#h#.....#h#...',
      '..#a#.....#a#...',
      '.#AA#.....#AA#..',
      '.####.....####..',
    ],
  ],
};

const PALETTE: Readonly<Record<string, number>> = {
  '#': 0x23343d, X: 0x15232b, B: 0x548994, T: 0x95c6c1, W: 0x365361,
  C: 0xe4d6ae, E: 0xf7efd3, O: 0xefb65c,
  A: 0x83938e, a: 0x485a5c, R: 0xa67e50, r: 0x615462,
  H: 0xc9cda5, h: 0x8e9d84, G: 0xf6d777, S: 0xc5d8d5,
};

export function createEnemyAtlas() {
  const frameCount = ART[ENEMY_SPECIES[0]].length;
  const sizes = ENEMY_SPECIES.map((species) => ({
    species, width: ART[species][0][0].length, height: ART[species][0].length,
  }));
  const width = Math.max(...sizes.map((size) => size.width * frameCount));
  const height = sizes.reduce((sum, size) => sum + size.height, 0);
  const pixels = new Uint8Array(width * height * 4);
  const frames = new Map<EnemySpecies, Vector4>();
  let top = 0;
  for (const size of sizes) {
    for (const [frameIndex, frame] of ART[size.species].entries()) {
      if (frame.length !== size.height) throw new Error(`Inconsistent ${size.species} frame height.`);
      for (const [y, row] of frame.entries()) {
        if (row.length !== size.width) throw new Error(`Inconsistent ${size.species} frame row ${y}.`);
        for (let x = 0; x < row.length; x++) {
          const pixel = row[x];
          if (pixel === '.') continue;
          const color = PALETTE[pixel];
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
  texture.name = 'original-enemy-atlas';
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, frames, frameCount, bytes: pixels.byteLength };
}
