import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gameTitle } from './build/game-title.ts';
import { projectStudio } from './server/project-api.ts';

const project = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  envDir: project,
  plugins: [gameTitle({ mode, envDir: project }), projectStudio({ root: project, mode })],
  server: { host: '0.0.0.0', port: 5181, strictPort: true },
  preview: { host: '0.0.0.0', port: 4174, strictPort: true },
}));
