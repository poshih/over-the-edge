// Course artwork for decorations: which GLB draws each decoration model in mesh releases, so a
// game's own models replace the built-in placeholders by model ID. DOM-free, so project, package
// and release validation share it.
import { ART_LIMITS, ArtError, artId, artRecord } from './art-types';
import { DECORATION_LIMITS, DECORATION_MODEL_ID } from './level';
import type { LevelDefinition } from './level';

/** Course artwork asset IDs by decoration model ID. */
export type DecorationArt = Readonly<Record<string, string>>;

export const NO_DECORATION_ART: DecorationArt = Object.freeze({});

/** Validates a model-to-asset map whose assets must all be among `assets`. */
export function validateDecorationArt(value: unknown, assets: ReadonlySet<string>): DecorationArt {
  const entries = Object.entries(artRecord(value, 'Decoration artwork'));
  if (entries.length > ART_LIMITS.decorationModels) {
    throw new ArtError(`Decoration artwork maps at most ${ART_LIMITS.decorationModels} models.`);
  }
  const art: Record<string, string> = {};
  for (const [model, asset] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (model.length > DECORATION_LIMITS.modelId || !DECORATION_MODEL_ID.test(model)) {
      throw new ArtError(`Decoration artwork names an invalid model ID "${model.slice(0, DECORATION_LIMITS.modelId)}".`);
    }
    const id = artId(asset);
    if (!assets.has(id)) throw new ArtError(`Decoration model ${model} uses artwork ${id}, which is not in the course artwork.`);
    art[model] = id;
  }
  return Object.freeze(art);
}

/** The asset that draws `model`, or undefined when its placeholder does. */
export function decorationAsset(art: DecorationArt, model: string): string | undefined {
  return Object.hasOwn(art, model) ? art[model] : undefined;
}

/** The part of `art` that the level's decorations use. */
export function usedDecorationArt(level: LevelDefinition, art: DecorationArt): DecorationArt {
  const used: Record<string, string> = {};
  for (const object of level.objects) {
    if (object.kind !== 'decoration') continue;
    const asset = decorationAsset(art, object.model);
    if (asset !== undefined) used[object.model] = asset;
  }
  return Object.freeze(Object.fromEntries(Object.entries(used).sort(([a], [b]) => (a < b ? -1 : 1))));
}
