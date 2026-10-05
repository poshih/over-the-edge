import type { ContentArt } from './content';
import type { ContentLoader } from './content-ref';
import { CourseArtView } from './course-art-view';
import type { Game } from './game';

// Draws a release's packaged course meshes in place of their collision's extrusion, and in place of the decoration
// placeholders they replace; only releases with meshes include it. Every mesh loads before play starts.
export async function loadCourseArt(game: Game, art: ContentArt, content: ContentLoader, signal: AbortSignal): Promise<void> {
  const sources = new Map(art.assets.map((asset) => [asset.id, asset.source]));
  const view = new CourseArtView({
    terrain: game.view.terrain,
    subscribe: (listener) => game.simulation.subscribeTerrain(listener),
    fetch: async (id, fetchSignal) => {
      const source = sources.get(id);
      if (source === undefined) throw new Error(`This release does not contain the course mesh ${id}.`);
      return new Blob([await content(source, fetchSignal)], { type: 'model/gltf-binary' });
    },
    onFailure: (id, error) => console.error(`The course mesh ${id} could not load; its terrain draws as its collision.`, error),
  });
  game.view.addLayer(view);
  await view.load(art.assets.map((asset) => asset.id), signal);
  view.setMode('meshes');
  if (Object.keys(art.decorations).length === 0) return;
  if (game.view.decorations === null) throw new Error('This release draws decoration artwork without its decoration view.');
  game.view.decorations.useArtwork(art.decorations, (id) => view.decorationMesh(id));
}
