import { characterModel, embeddedModel } from './character-profile';
import { inspectCharacterModel } from './character-model-inspect';
import type { SpriteDocument } from './sprite-data';
import { SpriteError } from './sprite-fields';
import type { AvatarRigRegistry } from './avatar-rig';
import { checkAvatarModelSettings } from './model-library';

// Validates a profile's embedded GLBs against MODEL_LIMITS, skins, bone maps, prop conventions, avatar rigs, hair
// chains and motions before bundling or storing it, exactly as the runtime loader does. The explicit registry comes
// from the host's composed Kinds, so build, server and browser checks apply the same trusted strategies and motion
// kinds (docs/kinds-plugins.md).
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
      if (usage === 'avatar' && document.avatar !== undefined) checkAvatarModelSettings(report, document.avatar, registry);
    } catch (error) {
      if (error instanceof Error) error.message = `${label}: ${usage} model "${model.name}": ${error.message}`;
      throw error;
    }
  }
}
