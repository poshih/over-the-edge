import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gameTitle } from './build/game-title.ts';

const project = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  envDir: project,
  plugins: [gameTitle({ mode, envDir: project })],
  server: { host: '0.0.0.0', port: 5181, strictPort: true },
  preview: { host: '0.0.0.0', port: 4174, strictPort: true },
}));
