import { AVATAR_MOTIONS, AVATAR_RIGS, AvatarRigRegistry, STANDARD_AVATAR_RIG_STRATEGY } from '../avatar-rig';
import { checkFacetEntries, Composition, PluginError } from './kernel';
import type { Contribution } from './kernel';

export interface KindsFacet {
  readonly contributes: readonly Contribution[];
}

export interface Kinds {
  readonly avatarRigs: AvatarRigRegistry;
}

export const KINDS = Object.freeze([AVATAR_RIGS, AVATAR_MOTIONS]);

export function defineKinds<T extends KindsFacet>(facet: T): T { return facet; }

function checkKinds(value: unknown, plugin: string): KindsFacet {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Array.isArray(Reflect.get(value, 'contributes'))) {
    throw new PluginError('invalid-facet', `Plugin "${plugin}" must default-export a kinds facet with contributes.`, plugin);
  }
  return value as KindsFacet;
}

// The same function composes Node validators and every browser page.
export function composeKinds(plugins: unknown): Kinds {
  const entries = checkFacetEntries(plugins, checkKinds);
  const composition = new Composition('kinds', KINDS, entries.map(({ id, facet }) => ({ plugin: id, contributions: facet.contributes })));
  return Object.freeze({
    avatarRigs: new AvatarRigRegistry(
      composition.keyed(AVATAR_RIGS, [STANDARD_AVATAR_RIG_STRATEGY]),
      composition.keyed(AVATAR_MOTIONS, []),
    ),
  });
}
