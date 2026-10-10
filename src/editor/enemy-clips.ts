import { SPECIES_CLIP_ROLES } from '../enemy-motion-data';
import type { EnemyClipRole } from '../enemy-motion-data';
import type { EnemySpecies } from '../enemy-types';

// What a clip playing each role is usually called.
const ROLE_NAMES: Readonly<Record<EnemyClipRole, RegExp>> = {
  idle: /idle|stand|breath/i,
  walk: /walk|run|move|fly|locomot/i,
  windup: /draw|aim|wind|charge|shoot|attack/i,
  dive: /dive|swoop|lunge|attack/i,
  recover: /recover|reload|stagger|rest|cool/i,
  hurt: /hurt|hit|damage|react|pain/i,
  death: /death|die|dead|defeat|fall/i,
};

/**
 * The clips a newly imported model plays for `species`' roles: the first clip named for each role, and otherwise the
 * idle clip, or the first clip, for the designer to change.
 */
export function defaultEnemyClips(species: EnemySpecies, names: readonly string[]): Partial<Record<EnemyClipRole, string>> {
  const named = (role: EnemyClipRole): string | undefined => names.find((name) => ROLE_NAMES[role].test(name));
  const fallback = named('idle') ?? names[0];
  return Object.fromEntries(SPECIES_CLIP_ROLES[species].flatMap((role) => {
    const name = named(role) ?? fallback;
    return name === undefined ? [] : [[role, name]];
  }));
}
