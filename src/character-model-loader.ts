import { CharacterModelError, embeddedModel } from './character-profile';
import type { CharacterModel } from './character-profile';
import { inspectCharacterModel } from './character-model-inspect';
import type { CharacterModelUsage } from './character-model-inspect';
import type { CharacterModelLoader, LoadedCharacterModel } from './character-model-types';
import { fetchModelBlob, ModelError } from './model-data';
import { loadVisualModel } from './visual-model';

function modelFailure(model: CharacterModel, error: unknown): unknown {
  if (!(error instanceof ModelError)) return error;
  const code = /at most|exceeds|no larger than/.test(error.message) ? 'model-limits' : 'invalid-model';
  return new CharacterModelError(code, `Character model "${model.name}": ${error.message}`, { cause: error });
}

// Every load runs the same typed inspection as release builds before GLTFLoader parses the model.
export function createCharacterModelLoader(): CharacterModelLoader {
  return {
    async load(model: CharacterModel, usage: CharacterModelUsage, signal: AbortSignal): Promise<LoadedCharacterModel> {
      signal.throwIfAborted();
      let data: ArrayBuffer;
      try {
        const embedded = embeddedModel(model.source);
        data = embedded !== null ? embedded.buffer
          : await (await fetchModelBlob(model.source, signal, 'character')).arrayBuffer();
      } catch (error) {
        throw modelFailure(model, error);
      }
      signal.throwIfAborted();
      const report = inspectCharacterModel(data, usage);
      let visual;
      try {
        visual = await loadVisualModel(new Blob([data], { type: 'model/gltf-binary' }));
      } catch (error) {
        throw modelFailure(model, error);
      }
      if (signal.aborted) {
        visual.dispose();
        signal.throwIfAborted();
      }
      for (const joint of report.joints) {
        if (!visual.nodes.has(joint.node)) {
          visual.dispose();
          throw new CharacterModelError('invalid-skin', `Character model "${model.name}" lost a skin joint while loading.`);
        }
      }
      return Object.freeze({
        name: model.name, source: model.source, usage, report,
        scene: visual.scene, bounds: visual.bounds, triangles: visual.triangles, nodes: visual.nodes,
        dispose: visual.dispose,
      });
    },
  };
}
