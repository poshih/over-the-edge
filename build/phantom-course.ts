import { createHash } from 'node:crypto';
import type { EnemyMotion } from '../src/enemy-motion-data';
import type { GameSettings } from '../src/game-settings';
import type { LevelDefinition } from '../src/level';
import { phantomCourseText } from '../src/phantom-course';

// The phantom course recordings made on a level with these settings and enemy model motion belong to: the SHA-256 of
// its play layout, physics and that motion (src/phantom-course.ts), so every version that plays the same shares its
// recordings.
export function phantomCourse(level: LevelDefinition, settings: GameSettings, motion: EnemyMotion): string {
  return createHash('sha256').update(phantomCourseText(level, settings, motion)).digest('hex');
}
