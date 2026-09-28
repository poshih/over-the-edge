import type { ArtResource } from './art-types';
import type { ContentLoader } from './content-ref';
import { CourseArtView } from './course-art-view';
import type { Game } from './game';

// Draws a release's packaged course meshes over its terrain; only releases with meshes include it.
export async function loadCourseArt(game: Game, assets: readonly ArtResource[], content: ContentLoader, signal: AbortSignal): Promise<void> {
  const art = new CourseArtView({
    terrain: game.view.terrain,
    subscribe: (listener) => game.simulation.subscribeTerrain(listener),
    onMissing: (message) => { throw new Error(message); },
    content,
  });
  game.view.addLayer(art);
  await art.load(assets, signal);
  art.setMode('meshes');
}
