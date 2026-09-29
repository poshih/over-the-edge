import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gameTitle } from './build/game-title.ts';
import { locationUrl } from './build/location-url.ts';
import { loadProjectInput } from './build/project-release.ts';
import { DEFAULT_CONTENT_URL } from './build/release.ts';
import { loadServerLevels, workshopLevels } from './build/workshop-levels.ts';
import { loadServerModels, workshopModels } from './build/workshop-models.ts';
import { workshopProject } from './build/workshop-project.ts';
import { projectStudio } from './server/project-api.ts';

const project = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode, isPreview }) => {
  // GAME_PROJECT publishes a game with its Workshop, which opens it; see docs/projects.md. Every
  // Workshop also serves the levels folder's levels, and offers the models folder's models from
  // WORKSHOP_CONTENT_URL. Previewing serves a finished build, so none of them is read again.
  const requested = isPreview === true ? undefined : process.env.GAME_PROJECT;
  const input = requested === undefined ? null : loadProjectInput(project, requested);
  const levels = isPreview === true ? [] : loadServerLevels(project);
  const models = isPreview === true ? [] : loadServerModels(project);
  const contentUrl = locationUrl('WORKSHOP_CONTENT_URL', process.env.WORKSHOP_CONTENT_URL ?? DEFAULT_CONTENT_URL);
  return {
    envDir: project,
    plugins: [
      gameTitle({ mode, envDir: project, projectTitle: input?.content.manifest.title }),
      workshopProject(input),
      workshopLevels(levels),
      workshopModels({ models, contentUrl }),
      projectStudio({ root: project, mode }),
    ],
    server: { host: '0.0.0.0', port: 5181, strictPort: true },
    preview: { host: '0.0.0.0', port: 4174, strictPort: true },
  };
});
