import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gameTitle } from './build/game-title.ts';
import { loadProjectInput } from './build/project-release.ts';
import { loadServerLevels, workshopLevels } from './build/workshop-levels.ts';
import { workshopProject } from './build/workshop-project.ts';
import { projectStudio } from './server/project-api.ts';

const project = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode, isPreview }) => {
  // GAME_PROJECT publishes a game with its Workshop, which opens it; see docs/projects.md. Every
  // Workshop also serves the levels folder's levels. Previewing serves a finished build, so
  // neither is read again.
  const requested = isPreview === true ? undefined : process.env.GAME_PROJECT;
  const input = requested === undefined ? null : loadProjectInput(project, requested);
  const levels = isPreview === true ? [] : loadServerLevels(project);
  return {
    envDir: project,
    plugins: [
      gameTitle({ mode, envDir: project, projectTitle: input?.content.manifest.title }),
      workshopProject(input),
      workshopLevels(levels),
      projectStudio({ root: project, mode }),
    ],
    server: { host: '0.0.0.0', port: 5181, strictPort: true },
    preview: { host: '0.0.0.0', port: 4174, strictPort: true },
  };
});
