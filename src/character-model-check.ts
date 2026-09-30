import { characterModel, embeddedModel } from './character-profile';
import { inspectCharacterModel } from './character-model-inspect';
import type { SpriteDocument } from './sprite-data';
import { SpriteError } from './sprite-fields';
import { checkAvatarRig } from './avatar-rig';
import type { AvatarRigRegistry } from './avatar-rig';

// Validates a profile's embedded GLBs against MODEL_LIMITS, their skins, bone maps, prop
// conventions and avatar rigs, exactly as the runtime loader will; used before bundling or storing
// a profile. The registry is the host's trusted rig strategies, passed in so the same custom
// AVATAR_RIG_MODULE is applied to build, server and browser checks.
export function checkCharacterModels(document: SpriteDocument, label: string, registry: AvatarRigRegistry): void {
  const profiles = [['avatar', document.avatar], ['hammer', document.hammer], ['pot', document.pot]] as const;
  for (const [usage, profile] of profiles) {
    if (profile === undefined) continue;
    const model = characterModel(document, profile.model);
    const bytes = embeddedModel(model.source);
    if (bytes === null) {
      throw new SpriteError(`${label}: character model "${model.name}" must be an embedded GLB so it can be validated.`);
    }
    try {
      const report = inspectCharacterModel(bytes.buffer, usage);
      if (usage === 'avatar' && document.avatar !== undefined) {
        checkAvatarRig(report, document.avatar.boneMap, document.avatar.driver, registry);
      }
    } catch (error) {
      if (error instanceof Error) error.message = `${label}: ${usage} model "${model.name}": ${error.message}`;
      throw error;
    }
  }
}
