import { START_SPAWN } from '../course';
import type { PlayerSpawn } from '../config';

export type PracticeId = 'start' | 'ledge' | 'pogo' | 'vault';

export interface Practice extends PlayerSpawn {
  id: PracticeId;
  label: string;
  description: string;
}

export const PRACTICES: readonly Practice[] = [
  { id: 'start', label: 'The ascent', description: 'Start at the foot of the climbing course.', ...START_SPAWN },
  { id: 'ledge', label: 'Ledge hold', description: 'A sideways hang. Release the mouse and watch the drift.', position: { x: 1.75, y: 1.75 }, angle: 0, reach: 1.75 },
  { id: 'pogo', label: 'Ground push', description: 'Point down. Extend to lift, then swing to launch.', position: { x: -3, y: 0.85 }, angle: -Math.PI / 2, reach: 1.2 },
  { id: 'vault', label: 'The vault', description: 'Hook the low block and swing the pot over it.', position: { x: -11.15, y: 0.65 }, angle: 0.14, reach: 1.7 },
];

export function practiceById(id: PracticeId): Practice {
  const practice = PRACTICES.find((candidate) => candidate.id === id);
  if (!practice) throw new Error(`Unknown practice position: ${id}`);
  return practice;
}
