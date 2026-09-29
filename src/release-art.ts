import type { ContentArt } from './content';
import type { ContentLoader } from './content-ref';
import { CourseArtView } from './course-art-view';
import type { Game } from './game';

// Draws a release's packaged course meshes over its terrain, and in place of the decoration
// placeholders they replace; only releases with meshes include it.
export async function loadCourseArt(game: Game, art: ContentArt, content: ContentLoader, signal: AbortSignal): Promise<void> {
  const view = new CourseArtView({
    terrain: game.view.terrain,
    subscribe: (listener) => game.simulation.subscribeTerrain(listener),
    onMissing: (message) => { throw new Error(message); },
    content,
  });
  game.view.addLayer(view);
  await view.load(art.assets, signal);
  view.setMode('meshes');
  if (Object.keys(art.decorations).length === 0) return;
  if (game.view.decorations === null) throw new Error('This release draws decoration artwork without its decoration view.');
  game.view.decorations.useArtwork(art.decorations, (id) => view.decorationMesh(id));
}
