import { characterModel, embeddedModel } from './character-profile';
import { inspectCharacterModel, resolveAvatarJoints } from './character-model-inspect';
import type { SpriteDocument } from './sprite-data';
import { SpriteError } from './sprite-fields';

// Validates a profile's embedded GLBs against MODEL_LIMITS, their skins, bone maps and prop
// conventions, exactly as the runtime loader will; used before bundling or storing a profile.
export function checkCharacterModels(document: SpriteDocument, label: string): void {
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
      if (document.avatar !== undefined && usage === 'avatar') resolveAvatarJoints(report, document.avatar.boneMap);
    } catch (error) {
      if (error instanceof Error) error.message = `${label}: ${usage} model "${model.name}": ${error.message}`;
      throw error;
    }
  }
}
