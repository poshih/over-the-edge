import type { DeathFrame } from './death-sequence';
import { checkDeathCallback, deathPluginFailure } from './death-sequence';
import { PluginError, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { CharacterRiggingType } from './sprite-data';

export interface DeathAnimationInput extends DeathFrame {
  readonly character: CharacterRiggingType;
  // The tool's side at death entry; +1 when centred.
  readonly direction: -1 | 1;
}

export interface DeathAnimationPose {
  // Offsets from the live torso/head pose, in radians. Pot, tool and arm passes stay unchanged.
  torsoLean: number;
  headPitch: number;
  // Runtime sprite material brightness, not opacity.
  spriteBrightness: number;
}

export type DeathAnimationWriter = (frame: DeathAnimationInput, out: DeathAnimationPose) => void;

function animationWriter(value: unknown): DeathAnimationWriter {
  if (typeof value !== 'function') throw new TypeError('A death animation must be a numeric pose writer.');
  return value as DeathAnimationWriter;
}

export const DEATH_ANIMATION = slotPoint('scene.death-animation', 'runtime', animationWriter);

export const DEFAULT_DEATH_ANIMATION: DeathAnimationWriter = (frame, out) => {
  const progress = frame.reducedMotion ? 1 : frame.poseProgress;
  const weight = progress * progress * (3 - 2 * progress);
  out.torsoLean = -frame.direction * 20 * Math.PI / 180 * weight;
  out.headPitch = 35 * Math.PI / 180 * weight;
  out.spriteBrightness = 1 - 0.55 * weight;
};

export function createDeathAnimation(plugins: RuntimePlugins): DeathAnimationWriter {
  const writer = plugins.slot(DEATH_ANIMATION, DEFAULT_DEATH_ANIMATION);
  const plugin = plugins.owner(DEATH_ANIMATION);
  return (frame, out) => {
    out.torsoLean = out.headPitch = out.spriteBrightness = NaN;
    try {
      checkDeathCallback(writer(frame, out), plugin, DEATH_ANIMATION.id, 'write');
      if (!Number.isFinite(out.torsoLean) || Math.abs(out.torsoLean) > Math.PI / 2 ||
        !Number.isFinite(out.headPitch) || Math.abs(out.headPitch) > Math.PI / 2 ||
        !Number.isFinite(out.spriteBrightness) || out.spriteBrightness < 0 || out.spriteBrightness > 1) {
        throw new PluginError('invalid-contribution',
          `Plugin "${plugin ?? 'engine'}": "${DEATH_ANIMATION.id}" must write finite torsoLean/headPitch within ±π/2 and spriteBrightness within 0–1.`,
          plugin, DEATH_ANIMATION.id);
      }
    } catch (error) {
      throw deathPluginFailure(error, plugin, DEATH_ANIMATION.id, 'write');
    }
  };
}
