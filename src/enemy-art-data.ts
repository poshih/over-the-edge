import { artId } from './art-types';
import { SPECIES_CLIP_ROLES, validateEnemyClipMotion } from './enemy-motion-data';
import type { EnemyClipMotion, EnemyClipRole } from './enemy-motion-data';
import { ENEMY_SPECIES } from './enemy-types';
import type { EnemySpecies } from './enemy-types';
import type { LevelDefinition } from './level';
import { colorValue, exactRecord, ProjectError } from './project-fields';

type Frames = readonly [readonly string[], readonly string[]];

// Hand-authored pixel art. Both frames face right; '.' is transparent.
const BUILT_IN_FRAMES: Readonly<Record<EnemySpecies, Frames>> = {
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
  'hollow-archer': [
    [
      '......###.........',
      '.....#rrr#........',
      '....#rrrrr#..#....',
      '....#rrHHh#..hR...',
      '....#rrG#G#..hR...',
      '..CC#rrhHh#.h..R..',
      '.#CC#rr#h#..h..R..',
      '.#R#rraaaA#.h...R.',
      '.#R#raaAaAA#h...R.',
      '.#R#raAahHHCCCCCCS',
      '.#R#raaAaaaaaaaHX.',
      '.#R#raaaAa#h....R.',
      '..##rRRRRR#.h...R.',
      '...#raaAaa#.h...R.',
      '...#rraaaaa#h..R..',
      '....#aa#aa#.h..R..',
      '....#a#.#a#..hR...',
      '....#h#.#h#..hR...',
      '....#h#.#h#..#....',
      '....#h#.#h#.......',
      '....#a#.#a#.......',
      '...#AA#.#AA#......',
      '...####.####......',
    ],
    [
      '......###.........',
      '.....#rrr#........',
      '....#rrrrr#..#....',
      '....#rrHHh#..hR...',
      '....#rrG#G#..hR...',
      '..CC#rrhHh#.h..R..',
      '.#CC#rr#h#..h..R..',
      '.#R#rraaaA#.h...R.',
      '.#R#raaAaAA#h...R.',
      '.#R#raAahHHCCCCCCS',
      '.#R#raaAaaaaaaaHX.',
      '.#R#raaaAa#h....R.',
      '..##rRRRRR#.h...R.',
      '...#raaAaa#.h...R.',
      '...#rraaaaa#h..R..',
      '....#aa#aa#.h..R..',
      '....#a#.#a#..hR...',
      '...#ah#..#h#.hR...',
      '..#hh#...#h#.#....',
      '..#h#.....#h#.....',
      '..#a#.....#a#.....',
      '.#AA#.....#AA#....',
      '.####.....####....',
    ],
  ],
};

const BUILT_IN_PALETTE: Readonly<Record<string, string>> = {
  '#': '#23343d', X: '#15232b', B: '#548994', T: '#95c6c1', W: '#365361', C: '#e4d6ae',
  E: '#f7efd3', O: '#efb65c', A: '#83938e', a: '#485a5c', R: '#a67e50', r: '#615462',
  H: '#c9cda5', h: '#8e9d84', G: '#f6d777', S: '#c5d8d5',
};

// Replacement pixel art for one species: two animation frames of equal size, read top to bottom,
// facing right. '.' is transparent; every other character must be a palette key.
export interface SpeciesArt {
  readonly frames: readonly (readonly string[])[];
  readonly palette: Readonly<Record<string, string>>;
}

// A species drawn as pixel art of its own. Cosmetic: colliders, health and behaviour are unchanged.
export interface SpriteArt extends SpeciesArt {
  readonly type: 'sprite';
}

/**
 * A species drawn as an animated skinned GLB from the course artwork, playing one clip for each role its phases have.
 * Its moves travel as those clips do: `motion` is each role's root motion, baked from its clip (src/enemy-motion.ts),
 * which the simulation reads, so the model enemy's moves are gameplay as well as looks.
 */
export interface ModelArt {
  readonly type: 'model';
  readonly asset: string;
  readonly clips: Readonly<Partial<Record<EnemyClipRole, string>>>;
  readonly motion: Readonly<Partial<Record<EnemyClipRole, EnemyClipMotion>>>;
}

// null keeps a species' built-in pixel art.
export type EnemyArtSettings = Readonly<Record<EnemySpecies, SpriteArt | ModelArt | null>>;

export const ENEMY_ART_LIMITS = { frames: 2, size: 64, palette: 32, clipName: 128 } as const;

export const DEFAULT_ENEMY_ART: EnemyArtSettings = Object.freeze({ bird: null, 'hollow-soldier': null, 'hollow-archer': null });

export function builtInEnemyArt(species: EnemySpecies): SpeciesArt {
  const frames = BUILT_IN_FRAMES[species];
  const used = new Set(frames.flatMap(frame => frame.flatMap(row => [...row])));
  return Object.freeze({
    frames,
    palette: Object.freeze(Object.fromEntries(Object.entries(BUILT_IN_PALETTE).filter(([key]) => used.has(key)))),
  });
}

export function validateSpeciesArt(value: unknown, label: string): SpeciesArt {
  const art = exactRecord(value, ['frames', 'palette'], label);
  const palette = art.palette;
  if (typeof palette !== 'object' || palette === null || Array.isArray(palette)) throw new ProjectError(`${label} palette must be an object.`);
  const keys = Object.keys(palette);
  if (keys.length === 0 || keys.length > ENEMY_ART_LIMITS.palette) {
    throw new ProjectError(`${label} needs 1-${ENEMY_ART_LIMITS.palette} palette colours.`);
  }
  const colours: Record<string, string> = {};
  for (const key of keys) {
    if (key.length !== 1 || key === '.' || !/^[\x21-\x7e]$/.test(key)) {
      throw new ProjectError(`${label} palette keys are single visible ASCII characters other than ".".`);
    }
    colours[key] = colorValue(Reflect.get(palette, key), `${label} palette colour "${key}"`);
  }
  if (!Array.isArray(art.frames) || art.frames.length !== ENEMY_ART_LIMITS.frames) {
    throw new ProjectError(`${label} needs exactly ${ENEMY_ART_LIMITS.frames} animation frames.`);
  }
  let width = 0;
  let height = 0;
  const frames = art.frames.map((frame: unknown, index) => {
    if (!Array.isArray(frame) || frame.length === 0 || frame.length > ENEMY_ART_LIMITS.size) {
      throw new ProjectError(`${label} frame ${index + 1} needs 1-${ENEMY_ART_LIMITS.size} rows.`);
    }
    if (index === 0) height = frame.length;
    else if (frame.length !== height) throw new ProjectError(`${label} frames must have the same number of rows.`);
    return Object.freeze(frame.map((row: unknown, y) => {
      if (typeof row !== 'string' || row.length === 0 || row.length > ENEMY_ART_LIMITS.size) {
        throw new ProjectError(`${label} frame ${index + 1} row ${y + 1} needs 1-${ENEMY_ART_LIMITS.size} pixels.`);
      }
      if (width === 0) width = row.length;
      else if (row.length !== width) throw new ProjectError(`${label} rows must all be ${width} pixels wide.`);
      for (const pixel of row) {
        if (pixel !== '.' && !Object.hasOwn(colours, pixel)) {
          throw new ProjectError(`${label} frame ${index + 1} row ${y + 1} uses "${pixel}", which is not in its palette.`);
        }
      }
      return row;
    }));
  });
  return Object.freeze({ frames: Object.freeze(frames), palette: Object.freeze(colours) });
}

// One species' art: its own pixel art, or a model with a clip and baked motion for each of the species' roles.
function validateArtEntry(value: unknown, species: EnemySpecies): SpriteArt | ModelArt {
  const label = `${species} art`;
  const type = typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined;
  if (type === 'sprite') {
    const { type: _type, ...art } = exactRecord(value, ['type', 'frames', 'palette'], label);
    return Object.freeze({ type: 'sprite', ...validateSpeciesArt(art, label) });
  }
  if (type !== 'model') throw new ProjectError(`${label} must be null, a "sprite" or a "model".`);
  const art = exactRecord(value, ['type', 'asset', 'clips', 'motion'], label);
  const roles = SPECIES_CLIP_ROLES[species];
  const clips = exactRecord(art.clips, roles, `${label} clips`);
  const motion = exactRecord(art.motion, roles, `${label} motion`);
  return Object.freeze({
    type: 'model',
    asset: artId(art.asset),
    clips: Object.freeze(Object.fromEntries(roles.map((role) => {
      const name = clips[role];
      if (typeof name !== 'string' || name.length === 0 || name.length > ENEMY_ART_LIMITS.clipName) {
        throw new ProjectError(`${label} clip for ${role} needs a name of 1-${ENEMY_ART_LIMITS.clipName} characters.`);
      }
      return [role, name];
    }))),
    motion: Object.freeze(Object.fromEntries(roles.map((role) =>
      [role, validateEnemyClipMotion(motion[role], `${label} ${role} motion`)]))),
  });
}

export function validateEnemyArt(value: unknown): EnemyArtSettings {
  const art = exactRecord(value, ENEMY_SPECIES, 'Enemy art');
  return Object.freeze(Object.fromEntries(ENEMY_SPECIES.map(species =>
    [species, art[species] === null ? null : validateArtEntry(art[species], species)])) as Record<EnemySpecies, SpriteArt | ModelArt | null>);
}

// The course artwork assets the art draws `species` with, for the species `placed`: each model's GLB.
export function enemyArtAssets(art: EnemyArtSettings, placed: ReadonlySet<EnemySpecies>): Set<string> {
  const assets = new Set<string>();
  for (const species of placed) {
    const entry = art[species];
    if (entry?.type === 'model') assets.add(entry.asset);
  }
  return assets;
}

// The species a level places.
export function placedSpecies(level: Pick<LevelDefinition, 'objects'>): Set<EnemySpecies> {
  return new Set(level.objects.flatMap((object) => object.kind === 'enemy' ? [object.species] : []));
}
