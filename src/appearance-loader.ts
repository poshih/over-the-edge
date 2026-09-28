import { AppearanceRig } from './appearance-rig';
import type { VisualAlignment } from './appearance-profile';
import type { VisualBinding, VisualPartId } from './character';
import { isContentRef } from './content-ref';
import type { ContentLoader } from './content-ref';
import { fetchModelBlob, ModelError } from './model-data';
import { loadVisualModel } from './visual-model';

export interface AppearanceSource {
  readonly part: VisualPartId;
  readonly name: string;
  readonly source: string;
  readonly alignment: Readonly<VisualAlignment>;
}

async function modelBlob(entry: AppearanceSource, options: { signal?: AbortSignal; content?: ContentLoader }): Promise<Blob> {
  if (!isContentRef(entry.source)) return fetchModelBlob(entry.source, options.signal, `${entry.part} appearance`);
  if (options.content === undefined) throw new ModelError(`The ${entry.part} appearance is packaged release content, which this host cannot load.`);
  return new Blob([await options.content(entry.source, options.signal ?? new AbortController().signal)], { type: 'model/gltf-binary' });
}

// Loads a project's per-part GLB replacements onto the game's visual anchors, all before play.
// `content` loads a release's packaged models.
export async function loadAppearance(
  visuals: ReadonlyMap<VisualPartId, VisualBinding>, parts: readonly AppearanceSource[],
  options: { signal?: AbortSignal; content?: ContentLoader } = {},
): Promise<AppearanceRig> {
  const rig = new AppearanceRig(visuals);
  const results = await Promise.allSettled(parts.map(async (entry) => loadVisualModel(await modelBlob(entry, options))));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure !== undefined) {
    for (const result of results) if (result.status === 'fulfilled') result.value.dispose();
    throw failure.reason;
  }
  for (const [index, entry] of parts.entries()) {
    const result = results[index]!;
    if (result.status === 'fulfilled') rig.setModel(entry.part, result.value, entry.alignment);
  }
  return rig;
}
