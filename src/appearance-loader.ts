import { AppearanceRig } from './appearance-rig';
import type { VisualAlignment } from './appearance-profile';
import type { VisualBinding, VisualPartId } from './character';
import { fetchModelBlob } from './model-data';
import { loadVisualModel } from './visual-model';

export interface AppearanceSource {
  readonly part: VisualPartId;
  readonly name: string;
  readonly source: string;
  readonly alignment: Readonly<VisualAlignment>;
}

// Loads a project's per-part GLB replacements onto the game's visual anchors, all before play.
export async function loadAppearance(
  visuals: ReadonlyMap<VisualPartId, VisualBinding>, parts: readonly AppearanceSource[], signal?: AbortSignal,
): Promise<AppearanceRig> {
  const rig = new AppearanceRig(visuals);
  const results = await Promise.allSettled(parts.map(async (entry) =>
    loadVisualModel(await fetchModelBlob(entry.source, signal, `${entry.part} appearance`))));
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
