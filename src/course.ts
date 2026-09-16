import type { PlayerSpawn, Point } from './config';

export interface Terrain {
  id: string;
  vertices: readonly Point[];
  color: number;
  depth: number;
}

export const COURSE: readonly Terrain[] = [
  {
    id: 'ground',
    vertices: [{ x: -22, y: -2 }, { x: 34, y: -2 }, { x: 34, y: 0 }, { x: -22, y: 0 }],
    color: 0x485d5a,
    depth: 3,
  },
  {
    id: 'ascent',
    vertices: [
      { x: 3.2, y: 0 }, { x: 18.4, y: 0 }, { x: 18.4, y: 12.2 },
      { x: 15, y: 12.2 }, { x: 15, y: 10.6 }, { x: 13, y: 10.6 },
      { x: 13, y: 9 }, { x: 11.6, y: 9 }, { x: 10.9, y: 7.3 },
      { x: 8.8, y: 7.3 }, { x: 8.8, y: 6.8 }, { x: 10, y: 6.8 },
      { x: 10, y: 5.1 }, { x: 8.1, y: 5.1 }, { x: 7.4, y: 3.6 },
      { x: 5.9, y: 3.6 }, { x: 5.3, y: 2.1 }, { x: 3.2, y: 2.1 },
    ],
    color: 0x71817a,
    depth: 2.1,
  },
  {
    id: 'vault',
    vertices: [
      { x: -10, y: 0 }, { x: -8.2, y: 0 }, { x: -8.2, y: 0.9 },
      { x: -8.4, y: 1.12 }, { x: -9.8, y: 1.12 }, { x: -10, y: 0.9 },
    ],
    color: 0x9a7660,
    depth: 1.5,
  },
];

export const START_SPAWN: Readonly<PlayerSpawn> = {
  position: { x: 0, y: 0.65 }, angle: -0.42, extension: 0.2,
};

export const ENDING_ZONE = { xMin: 15.25, xMax: 18.1, y: 12.2, arrivalTolerance: 0.08 } as const;

export const COURSE_LABELS = [
  { x: 4.2, y: 1.1, text: '01 / THE LEDGE' },
  { x: 6.8, y: 2.7, text: '02 / KEEP GOING' },
  { x: 10, y: 6.05, text: '03 / REACH BACK' },
  { x: 16.5, y: 11.3, text: '04 / THE TOP' },
  { x: -9.1, y: 0.45, text: 'THE VAULT' },
] as const;
