import type { Kinds } from '../plugins/kinds';
import { checkFacetEntries, Composition, namespaceOf, PluginError } from '../plugins/kernel';
import { AVATAR_MOTION_CONTROLS } from './avatar-motion-controls';
import { ENGINE_LEVEL_REACH, LEVEL_CHECKS, LEVEL_REACH } from './level-check-points';
import type { WorkshopFacet } from './workshop-sdk';

export const WORKSHOP = Object.freeze([AVATAR_MOTION_CONTROLS, LEVEL_CHECKS, LEVEL_REACH]);

function checkWorkshop(value: unknown, plugin: string): WorkshopFacet {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof Reflect.get(value, 'start') !== 'function' ||
    Reflect.get(value, 'validate') !== undefined && typeof Reflect.get(value, 'validate') !== 'function' ||
    Reflect.get(value, 'contributes') !== undefined && !Array.isArray(Reflect.get(value, 'contributes'))) {
    throw new PluginError('invalid-facet', `Plugin "${plugin}" must default-export a workshop facet with start, optional contributes and validate.`, plugin);
  }
  return value as WorkshopFacet;
}

// Workshop composition is browser-only, including on hot update. Node never evaluates authoring code.
export function composeWorkshop(value: unknown, kinds: Kinds) {
  const entries = checkFacetEntries(value, checkWorkshop);
  const composition = new Composition('workshop', WORKSHOP,
    entries.map(({ id, facet }) => ({ plugin: id, contributions: facet.contributes ?? [] })));
  const controls = composition.keyed(AVATAR_MOTION_CONTROLS, []);
  for (const id of controls.keys()) {
    if (!kinds.avatarRigs.motionIds.includes(id)) {
      throw new PluginError('invalid-contribution', `Motion controls name "${id}", which is not a registered motion kind.`,
        namespaceOf(id), AVATAR_MOTION_CONTROLS.id);
    }
  }
  return { entries, controls, checks: composition.keyed(LEVEL_CHECKS, []), reach: composition.slot(LEVEL_REACH, ENGINE_LEVEL_REACH) };
}
