import { characterModel, embeddedModel } from './character-profile';
import { inspectCharacterModel } from './character-model-inspect';
import type { CharacterModelUsage } from './character-model-inspect';
import type { SpriteDocument } from './sprite-data';
import { SpriteError } from './sprite-fields';
import type { AvatarRigRegistry } from './avatar-rig';
import { checkAvatarModelSettings } from './model-library';

const ROLES: readonly CharacterModelUsage[] = ['avatar', 'hammer', 'pot'];

// Validates the GLB a profile embeds for `role` against MODEL_LIMITS, its skin, the role's conventions and, for the
// avatar, its bone map, rig, hair chains and motions, exactly as the runtime loader does. False for a model given by
// URL, which only its loader can check; true once checked, or when the role has no model. The explicit registry comes
// from the host's composed Kinds, so build, server and browser checks apply the same trusted strategies and motion
// kinds (docs/kinds-plugins.md).
export function checkCharacterModel(
  document: SpriteDocument, role: CharacterModelUsage, label: string, registry: AvatarRigRegistry,
): boolean {
  const profile = document[role];
  if (profile === undefined) return true;
  const model = characterModel(document, profile.model);
  const bytes = embeddedModel(model.source);
  if (bytes === null) return false;
  try {
    const report = inspectCharacterModel(bytes.buffer, role);
    if (role === 'avatar' && document.avatar !== undefined) checkAvatarModelSettings(report, document.avatar, registry);
  } catch (error) {
    if (error instanceof Error) error.message = `${label}: ${role} model "${model.name}": ${error.message}`;
    throw error;
  }
  return true;
}

// Every model a profile uses, before bundling or storing it: each must be embedded so it can be checked.
export function checkCharacterModels(document: SpriteDocument, label: string, registry: AvatarRigRegistry): void {
  for (const role of ROLES) {
    if (checkCharacterModel(document, role, label, registry)) continue;
    const model = characterModel(document, document[role]!.model);
    throw new SpriteError(`${label}: character model "${model.name}" must be an embedded GLB so it can be validated.`);
  }
}

// The models a profile embeds, each on its own; one given by URL is checked as it loads, as the Workshop allows.
export function checkEmbeddedCharacterModels(document: SpriteDocument, label: string, registry: AvatarRigRegistry): void {
  for (const role of ROLES) checkCharacterModel(document, role, label, registry);
}
