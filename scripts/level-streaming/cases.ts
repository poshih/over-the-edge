import type { Point } from '../../src/config.ts';
import type { Bounds } from '../../src/collision-queries.ts';
import type { LevelDefinition, LevelObject, TerrainMesh, TerrainObject } from '../../src/level.ts';
import type { ProjectManifest } from '../../src/project.ts';
import { random } from '../course-kit/course.ts';
import { CourseLevelError } from '../course-kit/errors.ts';
import type { CourseJob } from '../course-kit/job.ts';
import { sceneryHelpers } from '../course-kit/scenery.ts';
import { denseArtwork, repeatedArtwork, REPEATED_MODELS, slicedArtwork, SLICE_RISE, tidy } from './artwork.ts';
import type { ArtLimits, ArtworkAsset } from './artwork.ts';

export const CASE_NAMES = ['spread', 'dense', 'perspective', 'slices'] as const;
export type CaseName = typeof CASE_NAMES[number];
export const CASE_SEEDS: Readonly<Record<CaseName, number>> = {
  spread: 0x53505244, dense: 0x44454e53, perspective: 0x50455253, slices: 0x534c4943,
};
type DecorationLimitFields = Pick<typeof import('../../src/level.ts').DECORATION_LIMITS,
  'objects' | 'back' | 'front' | 'minimumHeight' | 'maximumHeight'>;
export type DecorationLimits = { readonly [Key in keyof DecorationLimitFields]: number };
export interface BenchmarkCase {
  readonly name: CaseName;
  readonly seed: number;
  readonly level: LevelDefinition;
  readonly manifest: ProjectManifest;
  readonly artwork: readonly ArtworkAsset[];
  readonly routeIds: ReadonlySet<string>;
  readonly routeRungs: number;
  readonly ground: Point;
  readonly summit: Point;
  readonly fallLane: Bounds;
  readonly expected: { readonly terrain: number; readonly decorations: number; readonly assets: number; readonly geometries: number };
}

const GRID_CELL_SIZE = 64;
const CLIMB_RUNGS = 3;
const CLIMB_RISE = 2;

// Cell centres stay on the world-origin grid; four corners guarantee the coordinate-limit workload.
function gridCells(count: number, coordinate: number, seed: number): Point[] {
  const first = Math.ceil((-coordinate + 16) / GRID_CELL_SIZE - 0.5);
  const last = Math.floor((coordinate - 16) / GRID_CELL_SIZE - 0.5);
  const point = (column: number, row: number): Point => ({ x: (column + 0.5) * GRID_CELL_SIZE, y: (row + 0.5) * GRID_CELL_SIZE });
  const corners = [point(first, first), point(last, first), point(first, last), point(last, last)];
  const cells: Point[] = [];
  for (let row = first; row <= last; row++) {
    for (let column = first; column <= last; column++) {
      const cell = point(column, row);
      if (corners.some((corner) => corner.x === cell.x && corner.y === cell.y)) continue;
      cells.push(cell);
    }
  }
  const rng = random(seed);
  for (let index = cells.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [cells[index], cells[other]] = [cells[other], cells[index]];
  }
  if (first >= last || count < corners.length || count > cells.length + corners.length) {
    throw new CourseLevelError({ field: 'benchmark grid capacity', value: { count, first, last, capacity: cells.length + corners.length } });
  }
  return [...corners, ...cells].slice(0, count);
}

function terrain(id: string, mesh: TerrainMesh, x: number, y: number, width: number, height: number): TerrainObject {
  return {
    kind: 'terrain', id, mesh, x: tidy(x), y: tidy(y), width: tidy(width), height: tidy(height),
    angle: 0, depth: 2, mirror: false, color: 0x73918e, illusion: false, surface: 'rock',
  };
}

function simpleClimb(name: CaseName, ground: TerrainObject, meshes: readonly TerrainMesh[]): TerrainObject[] {
  const route = [ground], base = ground.y + ground.height / 2;
  for (let index = 1; index < CLIMB_RUNGS; index++) {
    route.push(terrain(`${name}-rung-${index}`, meshes[index % meshes.length], index % 2 === 0 ? 1 : -1,
      base + index * CLIMB_RISE - 0.3, 4, 0.6));
  }
  return route;
}

function top(job: CourseJob, object: TerrainObject): number {
  return Math.max(...job.engine.level.objectLoops(object).flat().map((point) => point.y));
}

export function buildCase(name: CaseName, job: CourseJob, decorations: DecorationLimits, artLimits: ArtLimits, defaults: ProjectManifest): BenchmarkCase {
  const limits = job.engine.level.LEVEL_LIMITS, seed = CASE_SEEDS[name], rng = random(seed);
  const objects: LevelObject[] = [];
  let artwork: readonly ArtworkAsset[];
  let route: TerrainObject[];
  let routeRungs: number;
  let decorationCount: number;
  let geometryCount: number;
  let terrainCount: number;
  let assetCount: number;
  let theme = { ...defaults.theme, backdrop: { ...defaults.theme.backdrop, visible: false } };

  if (name === 'spread') {
    const repeated = repeatedArtwork(job, seed);
    artwork = repeated;
    route = simpleClimb(name, terrain('spread-rung-0', repeated[0].mesh, 0, -1, 12, 2), repeated.map((asset) => asset.mesh));
    objects.push(...route);
    gridCells(limits.objects - route.length, limits.coordinate, seed).forEach((cell, index) => {
      objects.push(terrain(`spread-cell-${index}`, repeated[index % repeated.length].mesh, cell.x, cell.y, 4, 0.6));
    });
    gridCells(decorations.objects, limits.coordinate, seed ^ 0xdec0).forEach((cell, index) => {
      objects.push({
        kind: 'decoration', id: `spread-decoration-${index}`, model: repeated[index % repeated.length].model,
        x: cell.x, y: cell.y, z: tidy(-4 - rng() * 4), height: tidy(2 + rng() * 8),
        angle: 0, mirror: false, tint: 0xffffff,
      });
    });
    routeRungs = route.length;
    decorationCount = decorations.objects;
    geometryCount = 1;
    terrainCount = limits.objects;
    assetCount = REPEATED_MODELS.length;
  } else if (name === 'dense') {
    const dense = denseArtwork(job, seed, artLimits);
    artwork = dense;
    const side = Math.ceil(Math.sqrt(artLimits.assets)), width = 1.75, height = 0.25;
    const tiles = dense.map((asset, index) => terrain(`dense-tile-${index}`, asset.mesh,
      (index % side - (side - 1) / 2) * width, 1 - (Math.floor(index / side) + 0.5) * height, width, height));
    route = simpleClimb(name, tiles[Math.floor(side / 2)], [job.engine.level.shapeMesh('box')]);
    objects.push(...tiles, ...route.slice(1));
    routeRungs = route.length;
    decorationCount = 0;
    geometryCount = 1;
    terrainCount = artLimits.assets + CLIMB_RUNGS - 1;
    assetCount = artLimits.assets;
  } else if (name === 'perspective') {
    const repeated = repeatedArtwork(job, seed, true);
    artwork = repeated;
    const box = job.engine.level.shapeMesh('box');
    route = simpleClimb(name, terrain('perspective-rung-0', box, 0, -1, 12, 2), [box]);
    objects.push(...route);
    theme = {
      ...theme, camera: { ...theme.camera, perspective: true },
      fog: { ...theme.fog, near: decorations.back / 4, far: decorations.back * 1.5 },
    };
    const { depthScale } = sceneryHelpers(theme.camera);
    for (let index = 0; index < decorations.objects; index++) {
      const fraction = index / (decorations.objects - 1);
      const z = tidy(-decorations.back * fraction), scale = depthScale(z);
      const height = tidy(decorations.minimumHeight + (decorations.maximumHeight - decorations.minimumHeight) * fraction);
      objects.push({
        kind: 'decoration', id: `perspective-decoration-${index}`, model: repeated[index % repeated.length].model,
        x: tidy(((index % 24 - 11.5) * 0.5 + (rng() - 0.5) * 0.2) * scale),
        y: tidy(CLIMB_RISE - height / 4 + (rng() - 0.5) * 2 * scale), z, height,
        angle: 0, mirror: false, tint: 0xffffff,
      });
    }
    routeRungs = route.length;
    decorationCount = decorations.objects;
    geometryCount = 1;
    terrainCount = CLIMB_RUNGS;
    assetCount = REPEATED_MODELS.length;
  } else {
    // The kit cannot model upward moves between rungs inside one mesh; slices makes no reachability claim.
    const slices = slicedArtwork(job, seed, artLimits);
    artwork = slices;
    route = slices.map((asset, index) => terrain(`slices-route-${index}`, asset.mesh, 0,
      index * limits.meshLoops * SLICE_RISE + asset.centerY, asset.width, asset.height));
    objects.push(...route);
    gridCells(limits.objects - route.length, limits.coordinate, seed).forEach((cell, index) => {
      const asset = slices[(index + route.length) % slices.length];
      objects.push(terrain(`slices-cell-${index}`, asset.mesh, cell.x, cell.y, asset.width, asset.height));
    });
    routeRungs = route.length * limits.meshLoops;
    decorationCount = 0;
    geometryCount = limits.geometryKinds;
    terrainCount = limits.objects;
    assetCount = limits.geometryKinds;
  }

  const ground = { x: 0, y: name === 'slices'
    ? Math.max(...job.engine.level.objectLoops(route[0])[0].map((point) => point.y))
    : top(job, route[0]) };
  const summit = { x: route[route.length - 1].x + (name === 'slices' ? 1 : 0), y: top(job, route[route.length - 1]) };
  const checkpoint = route[Math.floor(route.length / 2)];
  objects.push(
    { kind: 'start', id: 'player-start', x: ground.x, y: ground.y + job.engine.checks.ENGINE_DEFAULT_REACH.startFootOffset, angle: -0.42, reach: 1.7 },
    { kind: 'bonfire', id: 'benchmark-bonfire', x: checkpoint.x + (name === 'slices' ? 1 : 0), y: top(job, checkpoint) },
    {
      kind: 'trigger', id: 'benchmark-summit', name: 'Benchmark summit', x: summit.x, y: summit.y + 0.95,
      region: { type: 'box', width: 2, height: 2 }, activation: 'once', marker: 'flag',
      events: [
        { type: 'stop-timer' },
        { type: 'message', title: 'Benchmark summit', message: 'Fall down the clear lane on the right. Reset to the start, then light the bonfire and try a respawn. Repeat the route for warm measurements.' },
      ],
    },
  );
  const manifest: ProjectManifest = {
    ...defaults, theme,
    art: {
      mode: name === 'slices' ? 'shapes' : 'meshes',
      assets: artwork.map(({ id, name }) => ({ id, name })),
      decorations: Object.fromEntries(artwork.flatMap((asset): [string, string][] => asset.model === null ? [] : [[asset.model, asset.id]])),
    },
  };
  return {
    name, seed, manifest, artwork, routeRungs, ground, summit, routeIds: new Set(route.map((object) => object.id)),
    fallLane: { left: 4, right: 5, bottom: ground.y + 0.05, top: summit.y + 0.9 },
    expected: { terrain: terrainCount, decorations: decorationCount, assets: assetCount, geometries: geometryCount },
    level: {
      schemaVersion: job.engine.level.LEVEL_SCHEMA_VERSION, objects,
      labels: [
        { x: -4, y: ground.y + 1.5, text: `${name.toUpperCase()} / ${name === 'slices' ? 'NO REACH CLAIM' : 'CLIMB'}; FALL RIGHT` },
        { x: summit.x, y: summit.y + 0.7, text: 'RESET TO START; RESPAWN AT BONFIRE' },
      ],
    },
  };
}
